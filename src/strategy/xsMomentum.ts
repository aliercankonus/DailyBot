// Strategy E: cross-sectional momentum (rank coins by past return, long winners, short losers).
// Return = close[t-SKIP] / close[t-SKIP-lookback] - 1. SKIP = 1 drops the most recent bar to
// avoid the short-term reversal effect. Stops are catastrophic only (ATR 14 x stopAtr).
// Time-series gate (tsGate = 1): a long is only taken if the coin's own lookback return is > 0,
// a short only if < 0. Gated-out slots stay empty (no refill from the next ranks).
//
// SURVIVORSHIP BIAS: backtests run on today's liquid symbols. Coins that were delisted or died
// are missing, which flatters the short side (dead coins would have been great shorts... or
// untradeable) and the long side (today's survivors were by definition winners). Treat results
// as optimistic.
import { atr } from "../core/indicators.js";
import type { Candle } from "../core/types.js";
import type { PortfolioStrategy, PortfolioTarget } from "./portfolio.js";

export interface XsMomentumParams {
  lookback: number;
  topK: number;
  bottomK: number;
  rebalanceEvery: number;
  stopAtr: number;
  /** 1 = time-series gate on (long needs return > 0, short needs < 0), 0 = off. */
  tsGate: number;
}

export const DEFAULT_XS_MOMENTUM: XsMomentumParams = { lookback: 21, topK: 4, bottomK: 4, rebalanceEvery: 7, stopAtr: 3, tsGate: 1 };
const ATR_PERIOD = 14;
/** Bars excluded from the return (most recent close), to avoid short-term reversal. */
export const SKIP = 1;

export function createXsMomentum(p: XsMomentumParams = DEFAULT_XS_MOMENTUM): PortfolioStrategy {
  const warmup = Math.max(p.lookback + SKIP + 1, ATR_PERIOD + 1);
  return {
    name: "xsMomentum",
    interval: "1d",
    warmup,
    rebalanceEvery: p.rebalanceEvery,
    stopAtr: p.stopAtr,
    maxPositions: p.topK + p.bottomK,
    targets(bySymbol: Record<string, Candle[]>): PortfolioTarget[] {
      const ranked: { symbol: string; ret: number; close: number; atr: number }[] = [];
      for (const [symbol, c] of Object.entries(bySymbol)) {
        const n = c.length;
        if (n < warmup) continue;
        const ret = c[n - 1 - SKIP]!.close / c[n - 1 - SKIP - p.lookback]!.close - 1;
        const a = atr(c, ATR_PERIOD)[n - 1]!;
        if (!Number.isFinite(ret) || !(a > 0)) continue;
        ranked.push({ symbol, ret, close: c[n - 1]!.close, atr: a });
      }
      ranked.sort((x, y) => y.ret - x.ret || (x.symbol < y.symbol ? -1 : 1));
      let kL = p.topK;
      let kS = p.bottomK;
      if (kL + kS > ranked.length) {
        kL = Math.floor((ranked.length * p.topK) / (p.topK + p.bottomK));
        kS = Math.floor((ranked.length * p.bottomK) / (p.topK + p.bottomK));
      }
      const gate = p.tsGate >= 1;
      const out: PortfolioTarget[] = [];
      for (const r of ranked.slice(0, kL)) if (!gate || r.ret > 0) out.push({ symbol: r.symbol, side: "LONG", stop: r.close - p.stopAtr * r.atr });
      for (const r of ranked.slice(ranked.length - kS)) {
        if (!gate || r.ret < 0) out.push({ symbol: r.symbol, side: "SHORT", stop: r.close + p.stopAtr * r.atr });
      }
      return out;
    },
  };
}
