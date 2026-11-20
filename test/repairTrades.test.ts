import { describe, expect, it } from "vitest";
import { needsRepair, repairFromFills } from "../src/report/repairTrades.js";
import type { PositionRow } from "../src/db/repo.js";
import type { TradeFill } from "../src/exchange/types.js";

const T = 1_763_596_800_000; // 2025-11-20 00:00 UTC
const row = (o: Partial<PositionRow> = {}): PositionRow => ({
  id: "p1", symbol: "BTCUSDT", side: "SHORT", status: "CLOSED", quantity: 0.01, entryPrice: 0, entryTime: T,
  entryCandleOpenTime: T - 4 * 3600_000, initialStop: 1955, stop: 1955, stopOrderId: null, leverage: 3, riskAmount: 50,
  exitPrice: 0, exitTime: T + 5_000, exitReason: "STOP_PLACEMENT_FAILED", realizedPnl: 0, fees: null, strategy: "trendlv+timestop", ...o,
});
const fill = (o: Partial<TradeFill>): TradeFill => ({ time: T + 100, price: 90_000, qty: 0.01, side: "SELL", realizedPnl: 0, commission: 0.45, orderId: "1", ...o });

describe("repairTrades", () => {
  it("flags only closed rows with a missing price", () => {
    expect(needsRepair(row())).toBe(true);
    expect(needsRepair(row({ entryPrice: 90_000, exitPrice: null }))).toBe(true);
    expect(needsRepair(row({ entryPrice: 90_000, exitPrice: 90_100 }))).toBe(false);
    expect(needsRepair(row({ status: "OPEN" }))).toBe(false);
  });

  it("rebuilds entry, exit and net PnL from the fills", () => {
    const p = repairFromFills(row(), [
      fill({}),
      fill({ time: T + 4_000, side: "BUY", price: 90_060, realizedPnl: -0.6, commission: 0.45, orderId: "2" }),
    ]);
    expect(p).toMatchObject({ entryPrice: 90_000, exitPrice: 90_060, exitTime: T + 4_000, fees: 0.9 });
    expect(p!.realizedPnl).toBeCloseTo(-1.5, 9);
  });

  it("refuses when the fills do not add up to the position quantity (unrelated trades)", () => {
    expect(repairFromFills(row(), [fill({}), fill({ side: "BUY", qty: 0.02, orderId: "2" })])).toBeNull();
    expect(repairFromFills(row(), [fill({})])).toBeNull();
    expect(repairFromFills(row(), [fill({ time: T - 10 * 60_000 }), fill({ side: "BUY", orderId: "2" })])).toBeNull();
  });
});
