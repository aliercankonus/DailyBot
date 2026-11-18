// Combine strategies at the portfolio level: each leg's equity curve is turned into daily
// returns (last point of each UTC day), and the portfolio earns the weighted sum of the legs'
// returns every day (daily rebalancing to fixed weights). Days on which a leg has no data count
// as a zero return for that leg.
const DAY = 86_400_000;

export type Curve = { time: number; equity: number }[];

export function dailyReturns(curve: Curve): Map<number, number> {
  const daily = new Map<number, number>();
  for (const p of curve) daily.set(Math.floor(p.time / DAY), p.equity);
  const days = [...daily.entries()].sort((a, b) => a[0] - b[0]);
  const out = new Map<number, number>();
  for (let i = 1; i < days.length; i++) out.set(days[i]![0], days[i]![1] / days[i - 1]![1] - 1);
  return out;
}

/** Weighted daily-rebalanced portfolio of the legs, as an equity curve starting at 1. */
export function blend(curves: Curve[], weights: number[]): Curve {
  const rets = curves.map(dailyReturns);
  const days = [...new Set(rets.flatMap((r) => [...r.keys()]))].sort((a, b) => a - b);
  if (!days.length) return [];
  let eq = 1;
  const out: Curve = [{ time: (days[0]! - 1) * DAY, equity: 1 }];
  for (const d of days) {
    eq *= 1 + rets.reduce((x, r, i) => x + weights[i]! * (r.get(d) ?? 0), 0);
    out.push({ time: d * DAY, equity: eq });
  }
  return out;
}

/** Pearson correlation of two legs' daily returns over the days both have. */
export function correlation(a: Curve, b: Curve): number {
  const ra = dailyReturns(a);
  const rb = dailyReturns(b);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [d, x] of ra) {
    const y = rb.get(d);
    if (y !== undefined) {
      xs.push(x);
      ys.push(y);
    }
  }
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** The part of a curve from `fromMs`, rebased to start at 1. */
export function rebaseFrom(curve: Curve, fromMs: number): Curve {
  const part = curve.filter((p) => p.time >= fromMs);
  const base = part[0]?.equity;
  return base ? part.map((p) => ({ time: p.time, equity: p.equity / base })) : [];
}
