import { describe, expect, it } from "vitest";
import { liquidationStreamUrl, parseForceOrder } from "../src/collect/liquidations.js";

const sample = JSON.stringify({ stream: "btcusdt@forceOrder", data: { e: "forceOrder", E: 1568014460893, o: { s: "BTCUSDT", S: "SELL", o: "LIMIT", f: "IOC", q: "0.014", p: "9910", ap: "9910.5", X: "FILLED", l: "0.014", z: "0.014", T: 1568014460893 } } });

describe("liquidation stream parsing", () => {
  it("builds the combined stream url", () => {
    expect(liquidationStreamUrl(["BTCUSDT", "ETHUSDT"])).toBe("wss://fstream.binance.com/stream?streams=btcusdt@forceOrder/ethusdt@forceOrder");
  });
  it("parses a forceOrder event (SELL = long liquidated)", () => {
    const l = parseForceOrder(sample)!;
    expect(l).toMatchObject({ symbol: "BTCUSDT", side: "SELL", price: 9910, avgPrice: 9910.5, quantity: 0.014, status: "FILLED", tradeTime: 1568014460893 });
    expect(l.notional).toBeCloseTo(9910.5 * 0.014);
  });
  it("rejects anything else", () => {
    expect(parseForceOrder("not json")).toBeNull();
    expect(parseForceOrder(JSON.stringify({ data: { e: "aggTrade" } }))).toBeNull();
    expect(parseForceOrder(JSON.stringify({ data: { e: "forceOrder", o: { s: "BTCUSDT", S: "HOLD", p: "1", ap: "1", q: "1", T: 1 } } }))).toBeNull();
  });
});
