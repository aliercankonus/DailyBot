// Runs only when TEST_DATABASE_URL points at a disposable Postgres database.
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgRepo } from "../src/db/pgRepo.js";
import type { PositionRow } from "../src/db/repo.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgRepo (postgres)", () => {
  let pool: pg.Pool;
  let repo: PgRepo;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await pool.query("DROP TABLE IF EXISTS positions, signals, events, equity, bot_state");
    const sql = await readFile(new URL("../src/db/schema.sql", import.meta.url), "utf8");
    await pool.query(sql);
    await pool.query(sql); // idempotent
    repo = new PgRepo(pool);
  });
  afterAll(async () => pool?.end());

  const row = (id: string): PositionRow => ({
    id, symbol: "BTCUSDT", side: "LONG", status: "OPEN", quantity: 0.01, entryPrice: 50000,
    entryTime: 1_700_000_000_000, entryCandleOpenTime: 1_699_990_000_000, initialStop: 49000, stop: 49000,
    stopOrderId: null, leverage: 2, riskAmount: 10, exitPrice: null, exitTime: null, exitReason: null,
    realizedPnl: null, fees: null, strategy: "t",
  });

  it("round-trips a position with numeric BIGINTs", async () => {
    await repo.insertPosition(row("a"));
    const p = await repo.getOpenPosition("BTCUSDT");
    expect(p).toEqual(row("a"));
    expect(typeof p!.entryTime).toBe("number");
  });

  it("enforces one open position per symbol", async () => {
    await expect(repo.insertPosition(row("b"))).rejects.toThrow();
  });

  it("updates and lists closed positions", async () => {
    await repo.updatePosition("a", { status: "CLOSED", exitTime: 1_700_000_100_000, exitPrice: 51000, realizedPnl: 10 });
    expect(await repo.getOpenPosition("BTCUSDT")).toBeNull();
    const closed = await repo.listClosedSince(0);
    expect(closed[0]!.exitPrice).toBe(51000);
    await repo.insertPosition({ ...row("c"), status: "CLOSED", exitTime: 1_700_000_200_000 });
    const latest = await repo.listClosed(1);
    expect(latest.map((p) => p.id)).toEqual(["c"]);
    expect(latest[0]!.exitTime).toBe(1_700_000_200_000);
    expect((await repo.listClosed(10)).map((p) => p.id)).toEqual(["c", "a"]);
  });

  it("stores state, signals, events and equity", async () => {
    await repo.setState("k", { on: true, n: 1 });
    expect(await repo.getState("k")).toEqual({ on: true, n: 1 });
    await repo.recordSignal({ symbol: "X", candleOpenTime: 1, side: "SHORT", accepted: false, gate: "NO_SIGNAL", detail: "d", createdAt: 2 });
    await repo.recordEvent({ level: "info", kind: "K", symbol: null, message: "m", data: { a: 1 }, createdAt: 3 });
    await repo.recordEquity(900_000, 1000);
    await repo.recordEquity(900_000, 1001);
    const eq = await pool.query("SELECT equity FROM equity");
    expect(eq.rows).toEqual([{ equity: 1001 }]);
  });
});
