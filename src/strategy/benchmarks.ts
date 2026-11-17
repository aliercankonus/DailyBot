// Benchmarks: what a strategy has to beat to be worth the effort.
import type { WeightInputs, WeightStrategy } from "./weights.js";

/** 100% long BTCUSDT, held. */
export function createBtcHold(): WeightStrategy {
  return {
    name: "benchmark: BTC buy and hold (1x)",
    interval: "1d",
    rebalanceEvery: 1,
    weightSeries({ candles }: WeightInputs) {
      const out = new Map<number, Record<string, number>>();
      for (const c of candles.BTCUSDT ?? []) out.set(c.openTime, { BTCUSDT: 1 });
      return out;
    },
  };
}

/** Equal weight long every coin that has data, rebalanced monthly. */
export function createEqualWeightHold(): WeightStrategy {
  return {
    name: "benchmark: equal-weight long all coins (1x, monthly)",
    interval: "1d",
    rebalanceEvery: 30,
    weightSeries({ candles }: WeightInputs) {
      const listed = new Map<number, string[]>();
      for (const [s, cs] of Object.entries(candles)) for (const c of cs) {
        if (!listed.has(c.openTime)) listed.set(c.openTime, []);
        listed.get(c.openTime)!.push(s);
      }
      const out = new Map<number, Record<string, number>>();
      for (const [t, syms] of listed) out.set(t, Object.fromEntries(syms.map((s) => [s, 1 / syms.length])));
      return out;
    },
  };
}
