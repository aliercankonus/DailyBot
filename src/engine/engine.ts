// Live engine. One tick per minute:
//   1. reconcile every symbol (the exchange is the source of truth),
//   2. when a new candle has closed: trail the stop of an open position, or evaluate an entry.
// The same Strategy object is used by the backtester, and both give it the last
// STRATEGY_WINDOW closed candles.
import type { Candle, OpenPositionView, Side, Signal } from "../core/types.js";
import type { PositionRow, Repo } from "../db/repo.js";
import { closingSide, openingSide, type AccountBalance, type Exchange, type StopOrder } from "../exchange/types.js";
import { evaluateGates } from "../risk/gates.js";
import { sizePosition } from "../risk/sizing.js";
import { STRATEGY_WINDOW, type Strategy } from "../strategy/types.js";
import { attachFunding } from "../data/funding.js";
import type { Notifier } from "../notify/notifier.js";

export interface EngineConfig {
  symbols: string[];
  interval: string;          // Binance interval, e.g. "4h"
  intervalMs: number;
  riskPerTrade: number;
  maxLeverage: number;
  maxOpenPositions: number;
  dailyLossLimit: number;
  maxDrawdown: number;
  /** A closed candle older than this (after its close) is considered stale. */
  maxCandleDelayMs: number;
  /** Expected fees + slippage for entry and exit, as a fraction of price. Counted as risk when sizing. */
  roundTripCostPct: number;
}

export interface EngineDeps {
  exchange: Exchange;
  repo: Repo;
  strategy: Strategy;
  notifier: Notifier;
  cfg: EngineConfig;
  now?: () => number;
  newId?: () => string;
}

export interface KillSwitch { on: boolean; reason: string; at: number; source?: "engine" | "manual" }
interface DayStart { day: string; equity: number }

/**
 * Written BEFORE the entry order is sent. If the process dies between the fill and the
 * database insert, reconcile() finds this record, adopts the live position and protects it.
 */
export interface PendingEntry {
  side: Side;
  clientOrderId: string;
  candleOpenTime: number;
  stopDistance: number;
  leverage: number;
  startedAt: number;
  reason: string;
}

const CLIENT_PREFIX = "te-";
/** How long a pending entry may be adopted after it was sent. */
const PENDING_ENTRY_TTL_MS = 60 * 60_000;
/** How long to wait for exit fills to appear after a position disappears from the exchange. */
const EXIT_FILLS_GRACE_MS = 10 * 60_000;
/** A stop-breach sighting older than this is stale (engine or API was down) and starts a new count. */
const BREACH_MAX_AGE_MS = 5 * 60_000;

/** Deterministic Binance client id (max 36 chars, [A-Za-z0-9._:/-]). Times are base36 to stay short. */
export function clientId(symbol: string, candleOpenTime: number, suffix: string): string {
  const id = `${CLIENT_PREFIX}${symbol}-${candleOpenTime.toString(36)}-${suffix}`;
  if (id.length > 36) throw new Error(`client id too long: ${id}`);
  return id;
}

/** Binance -2021 / paper: a stop that would trigger immediately, i.e. price is already through it. */
const wouldTriggerNow = (e: unknown) => /-2021|immediately trigger/i.test(errMsg(e));

export class Engine {
  private readonly now: () => number;
  private readonly newId: () => string;
  constructor(private readonly d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.newId = d.newId ?? (() => crypto.randomUUID());
  }

  // ---------- public ----------

  async tick(): Promise<void> {
    let balance: AccountBalance | null = null;
    try {
      balance = await this.d.exchange.getBalance();
      await this.trackEquity(balance);
    } catch (e) {
      await this.event("error", "BALANCE_ERROR", null, errMsg(e));
    }
    for (const symbol of this.d.cfg.symbols) {
      try {
        // Reconcile always runs, even without a balance: protecting positions comes first.
        await this.reconcile(symbol);
        if (balance) await this.onCandle(symbol, balance);
      } catch (e) {
        await this.event("error", "SYMBOL_ERROR", symbol, errMsg(e));
      }
    }
  }

  async setKillSwitch(on: boolean, reason: string): Promise<void> {
    await this.d.repo.setState<KillSwitch>("killSwitch", { on, reason, at: this.now(), source: "engine" });
    await this.event(on ? "error" : "info", on ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF", null, reason);
    await this.notify(on ? "error" : "info", `Kill switch ${on ? "ON" : "OFF"}: ${reason}`);
  }

  /** Turn the kill switch on unless it already is (avoids an alert every minute). */
  private async tripKillSwitch(reason: string): Promise<void> {
    const ks = await this.d.repo.getState<KillSwitch>("killSwitch");
    if (ks?.on) return;
    await this.setKillSwitch(true, reason);
  }

  // ---------- reconciliation ----------

  /** Make the database agree with the exchange and make sure every open position has a stop. */
  async reconcile(symbol: string): Promise<void> {
    const ex = this.d.exchange;
    const { repo } = this.d;
    const [db, live] = await Promise.all([repo.getOpenPosition(symbol), ex.getPosition(symbol)]);
    const pendingKey = `pendingEntry:${symbol}`;

    if (!db && !live) {
      const pending = await repo.getState<PendingEntry>(pendingKey);
      if (pending && this.now() - pending.startedAt > 10 * 60_000) await repo.setState(pendingKey, null);
      await this.cancelOurStops(symbol, await ex.getOpenStops(symbol));
      return;
    }

    if (db && !live) {
      await this.recordExchangeClose(db);
      return;
    }

    if (!db && live) {
      const pending = await repo.getState<PendingEntry>(pendingKey);
      if (pending && pending.side === live.side && this.now() - pending.startedAt <= PENDING_ENTRY_TTL_MS) {
        await this.event("warn", "ENTRY_ADOPTED", symbol, `live ${live.side} ${live.quantity} found without a row; adopting pending entry ${pending.clientOrderId}`);
        await this.openPosition(symbol, pending, live.entryPrice, live.quantity);
        await repo.setState(pendingKey, null);
        return;
      }
      await this.tripKillSwitch(`Unknown ${live.side} position on ${symbol} (qty ${live.quantity}). Not opened by the bot; manual action required.`);
      return;
    }

    // Both exist.
    const pos = db!;
    const lp = live!;
    if (pos.side !== lp.side) {
      await this.tripKillSwitch(`${symbol}: database says ${pos.side}, exchange says ${lp.side}.`);
      return;
    }
    if (Math.abs(pos.quantity - lp.quantity) > 1e-12) {
      await this.event("warn", "QTY_MISMATCH", symbol, `db ${pos.quantity} vs exchange ${lp.quantity}; adopting exchange quantity`);
      await repo.updatePosition(pos.id, { quantity: lp.quantity });
      pos.quantity = lp.quantity;
    }
    // Backstop for a stop that did not fire (e.g. Binance priceProtect suppresses STOP_MARKET while
    // mark and last price diverge in a crash, or an exchange glitch): if the mark price is through
    // the stop on two consecutive checks (>= one tick apart, so a stop that is filling right now
    // is not raced), close at market.
    const breachKey = `stopBreach:${pos.id}`;
    const breached = lp.markPrice !== undefined && pos.stop > 0 && (pos.side === "LONG" ? lp.markPrice <= pos.stop : lp.markPrice >= pos.stop);
    if (breached) {
      const firstSeen = await repo.getState<number>(breachKey);
      // A sighting older than BREACH_MAX_AGE_MS (engine or API was down in between) does not count.
      if (firstSeen === null || firstSeen === undefined || this.now() - firstSeen > BREACH_MAX_AGE_MS) {
        await repo.setState(breachKey, this.now());
        await this.event("warn", "STOP_BREACHED", symbol, `mark ${lp.markPrice} is through the stop ${pos.stop}; closing at market if it persists`);
      } else if (this.now() > firstSeen) {
        await this.event("error", "STOP_NOT_TRIGGERED", symbol, `mark ${lp.markPrice} still through the stop ${pos.stop}; closing at market`);
        await repo.setState(breachKey, null);
        // The stop may fill right now: re-read, and if the position is gone let the next reconcile book it.
        if (!(await ex.getPosition(symbol))) return;
        await this.closeAtMarket(pos, "STOP_NOT_TRIGGERED", { recheckOnFailure: true });
        return;
      }
    } else if ((await repo.getState<number>(breachKey)) != null) {
      await repo.setState(breachKey, null);
    }
    const stops = (await ex.getOpenStops(symbol)).filter((s) => s.side === closingSide(pos.side));
    const covered = stops.reduce((a, s) => a + s.quantity, 0) >= pos.quantity - 1e-12;
    if (!covered) {
      await this.event("warn", "STOP_MISSING", symbol, `no stop covers the position; placing one at ${pos.stop}`);
      await this.protectOrClose(pos, pos.stop, `R${this.now().toString(36)}`);
    }
  }

  /** The exchange no longer has the position: book the exit from the account's fills. */
  private async recordExchangeClose(db: PositionRow): Promise<void> {
    const { exchange: ex, repo } = this.d;
    const symbol = db.symbol;
    // Fills since just before the entry order, so the entry commission is included.
    const fills = await ex.getFills(symbol, db.entryTime - 60_000);
    const exits = fills.filter((f) => f.side === closingSide(db.side) && f.time >= db.entryTime);
    const qty = exits.reduce((a, f) => a + f.qty, 0);
    const waitKey = `exitWait:${db.id}`;

    if (qty <= 0) {
      // Exit fills can lag the position update. Do not invent an exit price; wait, then flag.
      const firstSeen = (await repo.getState<number>(waitKey)) ?? this.now();
      if (this.now() - firstSeen < EXIT_FILLS_GRACE_MS) {
        if (firstSeen === this.now()) {
          await repo.setState(waitKey, firstSeen);
          await this.event("warn", "EXIT_FILLS_PENDING", symbol, "position gone on exchange but no exit fills yet; waiting");
        }
        return;
      }
      await repo.updatePosition(db.id, { status: "CLOSED", exitTime: firstSeen, exitReason: "EXCHANGE_CLOSE_NO_FILLS" });
      await repo.setState(waitKey, null);
      await this.cancelOurStops(symbol, await ex.getOpenStops(symbol));
      const msg = `${symbol} ${db.side} closed on exchange but no exit fills were found; PnL unknown, check Binance trade history`;
      await this.event("error", "POSITION_CLOSED_UNKNOWN", symbol, msg);
      await this.notify("warn", msg);
      return;
    }

    const exitPrice = exits.reduce((a, f) => a + f.price * f.qty, 0) / qty;
    const realized = exits.reduce((a, f) => a + f.realizedPnl, 0);
    const fees = fills.reduce((a, f) => a + f.commission, 0);
    const exitTime = exits.at(-1)!.time;
    await repo.updatePosition(db.id, {
      status: "CLOSED", exitPrice, exitTime, exitReason: "EXCHANGE_CLOSE", realizedPnl: realized - fees, fees,
    });
    await repo.setState(waitKey, null);
    await this.cancelOurStops(symbol, await ex.getOpenStops(symbol));
    const msg = `${symbol} ${db.side} closed on exchange @ ${exitPrice.toFixed(4)}, pnl ${(realized - fees).toFixed(2)} USDT`;
    await this.event("info", "POSITION_CLOSED", symbol, msg);
    await this.notify("info", msg);
  }

  // ---------- candle close ----------

  async onCandle(symbol: string, balance: AccountBalance): Promise<void> {
    const { cfg, strategy, exchange: ex, repo } = this.d;
    let candles = await ex.getClosedCandles(symbol, cfg.interval, STRATEGY_WINDOW);
    const last = candles.at(-1);
    if (!last) return;
    const lastKey = `lastProcessed:${symbol}`;
    const lastProcessed = (await repo.getState<number>(lastKey)) ?? 0;
    if (last.openTime <= lastProcessed) return;

    if (strategy.needsFunding) {
      // Same attachment rule as the backtest: the last rate settled at or before each close.
      const funding = await ex.getFundingHistory(symbol, candles[0]!.openTime - 8 * 3600_000);
      candles = attachFunding(candles, funding);
    }

    const pos = await repo.getOpenPosition(symbol);
    if (pos) {
      const view: OpenPositionView = {
        side: pos.side, entryPrice: pos.entryPrice, stop: pos.stop, initialStop: pos.initialStop,
        entryCandleOpenTime: pos.entryCandleOpenTime,
      };
      // Same order as the backtest: a strategy exit takes precedence over a stop update.
      if (strategy.shouldExit?.(view, candles)) {
        await this.event("info", "STRATEGY_EXIT", symbol, `strategy exit on candle ${new Date(last.openTime).toISOString()}`);
        await this.closeAtMarket(pos, "STRATEGY_EXIT");
      } else {
        await this.trailStop(pos, candles);
      }
      await repo.setState(lastKey, last.openTime);
      return;
    }

    const signal = strategy.evaluate(symbol, candles);
    const kill = (await repo.getState<KillSwitch>("killSwitch"))?.on ?? false;
    const peak = (await repo.getState<number>("equityPeak")) ?? balance.equity;
    const day = await repo.getState<DayStart>("dayStart");
    const gate = evaluateGates({
      killSwitch: kill,
      dataFresh: candles.length >= strategy.warmup && this.now() - last.closeTime <= cfg.maxCandleDelayMs,
      hasSignal: signal !== null,
      symbolHasPosition: false,
      openPositions: (await repo.listOpenPositions()).length,
      maxOpenPositions: cfg.maxOpenPositions,
      dayPnlPct: day && day.equity > 0 ? (balance.equity - day.equity) / day.equity : 0,
      dailyLossLimit: cfg.dailyLossLimit,
      drawdownPct: peak > 0 ? Math.max(0, (peak - balance.equity) / peak) : 0,
      maxDrawdown: cfg.maxDrawdown,
    });

    if (signal) {
      // One signal row per candle, even when the entry is retried on later ticks.
      const sigKey = `signalLogged:${symbol}`;
      if ((await repo.getState<number>(sigKey)) !== last.openTime) {
        await repo.recordSignal({
          symbol, candleOpenTime: last.openTime, side: signal.side, accepted: gate.ok,
          gate: gate.ok ? null : gate.gate, detail: gate.ok ? signal.reason : gate.detail, createdAt: this.now(),
        });
        await repo.setState(sigKey, last.openTime);
      }
    }
    if (!signal && strategy.explain) {
      // Diagnostics only: why this closed candle gave no entry (once per candle). Logged and stored
      // in the signals table (gate NO_SIGNAL) for the dashboard; a storage failure must not stop the tick.
      let why: string;
      try {
        why = strategy.explain(candles);
      } catch (e) {
        why = `explain failed: ${errMsg(e)}`;
      }
      console.log(JSON.stringify({ level: "info", msg: "no signal", symbol, candle: new Date(last.openTime).toISOString(), why, time: new Date(this.now()).toISOString() }));
      await repo.recordSignal({ symbol, candleOpenTime: last.openTime, side: null, accepted: false, gate: "NO_SIGNAL", detail: why, createdAt: this.now() })
        .catch((e) => console.error(JSON.stringify({ level: "error", msg: "no-signal record failed", symbol, error: errMsg(e) })));
    }
    if (gate.ok && signal) {
      // Throws on transient failure: lastProcessed is NOT advanced, so the next tick retries
      // (the deterministic client order id prevents a double entry).
      await this.enter(signal, last);
    }
    await repo.setState(lastKey, last.openTime);
  }

  // ---------- orders ----------

  private async enter(signal: Signal, candle: Candle): Promise<void> {
    const { exchange: ex, cfg, repo } = this.d;
    // Fresh balance: an earlier entry in this tick may already use margin.
    const balance = await ex.getBalance();
    const filters = await ex.getFilters(signal.symbol);
    const size = sizePosition({
      equity: balance.equity, availableBalance: balance.available, entryPrice: signal.refPrice,
      stopPrice: signal.stop, riskPerTrade: cfg.riskPerTrade, maxLeverage: cfg.maxLeverage, filters,
      roundTripCostPct: cfg.roundTripCostPct,
    });
    if (!size.ok) {
      await this.event("warn", "SIZING_REJECTED", signal.symbol, size.reason);
      return;
    }

    await ex.prepareSymbol(signal.symbol, size.leverage);
    const pendingKey = `pendingEntry:${signal.symbol}`;
    const pending: PendingEntry = {
      side: signal.side,
      clientOrderId: clientId(signal.symbol, candle.openTime, "E"),
      candleOpenTime: candle.openTime,
      stopDistance: Math.abs(signal.refPrice - signal.stop),
      leverage: size.leverage,
      startedAt: this.now(),
      reason: signal.reason,
    };
    await repo.setState(pendingKey, pending);

    let fill;
    try {
      fill = await ex.marketOrder({
        symbol: signal.symbol, side: openingSide(signal.side), quantity: size.quantity, reduceOnly: false,
        clientOrderId: pending.clientOrderId,
      });
    } catch (e) {
      if (/CLIENT_ID_SPENT/.test(errMsg(e))) {
        // An earlier attempt for this candle was rejected/cancelled. Skip this candle.
        await repo.setState(pendingKey, null);
        await this.event("warn", "ENTRY_NOT_FILLED", signal.symbol, errMsg(e));
        return;
      }
      throw e; // pending stays: reconcile adopts the position if the order did fill
    }
    if (!(fill.executedQty > 0)) {
      await repo.setState(pendingKey, null);
      await this.event("warn", "ENTRY_NOT_FILLED", signal.symbol, `status ${fill.status}`);
      return;
    }
    let entryPrice = fill.avgPrice;
    if (!(entryPrice > 0)) {
      // Never derive the stop from a missing price (2026-11-19 demo incident: avgPrice 0 -> stop 1955 on BTC).
      const live = await ex.getPosition(signal.symbol).catch(() => null);
      const fromExchange = !!live && live.entryPrice > 0;
      entryPrice = fromExchange ? live!.entryPrice : signal.refPrice;
      await this.event("error", "FILL_PRICE_MISSING", signal.symbol,
        `entry fill reported without a price; using the ${fromExchange ? "exchange position entry" : "signal price"} ${entryPrice}`);
    }
    await this.openPosition(signal.symbol, pending, entryPrice, fill.executedQty);
    await repo.setState(pendingKey, null);
  }

  /** Insert the position row and protect it immediately; notifications come last. */
  private async openPosition(symbol: string, p: PendingEntry, entryPrice: number, quantity: number): Promise<void> {
    // Keep the planned risk distance relative to the actual fill price.
    const stop = p.side === "LONG" ? entryPrice - p.stopDistance : entryPrice + p.stopDistance;
    const row: PositionRow = {
      id: this.newId(), symbol, side: p.side, status: "OPEN",
      // The fill happens during the candle after the signal candle, as in the backtest.
      quantity, entryPrice, entryTime: p.startedAt, entryCandleOpenTime: p.candleOpenTime + this.d.cfg.intervalMs,
      initialStop: stop, stop, stopOrderId: null, leverage: p.leverage, riskAmount: p.stopDistance * quantity,
      exitPrice: null, exitTime: null, exitReason: null, realizedPnl: null, fees: null, strategy: this.d.strategy.name,
    };
    await this.d.repo.insertPosition(row);
    const placed = await this.protectOrClose(row, stop, "S0");
    if (!placed) return;
    const msg = `${symbol} ${p.side} ${quantity} @ ${entryPrice} | stop ${row.stop.toFixed(4)} | ${p.leverage}x | risk ${row.riskAmount.toFixed(2)} USDT`;
    await this.event("info", "POSITION_OPENED", symbol, msg, { reason: p.reason });
    await this.notify("info", `Opened ${msg}`);
  }

  private async trailStop(pos: PositionRow, candles: Candle[]): Promise<void> {
    const view: OpenPositionView = {
      side: pos.side, entryPrice: pos.entryPrice, stop: pos.stop, initialStop: pos.initialStop,
      entryCandleOpenTime: pos.entryCandleOpenTime,
    };
    const next = this.d.strategy.updateStop(view, candles);
    const tick = (await this.d.exchange.getFilters(pos.symbol)).tickSize;
    const improves = pos.side === "LONG" ? next >= pos.stop + tick : next <= pos.stop - tick;
    if (!improves) return;
    const old = pos.stopOrderId;
    let placed: StopOrder;
    try {
      placed = await this.d.exchange.placeStop({
        symbol: pos.symbol, side: closingSide(pos.side), quantity: pos.quantity, stopPrice: next,
        clientId: clientId(pos.symbol, pos.entryCandleOpenTime, `S${candles.at(-1)!.openTime.toString(36)}`),
      });
    } catch (e) {
      if (wouldTriggerNow(e)) {
        // Price already moved through the new stop level: exit now, as the backtest would at the next open.
        await this.event("info", "TRAIL_THROUGH_PRICE", pos.symbol, `new stop ${next} already crossed; closing at market`);
        await this.closeAtMarket(pos, "TRAIL_STOP_CROSSED");
      } else {
        // The old stop is still in place and valid; try again on the next candle.
        await this.event("warn", "TRAIL_FAILED", pos.symbol, `keeping stop ${pos.stop}: ${errMsg(e)}`);
      }
      return;
    }
    await this.d.repo.updatePosition(pos.id, { stop: placed.stopPrice, stopOrderId: placed.id });
    pos.stop = placed.stopPrice;
    pos.stopOrderId = placed.id;
    if (old && old !== placed.id) {
      try {
        await this.d.exchange.cancelStop(pos.symbol, old);
      } catch (e) {
        await this.event("warn", "CANCEL_OLD_STOP_FAILED", pos.symbol, errMsg(e));
      }
    }
  }

  /**
   * Place a reduce-only stop for the position. If that is impossible (price already
   * through the stop, exchange error), close the position at market instead. A position
   * is never left without protection.
   */
  private async protectOrClose(pos: PositionRow, stopPrice: number, suffix: string): Promise<StopOrder | null> {
    const ex = this.d.exchange;
    try {
      const s = await ex.placeStop({
        symbol: pos.symbol, side: closingSide(pos.side), quantity: pos.quantity, stopPrice,
        clientId: clientId(pos.symbol, pos.entryCandleOpenTime, suffix),
      });
      await this.d.repo.updatePosition(pos.id, { stop: s.stopPrice, stopOrderId: s.id });
      pos.stop = s.stopPrice;
      pos.stopOrderId = s.id;
      return s;
    } catch (e) {
      await this.event("error", "STOP_FAILED", pos.symbol, `stop @ ${stopPrice} failed: ${errMsg(e)}; closing at market`);
      await this.closeAtMarket(pos, "STOP_PLACEMENT_FAILED");
      return null;
    }
  }

  /** Volume-weighted price of the account fills of one order (last 5 minutes), or null. Never mixes in other orders. */
  private async orderFillPrice(symbol: string, side: "BUY" | "SELL", orderId: string): Promise<number | null> {
    const fills = (await this.d.exchange.getFills(symbol, this.now() - 5 * 60_000).catch(() => [])).filter((f) => f.side === side && f.orderId === orderId);
    const qty = fills.reduce((a, f) => a + f.qty, 0);
    return qty > 0 ? fills.reduce((a, f) => a + f.price * f.qty, 0) / qty : null;
  }

  async closeAtMarket(pos: PositionRow, reason: string, opts: { recheckOnFailure?: boolean } = {}): Promise<void> {
    const ex = this.d.exchange;
    try {
      const fill = await ex.marketOrder({
        symbol: pos.symbol, side: closingSide(pos.side), quantity: pos.quantity, reduceOnly: true,
        // Unique per attempt: a spent id from an earlier failed close must not block this one.
        clientOrderId: clientId(pos.symbol, pos.entryCandleOpenTime, `X${this.now().toString(36)}`),
      });
      if (fill.executedQty < pos.quantity - 1e-12) {
        // Partially closed: keep the row open; reconcile adopts the remaining quantity and re-protects it.
        await this.event("error", "PARTIAL_CLOSE", pos.symbol, `closed ${fill.executedQty} of ${pos.quantity}`);
        return;
      }
      await this.cancelOurStops(pos.symbol, await ex.getOpenStops(pos.symbol));
      let exitPrice: number | null = fill.avgPrice > 0 ? fill.avgPrice : await this.orderFillPrice(pos.symbol, closingSide(pos.side), fill.orderId);
      if (exitPrice === null) {
        await this.event("error", "FILL_PRICE_MISSING", pos.symbol, `market close (${reason}) filled without a price; PnL unknown, check the exchange trade history`);
      }
      const gross = exitPrice === null ? null : (pos.side === "LONG" ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice) * fill.executedQty;
      await this.d.repo.updatePosition(pos.id, {
        status: "CLOSED", exitPrice, exitTime: this.now(), exitReason: reason, realizedPnl: gross,
      });
      await this.notify("warn", `${pos.symbol} closed at market (${reason}) @ ${exitPrice ?? "unknown price"}`);
    } catch (e) {
      if (opts.recheckOnFailure) {
        // E.g. the exchange stop filled first and the reduce-only order was rejected: nothing to do.
        const still = await ex.getPosition(pos.symbol).catch(() => undefined);
        if (still === null) {
          await this.event("warn", "CLOSE_RACED", pos.symbol, `market close (${reason}) rejected but the position is already gone: ${errMsg(e)}`);
          return;
        }
      }
      // Could not close and could not protect: stop all trading and alert a human.
      await this.tripKillSwitch(`${pos.symbol}: market close failed (${reason}): ${errMsg(e)}`);
    }
  }

  private async cancelOurStops(symbol: string, stops: StopOrder[]): Promise<void> {
    for (const s of stops.filter((x) => x.clientId.startsWith(CLIENT_PREFIX))) {
      try {
        await this.d.exchange.cancelStop(symbol, s.id);
      } catch (e) {
        await this.event("warn", "CANCEL_STOP_FAILED", symbol, errMsg(e));
      }
    }
  }

  // ---------- bookkeeping ----------

  private async trackEquity(b: AccountBalance): Promise<void> {
    const { repo, cfg } = this.d;
    const now = this.now();
    // A null peak (e.g. reset when the kill switch is turned off) is re-seeded from current equity.
    const peak = Math.max((await repo.getState<number>("equityPeak")) ?? b.equity, b.equity);
    await repo.setState("equityPeak", peak);
    const today = new Date(now).toISOString().slice(0, 10);
    const day = await repo.getState<DayStart>("dayStart");
    if (!day || day.day !== today) await repo.setState<DayStart>("dayStart", { day: today, equity: b.equity });
    const bucket = Math.floor(now / 900_000) * 900_000; // one equity point per 15 minutes
    await repo.recordEquity(bucket, b.equity);
    if (peak > 0 && (peak - b.equity) / peak >= cfg.maxDrawdown) {
      await this.tripKillSwitch(`Max drawdown reached: equity ${b.equity.toFixed(2)} vs peak ${peak.toFixed(2)}`);
    }
  }

  /** Never throws: a logging failure must not abort position handling. */
  private async event(level: "info" | "warn" | "error", kind: string, symbol: string | null, message: string, data?: unknown) {
    try {
      await this.d.repo.recordEvent({ level, kind, symbol, message, data, createdAt: this.now() });
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "event write failed", kind, symbol, message, error: errMsg(e) }));
    }
  }

  /** Never throws and never blocks trading for long (the notifier has its own timeout). */
  private async notify(level: "info" | "warn" | "error", text: string) {
    try {
      await this.d.notifier.send(level, text);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "notify failed", text, error: errMsg(e) }));
    }
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
