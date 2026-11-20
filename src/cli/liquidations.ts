// Liquidation collector: listens to Binance USD-M !forceOrder for LIQ_SYMBOLS and stores every
// event in the main database (table liquidations). Research data only; it never trades.
// Env: DATABASE_URL (main db), LIQ_SYMBOLS (default BTCUSDT,ETHUSDT), LIQ_WS_BASE (default
// wss://fstream.binance.com/market; the legacy route without /market connects but sends nothing), LIQ_CONTROL=1 adds a mark-price control stream (diagnostics).
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { liquidationStreamUrl, parseForceOrder, streamOf, type Liquidation } from "../collect/liquidations.js";

const HEARTBEAT_FILE = "/tmp/collector-heartbeat";
const symbols = (process.env.LIQ_SYMBOLS || "BTCUSDT,ETHUSDT").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error(JSON.stringify({ level: "fatal", msg: "DATABASE_URL is required" }));
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, ...extra, time: new Date().toISOString() }));

const wsBase = process.env.LIQ_WS_BASE || "wss://fstream.binance.com/market";
const control = process.env.LIQ_CONTROL === "1";
const perStream: Record<string, number> = {};
let stored = 0, received = 0, backoff = 1_000, stopping = false, socket: WebSocket | null = null, lastMessage = Date.now();
let lastOpen = Date.now(), reconnectTimer: ReturnType<typeof setTimeout> | null = null;

async function store(l: Liquidation) {
  await pool.query(
    `INSERT INTO liquidations (symbol, side, price, avg_price, quantity, notional, status, trade_time, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
    [l.symbol, l.side, l.price, l.avgPrice, l.quantity, l.notional, l.status, l.tradeTime, Date.now()],
  );
  stored++;
}

/** Schedule exactly one reconnect (error and close can both fire, or close may never fire). */
function scheduleReconnect(reason: string) {
  if (stopping || reconnectTimer) return;
  log("warn", "reconnecting", { reason, inMs: backoff });
  try { socket?.close(); } catch { /* already closed */ }
  socket = null;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoff);
  backoff = Math.min(backoff * 2, 60_000);
}

function connect() {
  if (stopping) return;
  const url = liquidationStreamUrl(symbols, wsBase, control);
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    backoff = 1_000;
    lastOpen = Date.now();
    lastMessage = Date.now();
    log("info", "connected", { symbols, url });
  };
  ws.onmessage = (ev) => {
    lastMessage = Date.now();
    received++;
    const raw = String(ev.data);
    const st = streamOf(raw);
    perStream[st] = (perStream[st] ?? 0) + 1;
    const l = parseForceOrder(raw);
    if (l) store(l).catch((e) => log("error", "store failed", { error: e instanceof Error ? e.message : String(e) }));
  };
  ws.onerror = (ev) => {
    if (socket !== ws) return;
    scheduleReconnect(`error: ${(ev as { message?: string }).message ?? "websocket error"}`);
  };
  ws.onclose = (ev) => {
    if (socket !== ws) return;
    scheduleReconnect(`closed (code ${ev.code})`);
  };
}

// Heartbeat for the container healthcheck: written while the socket is open. Liquidations can be
// absent for long quiet periods, so silence alone is not a failure; a socket that stays closed is.
setInterval(() => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    lastOpen = Date.now();
    writeFile(HEARTBEAT_FILE, String(Date.now())).catch(() => {});
  } else if (Date.now() - lastOpen > 2 * 60_000) {
    // Watchdog: not connected for 2 minutes (a stuck CONNECTING socket, or a missed close event).
    scheduleReconnect("not connected for 2 minutes");
  }
  // Binance drops streams after 24h; if nothing at all arrived for 6 hours, force a reconnect.
  if (socket && Date.now() - lastMessage > 6 * 3600_000) {
    scheduleReconnect("no message for 6h");
  }
}, 60_000);
// Every 5 minutes for the first hour (diagnostics), then hourly.
const started = Date.now();
let lastStats = 0;
setInterval(() => {
  const every = Date.now() - started < 3600_000 ? 5 * 60_000 : 3600_000;
  if (Date.now() - lastStats < every) return;
  lastStats = Date.now();
  log("info", "stats", { received, stored, perStream });
}, 60_000);

async function shutdown() {
  stopping = true;
  socket?.close();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

await pool.query("SELECT 1 FROM liquidations LIMIT 1"); // fail fast if the schema is missing
connect();
