import { describe, expect, it } from "vitest";
import type { Candle, OpenPositionView, Signal } from "../src/core/types.js";
import { DEFAULT_BACKTEST, runBacktest } from "../src/backtest/engine.js";
import { acceptance, computeMetrics } from "../src/backtest/metrics.js";
import type { Strategy } from "../src/strategy/types.js";
import { createTrendBreakout } from "../src/strategy/trendBreakout.js";
import { candlesFromCloses, uptrend } from "./helpers.js";

/** Goes long on a given candle index with a fixed stop; never trails. */
function scripted(entryIndex: number, stop: number): Strategy {
  return {
    name: "scripted",
    warmup: 1,
    evaluate(symbol: string, candles: Candle[]): Signal | null {
      if (candles.length - 1 !== entryIndex) return null;
      const c = candles.at(-1)!;
      return { symbol, side: "LONG", refPrice: c.close, stop, candleOpenTime: c.openTime, reason: "test" };
    },
    updateStop: (p: OpenPositionView) => p.stop,
  };
}

const noCosts = { ...DEFAULT_BACKTEST, takerFee: 0, slippage: 0, fundingPer8h: 0 };

describe("backtest", () => {
  it("fills at the NEXT candle open, not the signal close", () => {
    const c = candlesFromCloses([100, 100, 100, 110, 120], undefined, undefined, 0);
    const r = runBacktest(scripted(1, 50), { X: c }, noCosts);
    expect(r.trades[0]!.entryPrice).toBe(c[2]!.open);
    expect(r.trades[0]!.entryTime).toBe(c[2]!.openTime);
  });

  it("stop is hit intrabar on the low, and a gap fills at the open", () => {
    const c: Candle[] = candlesFromCloses([100, 100, 100, 100], undefined, undefined, 0);
    c[3] = { ...c[3]!, open: 90, high: 91, low: 85, close: 88 }; // gaps through stop 95
    const r = runBacktest(scripted(1, 95), { X: c }, noCosts);
    expect(r.trades[0]!.exitReason).toBe("STOP");
    expect(r.trades[0]!.exitPrice).toBe(90);
  });

  it("costs reduce pnl", () => {
    const c = candlesFromCloses(uptrend());
    const s = createTrendBreakout();
    const free = runBacktest(s, { X: c }, noCosts);
    const costly = runBacktest(s, { X: c }, DEFAULT_BACKTEST);
    expect(free.trades.length).toBeGreaterThan(0);
    expect(costly.finalEquity).toBeLessThan(free.finalEquity);
  });

  it("decisions do not depend on future candles", () => {
    const closes = uptrend(220, 80);
    const s = createTrendBreakout();
    const a = runBacktest(s, { X: candlesFromCloses(closes) }, noCosts);
    const altered = [...closes.slice(0, 260), ...closes.slice(260).map((x) => x * 0.5)];
    const b = runBacktest(s, { X: candlesFromCloses(altered) }, noCosts);
    expect(b.trades[0]!.entryTime).toBe(a.trades[0]!.entryTime);
    expect(b.trades[0]!.entryPrice).toBe(a.trades[0]!.entryPrice);
  });

  it("respects maxOpenPositions across symbols", () => {
    const c = candlesFromCloses(uptrend());
    const data = { A: c, B: c, C: c, D: c };
    const r = runBacktest(createTrendBreakout(), data, { ...noCosts, maxOpenPositions: 2 });
    const firstEntry = Math.min(...r.trades.map((t) => t.entryTime));
    expect(r.trades.filter((t) => t.entryTime === firstEntry).length).toBe(2);
  });

  it("metrics and acceptance", () => {
    const r = runBacktest(createTrendBreakout(), { X: candlesFromCloses(uptrend()) }, DEFAULT_BACKTEST);
    const m = computeMetrics(r, DEFAULT_BACKTEST.initialEquity);
    expect(m.trades).toBe(r.trades.length);
    expect(acceptance(m).pass).toBe(false); // far fewer than 100 trades
  });
});
