import { describe, expect, it } from "vitest";
import { deviations, EXPECTATIONS, paperStats, postMortemDue } from "../src/report/paperStats.js";

const D = 86_400_000;

describe("paper stats", () => {
  const equity = [10_000, 10_200, 9_900, 10_500, 10_400, 10_800, 11_000].map((e, i) => ({ time: i * D, equity: e }));
  const trades = [
    { realizedPnl: 300, riskAmount: 100, fees: 2, exitTime: D },
    { realizedPnl: -100, riskAmount: 100, fees: 2, exitTime: 2 * D },
    { realizedPnl: -50, riskAmount: 100, fees: 2, exitTime: 3 * D },
  ];

  it("computes return, drawdown, trade stats and R", () => {
    const s = paperStats(trades, equity);
    expect(s.returnPct).toBeCloseTo(0.1);
    expect(s.maxDrawdown).toBeCloseTo(300 / 10_200);
    expect(s.trades).toBe(3);
    expect(s.winRate).toBeCloseTo(1 / 3);
    expect(s.profitFactor).toBeCloseTo(2);
    expect(s.avgR).toBeCloseTo(0.5);
    expect(s.fees).toBe(6);
    expect(s.annualVol).not.toBeNull();
  });

  it("handles an engine with no trades yet", () => {
    const s = paperStats([], [{ time: 0, equity: 10_000 }]);
    expect(s.trades).toBe(0);
    expect(s.winRate).toBeNull();
    expect(s.returnPct).toBe(0);
  });

  it("flags a drawdown beyond the backtest and a losing profit factor after 30 trades", () => {
    const crash = [10_000, 6_000].map((e, i) => ({ time: i * D, equity: e }));
    const losers = Array.from({ length: 30 }, (_, i) => ({ realizedPnl: i % 3 ? -100 : 50, riskAmount: 100, fees: 1, exitTime: i }));
    const f = deviations(paperStats(losers, crash), EXPECTATIONS.ST);
    expect(f.join(" ")).toMatch(/drawdown/);
    expect(f.join(" ")).toMatch(/profit factor/);
    expect(postMortemDue(30)).toBe(true);
    expect(postMortemDue(31)).toBe(false);
  });
});
