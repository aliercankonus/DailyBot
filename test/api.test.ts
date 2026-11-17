import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { MemoryRepo } from "../src/db/repo.js";

const url = process.env.TEST_DATABASE_URL;
const TOKEN = "t".repeat(32);

describe("api auth and kill switch", () => {
  const pool = new pg.Pool({ connectionString: url ?? "postgres://invalid:1/none" });
  const repo = new MemoryRepo();
  const app = buildServer({ pool, repo, token: TOKEN, mode: "paper" });
  afterAll(async () => { await app.close(); await pool.end(); });

  it("health is public", async () => {
    const r = await app.inject({ url: "/health" });
    expect(r.statusCode).toBe(200);
  });

  it("everything else needs the token", async () => {
    expect((await app.inject({ url: "/status" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/status", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/status", headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(200);
  });

  it("kill switch on is free, off needs a reason", async () => {
    const h = { authorization: `Bearer ${TOKEN}` };
    expect((await app.inject({ method: "POST", url: "/kill-switch", headers: h, payload: { on: true } })).statusCode).toBe(200);
    expect((await repo.getState<{ on: boolean }>("killSwitch"))?.on).toBe(true);
    expect((await app.inject({ method: "POST", url: "/kill-switch", headers: h, payload: { on: false } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/kill-switch", headers: h, payload: { on: false, reason: "checked" } })).statusCode).toBe(200);
  });

  it.skipIf(!url)("lists positions from postgres", async () => {
    const r = await app.inject({ url: "/positions", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(200);
  });
});
