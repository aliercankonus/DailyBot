// Long-running engine process. Ticks every TICK_SECONDS, never overlapping.
// A Postgres advisory lock guarantees a single engine instance per database.
import { loadConfig } from "../config.js";
import { PgRepo } from "../db/pgRepo.js";
import { Engine } from "../engine/engine.js";
import { createTrendBreakout } from "../strategy/trendBreakout.js";
import { makeExchange, makeNotifier, makePool } from "./runtime.js";

const ENGINE_LOCK_ID = 727_001;
const cfg = loadConfig();
const pool = makePool(cfg);
const lockClient = await pool.connect();
const { rows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS ok", [ENGINE_LOCK_ID]);
if (!rows[0]?.ok) {
  console.error("Another engine instance holds the lock. Exiting.");
  process.exit(1);
}

const repo = new PgRepo(pool);
const notifier = makeNotifier(cfg);
const { exchange, persist } = await makeExchange(cfg, repo);
const engine = new Engine({
  exchange, repo, notifier, strategy: createTrendBreakout(),
  cfg: {
    symbols: cfg.symbols, interval: cfg.INTERVAL, intervalMs: cfg.intervalMs, riskPerTrade: cfg.RISK_PER_TRADE,
    maxLeverage: cfg.MAX_LEVERAGE, maxOpenPositions: cfg.MAX_OPEN_POSITIONS, dailyLossLimit: cfg.DAILY_LOSS_LIMIT,
    maxDrawdown: cfg.MAX_DRAWDOWN, maxCandleDelayMs: 15 * 60_000,
  },
});

let running = false;
let stopping = false;
let consecutiveFailures = 0;

async function tick() {
  if (running || stopping) return;
  running = true;
  const t0 = Date.now();
  try {
    await engine.tick();
    await persist();
    consecutiveFailures = 0;
    console.log(JSON.stringify({ level: "info", msg: "tick", ms: Date.now() - t0, mode: cfg.MODE }));
  } catch (e) {
    consecutiveFailures++;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ level: "error", msg: "tick failed", error: msg, consecutiveFailures }));
    if (consecutiveFailures === 5) await notifier.send("error", `Engine: 5 consecutive tick failures. Last: ${msg}`);
  } finally {
    running = false;
  }
}

async function shutdown(sig: string) {
  stopping = true;
  console.log(`${sig}: waiting for current tick, then exiting`);
  while (running) await new Promise((r) => setTimeout(r, 200));
  await persist().catch(() => {});
  lockClient.release();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await notifier.send("info", `Engine started: mode=${cfg.MODE} symbols=${cfg.symbols.join(",")} interval=${cfg.INTERVAL} risk=${cfg.RISK_PER_TRADE * 100}%`);
await tick();
setInterval(() => void tick(), cfg.TICK_SECONDS * 1000);
