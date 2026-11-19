import { describe, expect, it } from "vitest";
import { thin, markPriceFeed } from "../src/dashboard/data.js";
import { buildDashboard } from "../src/dashboard/server.js";

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
const app = () => buildDashboard({ engines: [], user: "admin", password: "correct-horse-battery", prices: async () => ({ BTCUSDT: 1 }) });

describe("dashboard server", () => {
  it("an empty password means no login (owner's choice); pages still get the security headers", async () => {
    const a = buildDashboard({ engines: [], user: "admin", password: "", prices: async () => ({}) });
    const r = await a.inject({ url: "/" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["x-robots-tag"]).toMatch(/noindex/);
    expect((await a.inject({ url: "/api/overview" })).statusCode).toBe(200);
  });
  it("refuses a short password", () => {
    expect(() => buildDashboard({ engines: [], user: "a", password: "short", prices: async () => ({}) })).toThrow(/12 characters/);
  });
  it("requires basic auth everywhere except /health, and sets security headers", async () => {
    const a = app();
    expect((await a.inject({ url: "/health" })).statusCode).toBe(200);
    const denied = await a.inject({ url: "/" });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["www-authenticate"]).toMatch(/Basic/);
    expect((await a.inject({ url: "/api/overview", headers: { authorization: basic("admin", "wrong-password-xx") } })).statusCode).toBe(401);
    const ok = await a.inject({ url: "/", headers: { authorization: basic("admin", "correct-horse-battery") } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("DailyBot");
    expect(ok.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    const ov = await a.inject({ url: "/api/overview", headers: { authorization: basic("admin", "correct-horse-battery") } });
    expect(ov.json().prices.BTCUSDT).toBe(1);
  });
  it("locks out an IP after repeated failures", async () => {
    const a = app();
    for (let i = 0; i < 10; i++) await a.inject({ url: "/", headers: { authorization: basic("admin", "nope-nope-nope") } });
    expect((await a.inject({ url: "/", headers: { authorization: basic("admin", "correct-horse-battery") } })).statusCode).toBe(429);
  });
});

describe("dashboard data helpers", () => {
  it("thin keeps at most max points and the last one", () => {
    const r = thin(Array.from({ length: 1000 }, (_, i) => i), 100);
    expect(r).toHaveLength(100);
    expect(r.at(-1)).toBe(999);
  });
  it("mark price feed caches and survives failures", async () => {
    let calls = 0;
    const ok = (async () => { calls++; return new Response(JSON.stringify([{ symbol: "BTCUSDT", markPrice: "100" }, { symbol: "XRPUSDT", markPrice: "1" }])); }) as typeof fetch;
    const feed = markPriceFeed(["BTCUSDT"], ok, 15_000);
    expect(await feed(1_000_000)).toEqual({ BTCUSDT: 100 });
    await feed(1_005_000);
    expect(calls).toBe(1);
    const bad = markPriceFeed(["BTCUSDT"], (async () => { throw new Error("down"); }) as typeof fetch);
    expect(await bad(1)).toEqual({});
  });
});

describe("dashboard hardening", () => {
  it("a spoofed X-Forwarded-For does not reset the lockout (one trusted hop)", async () => {
    const a = app();
    for (let i = 0; i < 10; i++) {
      await a.inject({ url: "/", remoteAddress: "10.0.0.2", headers: { "x-forwarded-for": `1.2.3.${i}, 9.9.9.9`, authorization: basic("admin", "nope-nope-nope") } });
    }
    const r = await a.inject({ url: "/", remoteAddress: "10.0.0.2", headers: { "x-forwarded-for": "5.5.5.5, 9.9.9.9", authorization: basic("admin", "correct-horse-battery") } });
    expect(r.statusCode).toBe(429);
  });
  it("hides database error details from the client", async () => {
    const pool = { query: async () => { throw new Error("connect ECONNREFUSED db:5432"); } } as never;
    const a = buildDashboard({ engines: [{ key: "A", label: "A", mode: "paper", strategy: "x", exitRule: "y", pool }], user: "admin", password: "correct-horse-battery", prices: async () => ({}) });
    const r = await a.inject({ url: "/api/overview", headers: { authorization: basic("admin", "correct-horse-battery") } });
    expect(JSON.stringify(r.json())).not.toContain("ECONNREFUSED");
  });
});
