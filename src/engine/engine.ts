// Live engine. One tick per minute:
//   1. reconcile every symbol (the exchange is the source of truth),
//   2. when a new candle has closed: trail the stop of an open position, or evaluate an entry.
// The same Strategy object is used by the backtester.
import type { Candle, OpenPositionView, Signal } from "../core/types.js";
import type { PositionRow, Repo } from "../db/repo.js";
import { closingSide, openingSide, type AccountBalance, type Exchange, type StopOrder } from "../exchange/types.js";
import { evaluateGates } from "../risk/gates.js";
import { sizePosition } from "../risk/sizing.js";
import type { Strategy } from "../strategy/types.js";
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

export interface KillSwitch { on: boolean; reason: string; at: number }
interface DayStart { day: string; equity: number }

const CLIENT_PREFIX = "te-";

/** Deterministic Binance client id (max 36 chars, [A-Za-z0-9._:/-]). Times are base36 to stay short. */
export function clientId(symbol: string, candleOpenTime: number, suffix: string): string {
  const id = `${CLIENT_PREFIX}${symbol}-${candleOpenTime.toString(36)}-${suffix}`;
  if (id.length > 36) throw new Error(`client id too long: ${id}`);
  return id;
}

export class Engine {
  private readonly now: () => number;
  private readonly newId: () => string;
  constructor(private readonly d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.newId = d.newId ?? (() => crypto.randomUUID());
  }

  // ---------- public ----------

  async tick(): Promise<void> {
    const balance = await this.d.exchange.getBalance();
    await this.trackEquity(balance);
    for (const symbol of this.d.cfg.symbols) {
      try {
        await this.reconcile(symbol);
        await this.onCandle(symbol, balance);
      } catch (e) {
        await this.event("error", "SYMBOL_ERROR", symbol, errMsg(e));
      }
    }
  }

  async setKillSwitch(on: boolean, reason: string): Promise<void> {
    await this.d.repo.setState<KillSwitch>("killSwitch", { on, reason, at: this.now() });
    await this.event(on ? "error" : "info", on ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF", null, reason);
    await this.d.notifier.send(on ? "error" : "info", `Kill switch ${on ? "ON" : "OFF"}: ${reason}`);
  }

  // ---------- reconciliation ----------

  /** Make the database agree with the exchange and make sure every open position has a stop. */
  async reconcile(symbol: string): Promise<void> {
    const ex = this.d.exchange;
    const [db, live] = await Promise.all([this.d.repo.getOpenPosition(symbol), ex.getPosition(symbol)]);

    if (!db && !live) {
      await this.cancelOurStops(symbol, await ex.getOpenStops(symbol));
      return;
    }

    if (db && !live) {
      // Closed on the exchange: stop hit, liquidation, or a manual close.
      const fills = await ex.getFills(symbol, db.entryTime);
      const exits = fills.filter((f) => f.side === closingSide(db.side));
      const qty = exits.reduce((a, f) => a + f.qty, 0);
      const exitPrice = qty > 0 ? exits.reduce((a, f) => a + f.price * f.qty, 0) / qty : db.stop;
      const realized = exits.reduce((a, f) => a + f.realizedPnl, 0);
      const fees = fills.reduce((a, f) => a + f.commission, 0);
      const exitTime = exits.at(-1)?.time ?? this.now();
      await this.d.repo.updatePosition(db.id, {
        status: "CLOSED", exitPrice, exitTime, exitReason: "EXCHANGE_CLOSE", realizedPnl: realized - fees, fees,
      });
      await this.cancelOurStops(symbol, await ex.getOpenStops(symbol));
      const msg = `${symbol} ${db.side} closed on exchange @ ${exitPrice.toFixed(4)}, pnl ${(realized - fees).toFixed(2)} USDT`;
      await this.event("info", "POSITION_CLOSED", symbol, msg);
      await this.d.notifier.send("info", msg);
      return;
    }

    if (!db && live) {
      await this.setKillSwitch(true, `Unknown ${live.side} position on ${symbol} (qty ${live.quantity}). Not opened by the bot; manual action required.`);
      return;
    }

    // Both exist.
    const pos = db!;
    const lp = live!;
    if (pos.side !== lp.side) {
      await this.setKillSwitch(true, `${symbol}: database says ${pos.side}, exchange says ${lp.side}.`);
      return;
    }
    if (Math.abs(pos.quantity - lp.quantity) > 1e-12) {
      await this.event("warn", "QTY_MISMATCH", symbol, `db ${pos.quantity} vs exchange ${lp.quantity}; adopting exchange quantity`);
      await this.d.repo.updatePosition(pos.id, { quantity: lp.quantity });
      pos.quantity = lp.quantity;
    }
    const stops = (await ex.getOpenStops(symbol)).filter((s) => s.side === closingSide(pos.side));
    const covered = stops.reduce((a, s) => a + s.quantity, 0) >= pos.quantity - 1e-12;
    if (!covered) {
      await this.event("warn", "STOP_MISSING", symbol, `no stop covers the position; placing one at ${pos.stop}`);
      await this.protectOrClose(pos, pos.stop, `R${this.now().toString(36)}`);
    }
  }

  // ---------- candle close ----------

  async onCandle(symbol: string, balance: AccountBalance): Promise<void> {
    const { cfg, strategy, exchange: ex, repo } = this.d;
    const candles = await ex.getClosedCandles(symbol, cfg.interval, strategy.warmup + 100);
    const last = candles.at(-1);
    if (!last) return;
    const lastKey = `lastProcessed:${symbol}`;
    const lastProcessed = (await repo.getState<number>(lastKey)) ?? 0;
    if (last.openTime <= lastProcessed) return;

    const pos = await repo.getOpenPosition(symbol);
    if (pos) {
      await this.trailStop(pos, candles);
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
      await repo.recordSignal({
        symbol, candleOpenTime: last.openTime, side: signal.side, accepted: gate.ok,
        gate: gate.ok ? null : gate.gate, detail: gate.ok ? signal.reason : gate.detail, createdAt: this.now(),
      });
    }
    if (gate.ok && signal) {
      // Throws on transient failure: lastProcessed is NOT advanced, so the next tick retries
      // (the deterministic client order id prevents a double entry).
      await this.enter(signal, balance, last);
    }
    await repo.setState(lastKey, last.openTime);
  }

  // ---------- orders ----------

  private async enter(signal: Signal, balance: AccountBalance, candle: Candle): Promise<void> {
    const { exchange: ex, cfg, repo, strategy } = this.d;
    const filters = await ex.getFilters(signal.symbol);
    const size = sizePosition({
      equity: balance.equity, availableBalance: balance.available, entryPrice: signal.refPrice,
      stopPrice: signal.stop, riskPerTrade: cfg.riskPerTrade, maxLeverage: cfg.maxLeverage, filters,
    });
    if (!size.ok) {
      await this.event("warn", "SIZING_REJECTED", signal.symbol, size.reason);
      return;
    }

    await ex.prepareSymbol(signal.symbol, size.leverage);
        const fill = await ex.marketOrder({
      symbol: signal.symbol, side: openingSide(signal.side), quantity: size.quantity, reduceOnly: false, clientOrderId: clientId(signal.symbol, candle.openTime, "E"),
    });
    if (!(fill.executedQty > 0)) {
      await this.event("warn", "ENTRY_NOT_FILLED", signal.symbol, `status ${fill.status}`);
      return;
    }

    // Keep the planned risk distance relative to the actual fill price.
    const dist = Math.abs(signal.refPrice - signal.stop);
    const stop = signal.side === "LONG" ? fill.avgPrice - dist : fill.avgPrice + dist;
    const row: PositionRow = {
      id: this.newId(), symbol: signal.symbol, side: signal.side, status: "OPEN",
      quantity: fill.executedQty, entryPrice: fill.avgPrice, entryTime: this.now(), entryCandleOpenTime: candle.openTime,
      initialStop: stop, stop, stopOrderId: null, leverage: size.leverage, riskAmount: dist * fill.executedQty,
      exitPrice: null, exitTime: null, exitReason: null, realizedPnl: null, fees: null, strategy: strategy.name,
    };
    // Persist BEFORE placing the stop: if we crash here, reconcile() finds the position and protects it.
    await repo.insertPosition(row);
    const msg = `${signal.symbol} ${signal.side} ${fill.executedQty} @ ${fill.avgPrice} | stop ${stop.toFixed(4)} | ${size.leverage}x | risk ${row.riskAmount.toFixed(2)} USDT`;
    await this.event("info", "POSITION_OPENED", signal.symbol, msg, { reason: signal.reason });
    await this.d.notifier.send("info", `Opened ${msg}`);
    await this.protectOrClose(row, stop, "S0");
  }

  private async trailStop(pos: PositionRow, candles: Candle[]): Promise<void> {
    const view: OpenPositionView = { side: pos.side, entryPrice: pos.entryPrice, stop: pos.stop, entryCandleOpenTime: pos.entryCandleOpenTime };
    const next = this.d.strategy.updateStop(view, candles);
    const tick = (await this.d.exchange.getFilters(pos.symbol)).tickSize;
    const improves = pos.side === "LONG" ? next >= pos.stop + tick : next <= pos.stop - tick;
    if (!improves) return;
    const old = pos.stopOrderId;
    const placed = await this.protectOrClose(pos, next, `S${candles.at(-1)!.openTime.toString(36)}`);
    if (placed && old && old !== placed.id) {
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

  async closeAtMarket(pos: PositionRow, reason: string): Promise<void> {
    const ex = this.d.exchange;
    try {
      const fill = await ex.marketOrder({
        symbol: pos.symbol, side: closingSide(pos.side), quantity: pos.quantity, reduceOnly: true,
        clientOrderId: clientId(pos.symbol, pos.entryCandleOpenTime, "X"),
      });
      await this.cancelOurStops(pos.symbol, await ex.getOpenStops(pos.symbol));
      const gross = (pos.side === "LONG" ? fill.avgPrice - pos.entryPrice : pos.entryPrice - fill.avgPrice) * fill.executedQty;
      await this.d.repo.updatePosition(pos.id, {
        status: "CLOSED", exitPrice: fill.avgPrice, exitTime: this.now(), exitReason: reason, realizedPnl: gross,
      });
      await this.d.notifier.send("warn", `${pos.symbol} closed at market (${reason}) @ ${fill.avgPrice}`);
    } catch (e) {
      // Could not close and could not protect: stop all trading and alert a human.
      await this.setKillSwitch(true, `${pos.symbol}: market close failed after stop failure: ${errMsg(e)}`);
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
    const peak = Math.max((await repo.getState<number>("equityPeak")) ?? b.equity, b.equity);
    await repo.setState("equityPeak", peak);
    const today = new Date(now).toISOString().slice(0, 10);
    const day = await repo.getState<DayStart>("dayStart");
    if (!day || day.day !== today) await repo.setState<DayStart>("dayStart", { day: today, equity: b.equity });
    const bucket = Math.floor(now / 900_000) * 900_000; // one equity point per 15 minutes
    await repo.recordEquity(bucket, b.equity);
    if (peak > 0 && (peak - b.equity) / peak >= cfg.maxDrawdown) {
      const ks = await repo.getState<KillSwitch>("killSwitch");
      if (!ks?.on) await this.setKillSwitch(true, `Max drawdown reached: equity ${b.equity.toFixed(2)} vs peak ${peak.toFixed(2)}`);
    }
  }

  private async event(level: "info" | "warn" | "error", kind: string, symbol: string | null, message: string, data?: unknown) {
    await this.d.repo.recordEvent({ level, kind, symbol, message, data, createdAt: this.now() });
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
