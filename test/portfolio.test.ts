import { describe, expect, it } from "vitest";
import type { Candle } from "../src/core/types.js";
import { DEFAULT_BACKTEST } from "../src/backtest/engine.js";
import { computeMetrics, formatMetrics } from "../src/backtest/metrics.js";
import { runPortfolioBacktest } from "../src/backtest/portfolio.js";
import type { PortfolioStrategy, PortfolioTarget } from "../src/strategy/portfolio.js";
import { createXsMomentum, DEFAULT_XS_MOMENTUM } from "../src/strategy/xsMomentum.js";
import { candlesFromCloses } from "./helpers.js";

const D1 = 86_400_000;
const START = Date.UTC(2024, 0, 1);
const noCosts = { ...DEFAULT_BACKTEST, takerFee: 0, slippage: 0, fundingPer8h: 0 };
const daily = (closes: number[], spread = 0.002) => candlesFromCloses(closes, START, D1, spread);
/** Geometric path: n closes starting at 100 growing by `g` per bar. */
const path = (n: number, g: number) => Array.from({ length: n }, (_, i) => 100 * (1 + g) ** i);

/** Scripted portfolio strategy: `plan` gets the decision number and the view. Records every view. */
function scripted(plan: (n: number, view: Record<string, Candle[]>) => PortfolioTarget[], rebalanceEvery = 1, maxPositions = 6) {
  const views: Record<string, Candle[]>[] = [];
  const s: PortfolioStrategy = {
    name: "scripted", interval: "1d", warmup: 1, rebalanceEvery, stopAtr: 3, maxPositions,
    targets(view) { views.push(view); return plan(views.length - 1, view); },
  };
  return { s, views };
}

describe("xsMomentum ranking", () => {
  const strat = createXsMomentum({ ...DEFAULT_XS_MOMENTUM, topK: 3, bottomK: 3 });
  const n = 40;

  it("longs the topK and shorts the bottomK by past return", () => {
    const growth = { A: 0.03, B: 0.02, C: 0.01, D: 0.005, E: -0.005, F: -0.01, G: -0.02, H: -0.03 };
    const view = Object.fromEntries(Object.entries(growth).map(([s, g]) => [s, daily(path(n, g))]));
    const t = strat.targets(view);
    expect(t.filter((x) => x.side === "LONG").map((x) => x.symbol)).toEqual(["A", "B", "C"]);
    expect(t.filter((x) => x.side === "SHORT").map((x) => x.symbol).sort()).toEqual(["F", "G", "H"]);
    for (const x of t) {
      const last = view[x.symbol]!.at(-1)!.close;
      if (x.side === "LONG") expect(x.stop).toBeLessThan(last);
      else expect(x.stop).toBeGreaterThan(last);
    }
  });

  it("skip excludes the most recent bar from the return", () => {
    const jump = [...Array(n - 1).fill(100), 300]; // flat, then a huge last bar
    const view = { UP: daily(path(n, 0.005)), JUMP: daily(jump), DOWN: daily(path(n, -0.01)) };
    const t = createXsMomentum({ ...DEFAULT_XS_MOMENTUM, topK: 1, bottomK: 1 }).targets(view);
    expect(t.find((x) => x.side === "LONG")!.symbol).toBe("UP");
    // A crash on the last bar alone does not make a coin the short either.
    const crash = [...path(n - 1, 0.002), 30];
    const t2 = createXsMomentum({ ...DEFAULT_XS_MOMENTUM, topK: 1, bottomK: 1 }).targets({ UP: daily(path(n, 0.01)), CRASH: daily(crash), DOWN: daily(path(n, -0.01)) });
    expect(t2.find((x) => x.side === "SHORT")!.symbol).toBe("DOWN");
  });

  it("time-series gate drops longs with return <= 0 and shorts with return >= 0, without refilling", () => {
    // All coins rise: the bottom ranks have positive returns, so no shorts with the gate on.
    const up = { A: daily(path(n, 0.03)), B: daily(path(n, 0.02)), C: daily(path(n, 0.01)), D: daily(path(n, 0.005)), E: daily(path(n, 0.002)), F: daily(path(n, 0.001)) };
    const gated = createXsMomentum({ ...DEFAULT_XS_MOMENTUM, topK: 2, bottomK: 2 }).targets(up);
    expect(gated.map((x) => [x.symbol, x.side])).toEqual([["A", "LONG"], ["B", "LONG"]]);
    const ungated = createXsMomentum({ ...DEFAULT_XS_MOMENTUM, topK: 2, bottomK: 2, tsGate: 0 }).targets(up);
    expect(ungated.filter((x) => x.side === "SHORT").map((x) => x.symbol).sort()).toEqual(["E", "F"]);
    // One positive coin among losers: only 1 long, the 2nd long slot stays empty (no refill).
    const mixed = { A: daily(path(n, 0.01)), B: daily(path(n, -0.001)), C: daily(path(n, -0.002)), D: daily(path(n, -0.01)), E: daily(path(n, -0.02)) };
    const t = createXsMomentum({ ...DEFAULT_XS_MOMENTUM, topK: 2, bottomK: 2 }).targets(mixed);
    expect(t.filter((x) => x.side === "LONG").map((x) => x.symbol)).toEqual(["A"]);
    expect(t.filter((x) => x.side === "SHORT").map((x) => x.symbol).sort()).toEqual(["D", "E"]);
  });

  it("skips symbols lacking history and scales K down without overlap", () => {
    const view = {
      A: daily(path(n, 0.02)), B: daily(path(n, 0.01)), C: daily(path(n, -0.01)), D: daily(path(n, -0.02)),
      NEW: daily(path(10, 0.5)),
    };
    const t = strat.targets(view);
    expect(t.map((x) => x.symbol)).not.toContain("NEW");
    expect(t.filter((x) => x.side === "LONG").map((x) => x.symbol)).toEqual(["A", "B"]);
    expect(t.filter((x) => x.side === "SHORT").map((x) => x.symbol).sort()).toEqual(["C", "D"]);
    expect(strat.targets({ A: daily(path(n, 0.02)) })).toEqual([]);
  });
});

describe("portfolio backtest", () => {
  it("decides on closes at the rebalance cadence and fills at the next open", () => {
    const x = daily(path(20, 0.01), 0);
    const { s, views } = scripted(() => [{ symbol: "X", side: "LONG", stop: 80 }], 5);
    const r = runPortfolioBacktest(s, { X: x }, noCosts);
    expect(views.map((v) => v.X!.at(-1)!.openTime)).toEqual([0, 5, 10, 15].map((i) => x[i]!.openTime));
    expect(r.trades).toHaveLength(1); // same-side target kept, not resized
    expect(r.trades[0]!.entryTime).toBe(x[1]!.openTime);
    expect(r.trades[0]!.entryPrice).toBe(x[1]!.open);
    expect(r.trades[0]!.exitReason).toBe("END");
  });

  it("first rebalance bar follows tradeFromMs", () => {
    const x = daily(path(20, 0.01), 0);
    const { s, views } = scripted(() => [{ symbol: "X", side: "LONG", stop: 80 }], 5);
    const r = runPortfolioBacktest(s, { X: x }, { ...noCosts, tradeFromMs: x[3]!.openTime });
    expect(views[0]!.X!.at(-1)!.openTime).toBe(x[3]!.openTime);
    expect(r.trades[0]!.entryTime).toBe(x[4]!.openTime);
  });

  it("has no look-ahead: changing candles after a decision changes neither targets nor fills", () => {
    const mk = () => ({ A: daily(path(80, 0.01)), B: daily(path(80, 0.002)), C: daily(path(80, -0.004)), D: daily(path(80, -0.01)) });
    const base = mk();
    const altered = mk();
    const cut = 50; // decisions at closes <= 49 (and their fills at opens <= 50) must not change
    for (const s of Object.keys(altered) as (keyof typeof altered)[]) {
      altered[s] = altered[s].map((c, i) => (i > cut ? { ...c, open: c.open * 3, high: c.high * 3, low: c.low * 0.2, close: c.close * (i % 2 ? 5 : 0.1) } : c));
    }
    const strat = { ...createXsMomentum({ ...DEFAULT_XS_MOMENTUM, topK: 1, bottomK: 1, lookback: 10 }) };
    const before = (r: ReturnType<typeof runPortfolioBacktest>) =>
      r.trades.filter((t) => t.entryTime <= base.A[cut]!.openTime).map((t) => [t.symbol, t.side, t.entryTime, t.entryPrice, t.quantity, t.initialStop]);
    const r1 = runPortfolioBacktest(strat, base, DEFAULT_BACKTEST);
    const r2 = runPortfolioBacktest(strat, altered, DEFAULT_BACKTEST);
    expect(before(r1).length).toBeGreaterThan(0);
    expect(before(r2)).toEqual(before(r1));
    // Every view ends at the decision bar: the strategy never sees a later candle.
    const { s, views } = scripted(() => [], 1);
    runPortfolioBacktest(s, base, noCosts);
    views.forEach((v, k) => { for (const c of Object.values(v)) expect(c.at(-1)!.openTime).toBe(base.A[k]!.openTime); });
  });

  it("stop is hit intrabar on the low, and a gap fills at the open", () => {
    const run = (bar: Partial<Candle>) => {
      const x = daily(Array(10).fill(100), 0);
      x[3] = { ...x[3]!, ...bar };
      const { s } = scripted(() => [{ symbol: "X", side: "LONG", stop: 95 }], 100);
      return runPortfolioBacktest(s, { X: x }, noCosts).trades[0]!;
    };
    const hit = run({ low: 94 });
    expect(hit.exitReason).toBe("STOP");
    expect(hit.exitPrice).toBe(95);
    const gap = run({ open: 90, high: 91, low: 85, close: 88 });
    expect(gap.exitReason).toBe("STOP");
    expect(gap.exitPrice).toBe(90);
  });

  it("short stops are checked on the high", () => {
    const x = daily(Array(10).fill(100), 0);
    x[4] = { ...x[4]!, high: 106 };
    const { s } = scripted(() => [{ symbol: "X", side: "SHORT", stop: 105 }], 100);
    const t = runPortfolioBacktest(s, { X: x }, noCosts).trades[0]!;
    expect(t.exitReason).toBe("STOP");
    expect(t.exitPrice).toBe(105);
  });

  it("closes a symbol leaving the target set with reason SIGNAL at the next open", () => {
    const x = daily(path(12, 0.01), 0);
    const y = daily(path(12, 0.02), 0);
    const { s } = scripted((n) => [{ symbol: n === 0 ? "X" : "Y", side: "LONG", stop: 80 }], 4);
    const r = runPortfolioBacktest(s, { X: x, Y: y }, noCosts);
    const tx = r.trades.find((t) => t.symbol === "X")!;
    expect(tx.exitReason).toBe("SIGNAL");
    expect(tx.exitTime).toBe(x[5]!.openTime);
    expect(tx.exitPrice).toBe(x[5]!.open);
    expect(r.trades.find((t) => t.symbol === "Y")!.entryTime).toBe(y[5]!.openTime);
  });

  it("a side flip closes and reopens on the same open", () => {
    const x = daily(Array(12).fill(100), 0);
    const { s } = scripted((n) => [n === 0 ? { symbol: "X", side: "LONG", stop: 80 } : { symbol: "X", side: "SHORT", stop: 120 }], 4);
    const r = runPortfolioBacktest(s, { X: x }, noCosts);
    expect(r.trades.map((t) => [t.side, t.exitReason])).toEqual([["LONG", "SIGNAL"], ["SHORT", "END"]]);
    expect(r.trades[1]!.entryTime).toBe(r.trades[0]!.exitTime);
  });

  it("caps open positions at maxPositions", () => {
    const data = { A: daily(path(10, 0.01)), B: daily(path(10, 0.01)), C: daily(path(10, 0.01)) };
    const { s } = scripted(() => ["A", "B", "C"].map((sym) => ({ symbol: sym, side: "LONG" as const, stop: 80 })), 100, 2);
    expect(runPortfolioBacktest(s, data, noCosts).trades.map((t) => t.symbol)).toEqual(["A", "B"]);
  });

  it("costs (fees, slippage, funding) reduce PnL", () => {
    const data = { X: daily(path(30, 0.01)) };
    const { s } = scripted(() => [{ symbol: "X", side: "LONG", stop: 80 }], 100);
    const free = runPortfolioBacktest(s, data, noCosts);
    const paid = runPortfolioBacktest(s, data, DEFAULT_BACKTEST);
    expect(paid.trades[0]!.fees).toBeGreaterThan(0);
    expect(paid.trades[0]!.funding).toBeGreaterThan(0);
    expect(paid.trades[0]!.entryPrice).toBeGreaterThan(free.trades[0]!.entryPrice);
    expect(paid.finalEquity).toBeLessThan(free.finalEquity);
  });

  it("metrics.ts computes on the result and the curve ends at finalEquity", () => {
    const g = [0.01, 0.006, 0.002, -0.002, -0.006, -0.01];
    const data = Object.fromEntries(g.map((x, i) => [`S${i}`, daily(path(120, x).map((c, j) => c * (1 + 0.03 * Math.sin(j / 3 + i))))]));
    const strat = createXsMomentum({ ...DEFAULT_XS_MOMENTUM, topK: 2, bottomK: 2 });
    const r = runPortfolioBacktest(strat, data, DEFAULT_BACKTEST);
    const m = computeMetrics(r, DEFAULT_BACKTEST.initialEquity);
    expect(m.trades).toBe(r.trades.length);
    expect(m.trades).toBeGreaterThan(0);
    expect(m.longs).toBeGreaterThan(0);
    expect(m.shorts).toBeGreaterThan(0);
    expect(r.equityCurve.at(-1)!.equity).toBeCloseTo(r.finalEquity, 8);
    expect(Number.isFinite(m.maxDrawdownPct)).toBe(true);
    expect(formatMetrics(m)).toEqual(expect.any(String));
  });
});
