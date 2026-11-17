import { describe, expect, it } from "vitest";
import type { Candle } from "../src/core/types.js";
import { newPaperState, PaperExchange, type MarketData } from "../src/exchange/paper.js";
import { FILTERS } from "./helpers.js";

function md(mark: { v: number }, bars: Candle[]): MarketData {
  return {
    getServerTime: async () => Date.now(),
    getClosedCandles: async () => [],
    getFilters: async (s) => ({ ...FILTERS, symbol: s }),
    getMarkPrice: async () => mark.v,
    getKlinesSince: async (_s, _i, start) => bars.filter((b) => b.openTime >= start),
  };
}

const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ openTime: t, closeTime: t + 59_999, open: o, high: h, low: l, close: c, volume: 1 });

describe("paper exchange", () => {
  it("market order is idempotent by client id and charges fees", async () => {
    const mark = { v: 100 };
    const ex = new PaperExchange(md(mark, []), newPaperState(1000), { takerFee: 0.001, slippage: 0 });
    await ex.prepareSymbol("BTCUSDT", 2);
    const a = await ex.marketOrder({ symbol: "BTCUSDT", side: "BUY", quantity: 1, reduceOnly: false, clientOrderId: "x" });
    const b = await ex.marketOrder({ symbol: "BTCUSDT", side: "BUY", quantity: 1, reduceOnly: false, clientOrderId: "x" });
    expect(b).toEqual(a);
    expect((await ex.getPosition("BTCUSDT"))?.quantity).toBe(1);
    expect(ex.state.wallet).toBeCloseTo(1000 - 0.1);
  });

  it("refuses a stop that would trigger immediately", async () => {
    const ex = new PaperExchange(md({ v: 100 }, []), newPaperState(1000), { takerFee: 0, slippage: 0 });
    await ex.marketOrder({ symbol: "BTCUSDT", side: "BUY", quantity: 1, reduceOnly: false, clientOrderId: "e" });
    await expect(ex.placeStop({ symbol: "BTCUSDT", side: "SELL", quantity: 1, stopPrice: 101, clientId: "s" })).rejects.toThrow();
  });

  it("triggers a stop from a 1m low between ticks and books the loss", async () => {
    const mark = { v: 100 };
    const t0 = Date.UTC(2025, 0, 1);
    const bars = [bar(t0, 100, 100.5, 99.5, 100), bar(t0 + 60_000, 100, 100, 94, 96), bar(t0 + 120_000, 96, 97, 95, 96)];
    const state = newPaperState(1000);
    const ex = new PaperExchange(md(mark, bars), state, { takerFee: 0, slippage: 0 });
    await ex.marketOrder({ symbol: "BTCUSDT", side: "BUY", quantity: 2, reduceOnly: false, clientOrderId: "e" });
    await ex.placeStop({ symbol: "BTCUSDT", side: "SELL", quantity: 2, stopPrice: 95, clientId: "s" });
    state.lastStopCheck.BTCUSDT = t0;
    expect(await ex.getPosition("BTCUSDT")).toBeNull();
    expect(state.wallet).toBeCloseTo(1000 - 10);
    expect(await ex.getOpenStops("BTCUSDT")).toHaveLength(0);
    const fills = await ex.getFills("BTCUSDT", 0);
    expect(fills.at(-1)!.price).toBe(95);
  });
});
