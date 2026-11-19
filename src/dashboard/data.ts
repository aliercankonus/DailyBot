// Read-only queries for the operations dashboard. One pool per engine database.
import type pg from "pg";
import { EXPECTATIONS } from "../report/paperStats.js";

export interface EngineSource {
  key: string;            // BOT_NAME: A, GC, TS
  label: string;          // human name
  mode: string;           // paper | testnet | live (display only)
  strategy: string;       // STRATEGY name
  exitRule: string;       // how positions are closed (there are no take-profit orders)
  pool: pg.Pool;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function position(r: Record<string, unknown>) {
  return {
    id: String(r.id), symbol: String(r.symbol), side: String(r.side) as "LONG" | "SHORT", status: String(r.status),
    quantity: num(r.quantity)!, entryPrice: num(r.entry_price)!, entryTime: num(r.entry_time)!,
    initialStop: num(r.initial_stop)!, stop: num(r.stop)!, leverage: num(r.leverage)!, riskAmount: num(r.risk_amount)!,
    exitPrice: num(r.exit_price), exitTime: num(r.exit_time), exitReason: r.exit_reason === null ? null : String(r.exit_reason),
    realizedPnl: num(r.realized_pnl), fees: num(r.fees),
  };
}
export type DashPosition = ReturnType<typeof position>;

/** Equity series thinned to at most `max` points (always keeps the last one). */
export function thin<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(rows[Math.floor(i * step)]!);
  out.push(rows.at(-1)!);
  return out;
}

async function state<T>(pool: pg.Pool, key: string): Promise<T | null> {
  const r = await pool.query("SELECT value FROM bot_state WHERE key=$1", [key]);
  return r.rows[0] ? (r.rows[0].value as T) : null;
}

export async function engineSnapshot(src: EngineSource, now: number) {
  const { pool } = src;
  const since30d = now - 30 * 86_400_000;
  const [open, closed, decisions, events, eq, first, killSwitch, peak, dayStart] = await Promise.all([
    pool.query("SELECT * FROM positions WHERE status='OPEN' ORDER BY entry_time"),
    pool.query("SELECT * FROM positions WHERE status='CLOSED' ORDER BY exit_time DESC LIMIT 100"),
    pool.query("SELECT symbol, candle_open_time, side, accepted, gate, detail, created_at FROM signals ORDER BY created_at DESC LIMIT 200"),
    pool.query("SELECT level, kind, symbol, message, created_at FROM events ORDER BY created_at DESC LIMIT 50"),
    pool.query("SELECT time, equity FROM equity WHERE time >= $1 ORDER BY time", [since30d]),
    pool.query("SELECT time, equity FROM equity ORDER BY time LIMIT 1"),
    state<{ on: boolean; reason: string; at: number }>(pool, "killSwitch"),
    state<number>(pool, "equityPeak"),
    state<{ day: string; equity: number }>(pool, "dayStart"),
  ]);
  const series = eq.rows.map((r) => ({ t: Number(r.time), v: Number(r.equity) }));
  const startEquity = first.rows[0] ? Number(first.rows[0].equity) : null;
  const lastEquity = series.at(-1)?.v ?? startEquity;
  const closedRows = closed.rows.map(position);
  const wins = closedRows.filter((p) => (p.realizedPnl ?? 0) > 0);
  const grossWin = wins.reduce((a, p) => a + (p.realizedPnl ?? 0), 0);
  const grossLoss = -closedRows.filter((p) => (p.realizedPnl ?? 0) <= 0).reduce((a, p) => a + (p.realizedPnl ?? 0), 0);
  return {
    key: src.key, label: src.label, mode: src.mode, strategy: src.strategy, exitRule: src.exitRule,
    expectation: EXPECTATIONS[src.key] ?? null,
    killSwitch, equity: {
      now: lastEquity, start: startEquity, peak, dayStart: dayStart?.equity ?? null,
      drawdownPct: peak && lastEquity !== null && peak > 0 ? Math.max(0, (peak - lastEquity) / peak) : 0,
      series: thin(series, 240),
    },
    stats: {
      closedTrades: closedRows.length, winRate: closedRows.length ? wins.length / closedRows.length : null,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      avgR: closedRows.length ? closedRows.reduce((a, p) => a + (p.realizedPnl ?? 0) / (p.riskAmount || 1), 0) / closedRows.length : null,
      netPnl: closedRows.reduce((a, p) => a + (p.realizedPnl ?? 0), 0),
    },
    open: open.rows.map(position),
    closed: closedRows,
    decisions: decisions.rows.map((r) => ({
      symbol: String(r.symbol), candleOpenTime: Number(r.candle_open_time), side: r.side === null ? null : String(r.side),
      accepted: Boolean(r.accepted), gate: r.gate === null ? null : String(r.gate), detail: String(r.detail), createdAt: Number(r.created_at),
    })),
    events: events.rows.map((r) => ({ level: String(r.level), kind: String(r.kind), symbol: r.symbol === null ? null : String(r.symbol), message: String(r.message), createdAt: Number(r.created_at) })),
  };
}
export type EngineSnapshot = Awaited<ReturnType<typeof engineSnapshot>>;

/** Public mark prices from Binance USD-M (no key). Cached; failures return the last known values. */
export function markPriceFeed(symbols: string[], fetchImpl: typeof fetch = fetch, ttlMs = 15_000, base = "https://fapi.binance.com") {
  let cache: { at: number; prices: Record<string, number> } = { at: 0, prices: {} };
  return async (now: number): Promise<Record<string, number>> => {
    if (now - cache.at < ttlMs) return cache.prices;
    try {
      const res = await fetchImpl(`${base}/fapi/v1/premiumIndex`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(String(res.status));
      const rows = (await res.json()) as { symbol: string; markPrice: string }[];
      const prices: Record<string, number> = {};
      for (const r of rows) if (symbols.includes(r.symbol)) prices[r.symbol] = Number(r.markPrice);
      cache = { at: now, prices };
    } catch {
      cache = { ...cache, at: now - ttlMs + 5_000 }; // retry in 5 s, keep the old prices
    }
    return cache.prices;
  };
}
