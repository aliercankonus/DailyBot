import { buildServer } from "../api/server.js";
import { loadConfig } from "../config.js";
import { PgRepo } from "../db/pgRepo.js";
import { makePool } from "./runtime.js";

const cfg = loadConfig(process.env, "api");
if (!cfg.API_TOKEN) throw new Error("API_TOKEN is required for the API process");
const pool = makePool(cfg);
const app = buildServer({ pool, repo: new PgRepo(pool), token: cfg.API_TOKEN, mode: cfg.MODE });
await app.listen({ host: "0.0.0.0", port: cfg.API_PORT });
console.log(`api listening on :${cfg.API_PORT}`);
