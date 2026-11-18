import { describe, expect, it } from "vitest";
import { parseExtraDatabases, quoteIdent } from "../src/db/dbNames.js";
import { isWeightStrategy, validateEngineStrategy, WEIGHT_STRATEGIES } from "../src/strategy/weightRegistry.js";
import { getStrategy } from "../src/strategy/registry.js";
import { loadConfig } from "../src/config.js";

describe("EXTRA_DATABASES", () => {
  it("accepts plain lower-case identifiers up to 63 chars, trims and de-duplicates", () => {
    expect(parseExtraDatabases(" trader_st, trader_gls ,trader_st,")).toEqual(["trader_st", "trader_gls"]);
    expect(parseExtraDatabases("a".repeat(63))).toHaveLength(1);
    expect(parseExtraDatabases(undefined)).toEqual([]);
    expect(parseExtraDatabases("")).toEqual([]);
  });
  it.each(["a".repeat(64), "A", "1a", "a-b", 'a"; DROP DATABASE x;--', "a b"])("rejects %s", (n) => {
    expect(() => parseExtraDatabases(n)).toThrow(/invalid database name/);
  });
  it.each(["postgres", "template0", "template1"])("refuses the system database %s", (n) => {
    expect(() => parseExtraDatabases(n)).toThrow(/system database/);
  });
  it("quotes identifiers", () => {
    expect(quoteIdent("user")).toBe('"user"');
  });
});

describe("engine STRATEGY", () => {
  it("weight registry only knows its own names", () => {
    expect(isWeightStrategy("donchianls")).toBe(true);
    for (const n of ["toString", "constructor", "__proto__", "unknown", "trend"]) expect(isWeightStrategy(n)).toBe(false);
    for (const make of Object.values(WEIGHT_STRATEGIES)) expect(typeof make().weightSeries).toBe("function");
  });
  it("validates names and leverage before the engine starts", () => {
    const resolve = (n: string) => getStrategy(n);
    expect(() => validateEngineStrategy("trendlv+timestop", 3, resolve)).not.toThrow();
    expect(() => validateEngineStrategy("st1d", 3, resolve)).not.toThrow();
    expect(() => validateEngineStrategy("donchianls", 3, resolve)).not.toThrow();
    expect(() => validateEngineStrategy("donchianls", 1, resolve)).toThrow(/MAX_LEVERAGE 1/);
    expect(() => validateEngineStrategy("trendl", 3, resolve)).toThrow(/unknown strategy/);
    expect(() => validateEngineStrategy("donchianls+timestop", 3, resolve)).toThrow(/unknown strategy/);
  });
  it("config accepts strategy names and rejects anything else", () => {
    expect(loadConfig({}, "migrate").STRATEGY).toBe("trend");
    expect(loadConfig({ STRATEGY: "trendlv+timestop" }, "migrate").STRATEGY).toBe("trendlv+timestop");
    for (const bad of ["Trend", "a b", "a;b"]) expect(() => loadConfig({ STRATEGY: bad }, "migrate")).toThrow();
  });
});
