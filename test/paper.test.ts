import { afterEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "../src/core/types.js";
import { liquidationPrice, newPaperState, PaperExchange, type MarketData, type PaperState } from "../src/exchange/paper.js";
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

const T0 = Date.UTC(2025, 0, 1);
const S = "BTCUSDT";
const at = (t: number) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t); };
const order = (ex: PaperExchange, side: "BUY" | "SELL", quantity: number, id: string, reduceOnly = false) =>
  ex.marketOrder({ symbol: S, side, quantity, reduceOnly, clientOrderId: id });

describe("paper exchange", () => {
  afterEach(() => { vi.useRealTimers(); });

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
    at(t0 + 30_000);
    const bars = [bar(t0, 100, 100.5, 99.5, 100), bar(t0 + 60_000, 100, 100, 94, 96), bar(t0 + 120_000, 96, 97, 95, 96)];
    const state = newPaperState(1000);
    const ex = new PaperExchange(md(mark, bars), state, { takerFee: 0, slippage: 0 });
    await ex.marketOrder({ symbol: "BTCUSDT", side: "BUY", quantity: 2, reduceOnly: false, clientOrderId: "e" });
    await ex.placeStop({ symbol: "BTCUSDT", side: "SELL", quantity: 2, stopPrice: 95, clientId: "s" });
    at(t0 + 150_000);
    expect(await ex.getPosition("BTCUSDT")).toBeNull();
    expect(state.wallet).toBeCloseTo(1000 - 10);
    expect(await ex.getOpenStops("BTCUSDT")).toHaveLength(0);
    const fills = await ex.getFills("BTCUSDT", 0);
    expect(fills.at(-1)!.price).toBe(95);
  });

  it("U2-01: a new stop does not replay bars from before it existed", async () => {
    at(T0 + 10_000);
    const mark = { v: 100 };
    // Old dip to 90 at T0, long before the second stop is placed.
    const bars = [bar(T0, 100, 100, 90, 100), bar(T0 + 60_000, 100, 101, 99, 100)];
    const ex = new PaperExchange(md(mark, bars), newPaperState(1000), { takerFee: 0, slippage: 0 });
    await order(ex, "BUY", 1, "e");
    // An old stop far away keeps lastStopCheck at T0.
    await ex.placeStop({ symbol: S, side: "SELL", quantity: 1, stopPrice: 50, clientId: "far" });
    at(T0 + 125_000);
    // New stop at 95, created after the T0 bar closed: the 90 low must not trigger it.
    await ex.placeStop({ symbol: S, side: "SELL", quantity: 1, stopPrice: 95, clientId: "near" });
    ex.state.lastStopCheck[S] = T0;
    expect((await ex.getPosition(S))?.quantity).toBe(1);
    expect(await ex.getOpenStops(S)).toHaveLength(2);
  });

  it("U2-01: flat symbol with no stops resets lastStopCheck; old state without stopCreatedAt loads", async () => {
    at(T0 + 90_500);
    const state = newPaperState(1000) as Partial<PaperState>;
    delete state.stopCreatedAt;
    state.lastStopCheck = { [S]: T0 - 3_600_000 };
    const ex = new PaperExchange(md({ v: 100 }, []), state as PaperState, { takerFee: 0, slippage: 0 });
    expect(ex.state.stopCreatedAt).toEqual({});
    await ex.getPosition(S);
    expect(ex.state.lastStopCheck[S]).toBe(T0 + 60_000);
  });

  it("U2-02: an opposite order larger than the position flips it, PnL only on the close leg", async () => {
    at(T0);
    const mark = { v: 100 };
    const ex = new PaperExchange(md(mark, []), newPaperState(1000), { takerFee: 0.001, slippage: 0 });
    await order(ex, "BUY", 1, "e");
    mark.v = 110;
    const f = await order(ex, "SELL", 3, "flip");
    expect(f.status).toBe("FILLED");
    expect(f.executedQty).toBe(3);
    const pos = await ex.getPosition(S);
    expect(pos).toMatchObject({ side: "SHORT", quantity: 2, entryPrice: 110 });
    const fills = await ex.getFills(S, 0);
    expect(fills.slice(1).map((x) => [x.qty, x.realizedPnl])).toEqual([[1, 10], [2, 0]]);
    expect(fills[1]!.commission).toBeCloseTo(0.11);
    expect(fills[2]!.commission).toBeCloseTo(0.22);
    expect(ex.state.wallet).toBeCloseTo(1000 - 0.1 + 10 - 0.11 - 0.22);
  });

  it("U2-03: wrong-side stops are cancelled and going flat cancels all stops", async () => {
    at(T0);
    const mark = { v: 100 };
    const bars = [bar(T0, 100, 120, 99, 100)];
    const ex = new PaperExchange(md(mark, bars), newPaperState(1000), { takerFee: 0, slippage: 0 });
    await order(ex, "BUY", 1, "e");
    // BUY stop does not close a long: it must never open a short.
    await ex.placeStop({ symbol: S, side: "BUY", quantity: 1, stopPrice: 110, clientId: "wrong" });
    await ex.placeStop({ symbol: S, side: "SELL", quantity: 1, stopPrice: 90, clientId: "ok" });
    const open = await ex.getOpenStops(S);
    expect(open.map((s) => s.clientId)).toEqual(["ok"]);
    expect((await ex.getPosition(S))?.side).toBe("LONG");
    await order(ex, "SELL", 1, "x", true);
    expect(await ex.getPosition(S)).toBeNull();
    expect(ex.state.stops).toHaveLength(0);
    expect(ex.state.stopCreatedAt).toEqual({});
  });

  it("U2-04: marketOrder checks stops first", async () => {
    at(T0 + 10_000);
    const mark = { v: 100 };
    const bars: Candle[] = [];
    const ex = new PaperExchange(md(mark, bars), newPaperState(1000), { takerFee: 0, slippage: 0 });
    await order(ex, "BUY", 1, "e");
    await ex.placeStop({ symbol: S, side: "SELL", quantity: 1, stopPrice: 95, clientId: "s" });
    bars.push(bar(T0 + 60_000, 100, 100, 94, 96));
    mark.v = 96;
    at(T0 + 130_000);
    // A reduce-only close after the stop already fired must not fill.
    const f = await order(ex, "SELL", 1, "close", true);
    expect(f.status).toBe("REJECTED");
    expect(ex.state.wallet).toBeCloseTo(995);
  });

  it("U2-04: rejects an opening order without enough margin and does not cache the rejection", async () => {
    at(T0);
    const ex = new PaperExchange(md({ v: 100 }, []), newPaperState(100), { takerFee: 0.001, slippage: 0 });
    await ex.prepareSymbol(S, 2);
    const r = await order(ex, "BUY", 3, "big"); // needs 150 margin
    expect(r.status).toBe("REJECTED");
    expect(await ex.getPosition(S)).toBeNull();
    ex.state.wallet = 1000;
    const ok = await order(ex, "BUY", 3, "big");
    expect(ok.status).toBe("FILLED");
    expect((await ex.getPosition(S))?.quantity).toBe(3);
  });

  it("rounds market orders to marketStepSize", async () => {
    at(T0);
    const m = md({ v: 100 }, []);
    m.getFilters = async (s) => ({ ...FILTERS, symbol: s, stepSize: 0.001, marketStepSize: 0.1 });
    const ex = new PaperExchange(m, newPaperState(1000), { takerFee: 0, slippage: 0 });
    const f = await order(ex, "BUY", 1.2345, "e");
    expect(f.executedQty).toBe(1.2);
  });

  it("U2-05: liquidates before a stop placed beyond the liquidation price, loss capped at margin", async () => {
    at(T0);
    const mark = { v: 100 };
    const bars = [bar(T0 + 60_000, 100, 100, 70, 75)];
    const ex = new PaperExchange(md(mark, bars), newPaperState(1000), { takerFee: 0.001, slippage: 0 });
    await ex.prepareSymbol(S, 5);
    await order(ex, "BUY", 1, "e");
    const liq = liquidationPrice({ side: "LONG", entryPrice: 100, leverage: 5 });
    expect(liq).toBeCloseTo(80.5);
    await ex.placeStop({ symbol: S, side: "SELL", quantity: 1, stopPrice: 75, clientId: "s" });
    at(T0 + 130_000);
    expect(await ex.getPosition(S)).toBeNull();
    const last = (await ex.getFills(S, 0)).at(-1)!;
    expect(last.price).toBeCloseTo(80.5);
    expect(-(last.realizedPnl - last.commission)).toBeLessThanOrEqual(20 + 1e-9);
    expect(ex.state.wallet).toBeGreaterThanOrEqual(1000 - 0.1 - 20 - 1e-9);
    expect(ex.state.stops).toHaveLength(0);
  });

  it("U2-05: a short with no stop is liquidated on a spike", async () => {
    at(T0);
    const bars = [bar(T0 + 60_000, 100, 130, 100, 125)];
    const ex = new PaperExchange(md({ v: 100 }, bars), newPaperState(1000), { takerFee: 0, slippage: 0 });
    await ex.prepareSymbol(S, 5);
    await order(ex, "SELL", 1, "e");
    at(T0 + 130_000);
    expect(await ex.getPosition(S)).toBeNull();
    expect(ex.state.wallet).toBeCloseTo(1000 - 19.5);
  });

  it("a stop nearer than liquidation fills first", async () => {
    at(T0);
    const bars = [bar(T0 + 60_000, 100, 100, 70, 75)];
    const ex = new PaperExchange(md({ v: 100 }, bars), newPaperState(1000), { takerFee: 0, slippage: 0 });
    await ex.prepareSymbol(S, 5);
    await order(ex, "BUY", 1, "e");
    await ex.placeStop({ symbol: S, side: "SELL", quantity: 1, stopPrice: 90, clientId: "s" });
    at(T0 + 130_000);
    expect(await ex.getPosition(S)).toBeNull();
    expect(ex.state.wallet).toBeCloseTo(990);
  });

  it("triggers a short-side stop from a 1m high", async () => {
    at(T0);
    const bars = [bar(T0 + 60_000, 100, 106, 99, 104)];
    const ex = new PaperExchange(md({ v: 100 }, bars), newPaperState(1000), { takerFee: 0, slippage: 0 });
    await order(ex, "SELL", 2, "e");
    await ex.placeStop({ symbol: S, side: "BUY", quantity: 2, stopPrice: 105, clientId: "s" });
    at(T0 + 130_000);
    expect(await ex.getPosition(S)).toBeNull();
    expect((await ex.getFills(S, 0)).at(-1)!.price).toBe(105);
    expect(ex.state.wallet).toBeCloseTo(990);
  });

  it("a bar that gaps through the stop fills at the open", async () => {
    at(T0);
    const bars = [bar(T0 + 60_000, 92, 93, 91, 92)];
    const ex = new PaperExchange(md({ v: 100 }, bars), newPaperState(1000), { takerFee: 0, slippage: 0 });
    await order(ex, "BUY", 1, "e");
    await ex.placeStop({ symbol: S, side: "SELL", quantity: 1, stopPrice: 95, clientId: "s" });
    at(T0 + 130_000);
    expect(await ex.getPosition(S)).toBeNull();
    expect((await ex.getFills(S, 0)).at(-1)!.price).toBe(92);
  });
});
