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
  recordSignal(s: SignalRow): Promise<void>;
  recordEvent(e: EventRow): Promise<void>;
  recordEquity(time: number, equity: number): Promise<void>;
  getState<T>(key: string): Promise<T | null>;
  setState<T>(key: string, value: T): Promise<void>;
}

export class MemoryRepo implements Repo {
  positions: PositionRow[] = [];
  signals: SignalRow[] = [];
  events: EventRow[] = [];
  equity: { time: number; equity: number }[] = [];
  state = new Map<string, unknown>();

  async getOpenPosition(symbol: string) {
    return this.positions.find((p) => p.symbol === symbol && p.status === "OPEN") ?? null;
  }
  async listOpenPositions() {
    return this.positions.filter((p) => p.status === "OPEN");
  }
  async insertPosition(p: PositionRow) {
    if (p.status === "OPEN" && (await this.getOpenPosition(p.symbol))) throw new Error(`open position already exists for ${p.symbol}`);
    this.positions.push({ ...p });
  }
  async updatePosition(id: string, patch: Partial<PositionRow>) {
    const p = this.positions.find((x) => x.id === id);
    if (p) Object.assign(p, patch);
  }
  async listClosedSince(sinceMs: number) {
    return this.positions.filter((p) => p.status === "CLOSED" && (p.exitTime ?? 0) >= sinceMs);
  }
  async recordSignal(s: SignalRow) {
    this.signals.push(s);
  }
  async recordEvent(e: EventRow) {
    this.events.push(e);
  }
  async recordEquity(time: number, equity: number) {
    this.equity.push({ time, equity });
  }
  async getState<T>(key: string) {
    return (this.state.get(key) as T) ?? null;
  }
  async setState<T>(key: string, value: T) {
    this.state.set(key, structuredClone(value));
  }
}
