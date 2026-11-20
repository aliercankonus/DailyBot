// Rebuilds the prices and PnL of closed positions recorded without a fill price (e.g. the
// 2026-11-20 demo incident: avgPrice "0" -> entry 0, exit 0) from the exchange's own trade history.
import type { TradeFill } from "../exchange/types.js";
import type { PositionRow } from "../db/repo.js";

/** A closed row needs repair when its entry or exit price is missing or not positive. */
export const needsRepair = (p: PositionRow) =>
  p.status === "CLOSED" && (!(p.entryPrice > 0) || !(p.exitPrice !== null && p.exitPrice > 0));

const SLACK_MS = 2 * 60_000;
const vwap = (fs: TradeFill[]) => fs.reduce((a, f) => a + f.price * f.qty, 0) / fs.reduce((a, f) => a + f.qty, 0);
const sumQty = (fs: TradeFill[]) => fs.reduce((a, f) => a + f.qty, 0);
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, b * 1e-6);

/**
 * Patch from the exchange fills between entry and exit (2 min slack each side). Returns null unless the
 * entry fills and the exit fills each add up to exactly the position quantity, so an unrelated trade can
 * never be merged in. PnL is net of all commissions, as the EXCHANGE_CLOSE path records it.
 */
export function repairFromFills(p: PositionRow, fills: TradeFill[]): Partial<PositionRow> | null {
  const end = (p.exitTime ?? p.entryTime) + SLACK_MS;
  const window = fills.filter((f) => f.time >= p.entryTime - SLACK_MS && f.time <= end);
  const entrySide = p.side === "LONG" ? "BUY" : "SELL";
  const entries = window.filter((f) => f.side === entrySide);
  const exits = window.filter((f) => f.side !== entrySide);
  if (!entries.length || !exits.length) return null;
  if (!close(sumQty(entries), p.quantity) || !close(sumQty(exits), p.quantity)) return null;
  const fees = window.reduce((a, f) => a + f.commission, 0);
  const realized = exits.reduce((a, f) => a + f.realizedPnl, 0);
  return { entryPrice: vwap(entries), exitPrice: vwap(exits), exitTime: exits.at(-1)!.time, realizedPnl: realized - fees, fees };
}
