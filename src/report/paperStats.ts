// Paper-trading statistics per engine, compared with what the backtest led us to expect
// (PROGRESS.md round 10). Pure functions; src/cli/paperReport.ts feeds them from each database.

export interface ClosedTrade { realizedPnl: number; riskAmount: number; fees: number; exitTime: number }
export interface EquityPoint { time: number; equity: number }

export interface Expectation {
  label: string;
  /** Trades per 30 days in the backtest (trades engines only). */
  tradesPer30d?: number;
  winRate?: number;
  profitFactor?: number;
  avgR?: number;
  /** Annualised volatility and max drawdown of the backtest equity curve. */
  annualVol: number;
  maxDrawdown: number;
}

/**
 * Backtest expectations per BOT_NAME. A, GC, TS: the BTC/ETH portfolio (PROGRESS.md round 12,
 * 2020-01 to 2026-11, 2513 days, 1% risk per trade). ST, GLS: the phase-1 20-coin engines (rounds 8-10).
 */
export const EXPECTATIONS: Record<string, Expectation> = {
  // A runs with befee (stop to entry + 0.3% at MFE 1R, covers fees) since 2026-11-21 (owner's decision; PROGRESS.md 2026-11-21).
  A: { label: "A-LV + time stop + befee (4h, BTC/ETH)", tradesPer30d: (499 / 2513) * 30, winRate: 0.43, profitFactor: 1.54, avgR: 0.32, annualVol: 0.166, maxDrawdown: 0.183 },
  // GC runs with be2 (stop to entry at MFE 2R) since 2026-11-19 (PROGRESS.md round 15/17).
  GC: { label: "Golden cross EMA50/200 + be2 (1h, BTC/ETH)", tradesPer30d: (574 / 2513) * 30, winRate: 0.20, profitFactor: 1.44, avgR: 0.41, annualVol: 0.321, maxDrawdown: 0.257 },
  TS: { label: "Time-series momentum (4h, BTC/ETH, long only)", tradesPer30d: (267 / 2513) * 30, winRate: 0.31, profitFactor: 1.9, avgR: 0.36, annualVol: 0.126, maxDrawdown: 0.146 },
  ST: { label: "Supertrend(10,3) daily (20 coins)", tradesPer30d: 647 / 83, winRate: 0.40, profitFactor: 1.6, avgR: 0.29, annualVol: 0.169, maxDrawdown: 0.197 },
  GLS: { label: "G-LS daily Donchian ensemble (20 coins)", annualVol: 0.293, maxDrawdown: 0.326 },
};

/** A post-mortem is due after this many closed paper trades (and every multiple of it). */
export const POST_MORTEM_EVERY = 30;

export interface PaperStats {
  days: number;
  startEquity: number;
  endEquity: number;
  returnPct: number;
  maxDrawdown: number;
  annualVol: number | null;
  trades: number;
  tradesPer30d: number | null;
  winRate: number | null;
  profitFactor: number | null;
  avgR: number | null;
  fees: number;
}

export function paperStats(trades: ClosedTrade[], equity: EquityPoint[]): PaperStats {
  const pts = [...equity].sort((a, b) => a.time - b.time);
  const startEquity = pts[0]?.equity ?? 0;
  const endEquity = pts.at(-1)?.equity ?? startEquity;
  const days = pts.length > 1 ? (pts.at(-1)!.time - pts[0]!.time) / 86_400_000 : 0;
  let peak = -Infinity, maxDd = 0;
  for (const p of pts) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equity) / peak);
  }
  // Daily returns from the last point of each UTC day.
  const daily = new Map<number, number>();
  for (const p of pts) daily.set(Math.floor(p.time / 86_400_000), p.equity);
  const closes = [...daily.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  const rets = closes.slice(1).map((e, i) => e / closes[i]! - 1);
  let annualVol: number | null = null;
  if (rets.length >= 5) {
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    annualVol = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1)) * Math.sqrt(365);
  }
  const wins = trades.filter((t) => t.realizedPnl > 0);
  const grossWin = wins.reduce((a, t) => a + t.realizedPnl, 0);
  const grossLoss = -trades.filter((t) => t.realizedPnl < 0).reduce((a, t) => a + t.realizedPnl, 0);
  const rs = trades.filter((t) => t.riskAmount > 0).map((t) => t.realizedPnl / t.riskAmount);
  return {
    days, startEquity, endEquity,
    returnPct: startEquity > 0 ? endEquity / startEquity - 1 : 0,
    maxDrawdown: maxDd, annualVol,
    trades: trades.length,
    tradesPer30d: days >= 1 ? (trades.length / days) * 30 : null,
    winRate: trades.length ? wins.length / trades.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    fees: trades.reduce((a, t) => a + t.fees, 0),
  };
}

/** Plain-language flags: what deviates from the backtest enough to look at. */
export function deviations(s: PaperStats, e: Expectation | undefined): string[] {
  const out: string[] = [];
  if (!e) return out;
  if (s.maxDrawdown > e.maxDrawdown) out.push(`drawdown ${(s.maxDrawdown * 100).toFixed(1)}% is beyond the backtest maximum ${(e.maxDrawdown * 100).toFixed(1)}%`);
  if (s.annualVol !== null && s.days >= 30 && s.annualVol > e.annualVol * 1.5) out.push(`volatility ${(s.annualVol * 100).toFixed(0)}% is over 1.5x the backtest ${(e.annualVol * 100).toFixed(0)}%`);
  if (e.tradesPer30d && s.tradesPer30d !== null && s.days >= 30) {
    const ratio = s.tradesPer30d / e.tradesPer30d;
    if (ratio < 0.4 || ratio > 2.5) out.push(`trade frequency ${s.tradesPer30d.toFixed(1)}/30d vs backtest ${e.tradesPer30d.toFixed(1)}/30d`);
  }
  if (s.trades >= POST_MORTEM_EVERY && e.profitFactor && s.profitFactor !== null && s.profitFactor < 1) {
    out.push(`profit factor ${s.profitFactor.toFixed(2)} below 1 after ${s.trades} trades (backtest ${e.profitFactor.toFixed(2)})`);
  }
  return out;
}

export const postMortemDue = (trades: number) => trades > 0 && trades % POST_MORTEM_EVERY === 0;
