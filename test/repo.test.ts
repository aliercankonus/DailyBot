import { describe, expect, it } from "vitest";
import { MemoryRepo, type PositionRow } from "../src/db/repo.js";

const row = (id: string, symbol: string, entryTime: number, extra: Partial<PositionRow> = {}): PositionRow => ({
  id, symbol, side: "LONG", status: "OPEN", quantity: 1, entryPrice: 100, entryTime, entryCandleOpenTime: entryTime - 1,
  initialStop: 90, stop: 90, stopOrderId: null, leverage: 2, riskAmount: 10, exitPrice: null, exitTime: null,
  exitReason: null, realizedPnl: null, fees: null, strategy: "t", ...extra,
});

describe("MemoryRepo parity with PgRepo", () => {
  it("recordEquity upserts by time", async () => {
    const r = new MemoryRepo();
    await r.recordEquity(1, 100);
    await r.recordEquity(1, 101);
    await r.recordEquity(2, 102);
    expect(r.equity).toEqual([{ time: 1, equity: 101 }, { time: 2, equity: 102 }]);
  });

  it("getters return copies", async () => {
    const r = new MemoryRepo();
    await r.insertPosition(row("a", "BTCUSDT", 10));
    const p = (await r.getOpenPosition("BTCUSDT"))!;
    p.stop = 1;
    (await r.listOpenPositions())[0]!.stop = 2;
    expect((await r.getOpenPosition("BTCUSDT"))!.stop).toBe(90);
    await r.setState("k", { n: 1 });
    (await r.getState<{ n: number }>("k"))!.n = 5;
    expect(await r.getState("k")).toEqual({ n: 1 });
    expect(await r.getState("missing")).toBeNull();
  });

  it("lists open positions by entryTime and closed positions newest first", async () => {
    const r = new MemoryRepo();
    await r.insertPosition(row("b", "ETHUSDT", 30));
    await r.insertPosition(row("a", "BTCUSDT", 10));
    await r.insertPosition(row("c", "SOLUSDT", 20));
    expect((await r.listOpenPositions()).map((p) => p.id)).toEqual(["a", "c", "b"]);
    await r.updatePosition("a", { status: "CLOSED", exitTime: 100 });
    await r.updatePosition("b", { status: "CLOSED", exitTime: 300 });
    await r.updatePosition("c", { status: "CLOSED", exitTime: 200 });
    expect((await r.listClosed(2)).map((p) => p.id)).toEqual(["b", "c"]);
    expect((await r.listClosedSince(150)).map((p) => p.id)).toEqual(["c", "b"]);
  });
});
