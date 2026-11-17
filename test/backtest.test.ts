import { describe, expect, it } from "vitest";
import type { Candle, OpenPositionView, Signal } from "../src/core/types.js";
import { DEFAULT_BACKTEST, fundingSettlements, runBacktest, type BacktestResult } from "../src/backtest/engine.js";
import { acceptance, computeMetrics, formatMetrics, formatProfitFactor, perturbParam } from "../src/backtest/metrics.js";
import { STRATEGY_WINDOW, type Strategy } from "../src/strategy/types.js";
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

  it("strategy never receives more than STRATEGY_WINDOW candles (live parity)", () => {
    const n = STRATEGY_WINDOW + 300;
    const c = candlesFromCloses(Array.from({ length: n }, (_, i) => 100 + i * 0.01));
    const seen = { evaluate: 0, updateStop: 0, lastEvalFirst: -1 };
    const s: Strategy = {
      name: "spy",
      warmup: 1,
      evaluate(symbol, cs) {
        seen.evaluate = Math.max(seen.evaluate, cs.length);
        seen.lastEvalFirst = cs[0]!.openTime;
        // Enter late so updateStop is also called with full windows.
        if (cs.at(-1)!.openTime !== c[STRATEGY_WINDOW + 50]!.openTime) return null;
        return { symbol, side: "LONG", refPrice: cs.at(-1)!.close, stop: cs.at(-1)!.close * 0.9, candleOpenTime: cs.at(-1)!.openTime, reason: "t" };
      },
      updateStop(p, cs) {
        seen.updateStop = Math.max(seen.updateStop, cs.length);
        expect(cs.at(-1)!.openTime).toBeGreaterThanOrEqual(p.entryCandleOpenTime);
        return p.stop;
      },
    };
    const r = runBacktest(s, { X: c }, noCosts);
    expect(r.trades.length).toBe(1);
    expect(seen.evaluate).toBe(STRATEGY_WINDOW);
    expect(seen.updateStop).toBe(STRATEGY_WINDOW);
    expect(seen.lastEvalFirst).toBe(c[STRATEGY_WINDOW + 50 + 1 - STRATEGY_WINDOW]!.openTime);
  });

  it("mark-to-market uses the last known close when a symbol has no candle at t", () => {
    const x = candlesFromCloses([100, 100, 100, 150, 160, 170]);
    const missing = x[4]!.openTime;
    const xGap = x.filter((k) => k.openTime !== missing);
    const a = candlesFromCloses([1, 1, 1, 1, 1, 1]);
    const r = runBacktest(scripted(1, 50), { X: xGap, A: a }, noCosts);
    const q = r.trades[0]!.quantity;
    const entry = r.trades[0]!.entryPrice; // 100 at x[2].open
    const atGap = r.equityCurve.find((p) => p.time === missing)!;
    expect(atGap.equity).toBeCloseTo(noCosts.initialEquity + (150 - entry) * q, 6);
    expect(atGap.equity).not.toBeCloseTo(noCosts.initialEquity, 2);
  });

  it("last equity point equals finalEquity after END closes (with costs)", () => {
    const r = runBacktest(scripted(1, 90), { X: candlesFromCloses([100, 100, 100, 110, 120]) }, DEFAULT_BACKTEST);
    expect(r.trades[0]!.exitReason).toBe("END");
    expect(r.equityCurve.at(-1)!.equity).toBe(r.finalEquity);
    expect(r.equityCurve.at(-2)!.equity).toBeGreaterThan(r.finalEquity); // exit costs paid
  });

  it("funding is charged only at 8h UTC settlements strictly after entry, on mark notional", () => {
    const H1 = 3600_000;
    // 1h candles from 05:00 UTC; entry fills at 07:00 open, held to the 10:00 candle.
    const start = Date.UTC(2024, 0, 1, 5);
    const closes = [100, 100, 100, 100, 120, 130];
    const c = candlesFromCloses(closes, start, H1);
    const cfg = { ...noCosts, fundingPer8h: 0.001 };
    const r = runBacktest(scripted(1, 50), { X: c }, cfg);
    const t = r.trades[0]!;
    expect(t.entryTime).toBe(Date.UTC(2024, 0, 1, 7));
    // Only the 08:00 settlement, in the candle opening at 08:00 (open = 100).
    expect(t.funding).toBeCloseTo(t.quantity * c[3]!.open * 0.001, 9);

    // No charge for a settlement at the entry instant itself.
    expect(fundingSettlements(Date.UTC(2024, 0, 1, 8), Date.UTC(2024, 0, 1, 12) - 1, Date.UTC(2024, 0, 1, 8))).toBe(0);
    expect(fundingSettlements(Date.UTC(2024, 0, 1, 4), Date.UTC(2024, 0, 2, 4), Date.UTC(2024, 0, 1, 4))).toBe(3); // 08, 16, 00
    expect(fundingSettlements(Date.UTC(2024, 0, 1, 9), Date.UTC(2024, 0, 1, 15), 0)).toBe(0);
  });

  it("robustness perturbation rounds only integer periods", () => {
    expect(perturbParam("entryLookback", 20, 1.2)).toBe(24);
    expect(perturbParam("emaSlow", 200, 0.8)).toBe(160);
    expect(perturbParam("atrPeriod", 14, 1.2)).toBe(17);
    expect(perturbParam("emaFast", 1, 0.2)).toBe(1);
    expect(perturbParam("stopAtr", 2, 1.2)).toBeCloseTo(2.4, 12);
    expect(perturbParam("trailAtr", 3, 0.8)).toBeCloseTo(2.4, 12);
  });

  it("symbols are processed in configured (insertion) order, not alphabetical", () => {
    const c = candlesFromCloses([100, 100, 100, 110, 120]);
    const cfg = { ...noCosts, maxOpenPositions: 1 };
    const zFirst = runBacktest(scripted(1, 50), { ZZZ: c, AAA: c }, cfg);
    expect(zFirst.trades.map((t) => t.symbol)).toEqual(["ZZZ"]);
    const aFirst = runBacktest(scripted(1, 50), { AAA: c, ZZZ: c }, cfg);
    expect(aFirst.trades.map((t) => t.symbol)).toEqual(["AAA"]);
  });

  it("sizing includes round-trip costs and uses mark-to-market equity", () => {
    const c = candlesFromCloses([100, 100, 100, 110, 120]);
    const cfg = { ...DEFAULT_BACKTEST, fundingPer8h: 0 };
    const t = runBacktest(scripted(1, 90), { X: c }, cfg).trades[0]!;
    const lossPerUnit = Math.abs(t.entryPrice - 90) + t.entryPrice * 2 * (cfg.takerFee + cfg.slippage);
    expect(t.quantity * lossPerUnit).toBeCloseTo(cfg.initialEquity * cfg.riskPerTrade, 4);

    // Second symbol enters while the first sits on an unrealized gain: its risk budget is larger.
    const up = candlesFromCloses([100, 100, 100, 200, 200, 200, 200]);
    const flat = candlesFromCloses([100, 100, 100, 100, 100, 100, 100]);
    const r = runBacktest({ ...scripted(1, 50), evaluate: (sym, cs) => scripted(sym === "UP" ? 1 : 4, 50).evaluate(sym, cs) }, { UP: up, FLAT: flat }, noCosts);
    const second = r.trades.find((x) => x.symbol === "FLAT")!;
    const markEq = noCosts.initialEquity + (200 - 100) * r.trades.find((x) => x.symbol === "UP")!.quantity;
    expect(second.quantity * Math.abs(second.entryPrice - 50)).toBeCloseTo(markEq * noCosts.riskPerTrade, 4);
  });

  it("metrics never produce NaN for zero trades or all wins", () => {
    const empty: BacktestResult = { trades: [], equityCurve: [], finalEquity: 10_000 };
    const m0 = computeMetrics(empty, 10_000);
    for (const v of Object.values(m0)) expect(Number.isNaN(v)).toBe(false);
    expect(m0.profitFactor).toBe(0);
    expect(formatMetrics(m0)).not.toMatch(/NaN/);

    const wins = runBacktest(scripted(1, 50), { X: candlesFromCloses([100, 100, 100, 110, 120]) }, noCosts);
    const m1 = computeMetrics(wins, noCosts.initialEquity);
    for (const v of Object.values(m1)) expect(Number.isNaN(v)).toBe(false);
    expect(m1.profitFactor).toBe(Infinity);
    expect(formatProfitFactor(m1.profitFactor)).toBe("inf");
    expect(formatMetrics(m1)).not.toMatch(/NaN|Infinity/);
  });
});
