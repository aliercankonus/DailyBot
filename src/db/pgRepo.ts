import type pg from "pg";
import type { EventRow, PositionRow, Repo, SignalRow } from "./repo.js";

const COLS: Record<keyof PositionRow, string> = {
  id: "id", symbol: "symbol", side: "side", status: "status", quantity: "quantity",
  entryPrice: "entry_price", entryTime: "entry_time", entryCandleOpenTime: "entry_candle_open_time",
  initialStop: "initial_stop", stop: "stop", stopOrderId: "stop_order_id", leverage: "leverage",
  riskAmount: "risk_amount", exitPrice: "exit_price", exitTime: "exit_time", exitReason: "exit_reason",
  realizedPnl: "realized_pnl", fees: "fees", strategy: "strategy",
};
// BIGINT columns come back from pg as strings.
const BIGINTS = new Set(["entry_time", "entry_candle_open_time", "exit_time"]);

function fromRow(r: Record<string, unknown>): PositionRow {
  const out: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(COLS)) out[k] = BIGINTS.has(col) && r[col] !== null ? Number(r[col]) : r[col];
  return out as unknown as PositionRow;
}

export class PgRepo implements Repo {
  constructor(readonly pool: pg.Pool) {}

  async getOpenPosition(symbol: string) {
    const r = await this.pool.query("SELECT * FROM positions WHERE symbol=$1 AND status='OPEN'", [symbol]);
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }
  async listOpenPositions() {
    const r = await this.pool.query("SELECT * FROM positions WHERE status='OPEN' ORDER BY entry_time");
    return r.rows.map(fromRow);
  }
  async insertPosition(p: PositionRow) {
    const keys = Object.keys(COLS) as (keyof PositionRow)[];
    const cols = keys.map((k) => COLS[k]).join(",");
    const vals = keys.map((_, i) => `$${i + 1}`).join(",");
    await this.pool.query(`INSERT INTO positions (${cols}) VALUES (${vals})`, keys.map((k) => p[k]));
  }
  async updatePosition(id: string, patch: Partial<PositionRow>) {
    const keys = (Object.keys(patch) as (keyof PositionRow)[]).filter((k) => k in COLS);
    if (!keys.length) return;
    const set = keys.map((k, i) => `${COLS[k]}=$${i + 2}`).join(",");
    await this.pool.query(`UPDATE positions SET ${set} WHERE id=$1`, [id, ...keys.map((k) => patch[k])]);
  }
  async listClosedSince(sinceMs: number) {
    const r = await this.pool.query("SELECT * FROM positions WHERE status='CLOSED' AND exit_time >= $1 ORDER BY exit_time", [sinceMs]);
    return r.rows.map(fromRow);
  }
  async recordSignal(s: SignalRow) {
    await this.pool.query(
      "INSERT INTO signals (symbol,candle_open_time,side,accepted,gate,detail,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [s.symbol, s.candleOpenTime, s.side, s.accepted, s.gate, s.detail, s.createdAt],
    );
  }
  async recordEvent(e: EventRow) {
    await this.pool.query(
      "INSERT INTO events (level,kind,symbol,message,data,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [e.level, e.kind, e.symbol, e.message, e.data === undefined ? null : JSON.stringify(e.data), e.createdAt],
    );
  }
  async recordEquity(time: number, equity: number) {
    await this.pool.query(
      "INSERT INTO equity (time,equity) VALUES ($1,$2) ON CONFLICT (time) DO UPDATE SET equity=EXCLUDED.equity",
      [time, equity],
    );
  }
  async getState<T>(key: string) {
    const r = await this.pool.query("SELECT value FROM bot_state WHERE key=$1", [key]);
    return (r.rows[0]?.value as T) ?? null;
  }
  async setState<T>(key: string, value: T) {
    await this.pool.query(
      "INSERT INTO bot_state (key,value) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
      [key, JSON.stringify(value)],
    );
  }
}
