import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRepo } from "../src/db/repo.js";
import { clientId, Engine, type EngineConfig, type KillSwitch } from "../src/engine/engine.js";
import type { Notifier } from "../src/notify/notifier.js";
import { createTrendBreakout } from "../src/strategy/trendBreakout.js";
import { candlesFromCloses, FakeExchange, H4, uptrend } from "./helpers.js";

const cfg: EngineConfig = {
  symbols: ["BTCUSDT"], interval: "4h", intervalMs: H4, riskPerTrade: 0.01, maxLeverage: 3,
  maxOpenPositions: 3, dailyLossLimit: 0.03, maxDrawdown: 0.15, maxCandleDelayMs: 15 * 60_000,
};

const strategy = createTrendBreakout();
const allCandles = candlesFromCloses(uptrend());
/** Index of the first candle on which the strategy signals. */
const signalIdx = (() => {
  for (let i = strategy.warmup; i <= allCandles.length; i++) if (strategy.evaluate("BTCUSDT", allCandles.slice(0, i))) return i - 1;
  throw new Error("fixture never signals");
})();

let ex: FakeExchange;
let repo: MemoryRepo;
let sent: string[];
let engine: Engine;

/** Put the clock just after candle `i` closed. */
function at(i: number) {
  ex.now = allCandles[i]!.closeTime + 60_000;
  ex.mark.BTCUSDT = allCandles[i]!.close;
}

beforeEach(() => {
  ex = new FakeExchange();
  ex.candles.BTCUSDT = allCandles;
  repo = new MemoryRepo();
  sent = [];
  const notifier: Notifier = { send: async (_l, t) => void sent.push(t) };
  let n = 0;
  engine = new Engine({ exchange: ex, repo, strategy, notifier, cfg, now: () => ex.now, newId: () => `pos${++n}` });
});

describe("engine entry", () => {
  it("opens a position and places a reduce-only stop", async () => {
    at(signalIdx);
    await engine.tick();
    const pos = await repo.getOpenPosition("BTCUSDT");
    expect(pos).not.toBeNull();
    expect(pos!.side).toBe("LONG");
    expect(pos!.stopOrderId).not.toBeNull();
    expect(ex.stops).toHaveLength(1);
    expect(ex.stops[0]!.side).toBe("SELL");
    expect(ex.stops[0]!.stopPrice).toBeLessThan(pos!.entryPrice);
    expect(repo.signals[0]!.accepted).toBe(true);
  });

  it("does nothing twice for the same candle", async () => {
    at(signalIdx);
    await engine.tick();
    await engine.tick();
    expect(ex.calls.filter((c) => c.startsWith("market")).length).toBe(1);
  });

  it("closes at market when the stop cannot be placed", async () => {
    at(signalIdx);
    ex.failPlaceStop = true;
    await engine.tick();
    expect(ex.positions.BTCUSDT).toBeUndefined();
    expect(repo.positions[0]!.status).toBe("CLOSED");
    expect(repo.positions[0]!.exitReason).toBe("STOP_PLACEMENT_FAILED");
  });

  it("turns the kill switch on when neither stop nor close works", async () => {
    at(signalIdx);
    ex.failPlaceStop = true;
    const origMarket = ex.marketOrder.bind(ex);
    let n = 0;
    ex.marketOrder = async (p) => {
      if (++n > 1) throw new Error("exchange down");
      return origMarket(p);
    };
    await engine.tick();
    expect((await repo.getState<KillSwitch>("killSwitch"))?.on).toBe(true);
  });

  it("blocks entries while the kill switch is on", async () => {
    await repo.setState<KillSwitch>("killSwitch", { on: true, reason: "test", at: 0 });
    at(signalIdx);
    await engine.tick();
    expect(ex.positions.BTCUSDT).toBeUndefined();
    expect(repo.signals[0]!.gate).toBe("KILL_SWITCH");
  });

  it("rejects stale data", async () => {
    at(signalIdx);
    ex.now += 3 * 3600_000; // 3h after the close, still inside the same 4h bar
    await engine.tick();
    expect(ex.positions.BTCUSDT).toBeUndefined();
    expect(repo.signals[0]!.gate).toBe("DATA_STALE");
  });
});

describe("engine management", () => {
  it("trails the stop: places the new one, then cancels the old one", async () => {
    at(signalIdx);
    await engine.tick();
    const first = ex.stops[0]!.id;
    at(signalIdx + 10);
    await engine.tick();
    const pos = (await repo.getOpenPosition("BTCUSDT"))!;
    expect(ex.stops).toHaveLength(1);
    expect(ex.stops[0]!.id).not.toBe(first);
    expect(pos.stop).toBeGreaterThan(pos.initialStop);
    const placeIdx = ex.calls.findIndex((c) => c.startsWith("stop") && c.includes("-S") && !c.endsWith("-S0"));
    const cancelIdx = ex.calls.indexOf(`cancel ${first}`);
    expect(placeIdx).toBeGreaterThan(-1);
    expect(cancelIdx).toBeGreaterThan(placeIdx);
  });

  it("records a stop-out that happened on the exchange", async () => {
    at(signalIdx);
    await engine.tick();
    ex.now += 60_000;
    ex.triggerStop("BTCUSDT", ex.stops[0]!.stopPrice);
    await engine.tick();
    const p = repo.positions[0]!;
    expect(p.status).toBe("CLOSED");
    expect(p.exitReason).toBe("EXCHANGE_CLOSE");
    expect(p.realizedPnl!).toBeLessThan(0);
  });

  it("re-places a missing stop", async () => {
    at(signalIdx);
    await engine.tick();
    ex.stops = []; // someone cancelled it on the exchange
    ex.now += 60_000;
    await engine.tick();
    expect(ex.stops).toHaveLength(1);
    expect(repo.events.some((e) => e.kind === "STOP_MISSING")).toBe(true);
  });

  it("an unknown exchange position turns the kill switch on and is not touched", async () => {
    at(signalIdx - 5);
    ex.positions.BTCUSDT = { symbol: "BTCUSDT", side: "SHORT", quantity: 1, entryPrice: 100 };
    await engine.tick();
    expect((await repo.getState<KillSwitch>("killSwitch"))?.on).toBe(true);
    expect(ex.positions.BTCUSDT).toBeDefined();
    expect(ex.calls.some((c) => c.startsWith("market"))).toBe(false);
  });

  it("max drawdown turns the kill switch on", async () => {
    at(signalIdx - 5);
    await engine.tick();
    ex.balance = { equity: 8000, available: 8000 };
    ex.now += 60_000;
    await engine.tick();
    expect((await repo.getState<KillSwitch>("killSwitch"))?.on).toBe(true);
  });
});

describe("client ids", () => {
  it("fit Binance's 36-char limit for long symbols", () => {
    const id = clientId("1000PEPEUSDT", Date.UTC(2030, 0, 1), `S${Date.UTC(2030, 0, 1).toString(36)}`);
    expect(id.length).toBeLessThanOrEqual(36);
    expect(id).toMatch(/^[.A-Z:/a-z0-9_-]{1,36}$/);
  });
});
