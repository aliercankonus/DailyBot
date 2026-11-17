import type { Side } from "../core/types.js";

export interface PositionRow {
  id: string;
  symbol: string;
  side: Side;
  status: "OPEN" | "CLOSED";
  quantity: number;
  entryPrice: number;
  entryTime: number;
  entryCandleOpenTime: number;
  initialStop: number;
  stop: number;
  stopOrderId: string | null;
  leverage: number;
  riskAmount: number;
  exitPrice: number | null;
  exitTime: number | null;
  exitReason: string | null;
  realizedPnl: number | null;
  fees: number | null;
  strategy: string;
}

export interface SignalRow {
  symbol: string;
  candleOpenTime: number;
  side: Side | null;
  accepted: boolean;
  gate: string | null;
  detail: string;
  createdAt: number;
}

export interface EventRow {
  level: "info" | "warn" | "error";
  kind: string;
  symbol: string | null;
  message: string;
  data?: unknown;
  createdAt: number;
}

/** Storage used by the engine. Postgres in production, in-memory in tests. */
export interface Repo {
  getOpenPosition(symbol: string): Promise<PositionRow | null>;
  listOpenPositions(): Promise<PositionRow[]>;
  insertPosition(p: PositionRow): Promise<void>;
  updatePosition(id: string, patch: Partial<PositionRow>): Promise<void>;
  listClosedSince(sinceMs: number): Promise<PositionRow[]>;
  /** Most recently closed positions first. */
  listClosed(limit: number): Promise<PositionRow[]>;
  recordSignal(s: SignalRow): Promise<void>;
  recordEvent(e: EventRow): Promise<void>;
  recordEquity(time: number, equity: number): Promise<void>;
  getState<T>(key: string): Promise<T | null>;
  setState<T>(key: string, value: T): Promise<void>;
}

/** In-memory Repo with the same observable behaviour as PgRepo: getters return copies, ordering matches the SQL. */
export class MemoryRepo implements Repo {
  positions: PositionRow[] = [];
  signals: SignalRow[] = [];
  events: EventRow[] = [];
  equity: { time: number; equity: number }[] = [];
  state = new Map<string, unknown>();

  async getOpenPosition(symbol: string) {
    const p = this.positions.find((x) => x.symbol === symbol && x.status === "OPEN");
    return p ? { ...p } : null;
  }
  async listOpenPositions() {
    return this.positions.filter((p) => p.status === "OPEN").sort((a, b) => a.entryTime - b.entryTime).map((p) => ({ ...p }));
  }
  async insertPosition(p: PositionRow) {
    if (this.positions.some((x) => x.id === p.id)) throw new Error(`duplicate position id ${p.id}`);
    if (p.status === "OPEN" && (await this.getOpenPosition(p.symbol))) throw new Error(`open position already exists for ${p.symbol}`);
    this.positions.push({ ...p });
  }
  async updatePosition(id: string, patch: Partial<PositionRow>) {
    const p = this.positions.find((x) => x.id === id);
    if (p) Object.assign(p, patch);
  }
  async listClosedSince(sinceMs: number) {
    return this.positions
      .filter((p) => p.status === "CLOSED" && p.exitTime !== null && p.exitTime >= sinceMs)
      .sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0))
      .map((p) => ({ ...p }));
  }
  async listClosed(limit: number) {
    return this.positions
      .filter((p) => p.status === "CLOSED")
      .sort((a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0))
      .slice(0, limit)
      .map((p) => ({ ...p }));
  }
  async recordSignal(s: SignalRow) {
    this.signals.push({ ...s });
  }
  async recordEvent(e: EventRow) {
    this.events.push(structuredClone(e));
  }
  async recordEquity(time: number, equity: number) {
    const existing = this.equity.find((x) => x.time === time);
    if (existing) existing.equity = equity;
    else this.equity.push({ time, equity });
  }
  async getState<T>(key: string) {
    return this.state.has(key) ? (structuredClone(this.state.get(key)) as T) ?? null : null;
  }
  async setState<T>(key: string, value: T) {
    this.state.set(key, structuredClone(value));
  }
}
