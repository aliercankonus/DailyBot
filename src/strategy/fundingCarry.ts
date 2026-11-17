// Strategy H: cross-sectional funding carry, dollar-neutral, daily decisions.
// Rank coins by their average funding rate over the last `lookbackDays`. Long the cheapest
// `legFraction` (lowest funding: shorts are crowded / longs get paid), short the most expensive
// `legFraction` (highest funding: longs crowded / shorts get paid). Equal weight within each leg,
// total gross = `gross` of equity, long and short legs equal (market-neutral in dollars).
// Evidence is weak (practitioner research; see PROGRESS.md). Survivorship: today's liquid universe.
import type { FundingPoint } from "../exchange/types.js";
import type { WeightInputs, WeightStrategy } from "./weights.js";

export interface FundingCarryParams {
  lookbackDays: number;
  legFraction: number;
  gross: number;
  rebalanceEvery: number;
}

export const DEFAULT_FUNDING_CARRY: FundingCarryParams = {
  lookbackDays: 7,
  legFraction: 1 / 3,
  gross: 1,
  rebalanceEvery: 7,
};

const DAY = 86_400_000;

/** Average of funding rates with time in (endMs - windowMs, endMs]. Null if too few settlements. */
export function windowAverage(pts: FundingPoint[], endMs: number, windowMs: number, minCount: number): number | null {
  // pts sorted by time; binary search the window bounds
  const upper = upperBound(pts, endMs);
  const lower = upperBound(pts, endMs - windowMs);
  const n = upper - lower;
  if (n < minCount) return null;
  let sum = 0;
  for (let i = lower; i < upper; i++) sum += pts[i]!.rate;
  return sum / n;
}

/** First index with time > x. */
function upperBound(pts: FundingPoint[], x: number): number {
  let lo = 0, hi = pts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]!.time <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function createFundingCarry(p: FundingCarryParams = DEFAULT_FUNDING_CARRY): WeightStrategy {
  return {
    name: `funding-carry(${p.lookbackDays}d avg, legs ${(p.legFraction * 100).toFixed(0)}%, gross ${p.gross}, every ${p.rebalanceEvery}d)`,
    interval: "1d",
    needsFunding: true,
    rebalanceEvery: p.rebalanceEvery,

    weightSeries({ candles, funding }: WeightInputs) {
      const sorted: Record<string, FundingPoint[]> = {};
      for (const [s, pts] of Object.entries(funding)) sorted[s] = [...pts].sort((a, b) => a.time - b.time);
      const times = new Set<number>();
      const closeAt = new Map<string, Map<number, number>>(); // symbol -> openTime -> closeTime
      for (const [s, cs] of Object.entries(candles)) {
        closeAt.set(s, new Map(cs.map((c) => [c.openTime, c.closeTime])));
        for (const c of cs) times.add(c.openTime);
      }
      const minCount = Math.max(1, Math.floor(p.lookbackDays * 3 * 0.8));
      const out = new Map<number, Record<string, number>>();
      for (const t of [...times].sort((a, b) => a - b)) {
        const ranked: { s: string; f: number }[] = [];
        for (const s of Object.keys(candles)) {
          const close = closeAt.get(s)!.get(t);
          const pts = sorted[s];
          if (close === undefined || !pts) continue;
          const f = windowAverage(pts, close, p.lookbackDays * DAY, minCount);
          if (f !== null) ranked.push({ s, f });
        }
        const k = Math.floor(ranked.length * p.legFraction);
        if (k < 1) continue;
        ranked.sort((a, b) => a.f - b.f);
        const w: Record<string, number> = {};
        for (const { s } of ranked.slice(0, k)) w[s] = p.gross / 2 / k;
        for (const { s } of ranked.slice(-k)) w[s] = -p.gross / 2 / k;
        out.set(t, w);
      }
      return out;
    },
  };
}
