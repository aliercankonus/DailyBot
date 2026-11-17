import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { makePool } from "./runtime.js";

const cfg = loadConfig(process.env, "migrate");
const pool = makePool(cfg);
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
await pool.query(sql);
console.log("schema applied");
await pool.end();
