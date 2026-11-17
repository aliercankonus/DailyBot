import { describe, expect, it } from "vitest";
import type { Candle, OpenPositionView, Signal } from "../src/core/types.js";
import { DEFAULT_BACKTEST, runBacktest, settlementTimes } from "../src/backtest/engine.js";
import { getCatalogEntry, UNIVERSE_20 } from "../src/backtest/catalog.js";
import { computeMetrics, yearlyConsistency, type Metrics } from "../src/backtest/metrics.js";
import { attachFunding } from "../src/data/funding.js";
import { MemoryRepo } from "../src/db/repo.js";
import { Engine, type EngineConfig } from "../src/engine/engine.js";
import { createFunding, DEFAULT_FUNDING, fundingZ } from "../src/strategy/funding.js";
import type { Strategy } from "../src/strategy/types.js";
import { createTsmom, tsmomScore } from "../src/strategy/tsmom.js";
import { candlesFromCloses, FakeExchange } from "./helpers.js";

const H1 = 3_600_000;
const H8 = 8 * H1;
const D1 = 24 * H1;
const T0 = Date.UTC(2024, 0, 1);

describe("attachFunding", () => {
  it("a candle only sees settlements at or before its close", () => {
    const c = candlesFromCloses([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], T0, H1); // 00:00..09:00
    const out = attachFunding(c, [{ time: T0, rate: 0.0001 }, { time: T0 + H8, rate: 0.0009 }]);
    expect(out[7]!.fundingRate).toBe(0.0001); // 07:00-07:59 closes before the 08:00 settlement
    expect(out[8]!.fundingRate).toBe(0.0009); // 08:00 candle carries the new rate
    expect(c[8]!.fundingRate).toBeUndefined(); // input untouched
  });
});

/** 1h candles with a funding history: calm at `base`, one extreme settlement at `spikeAt`. */
function fundingSeries(spikeRate: number, settlements = 120, spikeAt = 100) {
  const n = settlements * 8;
  const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 10));
  const candles = candlesFromCloses(closes, T0, H1);
  const funding = Array.from({ length: settlements }, (_, k) => ({
    time: T0 + k * H8,
    rate: k === spikeAt ? spikeRate : 0.0001 + (k % 3) * 0.00001,
  }));
  return { candles: attachFunding(candles, funding), spikeIdx: spikeAt * 8 };
}

describe("strategy D: funding", () => {
  const s = createFunding();
  it("shorts on an extreme positive funding settlement, only on that candle", () => {
    const { candles, spikeIdx } = fundingSeries(0.001);
    expect(s.evaluate("X", candles.slice(0, spikeIdx))).toBeNull();       // before the spike
    const sig = s.evaluate("X", candles.slice(0, spikeIdx + 1));
    expect(sig?.side).toBe("SHORT");
    expect(sig!.stop).toBeGreaterThan(sig!.refPrice);
    expect(s.evaluate("X", candles.slice(0, spikeIdx + 2))).toBeNull();   // next hour: no new information
  });

  it("goes long on an extreme negative settlement", () => {
    const { candles, spikeIdx } = fundingSeries(-0.001);
    expect(s.evaluate("X", candles.slice(0, spikeIdx + 1))?.side).toBe("LONG");
  });

  it("does nothing when the settlement is within the normal range", () => {
    const { candles, spikeIdx } = fundingSeries(0.0001); // within the normal range
    expect(s.evaluate("X", candles.slice(0, spikeIdx + 1))).toBeNull();
  });

  it("z-score uses only the settlements before the current one", () => {
    const { candles, spikeIdx } = fundingSeries(0.001);
    const z = fundingZ(candles.slice(0, spikeIdx + 1), DEFAULT_FUNDING.lookback)!;
    expect(z.rate).toBe(0.001);
    expect(z.z).toBeGreaterThan(10);
  });

  it("exits when funding normalises or after maxBars", () => {
    const { candles, spikeIdx } = fundingSeries(0.001);
    const pos: OpenPositionView = { side: "SHORT", entryPrice: 100, stop: 103, initialStop: 103, entryCandleOpenTime: candles[spikeIdx + 1]!.openTime };
    expect(s.shouldExit!(pos, candles.slice(0, spikeIdx + 5))).toBe(false); // between settlements
    expect(s.shouldExit!(pos, candles.slice(0, spikeIdx + 9))).toBe(true);  // next settlement is normal again
    const late = { ...pos, entryCandleOpenTime: candles[spikeIdx + 1 - 48 + 4]!.openTime };
    expect(s.shouldExit!(late, candles.slice(0, spikeIdx + 5))).toBe(true);
  });
});

describe("backtest with historical funding", () => {
  it("lists settlement times strictly after entry", () => {
    expect(settlementTimes(T0, T0 + D1, T0)).toEqual([T0 + H8, T0 + 2 * H8, T0 + 3 * H8]);
  });

  it("a short receives positive funding, a long pays it", () => {
    const mk = (side: "LONG" | "SHORT"): Strategy => ({
      name: "f", interval: "1h", warmup: 1,
      evaluate: (symbol, cs) => cs.length === 2
        ? { symbol, side, refPrice: 100, stop: side === "LONG" ? 50 : 150, candleOpenTime: cs.at(-1)!.openTime, reason: "t" } as Signal
        : null,
      updateStop: (p) => p.stop,
    });
    const candles = candlesFromCloses(new Array(30).fill(100), T0, H1, 0);
    const fundingRates = { X: Array.from({ length: 5 }, (_, k) => ({ time: T0 + k * H8, rate: 0.001 })) };
    const cfg = { ...DEFAULT_BACKTEST, takerFee: 0, slippage: 0, fundingRates };
    const short = runBacktest(mk("SHORT"), { X: candles }, cfg).trades[0]!;
    const long = runBacktest(mk("LONG"), { X: candles }, cfg).trades[0]!;
    expect(short.funding).toBeLessThan(0);
    expect(long.funding).toBeGreaterThan(0);
    expect(short.funding).toBeCloseTo(-long.funding);
  });
});

describe("strategy F: time-series momentum", () => {
  const s = createTsmom();
  const up = candlesFromCloses(Array.from({ length: 400 }, (_, i) => 100 * 1.003 ** i), T0, D1);

  it("score is +1 in a steady up-trend and -1 in a down-trend", () => {
    expect(tsmomScore(up)).toBe(1);
    const down = candlesFromCloses(Array.from({ length: 400 }, (_, i) => 100 * 0.997 ** i), T0, D1);
    expect(tsmomScore(down)).toBe(-1);
    expect(tsmomScore(up.slice(0, 300))).toBeNull(); // needs 361 candles
  });

  it("long only by default; shorts only when enabled", () => {
    expect(s.evaluate("X", up)?.side).toBe("LONG");
    const down = candlesFromCloses(Array.from({ length: 400 }, (_, i) => 100 * 0.997 ** i), T0, D1);
    expect(s.evaluate("X", down)).toBeNull();
    expect(createTsmom({ entryScore: 0.6, exitScore: 0, stopAtr: 4, allowShort: 1 }).evaluate("X", down)?.side).toBe("SHORT");
  });

  it("exits when the score drops to the exit level", () => {
    const closes = Array.from({ length: 400 }, (_, i) => 100 * 1.003 ** i);
    const crash = [...closes, ...Array.from({ length: 40 }, (_, i) => closes.at(-1)! * 0.97 ** (i + 1))];
    const c = candlesFromCloses(crash, T0, D1);
    const pos: OpenPositionView = { side: "LONG", entryPrice: 300, stop: 200, initialStop: 200, entryCandleOpenTime: c[399]!.openTime };
    expect(s.shouldExit!(pos, c.slice(0, 401))).toBe(false);
    expect(s.shouldExit!(pos, c)).toBe(true);
  });
});

describe("catalog", () => {
  it("runs every entry on synthetic data without errors", () => {
    let x = 3;
    const r = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
    const daily: Record<string, Candle[]> = {};
    for (const sym of UNIVERSE_20.slice(0, 8)) {
      let p = 100;
      daily[sym] = candlesFromCloses(Array.from({ length: 700 }, () => (p *= 1 + r() * 0.06)), T0, D1, 0.01);
    }
    for (const name of ["tsmom", "xsmom"]) {
      const e = getCatalogEntry(name);
      const res = e.run(e.defaults, daily, { ...DEFAULT_BACKTEST, riskPerTrade: e.defaultRisk, maxOpenPositions: e.defaultMaxOpen });
      const m: Metrics = computeMetrics(res, DEFAULT_BACKTEST.initialEquity);
      expect(m.trades).toBeGreaterThan(0);
      expect(Number.isFinite(res.finalEquity)).toBe(true);
    }
    expect(getCatalogEntry("xsmom").label).toBe("E");
    expect(getCatalogEntry("funding").needsFunding).toBe(true);
  });

  it("yearly consistency computes a profit factor per year", () => {
    const t = (year: number, pnl: number) => ({ entryTime: Date.UTC(year, 5, 1), netPnl: pnl }) as never;
    const y = yearlyConsistency([t(2025, 10), t(2025, -5), t(2026, -3)]);
    expect(y).toEqual([{ year: 2025, trades: 2, profitFactor: 2 }, { year: 2026, trades: 1, profitFactor: 0 }]);
  });
});

describe("engine with a funding strategy", () => {
  it("attaches funding to the candles before the strategy sees them", async () => {
    const ex = new FakeExchange();
    const candles = candlesFromCloses(new Array(1100).fill(100), T0, H1);
    ex.candles.BTCUSDT = candles;
    ex.funding.BTCUSDT = Array.from({ length: 140 }, (_, k) => ({ time: T0 + k * H8, rate: 0.0002 }));
    ex.now = candles[1050]!.closeTime + 60_000;
    ex.mark.BTCUSDT = 100;
    let seen: Candle[] = [];
    const strat: Strategy = {
      name: "spy", interval: "1h", warmup: 1, needsFunding: true,
      evaluate: (_s, cs) => { seen = cs; return null; },
      updateStop: (p) => p.stop,
    };
    const cfg: EngineConfig = {
      symbols: ["BTCUSDT"], interval: "1h", intervalMs: H1, riskPerTrade: 0.01, maxLeverage: 3, maxOpenPositions: 3,
      dailyLossLimit: 0.03, maxDrawdown: 0.15, maxCandleDelayMs: 15 * 60_000, roundTripCostPct: 0.002,
    };
    await new Engine({ exchange: ex, repo: new MemoryRepo(), strategy: strat, notifier: { send: async () => {} }, cfg, now: () => ex.now }).tick();
    expect(ex.fundingCalls).toBe(1);
    expect(seen.at(-1)!.fundingRate).toBe(0.0002);
  });
});
