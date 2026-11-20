// Live engine for weight strategies (G-LS): once per daily close, compute target weights with
// the SAME WeightStrategy object the backtest uses, then trade each symbol to its target.
// Rules, mirroring src/backtest/weights.ts where possible:
//  * The decision is for the daily candle that just closed (by the clock, not by one symbol's
//    data). It waits up to `waitForDataMs` for every configured symbol's candle, so the strategy
//    sees the same universe as the backtest; after that it proceeds with what it has and logs it.
//  * If the close is more than `maxDecisionDelayMs` old (e.g. the engine was down), that day is
//    skipped rather than traded at a stale price.
//  * A no-trade band skips adjustments smaller than band x equity; closing always trades.
//  * Reductions (including closing the old side of a flip) go first to free margin, then opens.
//  * Client ids are derived from the decision candle and the intended quantity, so a retried tick
//    cannot double-trade, and a different remaining quantity gets a new id.
//  * The day is marked done only when every leg succeeded; failed legs are retried every tick
//    until the decision window closes.
//  * Every open position carries an exchange-side catastrophic stop (catastrophicAtr x daily ATR,
//    never more than half the price away). Stops are checked every tick, per symbol and isolated
//    from rebalance errors. A stop that would trigger immediately is re-based on the latest price;
//    if a stop still cannot be placed the position is closed at market; if that fails too the
//    kill switch turns on.
//  * Kill switch or max drawdown: flatten everything and stop trading until a human resets it.
//  * No gate is added to src/risk/gates.ts: exposure is set by the strategy's volatility target and
//    gross cap (G-LS: maxGross 2), which must not exceed MAX_LEVERAGE (checked at start).
import { atr } from "../core/indicators.js";
import type { Candle } from "../core/types.js";
import type { Repo } from "../db/repo.js";
import { closingSide, type Exchange, type StopOrder } from "../exchange/types.js";
import type { Notifier } from "../notify/notifier.js";
import { floorToStep, roundToStep } from "../risk/precision.js";
import type { WeightStrategy } from "../strategy/weights.js";
import { CATASTROPHIC_ATR, CATASTROPHIC_ATR_PERIOD } from "../strategy/donchianEnsemble.js";
import { clientId } from "./engine.js";

export interface WeightsEngineConfig {
  symbols: string[];
  maxLeverage: number;
  /** No-trade band as a fraction of equity (backtest default 0.02). */
  band: number;
  catastrophicAtr: number;
  maxDrawdown: number;
  maxDecisionDelayMs: number;
  /** How long after the close to wait for every symbol's candle before trading without it. */
  waitForDataMs: number;
  /** Daily candles fetched per symbol; must cover the strategy's longest lookback. */
  history: number;
}

export const DEFAULT_WEIGHTS_ENGINE: Omit<WeightsEngineConfig, "symbols" | "maxLeverage" | "maxDrawdown"> = {
  band: 0.02, catastrophicAtr: CATASTROPHIC_ATR, maxDecisionDelayMs: 3 * 3_600_000, waitForDataMs: 30 * 60_000, history: 1000,
};

export interface WeightsEngineDeps {
  exchange: Exchange;
  repo: Repo;
  notifier: Notifier;
  strategy: WeightStrategy;
  cfg: WeightsEngineConfig;
  now?: () => number;
}

interface KillSwitch { on: boolean; reason: string; at: number; source: string }
/** Per symbol: reference close and ATR of the last decision, used to place catastrophic stops. */
type StopRefs = Record<string, { price: number; atr: number }>;

const DAY = 86_400_000;
const PREFIX = "te-";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const signedQty = (p: { side: "LONG" | "SHORT"; quantity: number } | null) => (p ? (p.side === "LONG" ? p.quantity : -p.quantity) : 0);
/** Binance -2021 / paper: a stop that would trigger immediately. */
const wouldTriggerNow = (e: unknown) => /-2021|immediately trigger/i.test(errMsg(e));
/** Short, stable tag of an intended quantity for client ids (4 base36 chars). */
const qtyTag = (qty: number, step: number) => (Math.round(qty / step) % 1_679_616).toString(36);

export class WeightsEngine {
  private readonly now: () => number;
  constructor(private readonly d: WeightsEngineDeps) {
    if (!d.cfg.symbols.length) throw new Error("weights engine needs at least one symbol");
    this.now = d.now ?? Date.now;
  }

  async tick(): Promise<void> {
    const { exchange: ex, repo, cfg } = this.d;
    let balanceOk = true;
    try {
      const balance = await ex.getBalance();
      await this.trackEquity(balance.equity);
    } catch (e) {
      // Protection first: without a balance, still honour the kill switch and check stops (as Engine does).
      balanceOk = false;
      await this.event("error", "BALANCE_ERROR", null, errMsg(e));
    }
    const kill = (await repo.getState<KillSwitch>("killSwitch"))?.on ?? false;
    if (kill) {
      await this.flattenAll();
      return;
    }
    if (!balanceOk) {
      await this.ensureStops();
      return;
    }
    // The daily candle that closed most recently (UTC days, as on Binance).
    const t = Math.floor(this.now() / DAY) * DAY - DAY;
    const closeTime = t + DAY - 1;
    const done = await repo.getState<number>("lastRebalance");
    if (t !== done) {
      if (this.now() - closeTime > cfg.maxDecisionDelayMs) {
        await repo.setState("lastRebalance", t);
        await this.event("warn", "REBALANCE_SKIPPED", null, `daily close ${new Date(closeTime + 1).toISOString()} not traded within ${cfg.maxDecisionDelayMs / 3_600_000}h; waiting for the next one`);
      } else {
        try {
          if (await this.rebalance(t)) await repo.setState("lastRebalance", t);
        } catch (e) {
          // Retried next tick; stops are still checked below.
          await this.event("error", "REBALANCE_FAILED", null, errMsg(e));
        }
      }
    }
    await this.ensureStops();
  }

  /**
   * Trade every symbol to the strategy's target weight for the daily candle opening at `t`.
   * Returns true when the decision is complete (every leg traded or nothing to do), false when
   * it should be retried (data not in yet, or a leg failed).
   */
  async rebalance(t: number): Promise<boolean> {
    const { exchange: ex, repo, cfg, strategy } = this.d;
    const candles: Record<string, Candle[]> = {};
    const missing: string[] = [];
    for (const s of cfg.symbols) {
      const c = await ex.getClosedCandles(s, "1d", cfg.history);
      if (c.at(-1)?.openTime === t) candles[s] = c;
      else missing.push(s);
    }
    if (missing.length) {
      if (this.now() - (t + DAY) < cfg.waitForDataMs) return false; // wait for the full universe
      await this.event("warn", "DATA_MISSING", null, `no ${new Date(t).toISOString().slice(0, 10)} candle for ${missing.join(",")}; trading without them`);
    }
    if (!Object.keys(candles).length) return false;
    const w = strategy.weightSeries({ candles, funding: {} }).get(t);
    if (!w) {
      await this.event("warn", "NO_WEIGHTS", null, `strategy returned no weights for ${new Date(t).toISOString()}`);
      return true;
    }
    const equity = (await ex.getBalance()).equity;
    const refs: StopRefs = {};
    type Leg = { symbol: string; cur: number; target: number; price: number };
    const legs: Leg[] = [];
    for (const s of Object.keys(candles)) {
      const c = candles[s]!;
      const price = c.at(-1)!.close;
      const a = atr(c, CATASTROPHIC_ATR_PERIOD).at(-1)!;
      if (Number.isFinite(a) && a > 0) refs[s] = { price, atr: a };
      legs.push({ symbol: s, cur: signedQty(await ex.getPosition(s)), target: ((w[s] ?? 0) * equity) / price, price });
    }
    await repo.setState<StopRefs>("stopRefs", { ...((await repo.getState<StopRefs>("stopRefs")) ?? {}), ...refs });

    let ok = true;
    const traded: string[] = [];
    // Pass 1: reductions and the closing half of flips.
    for (const l of legs) {
      const flip = l.cur !== 0 && l.target !== 0 && Math.sign(l.cur) !== Math.sign(l.target);
      const reduce = l.cur !== 0 && (l.target === 0 || flip || Math.abs(l.target) < Math.abs(l.cur));
      if (!reduce) continue;
      const closeAll = l.target === 0 || flip;
      const qty = closeAll ? Math.abs(l.cur) : Math.abs(l.cur) - Math.abs(l.target);
      if (!closeAll && qty * l.price < cfg.band * equity) continue;
      const r = await this.order(l.symbol, l.cur > 0 ? "SELL" : "BUY", qty, l.price, true, t, closeAll ? "Wc" : "Wr", closeAll);
      if (r === "filled") traded.push(`${l.symbol} ${closeAll ? "close" : "reduce"}`);
      else if (r === "failed") ok = false;
    }
    // Pass 2: opens and increases, from the position actually held now.
    for (const l of legs) {
      if (l.target === 0) continue;
      const cur = signedQty(await ex.getPosition(l.symbol));
      const sameSide = cur === 0 || Math.sign(cur) === Math.sign(l.target);
      if (!sameSide) { ok = false; continue; } // the flip's close failed: retry next tick
      if (Math.abs(l.target) <= Math.abs(cur)) continue;
      const qty = Math.abs(l.target) - Math.abs(cur);
      if (qty * l.price < cfg.band * equity) continue;
      await ex.prepareSymbol(l.symbol, cfg.maxLeverage);
      const r = await this.order(l.symbol, l.target > 0 ? "BUY" : "SELL", qty, l.price, false, t, "Wo", false);
      if (r === "filled") traded.push(`${l.symbol} ${l.target > 0 ? "long" : "short"} to ${((w[l.symbol] ?? 0) * 100).toFixed(1)}%`);
      else if (r === "failed") ok = false;
    }
    const gross = Object.values(w).reduce((x, v) => x + Math.abs(v), 0);
    await this.event(ok ? "info" : "warn", ok ? "REBALANCE" : "REBALANCE_INCOMPLETE", null,
      `${new Date(t).toISOString().slice(0, 10)}: gross ${(gross * 100).toFixed(0)}%, ${traded.length} orders${ok ? "" : ", retrying failed legs"}`, { weights: w, traded });
    if (traded.length) await this.notify("info", `Rebalance ${new Date(t).toISOString().slice(0, 10)}: ${traded.join(", ")}`);
    return ok;
  }

  /**
   * Market order rounded to the exchange step. "skipped" means below the exchange minimums
   * (nothing to retry); "failed" means rejected or errored (retry).
   */
  private async order(symbol: string, side: "BUY" | "SELL", rawQty: number, price: number, reduceOnly: boolean, t: number, tag: string, closeAll: boolean): Promise<"filled" | "skipped" | "failed"> {
    const ex = this.d.exchange;
    try {
      const f = await ex.getFilters(symbol);
      let qty = floorToStep(rawQty, f.marketStepSize);
      if (closeAll) qty = Math.max(qty, rawQty); // the full position is already on the step
      if (!(qty >= f.minQty)) return "skipped";
      if (!reduceOnly && qty * price < f.minNotional) {
        await this.event("info", "ORDER_TOO_SMALL", symbol, `${side} ${qty} below min notional ${f.minNotional}`);
        return "skipped";
      }
      const id = clientId(symbol, t, `${tag}${qtyTag(qty, f.marketStepSize)}`);
      const fill = await ex.marketOrder({ symbol, side, quantity: qty, reduceOnly, clientOrderId: id });
      if (fill.status === "REJECTED" || fill.executedQty <= 0) {
        await this.event("warn", "ORDER_REJECTED", symbol, `${side} ${qty} (${id}) rejected`);
        return "failed";
      }
      if (fill.executedQty < qty - 1e-12) {
        // Partially filled: the day stays open and the remainder is retried with a new client id
        // (the quantity tag differs), computed from the position actually held.
        await this.event("warn", "PARTIAL_FILL", symbol, `${side} ${fill.executedQty} of ${qty} (${id})`);
        return "failed";
      }
      return "filled";
    } catch (e) {
      await this.event("error", "ORDER_FAILED", symbol, `${side} ${rawQty} failed: ${errMsg(e)}`);
      return "failed";
    }
  }

  /** Every open position must have exactly one of our stops covering its full quantity. */
  async ensureStops(): Promise<void> {
    const refs = (await this.d.repo.getState<StopRefs>("stopRefs")) ?? {};
    for (const s of this.d.cfg.symbols) {
      try {
        await this.ensureStop(s, refs[s]);
      } catch (e) {
        // Isolated per symbol: one failing symbol must not leave the others unprotected.
        await this.event("error", "STOP_CHECK_FAILED", s, errMsg(e));
      }
    }
  }

  private async ensureStop(s: string, ref: { price: number; atr: number } | undefined): Promise<void> {
    const { exchange: ex, cfg } = this.d;
    const pos = await ex.getPosition(s);
    const ours = (await ex.getOpenStops(s)).filter((x) => x.clientId.startsWith(PREFIX));
    if (!pos) {
      await this.cancel(s, ours);
      return;
    }
    const side = closingSide(pos.side);
    const good = ours.filter((x) => x.side === side && Math.abs(x.quantity - pos.quantity) < 1e-12);
    if (good.length === 1 && ours.length === 1) return;
    await this.cancel(s, ours);
    const f = await ex.getFilters(s);
    const priceAt = (base: number) => {
      // Never more than half the price away, so a long stop stays positive.
      const dist = Math.min(ref ? cfg.catastrophicAtr * ref.atr : base * 0.15, base * 0.5);
      return roundToStep(pos.side === "LONG" ? base - dist : base + dist, f.tickSize);
    };
    const place = (stopPrice: number) =>
      ex.placeStop({ symbol: s, side, quantity: pos.quantity, stopPrice, clientId: clientId(s, this.now(), "C") });
    let stopPrice = priceAt(ref?.price ?? pos.entryPrice);
    try {
      await place(stopPrice);
      return;
    } catch (e) {
      if (!wouldTriggerNow(e)) {
        await this.event("error", "STOP_FAILED", s, `stop @ ${stopPrice} failed: ${errMsg(e)}; closing at market`);
        await this.closeAtMarket(s, "STOP_PLACEMENT_FAILED");
        return;
      }
    }
    // The reference price is stale (the market moved past the stop): re-base on the latest price.
    const last = (await ex.getClosedCandles(s, "1m", 1)).at(-1)?.close;
    stopPrice = last ? priceAt(last) : stopPrice;
    try {
      await place(stopPrice);
      await this.event("warn", "STOP_REBASED", s, `stop re-based on latest price ${last}: ${stopPrice}`);
    } catch (e) {
      await this.event("error", "STOP_FAILED", s, `stop @ ${stopPrice} failed: ${errMsg(e)}; closing at market`);
      await this.closeAtMarket(s, "STOP_PLACEMENT_FAILED");
    }
  }

  private async flattenAll(): Promise<void> {
    for (const s of this.d.cfg.symbols) {
      try {
        if (await this.d.exchange.getPosition(s)) await this.closeAtMarket(s, "KILL_SWITCH");
      } catch (e) {
        await this.event("error", "FLATTEN_FAILED", s, errMsg(e));
      }
    }
  }

  private async closeAtMarket(symbol: string, reason: string): Promise<void> {
    const ex = this.d.exchange;
    try {
      const pos = await ex.getPosition(symbol);
      if (!pos) return;
      const fill = await ex.marketOrder({
        symbol, side: closingSide(pos.side), quantity: pos.quantity, reduceOnly: true,
        clientOrderId: clientId(symbol, this.now(), "X"),
      });
      if (fill.status === "REJECTED" || fill.executedQty < pos.quantity - 1e-12) throw new Error(`close ${fill.status}, filled ${fill.executedQty} of ${pos.quantity}`);
      await this.cancel(symbol, (await ex.getOpenStops(symbol)).filter((x) => x.clientId.startsWith(PREFIX)));
      await this.notify("warn", `${symbol} closed at market (${reason}) @ ${fill.avgPrice}`);
    } catch (e) {
      await this.tripKillSwitch(`${symbol}: market close failed (${reason}): ${errMsg(e)}`);
    }
  }

  private async cancel(symbol: string, stops: StopOrder[]): Promise<void> {
    for (const s of stops) {
      try {
        await this.d.exchange.cancelStop(symbol, s.id);
      } catch (e) {
        await this.event("warn", "CANCEL_STOP_FAILED", symbol, errMsg(e));
      }
    }
  }

  private async trackEquity(equity: number): Promise<void> {
    const { repo, cfg } = this.d;
    // A null peak (reset when the kill switch is turned off via the API) is re-seeded from equity.
    const peak = Math.max((await repo.getState<number>("equityPeak")) ?? equity, equity);
    await repo.setState("equityPeak", peak);
    await repo.recordEquity(Math.floor(this.now() / 900_000) * 900_000, equity);
    if (peak > 0 && (peak - equity) / peak >= cfg.maxDrawdown) {
      await this.tripKillSwitch(`Max drawdown reached: equity ${equity.toFixed(2)} vs peak ${peak.toFixed(2)}`);
    }
  }

  private async tripKillSwitch(reason: string): Promise<void> {
    const cur = await this.d.repo.getState<KillSwitch>("killSwitch");
    if (cur?.on) return;
    await this.d.repo.setState<KillSwitch>("killSwitch", { on: true, reason, at: this.now(), source: "engine" });
    await this.event("error", "KILL_SWITCH", null, reason);
    await this.notify("error", `KILL SWITCH ON: ${reason}`);
  }

  private async event(level: "info" | "warn" | "error", kind: string, symbol: string | null, message: string, data?: unknown) {
    try {
      await this.d.repo.recordEvent({ level, kind, symbol, message, data, createdAt: this.now() });
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "event write failed", kind, symbol, message, error: errMsg(e) }));
    }
  }

  private async notify(level: "info" | "warn" | "error", text: string) {
    try {
      await this.d.notifier.send(level, text);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "notify failed", text, error: errMsg(e) }));
    }
  }
}
