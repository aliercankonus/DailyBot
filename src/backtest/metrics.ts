import type { BacktestResult, BacktestTrade } from "./engine.js";

export interface Metrics {
  trades: number;
  winRate: number;
  profitFactor: number;
  expectancyR: number;
  avgWinR: number;
  avgLossR: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  totalFees: number;
  totalFunding: number;
  longs: number;
  shorts: number;
}

export function computeMetrics(res: BacktestResult, initialEquity: number): Metrics {
  const t = res.trades;
  const wins = t.filter((x) => x.netPnl > 0);
  const losses = t.filter((x) => x.netPnl <= 0);
  const grossWin = wins.reduce((a, x) => a + x.netPnl, 0);
  const grossLoss = -losses.reduce((a, x) => a + x.netPnl, 0);
  let peak = initialEquity;
  let maxDd = 0;
  for (const p of res.equityCurve) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equity) / peak);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    trades: t.length,
    winRate: t.length ? wins.length / t.length : 0,
    // No losses: Infinity when there are wins, 0 when there are no trades. Never NaN.
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancyR: mean(t.map((x) => x.r)),
    avgWinR: mean(wins.map((x) => x.r)),
    avgLossR: mean(losses.map((x) => x.r)),
    netReturnPct: initialEquity > 0 ? (res.finalEquity - initialEquity) / initialEquity : 0,
    maxDrawdownPct: maxDd,
    totalFees: t.reduce((a, x) => a + x.fees, 0),
    totalFunding: t.reduce((a, x) => a + x.funding, 0),
    longs: t.filter((x) => x.side === "LONG").length,
    shorts: t.filter((x) => x.side === "SHORT").length,
  };
}

/** Acceptance gate from docs/PLAN.md, evaluated on OUT-OF-SAMPLE results only. */
export const ACCEPTANCE = { minTrades: 100, minProfitFactor: 1.3, minExpectancyR: 0.3, maxDrawdownPct: 0.2 };

export function acceptance(m: Metrics): { pass: boolean; failures: string[] } {
  const f: string[] = [];
  if (m.trades < ACCEPTANCE.minTrades) f.push(`trades ${m.trades} < ${ACCEPTANCE.minTrades}`);
  if (m.profitFactor < ACCEPTANCE.minProfitFactor) f.push(`profit factor ${m.profitFactor.toFixed(2)} < ${ACCEPTANCE.minProfitFactor}`);
  if (m.expectancyR < ACCEPTANCE.minExpectancyR) f.push(`expectancy ${m.expectancyR.toFixed(2)}R < ${ACCEPTANCE.minExpectancyR}R`);
  if (m.maxDrawdownPct > ACCEPTANCE.maxDrawdownPct) f.push(`max drawdown ${(m.maxDrawdownPct * 100).toFixed(1)}% > ${ACCEPTANCE.maxDrawdownPct * 100}%`);
  return { pass: f.length === 0, failures: f };
}

/**
 * Consistency check across calendar years of a trade list: every year with trades must have a
 * profit factor above 1. Guards against one lucky period carrying the whole result, which matters
 * more the more strategies are tried on the same data.
 */
export function yearlyConsistency(trades: BacktestTrade[]): { year: number; trades: number; profitFactor: number }[] {
  const out: { year: number; trades: number; profitFactor: number }[] = [];
  for (const [year, ts] of groupBy(trades, (t) => new Date(t.entryTime).getUTCFullYear())) {
    const win = ts.filter((t) => t.netPnl > 0).reduce((a, t) => a + t.netPnl, 0);
    const loss = -ts.filter((t) => t.netPnl <= 0).reduce((a, t) => a + t.netPnl, 0);
    out.push({ year, trades: ts.length, profitFactor: loss > 0 ? win / loss : win > 0 ? Infinity : 0 });
  }
  return out.sort((a, b) => a.year - b.year);
}

export function groupBy<K extends string | number>(trades: BacktestTrade[], key: (t: BacktestTrade) => K) {
  const out = new Map<K, BacktestTrade[]>();
  for (const t of trades) out.set(key(t), [...(out.get(key(t)) ?? []), t]);
  return out;
}

/** Profit factor for display: "inf" when there are wins and no losses. */
export function formatProfitFactor(pf: number): string {
  return Number.isFinite(pf) ? pf.toFixed(2) : pf > 0 ? "inf" : "n/a";
}

/** Strategy parameters that are bar counts and must stay integers when perturbed. */
export const INTEGER_PARAM_KEYS: ReadonlySet<string> = new Set(["entryLookback", "emaFast", "emaSlow", "atrPeriod"]);

/**
 * Robustness sweep value for one parameter: integer periods are rounded (min 1);
 * multipliers such as stopAtr/trailAtr are scaled unrounded, even if their base is a whole number.
 */
export function perturbParam(key: string, base: number, factor: number, integerKeys: ReadonlySet<string> = INTEGER_PARAM_KEYS): number {
  return integerKeys.has(key) ? Math.max(1, Math.round(base * factor)) : base * factor;
}

export function formatMetrics(m: Metrics): string {
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  return [
    `trades        ${m.trades} (long ${m.longs} / short ${m.shorts})`,
    `win rate      ${pct(m.winRate)}`,
    `profit factor ${formatProfitFactor(m.profitFactor)}`,
    `expectancy    ${m.expectancyR.toFixed(3)} R  (avg win ${m.avgWinR.toFixed(2)}R, avg loss ${m.avgLossR.toFixed(2)}R)`,
    `net return    ${pct(m.netReturnPct)}`,
    `max drawdown  ${pct(m.maxDrawdownPct)}`,
    `fees/funding  ${m.totalFees.toFixed(2)} / ${m.totalFunding.toFixed(2)} USDT`,
  ].join("\n");
}

export interface EquityMetrics {
  cagr: number;
  annualVol: number;
  sharpe: number;
  maxDrawdownPct: number;
  /** Calendar-year returns (UTC) keyed by year. */
  yearly: { year: number; ret: number; maxDd: number }[];
}

/**
 * Metrics from an equity curve, comparable across strategies with any bar interval:
 * the curve is resampled to the last point of each UTC day.
 */
export function equityMetrics(curve: { time: number; equity: number }[]): EquityMetrics {
  const daily = new Map<number, number>();
  for (const p of curve) daily.set(Math.floor(p.time / 86_400_000), p.equity);
  const days = [...daily.entries()].sort((a, b) => a[0] - b[0]);
  if (days.length < 2) return { cagr: 0, annualVol: 0, sharpe: 0, maxDrawdownPct: 0, yearly: [] };
  const rets: number[] = [];
  for (let i = 1; i < days.length; i++) rets.push(days[i]![1] / days[i - 1]![1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const years = (days.at(-1)![0] - days[0]![0]) / 365;
  const total = days.at(-1)![1] / days[0]![1];
  let peak = days[0]![1];
  let maxDd = 0;
  const yearly = new Map<number, { start: number; end: number; peak: number; maxDd: number }>();
  let prevEq = days[0]![1];
  for (const [d, eq] of days) {
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
    const y = new Date(d * 86_400_000).getUTCFullYear();
    const cur = yearly.get(y) ?? { start: prevEq, end: eq, peak: prevEq, maxDd: 0 };
    cur.end = eq;
    cur.peak = Math.max(cur.peak, eq);
    cur.maxDd = Math.max(cur.maxDd, (cur.peak - eq) / cur.peak);
    yearly.set(y, cur);
    prevEq = eq;
  }
  return {
    cagr: years > 0 && total > 0 ? total ** (1 / years) - 1 : 0,
    annualVol: sd * Math.sqrt(365),
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    maxDrawdownPct: maxDd,
    yearly: [...yearly.entries()].map(([year, v]) => ({ year, ret: v.end / v.start - 1, maxDd: v.maxDd })),
  };
}

/** Acceptance for weight (portfolio) strategies, judged on the out-of-sample equity curve. */
export const EQUITY_ACCEPTANCE = { minSharpe: 1.0, maxDrawdownPct: 0.2 };

export function equityAcceptance(m: EquityMetrics): { pass: boolean; failures: string[] } {
  const f: string[] = [];
  if (m.sharpe < EQUITY_ACCEPTANCE.minSharpe) f.push(`Sharpe ${m.sharpe.toFixed(2)} < ${EQUITY_ACCEPTANCE.minSharpe}`);
  if (m.maxDrawdownPct > EQUITY_ACCEPTANCE.maxDrawdownPct) f.push(`max drawdown ${(m.maxDrawdownPct * 100).toFixed(1)}% > ${EQUITY_ACCEPTANCE.maxDrawdownPct * 100}%`);
  for (const y of m.yearly) if (!(y.ret > 0)) f.push(`year ${y.year} return ${(y.ret * 100).toFixed(1)}% <= 0`);
  return { pass: f.length === 0, failures: f };
}

export function formatEquity(m: EquityMetrics): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return [
    `CAGR ${pct(m.cagr)}  vol ${pct(m.annualVol)}  Sharpe ${m.sharpe.toFixed(2)}  max DD ${pct(m.maxDrawdownPct)}`,
    `yearly: ${m.yearly.map((y) => `${y.year} ${y.ret >= 0 ? "+" : ""}${pct(y.ret)} (dd ${pct(y.maxDd)})`).join(" | ")}`,
  ].join("\n");
}
