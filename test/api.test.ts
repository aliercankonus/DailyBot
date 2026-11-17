import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { MemoryRepo, type PositionRow } from "../src/db/repo.js";
import { PgRepo } from "../src/db/pgRepo.js";

const url = process.env.TEST_DATABASE_URL;
const TOKEN = "t".repeat(32);
const h = { authorization: `Bearer ${TOKEN}` };

const row = (id: string, symbol: string, extra: Partial<PositionRow> = {}): PositionRow => ({
  id, symbol, side: "SHORT", status: "OPEN", quantity: 1, entryPrice: 100, entryTime: 1_700_000_000_000,
  entryCandleOpenTime: 1_699_990_000_000, initialStop: 110, stop: 110, stopOrderId: null, leverage: 2, riskAmount: 10,
  exitPrice: null, exitTime: null, exitReason: null, realizedPnl: null, fees: null, strategy: "t", ...extra,
});

describe("api auth and kill switch", () => {
  const pool = new pg.Pool({ connectionString: "postgres://invalid:1/none" });
  const repo = new MemoryRepo();
  const app = buildServer({ pool, repo, token: TOKEN, mode: "paper" });
  afterAll(async () => { await app.close(); await pool.end(); });

  it("health is public, also with a query string", async () => {
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/health?probe=1" })).statusCode).toBe(200);
  });

  it("everything else needs the token", async () => {
    expect((await app.inject({ url: "/status" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/status", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/status?x=/health", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/status", headers: h })).statusCode).toBe(200);
  });

  it("kill switch on is free, off needs a non-empty trimmed reason", async () => {
    expect((await app.inject({ method: "POST", url: "/kill-switch", headers: h, payload: { on: true } })).statusCode).toBe(200);
    const ks = await repo.getState<{ on: boolean; source: string }>("killSwitch");
    expect(ks).toMatchObject({ on: true, source: "manual" });
    expect((await app.inject({ method: "POST", url: "/kill-switch", headers: h, payload: { on: false } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/kill-switch", headers: h, payload: { on: false, reason: "   " } })).statusCode).toBe(400);
    const r = await app.inject({ method: "POST", url: "/kill-switch", headers: h, payload: { on: false, reason: "  checked  " } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ on: false, reason: "checked", source: "manual" });
  });

  it("an engine kill switch needs force and a 10+ char reason; OFF resets the equity peak", async () => {
    await repo.setState("killSwitch", { on: true, reason: "Max drawdown reached", at: 1, source: "engine" });
    await repo.setState("equityPeak", 12_000);
    const post = (payload: object) => app.inject({ method: "POST", url: "/kill-switch", headers: h, payload });
    expect((await post({ on: false, reason: "reviewed the drawdown" })).statusCode).toBe(409);
    expect((await post({ on: false, reason: "short", force: true })).statusCode).toBe(409);
    expect((await post({ on: false, reason: "reviewed the drawdown", force: "true" })).statusCode).toBe(409);
    expect((await repo.getState<{ on: boolean }>("killSwitch"))?.on).toBe(true);
    expect(await repo.getState("equityPeak")).toBe(12_000);
    expect((await post({ on: false, reason: "reviewed the drawdown", force: true })).statusCode).toBe(200);
    expect((await repo.getState<{ on: boolean }>("killSwitch"))?.on).toBe(false);
    expect(await repo.getState("equityPeak")).toBeNull();
    expect(repo.events.at(-1)).toMatchObject({ kind: "KILL_SWITCH_OFF", message: "reviewed the drawdown" });
  });

  it("a kill switch without a source is treated as engine-set", async () => {
    await repo.setState("killSwitch", { on: true, reason: "legacy", at: 1 });
    expect((await app.inject({ method: "POST", url: "/kill-switch", headers: h, payload: { on: false, reason: "checked" } })).statusCode).toBe(409);
  });

  it("rejects a non-boolean on", async () => {
    expect((await app.inject({ method: "POST", url: "/kill-switch", headers: h, payload: { on: "false" } })).statusCode).toBe(400);
  });

  it("returns camelCase positions, open by entry time and closed newest first", async () => {
    await repo.insertPosition(row("o1", "BTCUSDT"));
    await repo.insertPosition(row("c1", "ETHUSDT", { status: "CLOSED", exitTime: 1_700_000_100_000, exitPrice: 90 }));
    await repo.insertPosition(row("c2", "SOLUSDT", { status: "CLOSED", exitTime: 1_700_000_200_000, exitPrice: 95 }));
    const r = await app.inject({ url: "/positions", headers: h });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { open: PositionRow[]; closed: PositionRow[] };
    expect(body.open.map((p) => p.id)).toEqual(["o1"]);
    expect(body.closed.map((p) => p.id)).toEqual(["c2", "c1"]);
    expect(body.closed[0]).toMatchObject({ exitTime: 1_700_000_200_000, entryPrice: 100 });
  });
});

describe("api auth failure limiter", () => {
  const pool = new pg.Pool({ connectionString: "postgres://invalid:1/none" });
  let t = 0;
  const app = buildServer({ pool, repo: new MemoryRepo(), token: TOKEN, mode: "paper", now: () => t });
  afterAll(async () => { await app.close(); await pool.end(); });

  it("returns 429 after 10 failed auths per IP per minute", async () => {
    const bad = { authorization: "Bearer nope" };
    for (let i = 0; i < 10; i++) expect((await app.inject({ url: "/status", headers: bad, remoteAddress: "10.0.0.1" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/status", headers: bad, remoteAddress: "10.0.0.1" })).statusCode).toBe(429);
    expect((await app.inject({ url: "/status", headers: h, remoteAddress: "10.0.0.1" })).statusCode).toBe(429);
    // Other IPs and /health are unaffected.
    expect((await app.inject({ url: "/status", headers: h, remoteAddress: "10.0.0.2" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/health", remoteAddress: "10.0.0.1" })).statusCode).toBe(200);
    t += 60_000;
    expect((await app.inject({ url: "/status", headers: h, remoteAddress: "10.0.0.1" })).statusCode).toBe(200);
  });
});

describe.skipIf(!url)("api with postgres", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof buildServer>;
  beforeAll(async () => {
    // Own schema, so this file can run in parallel with pgRepo.test.ts against the same database.
    const admin = new pg.Pool({ connectionString: url });
    await admin.query("DROP SCHEMA IF EXISTS api_test CASCADE; CREATE SCHEMA api_test");
    await admin.end();
    pool = new pg.Pool({ connectionString: url, options: "-c search_path=api_test" });
    await pool.query(await readFile(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
    const repo = new PgRepo(pool);
    app = buildServer({ pool, repo, token: TOKEN, mode: "paper" });
    await repo.insertPosition(row("o1", "BTCUSDT"));
    await repo.insertPosition(row("c1", "ETHUSDT", { status: "CLOSED", exitTime: 1_700_000_100_000, exitPrice: 90 }));
    await repo.recordSignal({ symbol: "X", candleOpenTime: 1_700_000_000_000, side: "LONG", accepted: true, gate: null, detail: "d", createdAt: 1_700_000_000_001 });
    await repo.recordEvent({ level: "info", kind: "K", symbol: null, message: "m", createdAt: 1_700_000_000_002 });
    await repo.recordEquity(1_700_000_000_000, 1000);
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it("lists camelCase positions from postgres", async () => {
    const r = await app.inject({ url: "/positions", headers: h });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { open: PositionRow[]; closed: PositionRow[] };
    expect(body.open[0]).toMatchObject({ id: "o1", entryTime: 1_700_000_000_000 });
    expect(body.closed[0]).toMatchObject({ id: "c1", exitTime: 1_700_000_100_000, exitPrice: 90 });
    expect(body.closed[0]).not.toHaveProperty("exit_time");
  });

  it("returns BIGINT columns as numbers", async () => {
    const [s] = (await app.inject({ url: "/signals", headers: h })).json();
    expect(s).toMatchObject({ candle_open_time: 1_700_000_000_000, created_at: 1_700_000_000_001 });
    expect(typeof s.id).toBe("number");
    const [e] = (await app.inject({ url: "/events", headers: h })).json();
    expect(e.created_at).toBe(1_700_000_000_002);
    expect((await app.inject({ url: "/equity", headers: h })).json()).toEqual([{ time: 1_700_000_000_000, equity: 1000 }]);
  });
});
