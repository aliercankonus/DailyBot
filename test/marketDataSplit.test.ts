import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { MarketDataSplit } from "../src/exchange/marketDataSplit.js";
import type { Exchange } from "../src/exchange/types.js";
import { candlesFromCloses, FakeExchange } from "./helpers.js";

const H4 = 4 * 3_600_000;
const T0 = Date.UTC(2026, 10, 1);

describe("MarketDataSplit", () => {
  it("reads candles and funding from market data, everything else from the trading exchange", async () => {
    const trading = new FakeExchange();
    trading.candles.BTCUSDT = candlesFromCloses([50_000, 50_000], T0, H4); // demo: a fake wick price
    trading.funding.BTCUSDT = [{ time: T0, rate: 0.01 }];
    const data = new FakeExchange();
    data.candles.BTCUSDT = candlesFromCloses([60_000, 60_100], T0, H4);
    data.funding.BTCUSDT = [{ time: T0, rate: 0.0001 }];
    data.now = trading.now = T0 + 10 * H4;
    const ex: Exchange = new MarketDataSplit(trading, data);

    const cs = await ex.getClosedCandles("BTCUSDT", "4h", 2);
    expect(cs.at(-1)!.close).toBe(60_100);
    expect((await ex.getFundingHistory("BTCUSDT", 0))[0]!.rate).toBe(0.0001);
    expect(data.fundingCalls).toBe(1);
    expect(trading.fundingCalls).toBe(0);

    trading.mark.BTCUSDT = 59_000;
    await ex.getBalance();
    await ex.placeStop({ symbol: "BTCUSDT", side: "BUY", quantity: 0.01, stopPrice: 62_000, clientId: "c1" });
    expect(trading.stops).toHaveLength(1);
    expect(data.stops).toHaveLength(0);
    expect(await ex.getOpenStops("BTCUSDT")).toHaveLength(1);
  });
});

describe("MARKET_DATA_BASE_URL", () => {
  const base = { BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s", ALLOW_UNREGISTERED_ACCOUNT: "1" };
  it("is accepted on testnet, https only", () => {
    expect(loadConfig({ ...base, MODE: "testnet", MARKET_DATA_BASE_URL: "https://fapi.binance.com" }).MARKET_DATA_BASE_URL).toBe("https://fapi.binance.com");
    expect(() => loadConfig({ ...base, MODE: "testnet", MARKET_DATA_BASE_URL: "http://fapi.binance.com" })).toThrow();
  });
  it("is refused outside testnet", () => {
    expect(() => loadConfig({ ...base, MODE: "paper", MARKET_DATA_BASE_URL: "https://fapi.binance.com" })).toThrow(/testnet only/);
    expect(() => loadConfig({ ...base, MODE: "live", CONFIRM_LIVE: "I_UNDERSTAND_REAL_MONEY", MARKET_DATA_BASE_URL: "https://fapi.binance.com" })).toThrow(/testnet only/);
  });
});
