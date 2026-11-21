import { describe, expect, it } from "vitest";
import type { Candle } from "../src/core/types.js";
import { MemoryRepo } from "../src/db/repo.js";
import { Engine, type EngineConfig } from "../src/engine/engine.js";
import { getStrategy } from "../src/strategy/registry.js";
import { createTrendBreakout, DEFAULT_TREND_BREAKOUT, fundingCrowded } from "../src/strategy/trendBreakout.js";
import type { Strategy } from "../src/strategy/types.js";
import { candlesFromCloses, FakeExchange } from "./helpers.js";

const H1 = 3_600_000;
const H4 = 4 * H1;
const T0 = Date.UTC(2024, 0, 1);

/** n candles with funding rising 0..n-1 (x 1e-6), last candle's rate given explicitly. */
const withFunding = (cs: Candle[], rate: (i: number) => number | undefined) => cs.map((c, i) => ({ ...c, fundingRate: rate(i) }));

describe("fundingCrowded", () => {
  const base = candlesFromCloses(new Array(201).fill(100), T0, H4);
  const hist = (i: number) => i * 1e-6; // previous 200 rates: 0 .. 199e-6

  it("flags a long when the last rate is above the percentile, a short when below the mirror", () => {
    const hi = withFunding(base, (i) => (i === 200 ? 1 : hist(i)));
    expect(fundingCrowded(hi, "LONG", 0.9, 200)).toBe(true);
    expect(fundingCrowded(hi, "SHORT", 0.9, 200)).toBe(false);
    const lo = withFunding(base, (i) => (i === 200 ? -1 : hist(i)));
    expect(fundingCrowded(lo, "SHORT", 0.9, 200)).toBe(true);
    expect(fundingCrowded(lo, "LONG", 0.9, 200)).toBe(false);
    const mid = withFunding(base, (i) => (i === 200 ? 100e-6 : hist(i)));
    expect(fundingCrowded(mid, "LONG", 0.9, 200)).toBe(false);
    expect(fundingCrowded(mid, "SHORT", 0.9, 200)).toBe(false);
  });

  it("never blocks without data: missing last rate or too little history gives null", () => {
    expect(fundingCrowded(withFunding(base, (i) => (i === 200 ? undefined : hist(i))), "LONG", 0.9, 200)).toBeNull();
    expect(fundingCrowded(withFunding(base, (i) => (i < 100 ? undefined : 1)), "LONG", 0.9, 200)).toBeNull();
  });

  it("uses only candles up to the signal candle (no look-ahead)", () => {
    const cs = withFunding(base, (i) => (i === 200 ? 150e-6 : hist(i)));
    const before = fundingCrowded(cs, "LONG", 0.9, 200);
    const future = [...cs, ...withFunding(candlesFromCloses([100, 100], T0 + 201 * H4, H4), () => 1)];
    expect(fundingCrowded(future.slice(0, 201), "LONG", 0.9, 200)).toBe(before);
  });
});

describe("trend breakout with the funding crowding filter", () => {
  // Uptrend, then a breakout on the last candle.
  const closes = Array.from({ length: 700 }, (_, i) => 100 + i * 0.05);
  closes.push(closes.at(-1)! + 5);
  const cs = candlesFromCloses(closes, T0, H4);
  const p = { ...DEFAULT_TREND_BREAKOUT, fundingCrowdPct: 0.9, fundingCrowdBars: 540 };

  it("declares needsFunding only when the filter is on", () => {
    expect(createTrendBreakout(p).needsFunding).toBe(true);
    expect(createTrendBreakout(DEFAULT_TREND_BREAKOUT).needsFunding).toBe(false);
    expect(getStrategy("trendlvfc+timestop+befee").create().needsFunding).toBe(true);
  });

  it("skips a long breakout when longs are crowded and takes it otherwise", () => {
    const s = createTrendBreakout(p);
    const crowded = withFunding(cs, (i) => (i === cs.length - 1 ? 0.001 : 0.0001 + (i % 10) * 1e-6));
    const normal = withFunding(cs, (i) => 0.0001 + (i % 10) * 1e-6);
    expect(s.evaluate("BTCUSDT", crowded)).toBeNull();
    expect(s.evaluate("BTCUSDT", normal)?.side).toBe("LONG");
    expect(s.evaluate("BTCUSDT", cs)?.side).toBe("LONG"); // no funding data: never blocks
    expect(s.explain!(crowded)).toMatch(/BLOCKED: long side crowded/);
  });
});

describe("engine when the funding history cannot be fetched", () => {
  it("keeps deciding without funding and records FUNDING_UNAVAILABLE", async () => {
    const ex = new FakeExchange();
    const candles = candlesFromCloses(new Array(1100).fill(100), T0, H1);
    ex.candles.BTCUSDT = candles;
    ex.now = candles[1050]!.closeTime + 60_000;
    ex.mark.BTCUSDT = 100;
    ex.getFundingHistory = async () => { throw new Error("demo timeout"); };
    let seen: Candle[] = [];
    const strat: Strategy = {
      name: "spy", interval: "1h", warmup: 1, needsFunding: true,
      evaluate: (_s, cs) => { seen = cs; return null; },
      updateStop: (q) => q.stop,
    };
    const cfg: EngineConfig = {
      symbols: ["BTCUSDT"], interval: "1h", intervalMs: H1, riskPerTrade: 0.01, maxLeverage: 3, maxOpenPositions: 3,
      dailyLossLimit: 0.03, maxDrawdown: 0.15, maxCandleDelayMs: 15 * 60_000, roundTripCostPct: 0.002,
    };
    const repo = new MemoryRepo();
    await new Engine({ exchange: ex, repo, strategy: strat, notifier: { send: async () => {} }, cfg, now: () => ex.now }).tick();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)!.fundingRate).toBeUndefined();
    const kinds = repo.events.map((e) => e.kind);
    expect(kinds).toContain("FUNDING_UNAVAILABLE");
    expect(kinds).not.toContain("SYMBOL_ERROR");
  });
});
