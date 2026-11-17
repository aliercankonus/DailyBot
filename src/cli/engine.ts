// Long-running engine process. Ticks every TICK_SECONDS, never overlapping.
// A Postgres advisory lock guarantees a single engine instance per database.
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { PgRepo } from "../db/pgRepo.js";
import { Engine } from "../engine/engine.js";
import { createTrendBreakout } from "../strategy/trendBreakout.js";
import { makeExchange, makeNotifier, makePool } from "./runtime.js";

const ENGINE_LOCK_ID = 727_001;
/** mtime is checked by the compose healthcheck (stale after 5 minutes). */
const HEARTBEAT_FILE = "/tmp/engine-heartbeat";
const SHUTDOWN_DEADLINE_MS = 45_000;
const LOCK_CHECK_TIMEOUT_MS = 10_000;
const STARTUP_FAILURE_DELAY_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const log = (level: "info" | "error" | "fatal", msg: string, extra: Record<string, unknown> = {}) =>
  (level === "info" ? console.log : console.error)(JSON.stringify({ level, msg, ...extra, time: new Date().toISOString() }));
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

const cfg = loadConfig(process.env, "engine");
const notifier = makeNotifier(cfg);
const pool = makePool(cfg);
const lockClient = await pool.connect();
// If the session holding the advisory lock dies, the lock is gone: another engine may start.
lockClient.on("error", (e) => {
  log("fatal", "advisory-lock connection error; lock possibly lost, exiting", { error: errMsg(e) });
  process.exit(1);
});
const { rows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS ok", [ENGINE_LOCK_ID]);
if (!rows[0]?.ok) {
  console.error("Another engine instance holds the lock. Exiting.");
  process.exit(1);
}

let running = false;
let stopping = false;
let consecutiveFailures = 0;
let interval: NodeJS.Timeout | undefined;
let persist: () => Promise<void> = async () => {};

async function persistSafely(context: string) {
  try {
    await withTimeout(persist(), 10_000, "persist");
    return true;
  } catch (e) {
    log("error", "persist failed", { context, error: errMsg(e) });
    return false;
  }
}

async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  if (interval) clearInterval(interval);
  log("info", `${sig}: waiting for current tick, then exiting`);
  const deadline = setTimeout(() => {
    log("fatal", `SHUTDOWN DEADLINE EXCEEDED (${SHUTDOWN_DEADLINE_MS / 1000}s): tick still running, persisting and exiting with code 1`);
    void persistSafely("shutdown deadline").finally(() => process.exit(1));
  }, SHUTDOWN_DEADLINE_MS);
  while (running) await sleep(200);
  await persistSafely("shutdown");
  clearTimeout(deadline);
  lockClient.release();
  await pool.end().catch(() => {});
  process.exit(0);
}
// Registered right after taking the lock, so a stop during startup is handled too.
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function tick(engine: Engine) {
  if (running || stopping) return;
  running = true;
  const t0 = Date.now();
  let ok = false;
  try {
    // Cheap liveness probe on the lock session: if it fails the lock may be lost.
    try {
      await withTimeout(lockClient.query("SELECT 1"), LOCK_CHECK_TIMEOUT_MS, "lock check");
    } catch (e) {
      log("fatal", "advisory-lock connection check failed; lock possibly lost, exiting", { error: errMsg(e) });
      await notifier.send("error", `Engine exiting: lock connection check failed (${errMsg(e)})`);
      process.exit(1);
    }
    await engine.tick();
    ok = true;
    consecutiveFailures = 0;
  } catch (e) {
    consecutiveFailures++;
    const msg = errMsg(e);
    log("error", "tick failed", { error: msg, consecutiveFailures });
    if (consecutiveFailures === 5) await notifier.send("error", `Engine: 5 consecutive tick failures. Last: ${msg}`);
  } finally {
    // Paper fills already happened in memory, so persist even after a failed tick.
    const persisted = await persistSafely(ok ? "tick" : "failed tick");
    if (ok && persisted) {
      await writeFile(HEARTBEAT_FILE, String(Date.now())).catch((e) => log("error", "heartbeat write failed", { error: errMsg(e) }));
      log("info", "tick", { ms: Date.now() - t0, mode: cfg.MODE });
    }
    running = false;
  }
}

try {
  const repo = new PgRepo(pool);
  const ex = await makeExchange(cfg, repo);
  persist = ex.persist;
  const engine = new Engine({
    exchange: ex.exchange, repo, notifier, strategy: createTrendBreakout(),
    cfg: {
      symbols: cfg.symbols, interval: cfg.INTERVAL, intervalMs: cfg.intervalMs, riskPerTrade: cfg.RISK_PER_TRADE,
      maxLeverage: cfg.MAX_LEVERAGE, maxOpenPositions: cfg.MAX_OPEN_POSITIONS, dailyLossLimit: cfg.DAILY_LOSS_LIMIT,
      maxDrawdown: cfg.MAX_DRAWDOWN, maxCandleDelayMs: 15 * 60_000,
      roundTripCostPct: 2 * (cfg.TAKER_FEE + cfg.SLIPPAGE),
    },
  });
  await notifier.send("info", `Engine started: mode=${cfg.MODE} symbols=${cfg.symbols.join(",")} interval=${cfg.INTERVAL} risk=${cfg.RISK_PER_TRADE * 100}%`);
  await tick(engine);
  if (!stopping) interval = setInterval(() => void tick(engine), cfg.TICK_SECONDS * 1000);
} catch (e) {
  // Delay before exiting so `restart: unless-stopped` does not turn this into a tight crash loop.
  log("fatal", "engine startup failed", { error: errMsg(e) });
  await notifier.send("error", `Engine startup failed: ${errMsg(e)}. Retrying in ${STARTUP_FAILURE_DELAY_MS / 1000}s.`);
  await sleep(STARTUP_FAILURE_DELAY_MS);
  if (!stopping) process.exit(1);
}
