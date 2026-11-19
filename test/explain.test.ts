import { describe, expect, it } from "vitest";
import { createGoldenCross } from "../src/strategy/popular.js";
import { getStrategy } from "../src/strategy/registry.js";
import { createTsmom } from "../src/strategy/tsmom.js";
import { candlesFromCloses } from "./helpers.js";

const H1 = 3_600_000, H4 = 4 * H1;
const closes = Array.from({ length: 600 }, (_, i) => 100 + i * 0.05 + Math.sin(i / 9) * 4);

describe("explain() (diagnostics for 'no signal')", () => {
  it.each([
    ["trendlv+timestop", H4, /trend (up|down|mixed).*atr .*%/],
    ["gcross1h", H1, /ema50 .* ema200 .*gap/],
    ["tsmom4h", H4, /momentum score -?\d\.\d\d \(entry >= 0\.6\)/],
  ])("%s describes the entry conditions", (name, step, re) => {
    const s = getStrategy(name).create({});
    const c = candlesFromCloses(closes, Date.UTC(2025, 0, 1), step);
    expect(s.explain?.(c)).toMatch(re);
  });

  it("reports warm-up on short history", () => {
    const c = candlesFromCloses(closes.slice(0, 50), Date.UTC(2025, 0, 1), H4);
    expect(createTsmom(undefined, "4h").explain?.(c)).toMatch(/warming up/);
    expect(createGoldenCross("1h").explain?.(c)).toMatch(/warming up/);
    expect(getStrategy("trendlv").create({}).explain?.(c)).toMatch(/warming up/);
  });

  it("does not change evaluate()", () => {
    const s = getStrategy("trendlv+timestop").create({});
    const c = candlesFromCloses(closes, Date.UTC(2025, 0, 1), H4);
    const before = s.evaluate("BTCUSDT", c);
    s.explain?.(c);
    expect(s.evaluate("BTCUSDT", c)).toEqual(before);
  });
});
