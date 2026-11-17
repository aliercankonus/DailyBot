import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("defaults to paper with safe limits and ignores empty values", () => {
    const c = loadConfig({ BINANCE_BASE_URL: "", API_TOKEN: "" });
    expect(c.MODE).toBe("paper");
    expect(c.RISK_PER_TRADE).toBe(0.005);
    expect(c.baseUrl).toBe("https://fapi.binance.com");
    expect(c.intervalMs).toBe(4 * 3600_000);
    expect(c.BINANCE_STOP_API).toBe("auto");
  });
  it("live needs explicit confirmation and keys", () => {
    expect(() => loadConfig({ MODE: "live", BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" })).toThrow(/CONFIRM_LIVE/);
    expect(() => loadConfig({ MODE: "testnet" })).toThrow(/API_KEY/);
    expect(() => loadConfig({ MODE: "testnet" }, "engine")).toThrow(/API_KEY/);
  });
  it("refuses risky settings", () => {
    expect(() => loadConfig({ RISK_PER_TRADE: "0.05" })).toThrow();
    expect(() => loadConfig({ MAX_LEVERAGE: "20" })).toThrow();
  });
  it("validates role-specific requirements per process", () => {
    // api and migrate never receive Binance keys or CONFIRM_LIVE.
    expect(loadConfig({ MODE: "live", API_TOKEN: "a".repeat(24) }, "api").MODE).toBe("live");
    expect(loadConfig({ MODE: "live", DATABASE_URL: "postgres://x@db/y" }, "migrate").DATABASE_URL).toBe("postgres://x@db/y");
    expect(() => loadConfig({ MODE: "paper" }, "api")).toThrow(/API_TOKEN/);
    expect(() => loadConfig({ API_TOKEN: "short" }, "api")).toThrow();
  });
  it("accepts every stop API mode", () => {
    for (const v of ["algo", "legacy", "auto"]) expect(loadConfig({ BINANCE_STOP_API: v }).BINANCE_STOP_API).toBe(v);
    expect(() => loadConfig({ BINANCE_STOP_API: "other" })).toThrow();
  });
  it("validates interval and numeric bounds", () => {
    expect(() => loadConfig({ INTERVAL: "toString" })).toThrow(/interval/);
    expect(() => loadConfig({ INTERVAL: "constructor" })).toThrow(/interval/);
    expect(loadConfig({ INTERVAL: "1h" }).intervalMs).toBe(3_600_000);
    expect(() => loadConfig({ TAKER_FEE: "0.02" })).toThrow();
    expect(loadConfig({ TAKER_FEE: "0.01" }).TAKER_FEE).toBe(0.01);
    expect(() => loadConfig({ SLIPPAGE: "0.06" })).toThrow();
    expect(() => loadConfig({ API_PORT: "0" })).toThrow();
    expect(() => loadConfig({ API_PORT: "65536" })).toThrow();
    expect(loadConfig({ API_PORT: "8081" }).API_PORT).toBe(8081);
  });
});
