import { describe, expect, it } from "vitest";
import { DEFAULT_BACKTEST, runBacktest } from "../src/backtest/engine.js";
import { bucket, lossReport } from "../src/backtest/analysis.js";
import type { Strategy } from "../src/strategy/types.js";
import { candlesFromCloses } from "./helpers.js";

const D1 = 86_400_000;
const free = { ...DEFAULT_BACKTEST, takerFee: 0, slippage: 0, fundingPer8h: 0 };

describe("loss analysis", () => {
  // Long at 100 with stop 90; price rises to 115 (1.5R MFE), then falls through the stop.
  const once: Strategy = {
    name: "once", interval: "1d", warmup: 1,
    evaluate: (symbol, cs) => (cs.length === 2 ? { symbol, side: "LONG", refPrice: 100, stop: 90, candleOpenTime: cs.at(-1)!.openTime, reason: "t" } : null),
    updateStop: (p) => p.stop,
  };
  const c = candlesFromCloses([100, 100, 105, 115, 100, 85, 85], Date.UTC(2024, 0, 1), D1, 0);

  it("records bars held, MFE and MAE in R", () => {
    const t = runBacktest(once, { X: c }, free).trades[0]!;
    expect(t.exitReason).toBe("STOP");
    expect(t.mfeR).toBeCloseTo(1.5);
    expect(t.maeR).toBeCloseTo(1.5); // the stop candle's low is 85
    expect(t.bars).toBe(4);
  });

  it("classifies a loser that was 1R+ in profit as given back", () => {
    const res = runBacktest(once, { X: c }, free);
    const lines = lossReport(res.trades, { X: c }).join("\n");
    expect(lines).toMatch(/1R\+ then lost \(gave back\)\s+n\s+1/);
    expect(lines).toContain("longest losing streak: 1");
  });

  it("bucket math", () => {
    const res = runBacktest(once, { X: c }, free);
    const b = bucket("x", res.trades);
    expect(b.trades).toBe(1);
    expect(b.winRate).toBe(0);
    expect(b.avgR).toBeCloseTo(-1);
  });
});
