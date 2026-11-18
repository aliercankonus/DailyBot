import { describe, expect, it } from "vitest";
import { blend, correlation, dailyReturns, rebaseFrom } from "../src/backtest/combine.js";

const D = 86_400_000;
const curve = (eqs: number[]) => eqs.map((equity, i) => ({ time: i * D, equity }));

describe("combine", () => {
  it("daily returns from the last point of each day", () => {
    const r = dailyReturns([{ time: 0, equity: 100 }, { time: D / 2, equity: 105 }, { time: D, equity: 110 }]);
    expect(r.get(1)).toBeCloseTo(110 / 105 - 1);
  });

  it("blends daily returns with fixed weights", () => {
    const a = curve([100, 110, 121]); // +10% / +10%
    const b = curve([100, 90, 81]);   // -10% / -10%
    const c = blend([a, b], [0.5, 0.5]);
    expect(c.at(-1)!.equity).toBeCloseTo(1);
    const d = blend([a, b], [0.75, 0.25]);
    expect(d.at(-1)!.equity).toBeCloseTo(1.05 * 1.05);
  });

  it("correlation and rebasing", () => {
    expect(correlation(curve([100, 110, 99, 120]), curve([50, 55, 49.5, 60]))).toBeCloseTo(1);
    expect(correlation(curve([100, 110, 99, 120]), curve([100, 90, 99, 80]))).toBeLessThan(-0.9);
    expect(rebaseFrom(curve([100, 200, 300]), D)[0]!.equity).toBe(1);
  });
});
