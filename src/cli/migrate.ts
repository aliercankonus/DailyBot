// Applies the idempotent schema to DATABASE_URL and, for running several engines side by side,
// to every database named in EXTRA_DATABASES (comma-separated, created when missing on the same
// server). Each engine instance uses its own database: its own positions, paper account,
// kill switch and equity curve.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { parseExtraDatabases, quoteIdent } from "../db/dbNames.js";
import { makePool } from "./runtime.js";

const cfg = loadConfig(process.env, "migrate");
const extra = parseExtraDatabases(process.env.EXTRA_DATABASES); // validated before any query
// schema.sql lives in src/db; in the Docker image it is copied next to dist/db.
const candidates = [new URL("../db/schema.sql", import.meta.url), new URL("../../src/db/schema.sql", import.meta.url)];
let sql: string | undefined;
for (const c of candidates) {
  try {
    sql = await readFile(fileURLToPath(c), "utf8");
    break;
  } catch {}
}
if (!sql) throw new Error("schema.sql not found");

const main = makePool(cfg);
try {
  await main.query(sql);
  console.log("schema applied");
  for (const name of extra) {
    const { rowCount } = await main.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!rowCount) {
      try {
        await main.query(`CREATE DATABASE ${quoteIdent(name)}`);
        console.log(`database ${name} created`);
      } catch (e) {
        // 42P04: created concurrently by another migrate run.
        if ((e as { code?: string }).code !== "42P04") throw e;
      }
    }
    const url = new URL(cfg.DATABASE_URL);
    url.pathname = `/${name}`;
    const pool = makePool({ DATABASE_URL: url.toString() });
    try {
      await pool.query(sql);
    } finally {
      await pool.end();
    }
    console.log(`schema applied to ${name}`);
  }
} finally {
  await main.end();
}
