// Backtester for weight strategies. Honest by construction:
//  * Weights decided at a bar's close are traded at the NEXT bar's open (slippage + taker fee on traded notional).
//  * A no-trade band skips tiny adjustments (turnover control); closing a position always trades.
//  * Equity is marked to market at every open and close. Funding is charged at every 8h settlement
//    on the position's notional with its real sign (longs pay positive funding) when history exists,
//    otherwise the flat conservative rate on |notional|.
//  * Symbols without a candle on a day keep their position and last price.
import type { Candle } from "../core/types.js";
import type { FundingPoint } from "../exchange/types.js";
import type { WeightStrategy } from "../strategy/weights.js";
import { settlementTimes, type BacktestConfig, type BacktestResult } from "./engine.js";

export interface WeightsBacktestStats {
  turnover: number; // total traded notional / average equity
  fees: number;
  funding: number;
  avgGross: number; // average gross exposure as a fraction of equity
}

const EIGHT_HOURS = 8 * 3_600_000;

export function runWeightsBacktest(
  strategy: WeightStrategy,
  data: Record<string, Candle[]>,
  cfg: BacktestConfig & { band?: number },
): BacktestResult & { stats: WeightsBacktestStats } {
  const band = cfg.band ?? 0.02;
  const symbols = Object.keys(data);
  const funding: Record<string, FundingPoint[]> = cfg.fundingRates ?? {};
  const weights = strategy.weightSeries({ candles: data, funding });
  const rateLookup = new Map<string, Map<number, number>>();
  for (const [s, pts] of Object.entries(funding)) {
    rateLookup.set(s, new Map(pts.map((f) => [Math.round(f.time / EIGHT_HOURS) * EIGHT_HOURS, f.rate])));
  }

  const byTime = new Map<number, Map<string, Candle>>();
  for (const s of symbols) for (const c of data[s]!) {
    if (!byTime.has(c.openTime)) byTime.set(c.openTime, new Map());
    byTime.get(c.openTime)!.set(s, c);
  }
  const timeline = [...byTime.keys()].sort((a, b) => a - b);

  let equity = cfg.initialEquity;
  const qty = new Map<string, number>();
  const last = new Map<string, number>();
  let pending: Record<string, number> | null = null;
  let barsSinceRebalance = Infinity;
  let traded = 0, fees = 0, fundingPaid = 0, grossSum = 0, eqSum = 0;
  const equityCurve: { time: number; equity: number }[] = [];

  for (const t of timeline) {
    const bars = byTime.get(t)!;
    // 1) Mark from the previous close to this open (gaps), then execute pending weights at the open.
    for (const [s, c] of bars) {
      const q = qty.get(s) ?? 0;
      const prev = last.get(s);
      if (q !== 0 && prev !== undefined) equity += q * (c.open - prev);
      last.set(s, c.open);
      // A settlement exactly at the open applies to the position held into it (before trading).
      if (q !== 0 && t % EIGHT_HOURS === 0) chargeFunding(s, q, c.open, t);
    }
    if (pending && t >= (cfg.tradeFromMs ?? -Infinity)) {
      for (const s of new Set([...Object.keys(pending), ...qty.keys()])) {
        const c = bars.get(s);
        if (!c) continue; // no market today: keep the position
        const target = (pending[s] ?? 0) * equity / c.open;
        const cur = qty.get(s) ?? 0;
        const delta = target - cur;
        const closing = target === 0 && cur !== 0;
        if (!closing && Math.abs(delta * c.open) < band * equity) continue;
        const notional = Math.abs(delta) * c.open;
        const cost = notional * (cfg.takerFee + cfg.slippage);
        equity -= cost;
        fees += cost;
        traded += notional;
        if (target === 0) qty.delete(s);
        else qty.set(s, target);
      }
      pending = null;
    }
    // 2) Funding settlements during the bar, then mark to the close.
    for (const [s, c] of bars) {
      const q = qty.get(s) ?? 0;
      if (q !== 0) {
        for (const st of settlementTimes(c.openTime, c.closeTime, c.openTime)) chargeFunding(s, q, c.open, st);
        equity += q * (c.close - c.open);
      }
      last.set(s, c.close);
    }
    let gross = 0;
    for (const [s, q] of qty) gross += Math.abs(q * (last.get(s) ?? 0));
    if (t >= (cfg.tradeFromMs ?? -Infinity)) {
      grossSum += equity > 0 ? gross / equity : 0;
      eqSum += 1;
    }
    equityCurve.push({ time: t, equity });
    // 3) Decide at this close; execute at the next open.
    barsSinceRebalance++;
    const w = weights.get(t);
    if (w && barsSinceRebalance >= strategy.rebalanceEvery) {
      pending = w;
      barsSinceRebalance = 0;
    }
    if (equity <= 0) break; // ruined
  }

  function chargeFunding(s: string, q: number, price: number, at: number) {
    const rates = rateLookup.get(s);
    const notional = q * price;
    const pay = rates ? notional * (rates.get(at) ?? 0) : Math.abs(notional) * cfg.fundingPer8h;
    equity -= pay;
    fundingPaid += pay;
  }

  const inWindow = equityCurve.filter((p) => p.time >= (cfg.tradeFromMs ?? -Infinity));
  const avgEq = inWindow.length ? inWindow.reduce((a, p) => a + p.equity, 0) / inWindow.length : cfg.initialEquity;
  return {
    trades: [],
    equityCurve,
    finalEquity: equity,
    stats: { turnover: traded / avgEq, fees, funding: fundingPaid, avgGross: eqSum ? grossSum / eqSum : 0 },
  };
}
