import { afterEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "../src/core/types.js";
import { MemoryRepo } from "../src/db/repo.js";
import { DEFAULT_WEIGHTS_ENGINE, WeightsEngine } from "../src/engine/weightsEngine.js";
import { newPaperState, PaperExchange, type MarketData } from "../src/exchange/paper.js";
import type { WeightStrategy } from "../src/strategy/weights.js";
import { FILTERS } from "./helpers.js";

const D = 86_400_000;
const T0 = Date.UTC(2025, 0, 1);
const N = 40; // daily candles of history

function daily(base: number, days: number): Candle[] {
  return Array.from({ length: days }, (_, i) => {
    const c = base * (1 + 0.01 * Math.sin(i));
    return { openTime: T0 + i * D, closeTime: T0 + (i + 1) * D - 1, open: c, high: c * 1.02, low: c * 0.98, close: c, volume: 1 };
  });
}

function setup(weightsByDay: Record<number, Record<string, number>>) {
  const data: Record<string, Candle[]> = { BTCUSDT: daily(100, N + 5), ETHUSDT: daily(50, N + 5) };
  const day = { n: N }; // candles 0..n-1 are closed
  const mark: Record<string, number> = {};
  const md: MarketData = {
    getServerTime: async () => Date.now(),
    getClosedCandles: async (s, _i, limit) => data[s]!.slice(0, day.n).slice(-limit),
    getFilters: async (s) => ({ ...FILTERS, symbol: s }),
    getMarkPrice: async (s) => mark[s] ?? data[s]![day.n - 1]!.close,
    getKlinesSince: async () => [],
    getFundingHistory: async () => [],
  };
  const ex = new PaperExchange(md, newPaperState(10_000), { takerFee: 0, slippage: 0 });
  const repo = new MemoryRepo();
  const strategy: WeightStrategy = {
    name: "fixed", interval: "1d", rebalanceEvery: 1,
    weightSeries: ({ candles }) => {
      const out = new Map<number, Record<string, number>>();
      for (const c of candles.BTCUSDT ?? []) {
        const w = weightsByDay[Math.round((c.openTime - T0) / D)];
        if (w) out.set(c.openTime, w);
      }
      return out;
    },
  };
  const clock = { t: T0 + N * D + 60_000 }; // one minute after the latest close
  const engine = new WeightsEngine({
    exchange: ex, repo, notifier: { send: async () => {} }, strategy, now: () => clock.t,
    cfg: { ...DEFAULT_WEIGHTS_ENGINE, symbols: ["BTCUSDT", "ETHUSDT"], maxLeverage: 3, maxDrawdown: 0.5 },
  });
  const at = (t: number) => { clock.t = t; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t); };
  at(clock.t);
  return { ex, repo, engine, day, clock, mark, data, at };
}

const pos = async (ex: PaperExchange, s: string) => ex.getPosition(s);

describe("weights engine", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("trades to target weights after the daily close, with one catastrophic stop per position", async () => {
    const { ex, repo, engine, data } = setup({ [N - 1]: { BTCUSDT: 0.5, ETHUSDT: -0.3 } });
    await engine.tick();
    const btc = (await pos(ex, "BTCUSDT"))!, eth = (await pos(ex, "ETHUSDT"))!;
    const pb = data.BTCUSDT![N - 1]!.close, pe = data.ETHUSDT![N - 1]!.close;
    expect(btc.side).toBe("LONG");
    expect(btc.quantity * pb).toBeCloseTo(5000, -1);
    expect(eth.side).toBe("SHORT");
    expect(eth.quantity * pe).toBeCloseTo(3000, -1);
    const sb = await ex.getOpenStops("BTCUSDT"), se = await ex.getOpenStops("ETHUSDT");
    expect(sb).toHaveLength(1);
    expect(sb[0]!.side).toBe("SELL");
    expect(sb[0]!.stopPrice).toBeLessThan(pb);
    expect(sb[0]!.quantity).toBe(btc.quantity);
    expect(se[0]!.side).toBe("BUY");
    expect(se[0]!.stopPrice).toBeGreaterThan(pe);
    expect(await repo.getState("lastRebalance")).toBe(T0 + (N - 1) * D);
  });

  it("a second tick on the same day trades nothing", async () => {
    const { ex, engine } = setup({ [N - 1]: { BTCUSDT: 0.5, ETHUSDT: -0.3 } });
    await engine.tick();
    const fills = Object.values(ex.state.fills).flat().length;
    const stops = ex.state.stops.map((s) => s.id);
    await engine.tick();
    expect(Object.values(ex.state.fills).flat().length).toBe(fills);
    expect(ex.state.stops.map((s) => s.id)).toEqual(stops);
  });

  it("next day: closes a zero weight, flips a side, and re-protects", async () => {
    const { ex, engine, day, at } = setup({ [N - 1]: { BTCUSDT: 0.5, ETHUSDT: -0.3 }, [N]: { ETHUSDT: 0.2 } });
    await engine.tick();
    day.n = N + 1;
    at(T0 + (N + 1) * D + 60_000);
    await engine.tick();
    expect(await pos(ex, "BTCUSDT")).toBeNull();
    expect(await ex.getOpenStops("BTCUSDT")).toHaveLength(0);
    const eth = (await pos(ex, "ETHUSDT"))!;
    expect(eth.side).toBe("LONG");
    const se = await ex.getOpenStops("ETHUSDT");
    expect(se).toHaveLength(1);
    expect(se[0]!.side).toBe("SELL");
    expect(se[0]!.quantity).toBe(eth.quantity);
  });

  it("skips a close it sees too late instead of trading at a stale price", async () => {
    const { ex, repo, engine, at } = setup({ [N - 1]: { BTCUSDT: 0.5 } });
    at(T0 + N * D + 4 * 3_600_000);
    await engine.tick();
    expect(await pos(ex, "BTCUSDT")).toBeNull();
    expect(await repo.getState("lastRebalance")).toBe(T0 + (N - 1) * D);
    expect(repo.events.some((e) => e.kind === "REBALANCE_SKIPPED")).toBe(true);
  });

  it("kill switch flattens every position", async () => {
    const { ex, repo, engine } = setup({ [N - 1]: { BTCUSDT: 0.5, ETHUSDT: -0.3 } });
    await engine.tick();
    await repo.setState("killSwitch", { on: true, reason: "test", at: 0, source: "api" });
    await engine.tick();
    expect(await pos(ex, "BTCUSDT")).toBeNull();
    expect(await pos(ex, "ETHUSDT")).toBeNull();
  });

  it("a throw during rebalance still protects open positions, and the day is retried", async () => {
    const { ex, repo, engine } = setup({ [N - 1]: { BTCUSDT: 0.5, ETHUSDT: -0.3 } });
    await engine.tick();
    for (const s of ["BTCUSDT", "ETHUSDT"]) for (const st of await ex.getOpenStops(s)) await ex.cancelStop(s, st.id);
    await repo.setState("lastRebalance", null);
    const orig = ex.getBalance.bind(ex);
    let calls = 0;
    ex.getBalance = async () => { if (++calls === 2) throw new Error("boom"); return orig(); }; // inside rebalance
    await engine.tick();
    expect(repo.events.some((e) => e.kind === "REBALANCE_FAILED")).toBe(true);
    expect(await ex.getOpenStops("BTCUSDT")).toHaveLength(1);
    expect(await ex.getOpenStops("ETHUSDT")).toHaveLength(1);
    expect(await repo.getState("lastRebalance")).toBeNull();
  });

  it("one symbol failing its stop check does not leave the others unprotected", async () => {
    const { ex, repo, engine } = setup({ [N - 1]: { BTCUSDT: 0.5, ETHUSDT: -0.3 } });
    await engine.tick();
    for (const s of ["BTCUSDT", "ETHUSDT"]) for (const st of await ex.getOpenStops(s)) await ex.cancelStop(s, st.id);
    const orig = ex.getOpenStops.bind(ex);
    ex.getOpenStops = async (s) => { if (s === "BTCUSDT") throw new Error("down"); return orig(s); };
    await engine.ensureStops();
    expect(repo.events.some((e) => e.kind === "STOP_CHECK_FAILED" && e.symbol === "BTCUSDT")).toBe(true);
    expect(await orig("ETHUSDT")).toHaveLength(1);
  });

  it("a failed leg keeps the day open and is retried on the next tick", async () => {
    const { ex, repo, engine } = setup({ [N - 1]: { BTCUSDT: 0.5 } });
    const orig = ex.marketOrder.bind(ex);
    let fail = true;
    ex.marketOrder = async (p) => (fail ? { orderId: "r", clientOrderId: p.clientOrderId, status: "REJECTED", executedQty: 0, avgPrice: 0 } : orig(p));
    await engine.tick();
    expect(await pos(ex, "BTCUSDT")).toBeNull();
    expect(await repo.getState("lastRebalance")).toBeNull();
    fail = false;
    await engine.tick();
    expect((await pos(ex, "BTCUSDT"))?.side).toBe("LONG");
    expect(await repo.getState("lastRebalance")).toBe(T0 + (N - 1) * D);
  });

  it("waits for every symbol's candle, then trades without a missing one after the wait", async () => {
    const { ex, repo, engine, data, at } = setup({ [N - 1]: { BTCUSDT: 0.5, ETHUSDT: -0.3 } });
    const eth = data.ETHUSDT!;
    data.ETHUSDT = eth.slice(0, N - 1); // ETH's last candle is not in yet
    await engine.tick();
    expect(await pos(ex, "BTCUSDT")).toBeNull();
    at(T0 + N * D + 31 * 60_000);
    await engine.tick();
    expect((await pos(ex, "BTCUSDT"))?.side).toBe("LONG");
    expect(repo.events.some((e) => e.kind === "DATA_MISSING")).toBe(true);
  });

  it("keeps a long stop positive for a very volatile symbol and re-bases a stale stop", async () => {
    const { ex, repo, engine, mark, data } = setup({ [N - 1]: { BTCUSDT: 0.5 } });
    await engine.tick();
    // Huge ATR: 4 x ATR is above the price; the stop is capped at half the price.
    await repo.setState("stopRefs", { BTCUSDT: { price: 100, atr: 40 } });
    for (const st of await ex.getOpenStops("BTCUSDT")) await ex.cancelStop("BTCUSDT", st.id);
    await engine.ensureStops();
    const [st] = await ex.getOpenStops("BTCUSDT");
    expect(st!.stopPrice).toBeGreaterThan(0);
    expect(st!.stopPrice).toBeCloseTo(50, 0);
    // Stale reference far above the market: the stop would trigger, so it is re-based on the latest price.
    await repo.setState("stopRefs", { BTCUSDT: { price: 1000, atr: 1 } });
    for (const s2 of await ex.getOpenStops("BTCUSDT")) await ex.cancelStop("BTCUSDT", s2.id);
    mark.BTCUSDT = data.BTCUSDT![N - 1]!.close;
    await engine.ensureStops();
    expect(await pos(ex, "BTCUSDT")).not.toBeNull();
    expect(repo.events.some((e) => e.kind === "STOP_REBASED")).toBe(true);
  });

  it("skips an open below the exchange minimum notional without failing the day", async () => {
    const { ex, repo, engine } = setup({ [N - 1]: { BTCUSDT: 0.5, ETHUSDT: 0.0004 } });
    // 0.04% of 10k = 4 USDT < min notional 5; band 0 so only the minimum stops it.
    (engine as unknown as { d: { cfg: { band: number } } }).d.cfg.band = 0;
    await engine.tick();
    expect(await pos(ex, "ETHUSDT")).toBeNull();
    expect(repo.events.some((e) => e.kind === "ORDER_TOO_SMALL")).toBe(true);
    expect(await repo.getState("lastRebalance")).toBe(T0 + (N - 1) * D);
  });

  it("a partial fill keeps the day open and the remainder is bought on the next tick", async () => {
    const { ex, repo, engine } = setup({ [N - 1]: { BTCUSDT: 0.5 } });
    const orig = ex.marketOrder.bind(ex);
    let partial = true;
    ex.marketOrder = async (p) => {
      if (!partial) return orig(p);
      partial = false;
      const f = await orig({ ...p, quantity: Math.floor(p.quantity / 2 * 1000) / 1000 });
      return { ...f, clientOrderId: p.clientOrderId };
    };
    await engine.tick();
    expect(repo.events.some((e) => e.kind === "PARTIAL_FILL")).toBe(true);
    expect(await repo.getState("lastRebalance")).toBeNull();
    const half = (await pos(ex, "BTCUSDT"))!.quantity;
    await engine.tick();
    expect((await pos(ex, "BTCUSDT"))!.quantity).toBeGreaterThan(half * 1.9);
    expect(await repo.getState("lastRebalance")).toBe(T0 + (N - 1) * D);
  });

  it("max drawdown turns the kill switch on and flattens", async () => {
    const { ex, repo, engine } = setup({ [N - 1]: { BTCUSDT: 0.5, ETHUSDT: -0.3 } });
    await engine.tick();
    await repo.setState("equityPeak", 100_000); // equity ~10k is a 90% drawdown from this peak
    await engine.tick(); // trips the kill switch
    await engine.tick(); // kill switch on: flatten
    expect((await repo.getState<{ on: boolean }>("killSwitch"))?.on).toBe(true);
    expect(await pos(ex, "BTCUSDT")).toBeNull();
    expect(await pos(ex, "ETHUSDT")).toBeNull();
  });

  it("a market close that fails turns the kill switch on", async () => {
    const { ex, repo, engine, mark, data } = setup({ [N - 1]: { BTCUSDT: 0.5 } });
    await engine.tick();
    for (const s of await ex.getOpenStops("BTCUSDT")) await ex.cancelStop("BTCUSDT", s.id);
    mark.BTCUSDT = data.BTCUSDT![N - 1]!.close * 0.5; // stop cannot be placed (even re-based on the 1d close used as "latest")
    ex.marketOrder = async (p) => ({ orderId: "r", clientOrderId: p.clientOrderId, status: "REJECTED", executedQty: 0, avgPrice: 0 });
    await engine.ensureStops();
    expect((await repo.getState<{ on: boolean; reason: string }>("killSwitch"))?.reason).toMatch(/market close failed/);
  });

  it("closes at market when the stop cannot be placed", async () => {
    const { ex, repo, engine, mark, data } = setup({ [N - 1]: { BTCUSDT: 0.5 } });
    await engine.tick();
    // Remove the stop and move the price far below where the stop would go: placement fails.
    for (const s of await ex.getOpenStops("BTCUSDT")) await ex.cancelStop("BTCUSDT", s.id);
    mark.BTCUSDT = data.BTCUSDT![N - 1]!.close * 0.5;
    await engine.ensureStops();
    expect(await pos(ex, "BTCUSDT")).toBeNull();
    expect(repo.events.some((e) => e.kind === "STOP_FAILED")).toBe(true);
  });
});
