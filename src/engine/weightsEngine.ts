// Live engine for weight strategies (G-LS): once per daily close, compute target weights with
// the SAME WeightStrategy object the backtest uses, then trade each symbol to its target.
// Rules, mirroring src/backtest/weights.ts where possible:
//  * The decision uses closed daily candles only; it is executed right after the close. If the
//    engine sees a close more than `maxDecisionDelayMs` late (e.g. it was down), that day is
//    skipped rather than traded at a stale price.
//  * A no-trade band skips adjustments smaller than band x equity; closing always trades.
//  * Reductions (including closing the old side of a flip) go first to free margin, then opens.
//  * Every order has a deterministic client id derived from the decision candle, so a retried
//    tick cannot double-trade.
//  * Every open position carries an exchange-side catastrophic stop (catastrophicAtr x daily ATR
//    from the decision close). If a stop cannot be placed the position is closed at market; if
//    that also fails the kill switch turns on. The strategy's own exits happen through weights.
//  * Kill switch or max drawdown: flatten everything and stop trading until a human resets it.
import { atr } from "../core/indicators.js";
import type { Candle } from "../core/types.js";
import type { Repo } from "../db/repo.js";
import { closingSide, type Exchange, type StopOrder } from "../exchange/types.js";
import type { Notifier } from "../notify/notifier.js";
import { floorToStep, roundToStep } from "../risk/precision.js";
import type { WeightStrategy } from "../strategy/weights.js";
import { clientId } from "./engine.js";

export interface WeightsEngineConfig {
  symbols: string[];
  maxLeverage: number;
  /** No-trade band as a fraction of equity (backtest default 0.02). */
  band: number;
  catastrophicAtr: number;
  maxDrawdown: number;
  maxDecisionDelayMs: number;
  /** Daily candles fetched per symbol; must cover the strategy's longest lookback. */
  history: number;
}

export const DEFAULT_WEIGHTS_ENGINE: Omit<WeightsEngineConfig, "symbols" | "maxLeverage" | "maxDrawdown"> = {
  band: 0.02, catastrophicAtr: 4, maxDecisionDelayMs: 3 * 3_600_000, history: 1000,
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

const PREFIX = "te-";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const signedQty = (p: { side: "LONG" | "SHORT"; quantity: number } | null) => (p ? (p.side === "LONG" ? p.quantity : -p.quantity) : 0);

export class WeightsEngine {
  private readonly now: () => number;
  constructor(private readonly d: WeightsEngineDeps) {
    this.now = d.now ?? Date.now;
  }

  async tick(): Promise<void> {
    const { exchange: ex, repo, cfg } = this.d;
    const balance = await ex.getBalance();
    await this.trackEquity(balance.equity);
    const kill = (await repo.getState<KillSwitch>("killSwitch"))?.on ?? false;
    if (kill) {
      await this.flattenAll();
      return;
    }
    const ref = (await ex.getClosedCandles(cfg.symbols[0]!, "1d", 2)).at(-1);
    const done = await repo.getState<number>("lastRebalance");
    if (ref && ref.openTime !== done) {
      if (this.now() - ref.closeTime <= cfg.maxDecisionDelayMs) await this.rebalance(ref.openTime);
      else {
        await repo.setState("lastRebalance", ref.openTime);
        await this.event("warn", "REBALANCE_SKIPPED", null, `daily close ${new Date(ref.closeTime).toISOString()} seen too late; waiting for the next one`);
      }
    }
    await this.ensureStops();
  }

  /** Trade every symbol to the strategy's target weight for the daily candle opening at `t`. */
  async rebalance(t: number): Promise<void> {
    const { exchange: ex, repo, cfg, strategy } = this.d;
    const candles: Record<string, Candle[]> = {};
    for (const s of cfg.symbols) {
      const c = await ex.getClosedCandles(s, "1d", cfg.history);
      if (c.at(-1)?.openTime === t) candles[s] = c; // only symbols whose decision candle is in
    }
    const w = strategy.weightSeries({ candles, funding: {} }).get(t);
    if (!w) {
      await repo.setState("lastRebalance", t);
      await this.event("warn", "NO_WEIGHTS", null, `strategy returned no weights for ${new Date(t).toISOString()}`);
      return;
    }
    const equity = (await ex.getBalance()).equity;
    const refs: StopRefs = {};
    type Leg = { symbol: string; cur: number; target: number; price: number };
    const legs: Leg[] = [];
    for (const s of cfg.symbols) {
      const c = candles[s];
      const cur = signedQty(await ex.getPosition(s));
      if (!c) continue; // no fresh data: keep the position as it is (like the backtest)
      const price = c.at(-1)!.close;
      const a = atr(c, 14).at(-1)!;
      if (Number.isFinite(a) && a > 0) refs[s] = { price, atr: a };
      legs.push({ symbol: s, cur, target: ((w[s] ?? 0) * equity) / price, price });
    }
    await repo.setState<StopRefs>("stopRefs", { ...((await repo.getState<StopRefs>("stopRefs")) ?? {}), ...refs });

    const traded: string[] = [];
    // Pass 1: reductions and the closing half of flips.
    for (const l of legs) {
      const flip = l.cur !== 0 && l.target !== 0 && Math.sign(l.cur) !== Math.sign(l.target);
      const reduce = l.cur !== 0 && (l.target === 0 || flip || Math.abs(l.target) < Math.abs(l.cur));
      if (!reduce) continue;
      const closeAll = l.target === 0 || flip;
      const qty = closeAll ? Math.abs(l.cur) : Math.abs(l.cur) - Math.abs(l.target);
      if (!closeAll && qty * l.price < cfg.band * equity) continue;
      if (await this.order(l.symbol, l.cur > 0 ? "SELL" : "BUY", qty, true, clientId(l.symbol, t, closeAll ? "Wc" : "Wr"), closeAll)) {
        traded.push(`${l.symbol} ${closeAll ? "close" : "reduce"}`);
      }
    }
    // Pass 2: opens and increases, from the position actually held now.
    for (const l of legs) {
      if (l.target === 0) continue;
      const cur = signedQty(await ex.getPosition(l.symbol));
      const sameSide = cur === 0 || Math.sign(cur) === Math.sign(l.target);
      if (!sameSide || Math.abs(l.target) <= Math.abs(cur)) continue;
      const qty = Math.abs(l.target) - Math.abs(cur);
      if (qty * l.price < cfg.band * equity) continue;
      await ex.prepareSymbol(l.symbol, cfg.maxLeverage);
      if (await this.order(l.symbol, l.target > 0 ? "BUY" : "SELL", qty, false, clientId(l.symbol, t, "Wo"), false)) {
        traded.push(`${l.symbol} ${l.target > 0 ? "long" : "short"} to ${((w[l.symbol] ?? 0) * 100).toFixed(1)}%`);
      }
    }
    await repo.setState("lastRebalance", t);
    const gross = Object.values(w).reduce((x, v) => x + Math.abs(v), 0);
    await this.event("info", "REBALANCE", null, `${new Date(t).toISOString().slice(0, 10)}: gross ${(gross * 100).toFixed(0)}%, ${traded.length} orders`, { weights: w, traded });
    if (traded.length) await this.notify("info", `Rebalance ${new Date(t).toISOString().slice(0, 10)}: ${traded.join(", ")}`);
  }

  /** Market order rounded to the exchange step. Returns true if something filled. */
  private async order(symbol: string, side: "BUY" | "SELL", rawQty: number, reduceOnly: boolean, id: string, closeAll: boolean): Promise<boolean> {
    const ex = this.d.exchange;
    const f = await ex.getFilters(symbol);
    let qty = floorToStep(rawQty, f.marketStepSize);
    if (closeAll) qty = Math.max(qty, rawQty); // the full position is already on the step
    if (!(qty >= f.minQty)) return false;
    try {
      const fill = await ex.marketOrder({ symbol, side, quantity: qty, reduceOnly, clientOrderId: id });
      if (fill.status === "REJECTED" || fill.executedQty <= 0) {
        await this.event("warn", "ORDER_REJECTED", symbol, `${side} ${qty} (${id}) rejected`);
        return false;
      }
      return true;
    } catch (e) {
      await this.event("error", "ORDER_FAILED", symbol, `${side} ${qty} (${id}) failed: ${errMsg(e)}`);
      return false;
    }
  }

  /** Every open position must have exactly one of our stops covering its full quantity. */
  async ensureStops(): Promise<void> {
    const { exchange: ex, repo, cfg } = this.d;
    const refs = (await repo.getState<StopRefs>("stopRefs")) ?? {};
    for (const s of cfg.symbols) {
      const pos = await ex.getPosition(s);
      const ours = (await ex.getOpenStops(s)).filter((x) => x.clientId.startsWith(PREFIX));
      if (!pos) {
        await this.cancel(s, ours);
        continue;
      }
      const side = closingSide(pos.side);
      const good = ours.filter((x) => x.side === side && Math.abs(x.quantity - pos.quantity) < 1e-12);
      if (good.length === 1 && ours.length === 1) continue;
      await this.cancel(s, ours);
      const r = refs[s];
      const f = await ex.getFilters(s);
      const base = r?.price ?? pos.entryPrice;
      const dist = r ? cfg.catastrophicAtr * r.atr : base * 0.15; // no ATR yet: 15% catastrophic stop
      const stopPrice = roundToStep(pos.side === "LONG" ? base - dist : base + dist, f.tickSize);
      try {
        await ex.placeStop({ symbol: s, side, quantity: pos.quantity, stopPrice, clientId: clientId(s, this.now(), "C") });
      } catch (e) {
        await this.event("error", "STOP_FAILED", s, `stop @ ${stopPrice} failed: ${errMsg(e)}; closing at market`);
        await this.closeAtMarket(s, "STOP_PLACEMENT_FAILED");
      }
    }
  }

  private async flattenAll(): Promise<void> {
    for (const s of this.d.cfg.symbols) if (await this.d.exchange.getPosition(s)) await this.closeAtMarket(s, "KILL_SWITCH");
  }

  private async closeAtMarket(symbol: string, reason: string): Promise<void> {
    const ex = this.d.exchange;
    const pos = await ex.getPosition(symbol);
    if (!pos) return;
    try {
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
