import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRepo, type PositionRow } from "../src/db/repo.js";
import { STRATEGY_WINDOW } from "../src/strategy/types.js";
import { clientId, Engine, type EngineConfig, type KillSwitch } from "../src/engine/engine.js";
import type { Notifier } from "../src/notify/notifier.js";
import { createTrendBreakout } from "../src/strategy/trendBreakout.js";
import { candlesFromCloses, FakeExchange, H4, uptrend } from "./helpers.js";

const cfg: EngineConfig = {
  symbols: ["BTCUSDT"], interval: "4h", intervalMs: H4, riskPerTrade: 0.01, maxLeverage: 3,
  maxOpenPositions: 3, dailyLossLimit: 0.03, maxDrawdown: 0.15, maxCandleDelayMs: 15 * 60_000,
  roundTripCostPct: 0.002,
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

describe("decision log", () => {
  it("stores why a closed candle gave no entry (gate NO_SIGNAL), once per candle", async () => {
    at(signalIdx - 3);
    await engine.tick();
    ex.now += 60_000;
    await engine.tick(); // same candle: no second row
    const rows = repo.signals.filter((s) => s.gate === "NO_SIGNAL");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.side).toBeNull();
    expect(rows[0]!.detail).toMatch(/trend|warming/);
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

  it("closes at market when the mark price stays through the stop (stop did not fire)", async () => {
    at(signalIdx);
    await engine.tick();
    const pos = (await repo.getOpenPosition("BTCUSDT"))!;
    const through = pos.stop * 0.99;
    ex.positions.BTCUSDT = { ...ex.positions.BTCUSDT!, markPrice: through };
    ex.mark.BTCUSDT = through;
    ex.now += 60_000;
    await engine.tick();
    expect(repo.events.some((e) => e.kind === "STOP_BREACHED")).toBe(true);
    expect((await repo.getOpenPosition("BTCUSDT"))).not.toBeNull(); // first sighting: wait one tick
    ex.now += 60_000;
    await engine.tick();
    expect(await repo.getOpenPosition("BTCUSDT")).toBeNull();
    expect(repo.positions[0]!.exitReason).toBe("STOP_NOT_TRIGGERED");
    expect(ex.positions.BTCUSDT).toBeUndefined();
  });

  it("a stale first sighting (engine was down) does not close immediately", async () => {
    at(signalIdx);
    await engine.tick();
    const pos = (await repo.getOpenPosition("BTCUSDT"))!;
    ex.positions.BTCUSDT = { ...ex.positions.BTCUSDT!, markPrice: pos.stop * 0.99 };
    ex.now += 60_000;
    await engine.tick();
    ex.now += 60 * 60_000; // an hour later
    await engine.tick();
    expect(await repo.getOpenPosition("BTCUSDT")).not.toBeNull();
    expect(repo.events.filter((e) => e.kind === "STOP_BREACHED")).toHaveLength(2);
  });

  it("a rejected backstop close does not trip the kill switch when the stop filled first", async () => {
    at(signalIdx);
    await engine.tick();
    const pos = (await repo.getOpenPosition("BTCUSDT"))!;
    ex.positions.BTCUSDT = { ...ex.positions.BTCUSDT!, markPrice: pos.stop * 0.99 };
    ex.now += 60_000;
    await engine.tick();
    // Next check: getPosition still shows it, but the market order fails because the stop fills in between.
    const realMarket = ex.marketOrder.bind(ex);
    ex.marketOrder = async (p) => {
      ex.triggerStop("BTCUSDT", pos.stop);
      return realMarket({ ...p, quantity: p.quantity }).then(() => { throw new Error("-2022 ReduceOnly Order is rejected"); });
    };
    ex.now += 60_000;
    await engine.tick();
    expect((await repo.getState<KillSwitch>("killSwitch"))?.on ?? false).toBe(false);
    expect(repo.events.some((e) => e.kind === "CLOSE_RACED")).toBe(true);
  });

  it("a brief breach that recovers does not close the position", async () => {
    at(signalIdx);
    await engine.tick();
    const pos = (await repo.getOpenPosition("BTCUSDT"))!;
    ex.positions.BTCUSDT = { ...ex.positions.BTCUSDT!, markPrice: pos.stop * 0.99 };
    ex.now += 60_000;
    await engine.tick();
    ex.positions.BTCUSDT = { ...ex.positions.BTCUSDT!, markPrice: pos.stop * 1.05 };
    ex.now += 60_000;
    await engine.tick();
    ex.positions.BTCUSDT = { ...ex.positions.BTCUSDT!, markPrice: pos.stop * 0.99 };
    ex.now += 60_000;
    await engine.tick(); // a new first sighting, not a close
    expect(await repo.getOpenPosition("BTCUSDT")).not.toBeNull();
    expect(repo.events.filter((e) => e.kind === "STOP_BREACHED")).toHaveLength(2);
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

describe("engine hardening (review fixes)", () => {
  it("adopts and protects a filled entry whose database insert failed", async () => {
    at(signalIdx);
    const orig = repo.insertPosition.bind(repo);
    let fail = true;
    repo.insertPosition = async (p: PositionRow) => {
      if (fail) { fail = false; throw new Error("db down"); }
      return orig(p);
    };
    await engine.tick();
    expect(ex.positions.BTCUSDT).toBeDefined(); // filled on the exchange
    expect(ex.stops).toHaveLength(0);           // not yet protected
    ex.now += 60_000;
    await engine.tick();
    const pos = await repo.getOpenPosition("BTCUSDT");
    expect(pos).not.toBeNull();
    expect(ex.stops).toHaveLength(1);
    expect((await repo.getState<KillSwitch>("killSwitch"))?.on ?? false).toBe(false);
    expect(repo.events.some((e) => e.kind === "ENTRY_ADOPTED")).toBe(true);
    expect(ex.calls.filter((c) => c.startsWith("market")).length).toBe(1); // no second entry
  });

  it("places the stop even when notifications fail", async () => {
    engine = new Engine({
      exchange: ex, repo, strategy, cfg, now: () => ex.now,
      notifier: { send: async () => { throw new Error("telegram down"); } },
    });
    at(signalIdx);
    await engine.tick();
    expect(ex.stops).toHaveLength(1);
  });

  it("keeps the old stop when a trailing update fails for a transient reason", async () => {
    at(signalIdx);
    await engine.tick();
    const first = ex.stops[0]!;
    ex.placeStopError = new Error("HTTP 503");
    at(signalIdx + 10);
    await engine.tick();
    expect(ex.positions.BTCUSDT).toBeDefined();
    expect(ex.stops.map((s) => s.id)).toEqual([first.id]);
    expect(repo.events.some((e) => e.kind === "TRAIL_FAILED")).toBe(true);
  });

  it("closes at market when the new trailing stop is already crossed (-2021)", async () => {
    at(signalIdx);
    await engine.tick();
    ex.placeStopError = new Error("Binance /fapi/v1/order 400 code=-2021: Order would immediately trigger.");
    at(signalIdx + 10);
    await engine.tick();
    expect(ex.positions.BTCUSDT).toBeUndefined();
    expect(repo.positions[0]!.exitReason).toBe("TRAIL_STOP_CROSSED");
  });

  it("does not invent an exit price when exit fills are not visible yet", async () => {
    at(signalIdx);
    await engine.tick();
    delete ex.positions.BTCUSDT; // gone on the exchange, but no fills reported
    ex.stops = [];
    ex.now += 60_000;
    await engine.tick();
    expect(repo.positions[0]!.status).toBe("OPEN");
    ex.now += 11 * 60_000;
    await engine.tick();
    expect(repo.positions[0]!.status).toBe("CLOSED");
    expect(repo.positions[0]!.exitReason).toBe("EXCHANGE_CLOSE_NO_FILLS");
    expect(repo.positions[0]!.realizedPnl).toBeNull();
  });

  it("includes the entry commission in exchange-close bookkeeping", async () => {
    at(signalIdx);
    await engine.tick();
    const entryTime = repo.positions[0]!.entryTime;
    (ex.fills.BTCUSDT ??= []).push({ time: entryTime + 1000, price: 1, qty: 0, side: "BUY", realizedPnl: 0, commission: 2 });
    ex.now += 60_000;
    ex.triggerStop("BTCUSDT", ex.stops[0]!.stopPrice);
    await engine.tick();
    expect(repo.positions[0]!.fees).toBeCloseTo(2.5);
  });

  it("opens shorts with the stop above entry", async () => {
    const down = candlesFromCloses(uptrend().map((x) => 200 - x));
    let idx = -1;
    for (let i = strategy.warmup; i <= down.length && idx < 0; i++) if (strategy.evaluate("BTCUSDT", down.slice(0, i))) idx = i - 1;
    ex.candles.BTCUSDT = down;
    ex.now = down[idx]!.closeTime + 60_000;
    ex.mark.BTCUSDT = down[idx]!.close;
    await engine.tick();
    const pos = (await repo.getOpenPosition("BTCUSDT"))!;
    expect(pos.side).toBe("SHORT");
    expect(ex.stops[0]!.side).toBe("BUY");
    expect(ex.stops[0]!.stopPrice).toBeGreaterThan(pos.entryPrice);
  });

  it("blocks entries after the daily loss limit", async () => {
    at(signalIdx - 5);
    await engine.tick(); // seeds dayStart at 10000
    ex.balance = { equity: 9600, available: 9600 }; // -4% today, below the 15% drawdown switch
    at(signalIdx);
    await engine.tick();
    expect(ex.positions.BTCUSDT).toBeUndefined();
    expect(repo.signals.at(-1)!.gate).toBe("DAILY_LOSS_LIMIT");
  });

  it("alerts once for an unknown position, not every minute", async () => {
    at(signalIdx - 5);
    ex.positions.BTCUSDT = { symbol: "BTCUSDT", side: "SHORT", quantity: 1, entryPrice: 100 };
    await engine.tick();
    ex.now += 60_000;
    await engine.tick();
    ex.now += 60_000;
    await engine.tick();
    expect(sent.filter((t) => t.startsWith("Kill switch ON")).length).toBe(1);
  });

  it("does not re-arm the drawdown switch after the peak is reset", async () => {
    at(signalIdx - 5);
    await engine.tick();
    ex.balance = { equity: 8000, available: 8000 };
    ex.now += 60_000;
    await engine.tick();
    expect((await repo.getState<KillSwitch>("killSwitch"))?.on).toBe(true);
    // What the API does on a manual OFF:
    await repo.setState<KillSwitch>("killSwitch", { on: false, reason: "reviewed", at: ex.now, source: "manual" });
    await repo.setState("equityPeak", null);
    ex.now += 60_000;
    await engine.tick();
    expect((await repo.getState<KillSwitch>("killSwitch"))?.on).toBe(false);
  });

  it("gives the strategy the same fixed window the backtest uses", async () => {
    at(signalIdx);
    await engine.tick();
    expect(ex.lastCandleLimit).toBe(STRATEGY_WINDOW);
  });

  it("still repairs stops when the balance call fails", async () => {
    at(signalIdx);
    await engine.tick();
    ex.stops = [];
    ex.failBalance = true;
    ex.now += 60_000;
    await engine.tick();
    expect(ex.stops).toHaveLength(1);
  });

  it("skips the candle when its entry client id is spent", async () => {
    at(signalIdx);
    ex.marketOrder = async () => { throw new Error("CLIENT_ID_SPENT: previous order EXPIRED"); };
    await engine.tick();
    expect(await repo.getState(`lastProcessed:BTCUSDT`)).toBe(allCandles[signalIdx]!.openTime);
    expect(await repo.getState("pendingEntry:BTCUSDT")).toBeNull();
  });

  it("sizes with round-trip costs counted as risk", async () => {
    at(signalIdx);
    await engine.tick();
    const pos = (await repo.getOpenPosition("BTCUSDT"))!;
    // risk = qty * (stop distance + price * cost) must not exceed 1% of 10000
    const lossAtStop = pos.quantity * (Math.abs(pos.entryPrice - pos.initialStop) + pos.entryPrice * cfg.roundTripCostPct);
    expect(lossAtStop).toBeLessThanOrEqual(100 + 1e-6);
  });
});

describe("engine strategy exits", () => {
  it("closes at market on shouldExit and records the fill candle as entry candle", async () => {
    const base = createTrendBreakout();
    let exitNow = false;
    const strat = { ...base, shouldExit: () => exitNow };
    engine = new Engine({ exchange: ex, repo, strategy: strat, notifier: { send: async () => {} }, cfg, now: () => ex.now });
    at(signalIdx);
    await engine.tick();
    const pos = (await repo.getOpenPosition("BTCUSDT"))!;
    expect(pos.entryCandleOpenTime).toBe(allCandles[signalIdx]!.openTime + H4);
    exitNow = true;
    at(signalIdx + 1);
    await engine.tick();
    expect(ex.positions.BTCUSDT).toBeUndefined();
    expect(repo.positions[0]!.exitReason).toBe("STRATEGY_EXIT");
    expect(ex.stops).toHaveLength(0);
  });
});
