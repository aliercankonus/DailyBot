// One-shot: repair closed positions that were recorded without fill prices, from Binance trade history.
// Env: DATABASE_URL (engine db), BINANCE_API_KEY/SECRET, BINANCE_BASE_URL (default demo for MODE=testnet),
// REPAIR=dry (print only) or REPAIR=apply (write). Anything else: skip. Never places orders (read-only on Binance).
import pg from "pg";
import { BinanceFutures } from "../exchange/binanceFutures.js";
import { PgRepo } from "../db/pgRepo.js";
import { needsRepair, repairFromFills } from "../report/repairTrades.js";

const mode = process.env.REPAIR;
if (mode !== "dry" && mode !== "apply") {
  console.log("repair skipped (set REPAIR=dry or REPAIR=apply to run)");
  process.exit(0);
}
const { DATABASE_URL, BINANCE_API_KEY, BINANCE_API_SECRET } = process.env;
if (!DATABASE_URL || !BINANCE_API_KEY || !BINANCE_API_SECRET) {
  console.error("repair: DATABASE_URL, BINANCE_API_KEY and BINANCE_API_SECRET are required");
  process.exit(1);
}
const baseUrl = process.env.BINANCE_BASE_URL || (process.env.MODE === "live" ? "https://fapi.binance.com" : "https://demo-fapi.binance.com");
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
const repo = new PgRepo(pool);
const ex = new BinanceFutures({ apiKey: BINANCE_API_KEY, apiSecret: BINANCE_API_SECRET, baseUrl, stopOrderApi: "legacy" });
await ex.syncTime();

const rows = (await repo.listClosed(1000)).filter(needsRepair);
console.log(JSON.stringify({ msg: "repair candidates", mode, count: rows.length }));
for (const p of rows) {
  const fills = await ex.getFills(p.symbol, p.entryTime - 2 * 60_000);
  const patch = repairFromFills(p, fills);
  const before = { entryPrice: p.entryPrice, exitPrice: p.exitPrice, realizedPnl: p.realizedPnl, fees: p.fees };
  if (!patch) {
    console.log(JSON.stringify({ msg: "repair not possible (fills do not match the position quantity)", id: p.id, symbol: p.symbol, before, fills: fills.length }));
    continue;
  }
  if (mode === "apply") {
    await repo.updatePosition(p.id, patch);
    await repo.recordEvent({ createdAt: Date.now(), level: "info", kind: "POSITION_REPAIRED", symbol: p.symbol, message: `prices rebuilt from exchange fills: ${JSON.stringify(before)} -> ${JSON.stringify(patch)}` });
  }
  console.log(JSON.stringify({ msg: mode === "apply" ? "repaired" : "would repair", id: p.id, symbol: p.symbol, side: p.side, before, after: patch }));
}
await pool.end();
