import { describe, expect, it } from "vitest";
import { aggregate, createIntrabar } from "../src/strategy/intrabar.js";
import { createTrendBreakout } from "../src/strategy/trendBreakout.js";
import { candlesFromCloses, uptrend } from "./helpers.js";

const M15 = 900_000, H4 = 14_400_000;
// 15m candles whose closes walk linearly between the 4h closes of the uptrend fixture.
const closes4h = uptrend();
const closes15 = closes4h.flatMap((c, i) => Array.from({ length: 16 }, (_, j) => (closes4h[i - 1] ?? c) + ((c - (closes4h[i - 1] ?? c)) * (j + 1)) / 16));
const fast = candlesFromCloses(closes15, Date.UTC(2024, 0, 1), M15);

describe("intrabar harness (round 18)", () => {
  it("aggregates 15m into aligned 4h candles and flags a forming one", () => {
    const { candles, lastClosed } = aggregate(fast.slice(0, 16 * 3 + 5), H4);
    expect(candles).toHaveLength(4);
    expect(candles[1]!.openTime - candles[0]!.openTime).toBe(H4);
    expect(lastClosed).toBe(false);
    expect(aggregate(fast.slice(0, 16 * 3), H4).lastClosed).toBe(true);
  });
  it("closed mode only decides at 4h closes; intrabar can decide earlier", () => {
    const base = createTrendBreakout();
    const closed = createIntrabar(base, "15m", M15, H4, "closed");
    const intra = createIntrabar(base, "15m", M15, H4, "intrabar");
    let firstClosed = -1, firstIntra = -1;
    for (let i = closed.warmup; i <= fast.length; i++) {
      const w = fast.slice(Math.max(0, i - (closed.window ?? 1000)), i);
      if (firstIntra < 0 && intra.evaluate("X", w)) firstIntra = i;
      if (firstClosed < 0 && closed.evaluate("X", w)) firstClosed = i;
      if (firstClosed > 0 && firstIntra > 0) break;
    }
    expect(firstClosed).toBeGreaterThan(0);
    expect(firstClosed % 16).toBe(0); // a 4h boundary
    expect(firstIntra).toBeLessThanOrEqual(firstClosed);
  });
});
