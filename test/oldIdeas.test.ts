import { describe, expect, it } from "vitest";
import type { Candle, OpenPositionView } from "../src/core/types.js";
import { closeR, EXIT_PRESETS, mfeR, overlayExit, overlayStop, withExits } from "../src/strategy/exitOverlays.js";
import { createCapitulation, createDailyPullback, createFailedBreakout, createSqueezeBreakout } from "../src/strategy/oldIdeas.js";
import { getStrategy } from "../src/strategy/registry.js";
import { createTrendBreakout } from "../src/strategy/trendBreakout.js";
import { candlesFromCloses } from "./helpers.js";

const D1 = 86_400_000;
const H4 = 4 * 3_600_000;
const T0 = Date.UTC(2023, 0, 1);

function bar(t: number, o: number, h: number, l: number, c: number): Candle {
  return { openTime: t, closeTime: t + D1 - 1, open: o, high: h, low: l, close: c, volume: 1 };
}

/** 40 flat-ish daily bars in a 95..105 range. */
function range(): Candle[] {
  return Array.from({ length: 40 }, (_, i) => bar(T0 + i * D1, 100, 105 - (i % 3), 95 + (i % 3), 100 + ((i % 5) - 2) * 0.5));
}

describe("S1 failed breakout", () => {
  const s = createFailedBreakout();
  it("longs a sweep of the 20-day low that closes back inside, high in its range", () => {
    const c = [...range(), bar(T0 + 40 * D1, 99, 100.5, 90, 100)]; // low 90 < 95, close 100 > 95, rank (100-90)/10.5 = 0.95
    const sig = s.evaluate("X", c);
    expect(sig?.side).toBe("LONG");
    expect(sig!.stop).toBeLessThan(90);
  });
  it("ignores a breakdown that closes below the level", () => {
    const c = [...range(), bar(T0 + 40 * D1, 99, 99.5, 90, 92)];
    expect(s.evaluate("X", c)).toBeNull();
  });
  it("shorts a sweep of the high that closes back below, low in its range", () => {
    const c = [...range(), bar(T0 + 40 * D1, 101, 110, 99.5, 100)];
    expect(s.evaluate("X", c)?.side).toBe("SHORT");
  });
  it("exits at the channel midpoint or after maxBars", () => {
    const c = range();
    const pos: OpenPositionView = { side: "LONG", entryPrice: 96, stop: 88, initialStop: 88, entryCandleOpenTime: c[35]!.openTime };
    const mid = [...c.slice(0, -1), bar(c.at(-1)!.openTime, 100, 101, 99, 100.5)];
    expect(s.shouldExit!(pos, mid)).toBe(true);
    expect(s.shouldExit!({ ...pos, entryCandleOpenTime: c[0]!.openTime }, c.slice(0, 12))).toBe(true);
  });
});

describe("S2 squeeze breakout", () => {
  it("needs a prior squeeze before a band break", () => {
    const s = createSqueezeBreakout();
    // wide swings, then a tight range, then a break
    const closes = [
      ...Array.from({ length: 150 }, (_, i) => 100 + Math.sin(i / 2) * 8),
      ...Array.from({ length: 20 }, (_, i) => 100 + (i % 2 ? 0.2 : -0.2)),
      104,
    ];
    const c = candlesFromCloses(closes, T0, H4, 0.002);
    expect(s.evaluate("X", c)?.side).toBe("LONG");
    // Width is judged against its own history, so "no squeeze" needs steadily widening swings.
    const widening = Array.from({ length: 170 }, (_, i) => 100 + Math.sin(i / 2) * (1 + i * 0.1));
    const noSqueeze = candlesFromCloses([...widening, 150], T0, H4);
    expect(s.evaluate("X", noSqueeze)).toBeNull();
  });
});

describe("S3 capitulation", () => {
  const s = createCapitulation();
  it("buys the first up-close after a drop of >= 3 ATR", () => {
    const calm = Array.from({ length: 40 }, (_, i) => bar(T0 + i * D1, 100, 101, 99, 100));
    const drop = [bar(T0 + 40 * D1, 100, 100, 95, 95), bar(T0 + 41 * D1, 95, 95, 90, 90), bar(T0 + 42 * D1, 90, 90, 85, 86)];
    const bounce = bar(T0 + 43 * D1, 86, 89, 85.5, 88.5);
    const sig = s.evaluate("X", [...calm, ...drop, bounce]);
    expect(sig?.side).toBe("LONG");
    expect(sig!.stop).toBeLessThan(85);
    expect(s.evaluate("X", [...calm, ...drop, bar(T0 + 43 * D1, 86, 86, 83, 84)])).toBeNull(); // no up close
  });
});

describe("S4 daily pullback", () => {
  const s = createDailyPullback();
  it("buys a sharp dip inside an up-trend and exits when RSI(3) recovers", () => {
    const up = Array.from({ length: 150 }, (_, i) => 100 * 1.004 ** i);
    const dip = [...up, up.at(-1)! * 0.97, up.at(-1)! * 0.94];
    const c = candlesFromCloses(dip, T0, D1, 0.005);
    expect(s.evaluate("X", c)?.side).toBe("LONG");
    const pos: OpenPositionView = { side: "LONG", entryPrice: 170, stop: 160, initialStop: 160, entryCandleOpenTime: c.at(-1)!.openTime };
    const rec = candlesFromCloses([...dip, up.at(-1)! * 0.99, up.at(-1)! * 1.03], T0, D1, 0.005);
    expect(s.shouldExit!(pos, rec)).toBe(true);
  });
});

describe("exit overlays (R units)", () => {
  const c = (closes: number[]) => candlesFromCloses(closes, T0, D1, 0);
  const pos: OpenPositionView = { side: "LONG", entryPrice: 100, stop: 90, initialStop: 90, entryCandleOpenTime: T0 };

  it("MFE and close in R", () => {
    const k = c([100, 105, 112, 108]);
    expect(mfeR(pos, k)).toBeCloseTo(1.2);
    expect(closeR(pos, k)).toBeCloseTo(0.8);
  });

  it("break-even moves the stop to entry + buffer after 1R, never loosens", () => {
    expect(overlayStop(EXIT_PRESETS.be!, pos, c([100, 105]))).toBe(90);
    expect(overlayStop(EXIT_PRESETS.be!, pos, c([100, 111]))).toBeCloseTo(100.2);
    expect(overlayStop(EXIT_PRESETS.be!, { ...pos, stop: 105 }, c([100, 111]))).toBe(105);
  });

  it("lock tiers lock 0.75R at a 2R peak", () => {
    expect(overlayStop(EXIT_PRESETS.lock!, pos, c([100, 121, 115]))).toBeCloseTo(107.5);
  });

  it("R trailing follows the close once 1.2R in profit", () => {
    expect(overlayStop(EXIT_PRESETS.trail!, pos, c([100, 113]))).toBeCloseTo(113 - 7.5);
    expect(overlayStop(EXIT_PRESETS.trail!, pos, c([100, 111]))).toBe(90);
  });

  it("time stops: early invalidation and loser time stop", () => {
    expect(overlayExit(EXIT_PRESETS.timestop!, pos, c([100, 99, 97, 95]))).toBe(true); // 4 bars, MFE 0, -0.5R
    expect(overlayExit(EXIT_PRESETS.timestop!, pos, c([100, 104, 97]))).toBe(false);
  });

  it("works for shorts", () => {
    const sp: OpenPositionView = { side: "SHORT", entryPrice: 100, stop: 110, initialStop: 110, entryCandleOpenTime: T0 };
    expect(overlayStop(EXIT_PRESETS.be!, sp, c([100, 89]))).toBeCloseTo(99.8);
  });

  it("withExits keeps the base stop when tighter and ORs the exits", () => {
    const base = createTrendBreakout();
    const wrapped = withExits(base, EXIT_PRESETS.be!, "be");
    expect(wrapped.name).toContain("+ be");
    expect(wrapped.updateStop({ ...pos, stop: 108 }, c([100, 111]))).toBeGreaterThanOrEqual(108);
  });

  it("registry resolves base+preset names", () => {
    const e = getStrategy("trend+lock");
    expect(e.label).toBe("A+lock");
    expect(e.create().name).toContain("+ lock");
    expect(() => getStrategy("trend+nope")).toThrow();
    expect(getStrategy("failedbo").interval).toBe("1d");
    expect(getStrategy("squeeze").interval).toBe("4h");
  });
});

import { DEFAULT_BACKTEST, runBacktest } from "../src/backtest/engine.js";
import type { Strategy } from "../src/strategy/types.js";

describe("risk modifiers in the backtest", () => {
  // Enters long every 3rd bar with a stop 5% below; every bar drops 6%, so every trade is a stop-out loss.
  const loser: Strategy = {
    name: "loser", interval: "1d", warmup: 1,
    evaluate: (symbol, cs) => (cs.length % 3 === 0 ? { symbol, side: "LONG", refPrice: cs.at(-1)!.close, stop: cs.at(-1)!.close * 0.95, candleOpenTime: cs.at(-1)!.openTime, reason: "t" } : null),
    updateStop: (p) => p.stop,
  };
  const closes = Array.from({ length: 40 }, (_, i) => 100 * 0.94 ** i);
  const c = candlesFromCloses(closes, T0, D1, 0);
  const free = { ...DEFAULT_BACKTEST, takerFee: 0, slippage: 0, fundingPer8h: 0 };

  it("loss streak halves the risk after 3 consecutive losses", () => {
    const base = runBacktest(loser, { X: c }, free);
    const mod = runBacktest(loser, { X: c }, { ...free, riskModifiers: { lossStreak: true } });
    const notional = (t: { quantity: number; entryPrice: number }) => t.quantity * t.entryPrice;
    const ratio = (r: typeof base, i: number) => notional(r.trades[i]!) / notional(r.trades[0]!);
    expect(ratio(mod, 3) / ratio(base, 3)).toBeCloseTo(0.5, 1);
    expect(ratio(mod, 2) / ratio(base, 2)).toBeCloseTo(1, 1);
  });

  it("partial take-profits: TP1 at 1R, break-even, runner stopped at break-even = one trade", () => {
    // Enter at the open of bar 2 (100), stop 90. Bar 2 reaches 110 (TP1, half closed) but also
    // trades at 100: the rest is assumed stopped at break-even in the same candle (pessimistic).
    const once: Strategy = {
      name: "once", interval: "1d", warmup: 1,
      evaluate: (symbol, cs) => (cs.length === 2 ? { symbol, side: "LONG", refPrice: 100, stop: 90, candleOpenTime: cs.at(-1)!.openTime, reason: "t" } : null),
      updateStop: (p) => p.stop,
      takeProfit: { levels: [{ r: 1, fraction: 0.5 }], breakEvenAfterFirst: true },
    };
    const k = [bar(T0, 100, 100, 100, 100), bar(T0 + D1, 100, 100, 100, 100), bar(T0 + 2 * D1, 100, 110, 100, 108), bar(T0 + 3 * D1, 105, 106, 99, 100), bar(T0 + 4 * D1, 100, 100, 100, 100)];
    const r = runBacktest(once, { X: k }, free);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t.exitReason).toBe("STOP");
    expect(t.exitPrice).toBeCloseTo(105); // half at 110, half at 100
    expect(t.r).toBeCloseTo(0.5);
    expect(r.finalEquity - free.initialEquity).toBeCloseTo(t.netPnl);
  });

  it("a candle that touches both the stop and TP1 is a stop-out", () => {
    const once: Strategy = {
      name: "once", interval: "1d", warmup: 1,
      evaluate: (symbol, cs) => (cs.length === 2 ? { symbol, side: "SHORT", refPrice: 100, stop: 110, candleOpenTime: cs.at(-1)!.openTime, reason: "t" } : null),
      updateStop: (p) => p.stop,
      takeProfit: { levels: [{ r: 1, fraction: 0.5 }], breakEvenAfterFirst: true },
    };
    const k = [bar(T0, 100, 100, 100, 100), bar(T0 + D1, 100, 100, 100, 100), bar(T0 + 2 * D1, 100, 111, 89, 100), bar(T0 + 3 * D1, 100, 100, 100, 100)];
    const t = runBacktest(once, { X: k }, free).trades[0]!;
    expect(t.exitReason).toBe("STOP");
    expect(t.r).toBeCloseTo(-1);
  });

  it("all levels filled closes the whole position; presets compose", () => {
    const once: Strategy = {
      name: "once", interval: "1d", warmup: 1,
      evaluate: (symbol, cs) => (cs.length === 2 ? { symbol, side: "LONG", refPrice: 100, stop: 90, candleOpenTime: cs.at(-1)!.openTime, reason: "t" } : null),
      updateStop: (p) => p.stop,
      takeProfit: { levels: [{ r: 1, fraction: 0.5 }, { r: 2, fraction: 0.5 }], breakEvenAfterFirst: false },
    };
    const k = [bar(T0, 100, 100, 100, 100), bar(T0 + D1, 100, 100, 100, 100), bar(T0 + 2 * D1, 100, 125, 100, 120), bar(T0 + 3 * D1, 120, 120, 120, 120)];
    const r = runBacktest(once, { X: k }, free);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.r).toBeCloseTo(1.5);
    const e = getStrategy("trend+tp12+timestop");
    expect(e.label).toBe("A+tp12+timestop");
    expect(e.create().takeProfit?.levels).toHaveLength(2);
  });

  it("maxSameDirection caps open positions on one side", () => {
    const always: Strategy = {
      name: "always", interval: "1d", warmup: 1,
      evaluate: (symbol, cs) => ({ symbol, side: "LONG", refPrice: cs.at(-1)!.close, stop: cs.at(-1)!.close * 0.5, candleOpenTime: cs.at(-1)!.openTime, reason: "t" }),
      updateStop: (p) => p.stop,
    };
    const flat = candlesFromCloses(new Array(10).fill(100), T0, D1, 0);
    const data = { A: flat, B: flat, C: flat };
    expect(runBacktest(always, data, free).trades).toHaveLength(3);
    expect(runBacktest(always, data, { ...free, maxSameDirection: 2 }).trades).toHaveLength(2);
  });

  it("re-entry cooldown blocks the same direction for N bars after a stop", () => {
    // `loser` enters every 3rd bar and every trade is stopped on its entry bar.
    const base = runBacktest(loser, { X: c }, free);
    const cool = runBacktest(loser, { X: c }, { ...free, reentryCooldownBars: 4 });
    expect(cool.trades.length).toBeLessThan(base.trades.length);
    for (let i = 1; i < cool.trades.length; i++) {
      expect(cool.trades[i]!.entryTime - cool.trades[i - 1]!.exitTime).toBeGreaterThan(4 * D1);
    }
  });

  it("drawdown scaling reduces risk as equity falls", () => {
    const base = runBacktest(loser, { X: c }, free);
    const mod = runBacktest(loser, { X: c }, { ...free, riskModifiers: { ddScale: true } });
    expect(mod.finalEquity).toBeGreaterThan(base.finalEquity);
  });
});
