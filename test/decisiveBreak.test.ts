import { describe, expect, it } from "vitest";
import { atr, priorLowest } from "../src/core/indicators.js";
import { createTrendBreakout, DEFAULT_TREND_BREAKOUT } from "../src/strategy/trendBreakout.js";
import { getStrategy } from "../src/strategy/registry.js";
import { candlesFromCloses } from "./helpers.js";

const H4 = 4 * 3_600_000;
const T0 = Date.UTC(2024, 0, 1);
// Downtrend, then a last close that breaks the 20-bar low by `depth` ATRs.
function series(depth: number) {
  const closes = Array.from({ length: 400 }, (_, i) => 1000 - i * 0.5);
  const base = candlesFromCloses(closes, T0, H4);
  const lo = priorLowest(base, 20).at(-1)!, a = atr(base, 14).at(-1)!;
  return candlesFromCloses([...closes.slice(0, -1), lo - depth * a], T0, H4);
}

describe("decisive-break margin", () => {
  const p = { ...DEFAULT_TREND_BREAKOUT, breakoutAtr: 0.25 };
  it("skips a break that clears the low by less than the margin and logs it as a weak break", () => {
    const s = createTrendBreakout(p);
    const weak = series(0.05);
    expect(s.evaluate("BTCUSDT", weak)).toBeNull();
    expect(createTrendBreakout(DEFAULT_TREND_BREAKOUT).evaluate("BTCUSDT", weak)?.side).toBe("SHORT");
    expect(s.explain!(weak)).toMatch(/BLOCKED: weak break/);
  });
  it("takes a decisive break", () => {
    expect(createTrendBreakout(p).evaluate("BTCUSDT", series(0.6))?.side).toBe("SHORT");
  });
  it("is live as trendlvfcd with margin 0.25 ATR", () => {
    expect(getStrategy("trendlvfcd+timestop+befee").create().name).toMatch(/break>=0.25atr/);
  });
});
