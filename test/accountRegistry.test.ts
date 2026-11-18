import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyFingerprint, registerEngineAccount } from "../src/db/accountRegistry.js";

const url = process.env.TEST_DATABASE_URL;

describe("account registry", () => {
  it("fingerprints never contain the key", () => {
    const fp = keyFingerprint("my-secret-api-key");
    expect(fp).toHaveLength(24);
    expect(fp).not.toContain("secret");
    expect(keyFingerprint("my-secret-api-key")).toBe(fp);
  });
});

describe.skipIf(!url)("account registry (postgres)", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    const sql = await readFile(new URL("../src/db/schema.sql", import.meta.url), "utf8");
    // Other test files may apply the schema at the same moment; concurrent CREATE ... IF NOT EXISTS
    // on a fresh database can fail once with a duplicate-type error, so retry once.
    await pool.query(sql).catch(() => pool.query(sql));
    await pool.query("DELETE FROM engine_accounts");
  });
  afterAll(async () => { await pool.end(); });

  it("lets an engine re-register its own key and refuses the same key for another engine", async () => {
    await registerEngineAccount(pool, "key-A", "A", "trader");
    await registerEngineAccount(pool, "key-A", "A", "trader"); // restart of the same engine
    await registerEngineAccount(pool, "key-ST", "ST", "trader_st");
    await expect(registerEngineAccount(pool, "key-A", "GLS", "trader_gls")).rejects.toThrow(/already registered by engine A .*DELETE FROM engine_accounts/);
    // A copied service that kept BOT_NAME and the key but uses another database is refused too.
    await expect(registerEngineAccount(pool, "key-ST", "ST", "trader_st2")).rejects.toThrow(/database trader_st/);
    const { rows } = await pool.query("SELECT fingerprint FROM engine_accounts");
    expect(JSON.stringify(rows)).not.toContain("key-A");
  });
});
