import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Candle } from "../src/core/types.js";
import { loadCsv, saveCsv } from "../src/data/klines.js";
import { parseKline } from "../src/exchange/binanceFutures.js";
import { DEFAULT_TREND_BREAKOUT, createTrendBreakout, takerBuyShare } from "../src/strategy/trendBreakout.js";
import { candlesFromCloses, uptrend } from "./helpers.js";

const withShare = (cs: Candle[], share: number | undefined): Candle[] =>
  cs.map((c) => (share === undefined ? { ...c, takerBuyVolume: undefined } : { ...c, volume: 100, takerBuyVolume: 100 * share }));

describe("taker flow (order-flow confirmation)", () => {
  it("parses the kline taker buy volume (index 9)", () => {
    const k = parseKline([1, "10", "11", "9", "10.5", "200", 2, "0", 5, "120", "0", "0"]);
    expect(k.takerBuyVolume).toBe(120);
    expect(takerBuyShare(k)).toBeCloseTo(0.6);
    expect(parseKline([1, "10", "11", "9", "10.5", "200", 2]).takerBuyVolume).toBeUndefined();
  });

  it("CSV round trip keeps the column and still reads 7-column files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tk-"));
    const cs = withShare(candlesFromCloses([1, 2, 3]), 0.4);
    await saveCsv(join(dir, "a.csv"), cs);
    expect((await loadCsv(join(dir, "a.csv")))[1]!.takerBuyVolume).toBeCloseTo(40);
    const old = withShare(candlesFromCloses([1, 2]), undefined);
    await saveCsv(join(dir, "b.csv"), old);
    expect((await loadCsv(join(dir, "b.csv")))[0]!.takerBuyVolume).toBeUndefined();
  });

  it("filter blocks a long breakout without buyer majority and is off by default", () => {
    const base = candlesFromCloses(uptrend());
    const on = createTrendBreakout({ ...DEFAULT_TREND_BREAKOUT, minTakerShare: 0.5 });
    const off = createTrendBreakout(DEFAULT_TREND_BREAKOUT);
    // find a candle where the unfiltered strategy goes long
    let n = -1;
    for (let i = 250; i <= base.length; i++) if (off.evaluate("X", base.slice(0, i))?.side === "LONG") { n = i; break; }
    expect(n).toBeGreaterThan(0);
    expect(on.evaluate("X", withShare(base.slice(0, n), 0.6))?.side).toBe("LONG");
    expect(on.evaluate("X", withShare(base.slice(0, n), 0.4))).toBeNull();
    expect(on.evaluate("X", withShare(base.slice(0, n), undefined))).toBeNull(); // no data -> no signal
    expect(off.evaluate("X", withShare(base.slice(0, n), 0.4))?.side).toBe("LONG");
  });
});
