// Operations dashboard process. Env: DASHBOARD_PASSWORD (>= 12 chars), DASHBOARD_USER (default admin),
// DASH_DB_A / DASH_DB_GC / DASH_DB_TS (engine databases), DASH_MODE_A / _GC / _TS (display only),
// DASH_STRATEGY_A / _GC / _TS (display only), API_PORT (default 8080).
import pg from "pg";
import { markPriceFeed } from "../dashboard/data.js";
import { buildDashboard } from "../dashboard/server.js";

const env = process.env;
const password = env.DASHBOARD_PASSWORD ?? "";
if (password.length < 12) {
  console.error(JSON.stringify({ level: "fatal", msg: "DASHBOARD_PASSWORD must be set (at least 12 characters)" }));
  process.exit(1);
}
const ENGINES = [
  { key: "A", label: "Trend kırılımı (4s)", exitRule: "3 ATR takip eden stop + zaman stopu" },
  { key: "GC", label: "Altın kesişim (1s)", exitRule: "ters kesişim; 2R'de stop girişe (be2)" },
  { key: "TS", label: "Momentum (4s, long)", exitRule: "momentum skoru 0'a düşünce; 4 ATR stop" },
];
const engines = ENGINES.flatMap((e) => {
  const url = env[`DASH_DB_${e.key}`];
  if (!url) return [];
  return [{ ...e, mode: env[`DASH_MODE_${e.key}`] || "paper", strategy: env[`DASH_STRATEGY_${e.key}`] || "", pool: new pg.Pool({ connectionString: url, max: 3 }) }];
});
if (!engines.length) {
  console.error(JSON.stringify({ level: "fatal", msg: "no DASH_DB_* database configured" }));
  process.exit(1);
}
const app = buildDashboard({ engines, user: env.DASHBOARD_USER || "admin", password, prices: markPriceFeed(["BTCUSDT", "ETHUSDT"]) });
const port = Number(env.API_PORT || 8080);
await app.listen({ host: "0.0.0.0", port });
console.log(`dashboard listening on :${port} (${engines.map((e) => e.key).join(", ")})`);
