import { describe, expect, it } from "vitest";
import { atr, ema, priorHighest, rsi } from "../src/core/indicators.js";
import { evaluateGates, type GateContext } from "../src/risk/gates.js";
import { ceilToStep, decimalsOf, floorToStep, fmt } from "../src/risk/precision.js";
import { sizePosition } from "../src/risk/sizing.js";
import { createTrendBreakout } from "../src/strategy/trendBreakout.js";
import { candlesFromCloses, FILTERS, uptrend } from "./helpers.js";

describe("indicators have no look-ahead", () => {
  it("value at i does not change when future candles change", () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const a = candlesFromCloses(closes);
    const b = candlesFromCloses([...closes.slice(0, 250), ...closes.slice(250).map((c) => c * 3)]);
    for (const i of [30, 120, 249]) {
      expect(ema(b.map((c) => c.close), 50)[i]).toBe(ema(a.map((c) => c.close), 50)[i]);
      expect(atr(b, 14)[i]).toBe(atr(a, 14)[i]);
      expect(rsi(b.map((c) => c.close), 14)[i]).toBe(rsi(a.map((c) => c.close), 14)[i]);
      expect(priorHighest(b, 20)[i]).toBe(priorHighest(a, 20)[i]);
    }
  });

  it("priorHighest excludes the current candle", () => {
    const c = candlesFromCloses([1, 2, 3, 10], undefined, undefined, 0);
    expect(priorHighest(c, 3)[3]).toBe(3);
  });

  it("ema of a constant is the constant", () => {
    expect(ema(new Array(30).fill(5), 10)[29]).toBeCloseTo(5);
  });
});

describe("precision", () => {
  it("floors and ceils without float noise", () => {
    expect(floorToStep(0.30000000000000004, 0.1)).toBe(0.3);
    expect(floorToStep(1.23456, 0.001)).toBe(1.234);
    expect(ceilToStep(1.2341, 0.001)).toBe(1.235);
    expect(floorToStep(2.9999999999, 1)).toBe(3);
    expect(fmt(0.00001, 0.00001)).toBe("0.00001");
  });
  it("handles exponent steps with a mantissa fraction", () => {
    expect(decimalsOf(1.5e-7)).toBe(8);
    expect(decimalsOf(1e-8)).toBe(8);
    expect(decimalsOf(0.1)).toBe(1);
    expect(decimalsOf(10)).toBe(0);
  });
  it("snaps large values without spurious rounding", () => {
    expect(floorToStep(99999.99999, 0.0001)).toBe(99999.9999);
    expect(floorToStep(123456.7, 0.1)).toBe(123456.7);
  });
});

describe("sizing", () => {
  const base = { equity: 10_000, availableBalance: 10_000, entryPrice: 100, riskPerTrade: 0.01, maxLeverage: 3, filters: FILTERS };

  it("loses ~riskPerTrade at the stop", () => {
    const r = sizePosition({ ...base, stopPrice: 95 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.quantity).toBe(20);
      expect(r.riskAmount).toBeCloseTo(100);
      expect(r.leverage).toBe(1);
    }
  });

  it("keeps the liquidation price beyond the stop", () => {
    // 2% stop -> liq-safe leverage = floor(0.5 / 0.02) = 25, capped by maxLeverage 3.
    // Wide 30% stop -> liq-safe leverage 1.
    const r = sizePosition({ ...base, stopPrice: 70, maxLeverage: 5, riskPerTrade: 0.02 });
    expect(r.ok && r.leverage).toBe(1);
    const tooWide = sizePosition({ ...base, stopPrice: 40 });
    expect(tooWide.ok).toBe(false);
  });

  it("shrinks to available margin", () => {
    const r = sizePosition({ ...base, availableBalance: 100, stopPrice: 99.5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.notional / r.leverage).toBeLessThanOrEqual(95 + 1e-9);
  });

  it("rejects NaN or non-positive inputs", () => {
    expect(sizePosition({ ...base, stopPrice: 95, availableBalance: NaN }).ok).toBe(false);
    expect(sizePosition({ ...base, stopPrice: 95, riskPerTrade: NaN }).ok).toBe(false);
    expect(sizePosition({ ...base, stopPrice: 95, maxLeverage: 0 }).ok).toBe(false);
    expect(sizePosition({ ...base, stopPrice: 100 }).ok).toBe(false);
  });

  it("counts round-trip costs as risk", () => {
    const r = sizePosition({ ...base, stopPrice: 95, roundTripCostPct: 0.01 });
    expect(r.ok && r.quantity).toBe(16.666);
    if (r.ok) expect(r.riskAmount).toBeLessThanOrEqual(100);
  });

  it("uses the stricter of LOT_SIZE and MARKET_LOT_SIZE", () => {
    const r = sizePosition({ ...base, stopPrice: 95, filters: { ...FILTERS, marketStepSize: 1, marketMaxQty: 5 } });
    expect(r.ok && r.quantity).toBe(5);
  });

  it("rejects below min notional", () => {
    const r = sizePosition({ ...base, equity: 10, availableBalance: 10, stopPrice: 50, riskPerTrade: 0.001 });
    expect(r.ok).toBe(false);
  });
});

describe("gates", () => {
  const ok: GateContext = {
    killSwitch: false, dataFresh: true, hasSignal: true, symbolHasPosition: false, openPositions: 0,
    maxOpenPositions: 3, dayPnlPct: 0, dailyLossLimit: 0.03, drawdownPct: 0, maxDrawdown: 0.15,
  };
  it("passes a clean context", () => expect(evaluateGates(ok).ok).toBe(true));
  it("fails closed on NaN inputs", () => {
    expect(evaluateGates({ ...ok, drawdownPct: NaN }).ok).toBe(false);
    expect(evaluateGates({ ...ok, dayPnlPct: NaN }).ok).toBe(false);
    expect(evaluateGates({ ...ok, openPositions: NaN }).ok).toBe(false);
  });
  it("limits are inclusive", () => {
    expect(evaluateGates({ ...ok, drawdownPct: 0.15 }).ok).toBe(false);
    expect(evaluateGates({ ...ok, drawdownPct: 0.1499 }).ok).toBe(true);
    expect(evaluateGates({ ...ok, dayPnlPct: -0.03 }).ok).toBe(false);
    expect(evaluateGates({ ...ok, dayPnlPct: -0.0299 }).ok).toBe(true);
    expect(evaluateGates({ ...ok, openPositions: 2 }).ok).toBe(true);
  });
  it.each([
    [{ killSwitch: true }, "KILL_SWITCH"],
    [{ dataFresh: false }, "DATA_STALE"],
    [{ drawdownPct: 0.2 }, "MAX_DRAWDOWN"],
    [{ dayPnlPct: -0.05 }, "DAILY_LOSS_LIMIT"],
    [{ hasSignal: false }, "NO_SIGNAL"],
    [{ symbolHasPosition: true }, "ALREADY_IN_POSITION"],
    [{ openPositions: 3 }, "MAX_OPEN_POSITIONS"],
  ] as const)("%o -> %s", (patch, gate) => {
    const r = evaluateGates({ ...ok, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.gate).toBe(gate);
  });
});

describe("trend breakout strategy", () => {
  const s = createTrendBreakout();
  it("signals long on an up-trend breakout", () => {
    const c = candlesFromCloses(uptrend());
    let found = null;
    for (let i = s.warmup; i <= c.length && !found; i++) found = s.evaluate("X", c.slice(0, i));
    expect(found?.side).toBe("LONG");
    expect(found!.stop).toBeLessThan(found!.refPrice);
  });

  it("signals short on a mirrored down-trend", () => {
    const c = candlesFromCloses(uptrend().map((x) => 200 - x));
    let found = null;
    for (let i = s.warmup; i <= c.length && !found; i++) found = s.evaluate("X", c.slice(0, i));
    expect(found?.side).toBe("SHORT");
    expect(found!.stop).toBeGreaterThan(found!.refPrice);
  });

  it("no signal before warm-up", () => {
    expect(s.evaluate("X", candlesFromCloses(uptrend()).slice(0, s.warmup - 1))).toBeNull();
  });

  it("trailing stop never loosens", () => {
    const c = candlesFromCloses(uptrend());
    const pos = { side: "LONG" as const, entryPrice: 100, stop: 1e9, entryCandleOpenTime: c[0]!.openTime };
    expect(s.updateStop(pos, c)).toBe(1e9);
    const shortPos = { side: "SHORT" as const, entryPrice: 100, stop: 1, entryCandleOpenTime: c[0]!.openTime };
    expect(s.updateStop(shortPos, c)).toBe(1);
  });
});
