// Paper-vs-backtest report for every engine database named in REPORT_DB_<BOT>=<url> env vars
// (docker-compose.vps.yml: the one-shot `report` service, REPORT=1). Prints per engine: equity,
// drawdown, volatility, closed trades, win rate, profit factor, average R, open positions,
// recent errors and the kill switch, next to the backtest expectation, plus deviation flags and
// whether a 30-trade post-mortem is due.
import pg from "pg";
import { deviations, EXPECTATIONS, paperStats, POST_MORTEM_EVERY, type PaperStats } from "../report/paperStats.js";
import { distinctReasons, tagCounts } from "../report/decisions.js";

const pct = (x: number | null, d = 1) => (x === null ? "n/a" : `${(x * 100).toFixed(d)}%`);
const num = (x: number | null, d = 2) => (x === null ? "n/a" : Number.isFinite(x) ? x.toFixed(d) : "inf");

const dbs = Object.entries(process.env)
  .filter(([k, v]) => k.startsWith("REPORT_DB_") && v)
  .map(([k, v]) => ({ bot: k.slice("REPORT_DB_".length), url: v! }))
  .sort((a, b) => a.bot.localeCompare(b.bot));
if (!dbs.length) throw new Error("set REPORT_DB_<BOT>=<postgres url> for each engine database");

let total = { start: 0, end: 0 };
for (const { bot, url } of dbs) {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  pool.on("error", () => {});
  try {
    const trades = (await pool.query("SELECT realized_pnl, risk_amount, fees, exit_time FROM positions WHERE status = 'CLOSED' ORDER BY exit_time")).rows
      .map((r) => ({ realizedPnl: Number(r.realized_pnl ?? 0), riskAmount: Number(r.risk_amount ?? 0), fees: Number(r.fees ?? 0), exitTime: Number(r.exit_time ?? 0) }));
    const equity = (await pool.query("SELECT time, equity FROM equity ORDER BY time")).rows.map((r) => ({ time: Number(r.time), equity: Number(r.equity) }));
    const open = (await pool.query("SELECT symbol, side, quantity, entry_price, stop FROM positions WHERE status = 'OPEN' ORDER BY symbol")).rows;
    const errors = (await pool.query("SELECT kind, symbol, message, created_at FROM events WHERE level = 'error' ORDER BY created_at DESC LIMIT 5")).rows;
    const kinds = (await pool.query("SELECT kind, count(*)::int AS n FROM events WHERE created_at > $1 GROUP BY kind ORDER BY n DESC LIMIT 8", [Date.now() - 7 * 86_400_000])).rows;
    const ks = (await pool.query("SELECT value FROM bot_state WHERE key = 'killSwitch'")).rows[0]?.value as { on?: boolean; reason?: string } | undefined;
    const s: PaperStats = paperStats(trades, equity);
    const e = EXPECTATIONS[bot];
    total = { start: total.start + s.startEquity, end: total.end + s.endEquity };

    console.log(`==================== ${bot}: ${e?.label ?? "unknown engine"} ====================`);
    console.log(`period ${s.days.toFixed(1)} days | equity ${s.startEquity.toFixed(2)} -> ${s.endEquity.toFixed(2)} (${pct(s.returnPct, 2)}) | max DD ${pct(s.maxDrawdown)} (backtest max ${pct(e?.maxDrawdown ?? null)}) | vol ${pct(s.annualVol, 0)} (backtest ${pct(e?.annualVol ?? null, 0)})`);
    if (e?.tradesPer30d !== undefined || s.trades) {
      console.log(`closed trades ${s.trades} (${num(s.tradesPer30d, 1)}/30d, backtest ${num(e?.tradesPer30d ?? null, 1)}) | win ${pct(s.winRate)} (backtest ${pct(e?.winRate ?? null)}) | PF ${num(s.profitFactor)} (backtest ${num(e?.profitFactor ?? null)}) | avg R ${num(s.avgR)} (backtest ${num(e?.avgR ?? null)}) | fees ${s.fees.toFixed(2)}`);
    }
    console.log(`open positions: ${open.length ? open.map((p) => `${p.symbol} ${p.side} ${Number(p.quantity)} @ ${Number(p.entry_price)} stop ${Number(p.stop)}`).join(" | ") : bot === "GLS" ? "kept on the exchange only (weight engine; see the paper account)" : "none"}`);
    console.log(`kill switch: ${ks?.on ? `ON (${ks.reason})` : "off"}`);
    console.log(`events last 7 days: ${kinds.map((k) => `${k.kind} ${k.n}`).join(", ") || "none"}`);
    for (const r of errors) console.log(`  error ${new Date(Number(r.created_at)).toISOString()} ${r.kind} ${r.symbol ?? ""} ${r.message}`);
    const flags = deviations(s, e);
    console.log(flags.length ? `CHECK: ${flags.join("; ")}` : "no deviation from the backtest beyond the thresholds");
    // Decision log: distinct reasons why no order was placed (all candles in this database).
    const sig = (await pool.query("SELECT symbol, gate, detail, candle_open_time FROM signals WHERE accepted = false ORDER BY candle_open_time")).rows
      .map((r) => ({ symbol: String(r.symbol), gate: r.gate as string | null, detail: String(r.detail), candleOpenTime: Number(r.candle_open_time) }));
    const groups = distinctReasons(sig);
    const t = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
    const taken = Number((await pool.query("SELECT count(*)::int AS n FROM signals WHERE accepted = true")).rows[0]?.n ?? 0);
    const tags = Object.entries(tagCounts(sig)).map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(`decisions without an order: ${sig.length} candles, ${groups.length} distinct reasons | taken ${taken} | ${tags}`);
    for (const g of groups) console.log(`  DECISION ${g.symbol} ${g.gate} x${g.count} [${t(g.firstCandle)} .. ${t(g.lastCandle)}] | ${g.example}`);
    if (s.trades >= POST_MORTEM_EVERY) console.log(`POST-MORTEM: ${s.trades} closed trades (one every ${POST_MORTEM_EVERY}); compare with the backtest before changing anything, one versioned change at a time`);
  } catch (e) {
    // One unreachable database must not hide the other engines' reports.
    console.log(`==================== ${bot}: report failed: ${e instanceof Error ? e.message : String(e)} ====================`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
if (dbs.length > 1 && total.start > 0) {
  console.log(`==================== portfolio (sum of ${dbs.length} paper accounts) ====================`);
  console.log(`equity ${total.start.toFixed(2)} -> ${total.end.toFixed(2)} (${pct(total.end / total.start - 1, 2)})`);
}
