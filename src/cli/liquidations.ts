// Liquidation collector: listens to Binance USD-M !forceOrder for LIQ_SYMBOLS and stores every
// event in the main database (table liquidations). Research data only; it never trades.
// Env: DATABASE_URL (main db), LIQ_SYMBOLS (default BTCUSDT,ETHUSDT).
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { liquidationStreamUrl, parseForceOrder, type Liquidation } from "../collect/liquidations.js";

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

let stored = 0, received = 0, backoff = 1_000, stopping = false, socket: WebSocket | null = null, lastMessage = Date.now();

async function store(l: Liquidation) {
  await pool.query(
    `INSERT INTO liquidations (symbol, side, price, avg_price, quantity, notional, status, trade_time, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
    [l.symbol, l.side, l.price, l.avgPrice, l.quantity, l.notional, l.status, l.tradeTime, Date.now()],
  );
  stored++;
}

function connect() {
  if (stopping) return;
  const url = liquidationStreamUrl(symbols);
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    backoff = 1_000;
    lastMessage = Date.now();
    log("info", "connected", { symbols });
  };
  ws.onmessage = (ev) => {
    lastMessage = Date.now();
    received++;
    const l = parseForceOrder(String(ev.data));
    if (l) store(l).catch((e) => log("error", "store failed", { error: e instanceof Error ? e.message : String(e) }));
  };
  ws.onerror = () => log("warn", "websocket error");
  ws.onclose = (ev) => {
    socket = null;
    if (stopping) return;
    log("warn", "disconnected; reconnecting", { code: ev.code, inMs: backoff });
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  };
}

// Heartbeat for the container healthcheck: written while the socket is open. Liquidations can be
// absent for long quiet periods, so silence alone is not a failure; a socket that stays closed is.
setInterval(() => {
  if (socket && socket.readyState === WebSocket.OPEN) writeFile(HEARTBEAT_FILE, String(Date.now())).catch(() => {});
  // Binance drops streams after 24h; if nothing at all arrived for 6 hours, force a reconnect.
  if (socket && Date.now() - lastMessage > 6 * 3600_000) {
    log("warn", "no message for 6h; reconnecting");
    socket.close();
  }
}, 60_000);
setInterval(() => log("info", "stats", { received, stored }), 3600_000);

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
