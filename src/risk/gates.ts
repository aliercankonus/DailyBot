// The complete list of entry gates. Hard limit: 8. A new gate may only be added
// if one is removed (see CLAUDE.md). Each gate returns a single reason code.
export interface GateContext {
  killSwitch: boolean;
  dataFresh: boolean;
  hasSignal: boolean;
  symbolHasPosition: boolean;
  openPositions: number;
  maxOpenPositions: number;
  /** Realized + unrealized PnL today as a fraction of start-of-day equity (negative = loss). */
  dayPnlPct: number;
  dailyLossLimit: number; // positive fraction, e.g. 0.03
  /** Current drawdown from equity peak as a positive fraction. */
  drawdownPct: number;
  maxDrawdown: number; // positive fraction, e.g. 0.15
}

export type GateResult = { ok: true } | { ok: false; gate: GateName; detail: string };

export type GateName =
  | "KILL_SWITCH"
  | "DATA_STALE"
  | "NO_SIGNAL"
  | "ALREADY_IN_POSITION"
  | "MAX_OPEN_POSITIONS"
  | "DAILY_LOSS_LIMIT"
  | "MAX_DRAWDOWN";

export function evaluateGates(c: GateContext): GateResult {
  if (c.killSwitch) return { ok: false, gate: "KILL_SWITCH", detail: "kill switch is on" };
  if (!c.dataFresh) return { ok: false, gate: "DATA_STALE", detail: "latest closed candle is missing or late" };
  if (c.drawdownPct >= c.maxDrawdown)
    return { ok: false, gate: "MAX_DRAWDOWN", detail: `drawdown ${(c.drawdownPct * 100).toFixed(2)}% >= ${(c.maxDrawdown * 100).toFixed(2)}%` };
  if (-c.dayPnlPct >= c.dailyLossLimit)
    return { ok: false, gate: "DAILY_LOSS_LIMIT", detail: `day pnl ${(c.dayPnlPct * 100).toFixed(2)}% <= -${(c.dailyLossLimit * 100).toFixed(2)}%` };
  if (!c.hasSignal) return { ok: false, gate: "NO_SIGNAL", detail: "strategy returned no signal" };
  if (c.symbolHasPosition) return { ok: false, gate: "ALREADY_IN_POSITION", detail: "symbol already has a position" };
  if (c.openPositions >= c.maxOpenPositions)
    return { ok: false, gate: "MAX_OPEN_POSITIONS", detail: `${c.openPositions} >= ${c.maxOpenPositions}` };
  return { ok: true };
}
