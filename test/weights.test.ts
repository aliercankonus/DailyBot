import { describe, expect, it } from "vitest";
import type { Candle } from "../src/core/types.js";
import { DEFAULT_BACKTEST } from "../src/backtest/engine.js";
import { getCatalogEntry } from "../src/backtest/catalog.js";
import { equityAcceptance, equityMetrics } from "../src/backtest/metrics.js";
import { runWeightsBacktest } from "../src/backtest/weights.js";
import { createBtcHold } from "../src/strategy/benchmarks.js";
import { createDonchianEnsemble, DONCHIAN_LOOKBACKS, ensembleFraction, priorRollingExtreme } from "../src/strategy/donchianEnsemble.js";
import { createFundingCarry, windowAverage } from "../src/strategy/fundingCarry.js";
import type { WeightStrategy } from "../src/strategy/weights.js";
import { realizedVol } from "../src/strategy/weights.js";
import { candlesFromCloses } from "./helpers.js";

const D1 = 86_400_000;
const T0 = Date.UTC(2022, 0, 1);
const free = { ...DEFAULT_BACKTEST, takerFee: 0, slippage: 0, fundingPer8h: 0, band: 0 };

function noise(seed = 11) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
}

describe("priorRollingExtreme", () => {
  it("matches a naive computation and excludes the current value", () => {
    const r = noise();
    const v = Array.from({ length: 300 }, () => 100 + r() * 10);
    for (const L of [1, 5, 37]) {
      const mx = priorRollingExtreme(v, L, "max");
      const mn = priorRollingExtreme(v, L, "min");
      for (let i = 0; i < v.length; i++) {
        if (i < L) { expect(mx[i]).toBeNaN(); continue; }
        expect(mx[i]).toBe(Math.max(...v.slice(i - L, i)));
        expect(mn[i]).toBe(Math.min(...v.slice(i - L, i)));
      }
    }
  });
});

describe("strategy G: Donchian ensemble", () => {
  it("is fully long in a long steady up-trend and flat after a crash", () => {
    const up = Array.from({ length: 500 }, (_, i) => 100 * 1.004 ** i);
    expect(ensembleFraction(up, false).at(-1)).toBeCloseTo(1);
    const crash = [...up, ...Array.from({ length: 60 }, (_, i) => up.at(-1)! * 0.96 ** (i + 1))];
    expect(ensembleFraction(crash, false).at(-1)).toBe(0);
    expect(ensembleFraction(crash, true).at(-1)!).toBeLessThan(0);
  });

  it("the trailing stop only tightens: a pullback above the midpoint keeps the position", () => {
    const up = Array.from({ length: 400 }, (_, i) => 100 * 1.004 ** i);
    const dip = [...up, up.at(-1)! * 0.99];
    expect(ensembleFraction(dip, false).at(-1)!).toBeGreaterThan(0.5);
  });

  it("weights have no look-ahead", () => {
    const r = noise(5);
    let p = 100;
    const closes = Array.from({ length: 700 }, () => (p *= 1 + r() * 0.08));
    const a = { X: candlesFromCloses(closes, T0, D1), Y: candlesFromCloses(closes.map((c) => c * 2), T0, D1) };
    const changed = closes.map((c, i) => (i > 600 ? c * 3 : c));
    const b = { X: candlesFromCloses(changed, T0, D1), Y: a.Y };
    const g = createDonchianEnsemble();
    const wa = g.weightSeries({ candles: a, funding: {} });
    const wb = g.weightSeries({ candles: b, funding: {} });
    for (let i = 400; i <= 600; i++) expect(wb.get(a.X[i]!.openTime)).toEqual(wa.get(a.X[i]!.openTime));
  });

  it("inverse-volatility sizing and the gross cap", () => {
    const up = Array.from({ length: 500 }, (_, i) => 100 * 1.004 ** i * (1 + (i % 2 ? 0.01 : -0.01)));
    const c = { A: candlesFromCloses(up, T0, D1) };
    const w = createDonchianEnsemble({ volTarget: 0.25, volLookback: 90, maxGross: 2, allowShort: 0 }).weightSeries({ candles: c, funding: {} });
    const last = w.get(c.A.at(-1)!.openTime)!.A!;
    const vol = realizedVol(up, up.length - 1, 90);
    expect(last).toBeCloseTo(Math.min(2, 0.25 / vol), 5);
    expect(DONCHIAN_LOOKBACKS).toHaveLength(9);
  });
});

describe("weights backtester", () => {
  it("buy and hold tracks the price ratio exactly without costs", () => {
    const closes = [100, 110, 90, 120, 150];
    const res = runWeightsBacktest(createBtcHold(), { BTCUSDT: candlesFromCloses(closes, T0, D1, 0) }, free);
    // decided at close of bar 0 (100), bought at open of bar 1 (= 100), held to the last close (150)
    expect(res.finalEquity).toBeCloseTo(10_000 * 1.5);
  });

  it("trades at the next open and charges costs on traded notional", () => {
    const closes = [100, 100, 100, 100];
    const c = candlesFromCloses(closes, T0, D1, 0);
    const res = runWeightsBacktest(createBtcHold(), { BTCUSDT: c }, { ...free, takerFee: 0.001, band: 0.02 });
    expect(res.finalEquity).toBeCloseTo(10_000 - 10); // one entry of 10k notional at 0.1%
    expect(res.stats.fees).toBeCloseTo(10);
  });

  it("funding: a long pays positive funding, a short receives it", () => {
    const c = candlesFromCloses(new Array(5).fill(100), T0, D1, 0);
    const rates = Array.from({ length: 15 }, (_, k) => ({ time: T0 + k * 8 * 3_600_000, rate: 0.001 }));
    const mk = (w: number): WeightStrategy => ({
      name: "w", interval: "1d", rebalanceEvery: 1,
      weightSeries: ({ candles }) => new Map(candles.X!.map((k) => [k.openTime, { X: w }])),
    });
    // band > 0: no daily resizing, so both sides hold the same notional
    const long = runWeightsBacktest(mk(1), { X: c }, { ...free, band: 0.02, fundingRates: { X: rates } });
    const short = runWeightsBacktest(mk(-1), { X: c }, { ...free, band: 0.02, fundingRates: { X: rates } });
    expect(long.finalEquity).toBeLessThan(10_000);
    expect(short.finalEquity).toBeGreaterThan(10_000);
    expect(long.stats.funding).toBeCloseTo(-short.stats.funding, 6);
  });

  it("the no-trade band skips small adjustments", () => {
    let k = 0;
    const s: WeightStrategy = {
      name: "jitter", interval: "1d", rebalanceEvery: 1,
      weightSeries: ({ candles }) => new Map(candles.X!.map((c) => [c.openTime, { X: 0.5 + (k++ % 2 ? 0.005 : -0.005) }])),
    };
    const c = candlesFromCloses(new Array(30).fill(100), T0, D1, 0);
    const res = runWeightsBacktest(s, { X: c }, { ...free, takerFee: 0.001, band: 0.02 });
    expect(res.stats.fees).toBeCloseTo(0.001 * 0.495 * 10_000, 1); // only the initial entry
  });
});

describe("strategy H: funding carry", () => {
  it("averages funding inside the window only", () => {
    const pts = [1, 2, 3, 4].map((r, i) => ({ time: i * 10, rate: r }));
    expect(windowAverage(pts, 30, 20, 1)).toBe(3.5); // (10,30] -> 3,4
    expect(windowAverage(pts, 30, 20, 3)).toBeNull();
  });

  it("is dollar-neutral: long the lowest funding, short the highest", () => {
    const syms = ["A", "B", "C", "D", "E", "F"];
    const candles: Record<string, Candle[]> = {};
    const funding: Record<string, { time: number; rate: number }[]> = {};
    syms.forEach((s, j) => {
      candles[s] = candlesFromCloses(new Array(20).fill(100), T0, D1, 0);
      funding[s] = Array.from({ length: 60 }, (_, k) => ({ time: T0 + k * 8 * 3_600_000, rate: (j - 2) * 0.0001 }));
    });
    const w = createFundingCarry().weightSeries({ candles, funding });
    const day = w.get(candles.A![10]!.openTime)!;
    expect(day.A).toBeCloseTo(0.25);
    expect(day.B).toBeCloseTo(0.25);
    expect(day.E).toBeCloseTo(-0.25);
    expect(day.F).toBeCloseTo(-0.25);
    expect(day.C).toBeUndefined();
    expect(Object.values(day).reduce((a, b) => a + b, 0)).toBeCloseTo(0);
  });
});

describe("equity metrics", () => {
  it("yearly returns, Sharpe and drawdown", () => {
    const curve = [
      { time: Date.UTC(2024, 0, 1), equity: 100 },
      { time: Date.UTC(2024, 6, 1), equity: 120 },
      { time: Date.UTC(2024, 11, 31), equity: 110 },
      { time: Date.UTC(2025, 5, 1), equity: 99 },
    ];
    const m = equityMetrics(curve);
    expect(m.yearly[0]!.ret).toBeCloseTo(0.1);
    expect(m.yearly[1]!.ret).toBeCloseTo(-0.1);
    expect(m.maxDrawdownPct).toBeCloseTo(21 / 120);
    expect(equityAcceptance(m).pass).toBe(false);
  });

  it("catalog runs G, H and the benchmarks", () => {
    const r = noise(9);
    const candles: Record<string, Candle[]> = {};
    const funding: Record<string, { time: number; rate: number }[]> = {};
    for (const s of ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "BNBUSDT"]) {
      let p = 100;
      candles[s] = candlesFromCloses(Array.from({ length: 600 }, () => (p *= 1 + r() * 0.06)), T0, D1, 0.01);
      funding[s] = Array.from({ length: 1800 }, (_, k) => ({ time: T0 + k * 8 * 3_600_000, rate: r() * 0.0004 }));
    }
    for (const name of ["donchian", "carry", "btchold", "ewhold"]) {
      const e = getCatalogEntry(name);
      expect(e.kind).toBe("weights");
      const res = e.run(e.defaults, candles, { ...DEFAULT_BACKTEST, fundingRates: funding });
      expect(Number.isFinite(res.finalEquity)).toBe(true);
      expect(res.equityCurve.length).toBeGreaterThan(500);
    }
  });
});
