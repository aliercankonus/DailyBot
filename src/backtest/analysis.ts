// Loss attribution: where do a strategy's losses come from? Splits trades by exit reason, side,
// holding time, excursion (bad entry vs given-back profit) and by the market regime at the
// signal candle (ADX, price vs EMA200 on the symbol and on BTC, ATR as % of price).
// Regime values use only candles up to and including the signal candle (no look-ahead).
import { adx, atr, ema } from "../core/indicators.js";
import type { Candle } from "../core/types.js";
import type { BacktestTrade } from "./engine.js";

export interface Bucket {
  label: string;
  trades: number;
  winRate: number;
  sumR: number;
  avgR: number;
  profitFactor: number;
}

export function bucket(label: string, ts: BacktestTrade[]): Bucket {
  const wins = ts.filter((t) => t.netPnl > 0);
  const grossWin = wins.reduce((x, t) => x + t.netPnl, 0);
  const grossLoss = -ts.filter((t) => t.netPnl <= 0).reduce((x, t) => x + t.netPnl, 0);
  const sumR = ts.reduce((x, t) => x + t.r, 0);
  return {
    label, trades: ts.length, winRate: ts.length ? wins.length / ts.length : 0, sumR,
    avgR: ts.length ? sumR / ts.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
  };
}

/** Per-trade regime at the signal candle (the candle before the fill). */
export interface Regime {
  adx: number;
  aboveEma200: boolean;
  btcAboveEma200: boolean | undefined;
  atrPct: number;
}

export function regimes(trades: BacktestTrade[], data: Record<string, Candle[]>): Map<BacktestTrade, Regime> {
  const ind: Record<string, { idx: Map<number, number>; adx: number[]; ema: number[]; atr: number[]; c: Candle[] }> = {};
  for (const [s, c] of Object.entries(data)) {
    ind[s] = { idx: new Map(c.map((k, i) => [k.openTime, i])), adx: adx(c, 14), ema: ema(c.map((k) => k.close), 200), atr: atr(c, 14), c };
  }
  const btc = ind.BTCUSDT;
  const out = new Map<BacktestTrade, Regime>();
  for (const t of trades) {
    const d = ind[t.symbol];
    const i = d?.idx.get(t.entryTime);
    if (!d || i === undefined || i < 1) continue;
    const j = i - 1; // signal candle
    const close = d.c[j]!.close;
    let btcAbove: boolean | undefined;
    const bi = btc?.idx.get(d.c[j]!.openTime);
    if (btc && bi !== undefined && Number.isFinite(btc.ema[bi]!)) btcAbove = btc.c[bi]!.close > btc.ema[bi]!;
    out.set(t, { adx: d.adx[j]!, aboveEma200: close > d.ema[j]!, btcAboveEma200: btcAbove, atrPct: d.atr[j]! / close });
  }
  return out;
}

function split<T>(ts: T[], parts: [string, (t: T) => boolean][]): [string, T[]][] {
  return parts.map(([l, f]) => [l, ts.filter(f)]);
}

/** Text report; one line per bucket. */
export function lossReport(trades: BacktestTrade[], data: Record<string, Candle[]>): string[] {
  const lines: string[] = [];
  const fmt = (b: Bucket) => `  ${b.label.padEnd(34)} n ${String(b.trades).padStart(4)}  win ${(b.winRate * 100).toFixed(0).padStart(3)}%  PF ${Number.isFinite(b.profitFactor) ? b.profitFactor.toFixed(2) : "inf"}  sumR ${b.sumR.toFixed(1).padStart(7)}  avgR ${b.avgR.toFixed(2)}`;
  const section = (title: string, groups: [string, BacktestTrade[]][]) => {
    lines.push(title);
    for (const [l, ts] of groups) if (ts.length) lines.push(fmt(bucket(l, ts)));
  };
  const reg = regimes(trades, data);
  const r = (t: BacktestTrade) => reg.get(t);

  section("by exit reason:", split(trades, [["STOP", (t) => t.exitReason === "STOP"], ["SIGNAL", (t) => t.exitReason === "SIGNAL"], ["END", (t) => t.exitReason === "END"]]));
  section("by side:", split(trades, [["LONG", (t) => t.side === "LONG"], ["SHORT", (t) => t.side === "SHORT"]]));
  section("by candles held:", split(trades, [
    ["1-2", (t) => (t.bars ?? 0) <= 2], ["3-6", (t) => (t.bars ?? 0) >= 3 && (t.bars ?? 0) <= 6],
    ["7-18", (t) => (t.bars ?? 0) >= 7 && (t.bars ?? 0) <= 18], ["19-48", (t) => (t.bars ?? 0) >= 19 && (t.bars ?? 0) <= 48],
    ["49+", (t) => (t.bars ?? 0) >= 49],
  ]));
  const losers = trades.filter((t) => t.netPnl <= 0);
  section("losers by best excursion (MFE):", split(losers, [
    ["never > 0.25R in profit (bad entry)", (t) => (t.mfeR ?? 0) < 0.25],
    ["0.25-1R then lost", (t) => (t.mfeR ?? 0) >= 0.25 && (t.mfeR ?? 0) < 1],
    ["1R+ then lost (gave back)", (t) => (t.mfeR ?? 0) >= 1],
  ]));
  const winners = trades.filter((t) => t.netPnl > 0);
  section("winners by result:", split(winners, [["0-1R", (t) => t.r < 1], ["1-3R", (t) => t.r >= 1 && t.r < 3], ["3R+", (t) => t.r >= 3]]));
  section("by ADX at signal:", split(trades, [
    ["ADX < 20 (range)", (t) => (r(t)?.adx ?? NaN) < 20], ["ADX 20-30", (t) => (r(t)?.adx ?? NaN) >= 20 && (r(t)?.adx ?? NaN) < 30],
    ["ADX 30-40", (t) => (r(t)?.adx ?? NaN) >= 30 && (r(t)?.adx ?? NaN) < 40], ["ADX >= 40", (t) => (r(t)?.adx ?? NaN) >= 40],
  ]));
  section("by side vs symbol EMA200:", split(trades, [
    ["LONG above EMA200", (t) => t.side === "LONG" && r(t)?.aboveEma200 === true], ["LONG below EMA200", (t) => t.side === "LONG" && r(t)?.aboveEma200 === false],
    ["SHORT below EMA200", (t) => t.side === "SHORT" && r(t)?.aboveEma200 === false], ["SHORT above EMA200", (t) => t.side === "SHORT" && r(t)?.aboveEma200 === true],
  ]));
  section("by side vs BTC EMA200:", split(trades, [
    ["LONG, BTC above", (t) => t.side === "LONG" && r(t)?.btcAboveEma200 === true], ["LONG, BTC below", (t) => t.side === "LONG" && r(t)?.btcAboveEma200 === false],
    ["SHORT, BTC below", (t) => t.side === "SHORT" && r(t)?.btcAboveEma200 === false], ["SHORT, BTC above", (t) => t.side === "SHORT" && r(t)?.btcAboveEma200 === true],
  ]));
  section("by ATR % of price at signal:", split(trades, [
    ["< 1%", (t) => (r(t)?.atrPct ?? NaN) < 0.01], ["1-2%", (t) => (r(t)?.atrPct ?? NaN) >= 0.01 && (r(t)?.atrPct ?? NaN) < 0.02],
    ["2-3%", (t) => (r(t)?.atrPct ?? NaN) >= 0.02 && (r(t)?.atrPct ?? NaN) < 0.03], [">= 3%", (t) => (r(t)?.atrPct ?? NaN) >= 0.03],
  ]));
  section("by year and side:", [...new Set(trades.map((t) => new Date(t.entryTime).getUTCFullYear()))].sort().flatMap((y) => [
    [`${y} LONG`, trades.filter((t) => t.side === "LONG" && new Date(t.entryTime).getUTCFullYear() === y)],
    [`${y} SHORT`, trades.filter((t) => t.side === "SHORT" && new Date(t.entryTime).getUTCFullYear() === y)],
  ] as [string, BacktestTrade[]][]));

  // Worst months by summed R and the longest losing streak.
  const months = new Map<string, number>();
  for (const t of trades) {
    const k = new Date(t.exitTime).toISOString().slice(0, 7);
    months.set(k, (months.get(k) ?? 0) + t.r);
  }
  const worst = [...months].sort((a, b) => a[1] - b[1]).slice(0, 6);
  lines.push(`worst months (sum R): ${worst.map(([m, v]) => `${m} ${v.toFixed(1)}`).join(" | ")}`);
  let streak = 0, maxStreak = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    streak = t.netPnl <= 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  lines.push(`longest losing streak: ${maxStreak} trades`);
  return lines;
}
