import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("defaults to paper with safe limits and ignores empty values", () => {
    const c = loadConfig({ BINANCE_BASE_URL: "", API_TOKEN: "" });
    expect(c.MODE).toBe("paper");
    expect(c.RISK_PER_TRADE).toBe(0.005);
    expect(c.baseUrl).toBe("https://fapi.binance.com");
    expect(c.intervalMs).toBe(4 * 3600_000);
  });
  it("live needs explicit confirmation and keys", () => {
    expect(() => loadConfig({ MODE: "live", BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" })).toThrow(/CONFIRM_LIVE/);
    expect(() => loadConfig({ MODE: "testnet" })).toThrow(/API_KEY/);
  });
  it("refuses risky settings", () => {
    expect(() => loadConfig({ RISK_PER_TRADE: "0.05" })).toThrow();
    expect(() => loadConfig({ MAX_LEVERAGE: "20" })).toThrow();
  });
});
