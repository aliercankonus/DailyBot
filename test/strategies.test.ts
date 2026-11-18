import { describe, expect, it } from "vitest";
import { adx, aggregate, bollinger, sma } from "../src/core/indicators.js";
import type { Candle, OpenPositionView, Signal } from "../src/core/types.js";
import { DEFAULT_BACKTEST, runBacktest } from "../src/backtest/engine.js";
import { perturbParam } from "../src/backtest/metrics.js";
import { createMeanReversion, DEFAULT_MEAN_REVERSION } from "../src/strategy/meanReversion.js";
import { createPullback } from "../src/strategy/pullback.js";
import { getStrategy, STRATEGIES, STRATEGY_NAMES } from "../src/strategy/registry.js";
import type { Strategy } from "../src/strategy/types.js";
import { candlesFromCloses } from "./helpers.js";

const H1 = 3_600_000;
const H4 = 4 * H1;
const noCosts = { ...DEFAULT_BACKTEST, takerFee: 0, slippage: 0, fundingPer8h: 0 };

/** Deterministic noise in [-0.5, 0.5). */
function noise(seed = 42) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
}

describe("new indicators have no look-ahead", () => {
  const closes = Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 7) * 8 + Math.cos(i / 3));
  const a = candlesFromCloses(closes, Date.UTC(2024, 0, 1), H1);
  const b = candlesFromCloses([...closes.slice(0, 300), ...closes.slice(300).map((x) => x * 2)], Date.UTC(2024, 0, 1), H1);
  it.each([50, 150, 299])("index %i unchanged by future candles", (i) => {
    expect(sma(b.map((c) => c.close), 20)[i]).toBe(sma(a.map((c) => c.close), 20)[i]);
    expect(bollinger(b.map((c) => c.close), 20, 2).lower[i]).toBe(bollinger(a.map((c) => c.close), 20, 2).lower[i]);
    expect(adx(b, 14)[i]).toBe(adx(a, 14)[i]);
  });

  it("sma and bollinger basics", () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([NaN, 1.5, 2.5, 3.5]);
    const bb = bollinger([2, 2, 2, 2], 4, 2);
    expect(bb.upper[3]).toBe(2);
    expect(bb.lower[3]).toBe(2);
  });

  it("adx is high in a steady trend and low in chop", () => {
    const trend = candlesFromCloses(Array.from({ length: 200 }, (_, i) => 100 * 1.01 ** i), undefined, H1);
    const r = noise();
    const chop = candlesFromCloses(Array.from({ length: 200 }, () => 100 + r()), undefined, H1);
    expect(adx(trend, 14).at(-1)!).toBeGreaterThan(40);
    expect(adx(chop, 14).at(-1)!).toBeLessThan(30);
  });
});

describe("aggregate (1h -> 4h)", () => {
  it("returns only complete, UTC-aligned buckets", () => {
    const start = Date.UTC(2024, 0, 1, 2); // starts mid-bucket at 02:00
    const c = candlesFromCloses(Array.from({ length: 11 }, (_, i) => 100 + i), start, H1); // 02:00 .. 12:00
    const h4 = aggregate(c, H1, H4);
    // 00-04 incomplete (starts at 02), 04-08 and 08-12 complete, 12-16 incomplete
    expect(h4.map((k) => new Date(k.openTime).getUTCHours())).toEqual([4, 8]);
    expect(h4[0]!.open).toBe(c[2]!.open);
    expect(h4[0]!.close).toBe(c[5]!.close);
    expect(h4[0]!.high).toBe(Math.max(...c.slice(2, 6).map((k) => k.high)));
  });

  it("a forming bucket never appears", () => {
    const c = candlesFromCloses(Array.from({ length: 7 }, (_, i) => 100 + i), Date.UTC(2024, 0, 1), H1); // 00:00..06:00
    expect(aggregate(c, H1, H4)).toHaveLength(1);
  });
});

/** 1h series: long 4h up-trend, then a sharp pullback, then recovery. */
function pullbackSeries(): Candle[] {
  const closes: number[] = [];
  let p = 100;
  for (let i = 0; i < 400; i++) closes.push((p *= 1.002));
  for (let i = 0; i < 8; i++) closes.push((p *= 0.985)); // pullback, RSI falls below 35
  for (let i = 0; i < 40; i++) closes.push((p *= 1.006)); // recovery, RSI crosses back up
  return candlesFromCloses(closes, Date.UTC(2024, 0, 1), H1, 0.001);
}

function firstSignal(s: Strategy, c: Candle[]): { i: number; sig: Signal } | null {
  for (let i = s.warmup; i <= c.length; i++) {
    const sig = s.evaluate("X", c.slice(0, i));
    if (sig) return { i: i - 1, sig };
  }
  return null;
}

describe("strategy B: pullback", () => {
  const s = createPullback();
  it("goes long when RSI recovers inside a 4h up-trend", () => {
    const hit = firstSignal(s, pullbackSeries());
    expect(hit?.sig.side).toBe("LONG");
    expect(hit!.i).toBeGreaterThanOrEqual(408);
    expect(hit!.sig.stop).toBeLessThan(hit!.sig.refPrice);
  });

  it("goes short on the mirrored series", () => {
    const mirrored = pullbackSeries().map((c) => ({ ...c, open: 1000 - c.open, close: 1000 - c.close, high: 1000 - c.low, low: 1000 - c.high }));
    expect(firstSignal(s, mirrored)?.sig.side).toBe("SHORT");
  });

  it("exits at the R target and never moves the stop", () => {
    const pos: OpenPositionView = { side: "LONG", entryPrice: 100, stop: 95, initialStop: 95, entryCandleOpenTime: 0 };
    const at = (close: number) => candlesFromCloses([close], 0, H1);
    expect(s.shouldExit!(pos, at(109.9))).toBe(false);
    expect(s.shouldExit!(pos, at(110))).toBe(true);
    expect(s.updateStop(pos, at(120))).toBe(95);
    const short: OpenPositionView = { side: "SHORT", entryPrice: 100, stop: 105, initialStop: 105, entryCandleOpenTime: 0 };
    expect(s.shouldExit!(short, at(90))).toBe(true);
  });
});

/** 1h range-bound noise with a dip below the lower band (index 200) and a recovery (201). */
function rangeSeries(): Candle[] {
  const r = noise();
  const closes: number[] = [];
  for (let i = 0; i < 200; i++) closes.push(100 + r());
  closes.push(98.6, 99.9, 100.3, 100.2, 100.1, 100, 99.9);
  return candlesFromCloses(closes, Date.UTC(2024, 0, 1), H1, 0.001);
}

describe("strategy C: mean reversion", () => {
  const s = createMeanReversion();
  it("goes long when price closes back inside the lower band in a range", () => {
    // ADX of this noise is ~21, so the band logic is tested with a looser regime limit;
    // the ADX filter itself is tested below.
    const loose = createMeanReversion({ ...DEFAULT_MEAN_REVERSION, adxMax: 30 });
    const c = rangeSeries();
    expect(loose.evaluate("X", c.slice(0, 201))).toBeNull(); // the dip candle itself: still outside the band
    const sig = loose.evaluate("X", c.slice(0, 202));        // closes back inside
    expect(sig?.side).toBe("LONG");
    expect(sig!.stop).toBeLessThan(sig!.refPrice);
  });

  it("the same setup is skipped when ADX is above the limit", () => {
    const strict = createMeanReversion({ ...DEFAULT_MEAN_REVERSION, adxMax: 15 });
    expect(strict.evaluate("X", rangeSeries().slice(0, 202))).toBeNull();
  });

  it("does not trade in a strong trend (ADX filter)", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 * 1.01 ** i);
    closes.push(closes.at(-1)! * 0.9, closes.at(-1)!);
    expect(firstSignal(s, candlesFromCloses(closes, undefined, H1))).toBeNull();
  });

  it("exits at the middle band or after maxBars", () => {
    const below = candlesFromCloses([...new Array(19).fill(100), 99], 0, H1); // close 99 < mid 99.95
    const above = candlesFromCloses([...new Array(19).fill(100), 101], 0, H1); // close 101 > mid 100.05
    const pos: OpenPositionView = { side: "LONG", entryPrice: 99, stop: 98, initialStop: 98, entryCandleOpenTime: below.at(-1)!.openTime };
    expect(s.shouldExit!(pos, below)).toBe(false);
    expect(s.shouldExit!(pos, above)).toBe(true);
    expect(s.shouldExit!({ ...pos, side: "SHORT", stop: 102, initialStop: 102 }, below)).toBe(true);
    const flat = candlesFromCloses(new Array(30).fill(99), 0, H1);
    const timePos: OpenPositionView = { ...pos, entryPrice: 99, entryCandleOpenTime: flat[30 - DEFAULT_MEAN_REVERSION.maxBars]!.openTime };
    expect(s.shouldExit!(timePos, flat)).toBe(true);
  });
});

describe("backtest strategy exits", () => {
  it("fills a shouldExit at the next candle's open with reason SIGNAL", () => {
    const strat: Strategy = {
      name: "exit-test", interval: "1h", warmup: 1,
      evaluate: (symbol, candles) => candles.length === 2
        ? { symbol, side: "LONG", refPrice: candles.at(-1)!.close, stop: 50, candleOpenTime: candles.at(-1)!.openTime, reason: "t" }
        : null,
      updateStop: (p) => p.stop,
      shouldExit: (_p, candles) => candles.length === 4,
    };
    const c = candlesFromCloses([100, 100, 101, 102, 103, 104], undefined, H1, 0);
    const r = runBacktest(strat, { X: c }, noCosts);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.exitReason).toBe("SIGNAL");
    expect(r.trades[0]!.exitPrice).toBe(c[4]!.open);
    expect(r.trades[0]!.entryPrice).toBe(c[2]!.open);
  });
});

describe("registry", () => {
  it("every strategy has a matching interval", () => {
    expect(STRATEGY_NAMES).toEqual(["trend", "pullback", "meanrev", "funding", "tsmom", "failedbo", "squeeze", "capit", "dpullback"]);
    for (const name of STRATEGY_NAMES) {
      const e = getStrategy(name);
      expect(e.create().interval).toBe(e.interval);
      for (const k of e.integerKeys) expect(Number.isInteger(e.defaults[k])).toBe(true);
    }
    expect(() => getStrategy("toString")).toThrow();
  });

  it("robustness rounds only integer keys", () => {
    const e = STRATEGIES.meanrev;
    expect(perturbParam("maxBars", 24, 0.8, e.integerKeys)).toBe(19);
    expect(perturbParam("bbStd", 2, 0.8, e.integerKeys)).toBeCloseTo(1.6);
  });
});
