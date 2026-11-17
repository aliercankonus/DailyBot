// Position sizing for USDⓈ-M futures with isolated margin.
// Size comes from the stop distance: a stop-out loses ~riskPerTrade of equity.
// Leverage is chosen so the liquidation price stays well beyond the stop.
import type { SymbolFilters } from "../exchange/types.js";
import { floorToStep } from "./precision.js";

export interface SizingInput {
  equity: number;           // account equity in USDT
  availableBalance: number; // free margin in USDT
  entryPrice: number;
  stopPrice: number;
  riskPerTrade: number;     // e.g. 0.01 = 1% of equity
  maxLeverage: number;      // hard cap from config
  filters: SymbolFilters;
  /** Fraction of the liquidation distance the stop may use. 0.5 = stop sits halfway to liquidation. */
  liquidationBuffer?: number;
}

export type SizingResult =
  | { ok: true; quantity: number; leverage: number; notional: number; riskAmount: number }
  | { ok: false; reason: string };

export function sizePosition(inp: SizingInput): SizingResult {
  const { equity, availableBalance, entryPrice, stopPrice, riskPerTrade, maxLeverage, filters } = inp;
  const buffer = inp.liquidationBuffer ?? 0.5;
  if (!(equity > 0) || !(entryPrice > 0) || !(stopPrice > 0)) return { ok: false, reason: "INVALID_INPUT" };

  const stopDist = Math.abs(entryPrice - stopPrice);
  const stopPct = stopDist / entryPrice;
  if (stopPct <= 0) return { ok: false, reason: "ZERO_STOP_DISTANCE" };

  // Isolated liquidation is roughly at 1/leverage adverse move (minus maintenance margin).
  // Require stopPct <= buffer / leverage  ->  leverage <= buffer / stopPct.
  const liqSafeLeverage = Math.floor(buffer / stopPct);
  if (liqSafeLeverage < 1) return { ok: false, reason: "STOP_TOO_WIDE_FOR_1X" };

  const riskAmount = equity * riskPerTrade;
  let qty = riskAmount / stopDist;
  let notional = qty * entryPrice;

  // Leverage needed to post this notional from free margin (keep 5% headroom for fees).
  const usable = availableBalance * 0.95;
  const leverageCap = Math.min(maxLeverage, liqSafeLeverage);
  if (notional / leverageCap > usable) {
    notional = usable * leverageCap;
    qty = notional / entryPrice;
  }
  const leverage = Math.max(1, Math.min(leverageCap, Math.ceil(notional / usable)));

  qty = floorToStep(qty, filters.stepSize);
  if (qty < filters.minQty) return { ok: false, reason: `BELOW_MIN_QTY (${qty} < ${filters.minQty})` };
  if (qty > filters.maxQty) qty = floorToStep(filters.maxQty, filters.stepSize);
  notional = qty * entryPrice;
  if (notional < filters.minNotional) return { ok: false, reason: `BELOW_MIN_NOTIONAL (${notional.toFixed(2)} < ${filters.minNotional})` };

  return { ok: true, quantity: qty, leverage, notional, riskAmount: qty * stopDist };
}
