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
export function perturbParam(key: string, base: number, factor: number): number {
  return INTEGER_PARAM_KEYS.has(key) ? Math.max(1, Math.round(base * factor)) : base * factor;
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
