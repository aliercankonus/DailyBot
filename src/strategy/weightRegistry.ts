// Weight strategies the live engine can run (STRATEGY=<name>), built exactly like the backtest catalog.
import { createDonchianEnsemble, DEFAULT_DONCHIAN_ENSEMBLE } from "./donchianEnsemble.js";
import type { WeightStrategy } from "./weights.js";

/** The 2% per-trade rule (CLAUDE.md) applied to each weight leg's catastrophic stop. */
export const MAX_LEG_RISK = 0.02;

export const WEIGHT_STRATEGIES: Record<string, () => WeightStrategy> = {
  donchian: () => createDonchianEnsemble({ ...DEFAULT_DONCHIAN_ENSEMBLE }),
  donchianls: () => createDonchianEnsemble({ ...DEFAULT_DONCHIAN_ENSEMBLE, allowShort: 1 }),
  // G-LS with the project's 2% rule per leg (round 12); the only G-LS allowed outside paper mode.
  donchianls2: () => createDonchianEnsemble({ ...DEFAULT_DONCHIAN_ENSEMBLE, allowShort: 1, maxLegRisk: MAX_LEG_RISK }),
};

export const isWeightStrategy = (name: string) => Object.hasOwn(WEIGHT_STRATEGIES, name);

/**
 * Checks a STRATEGY value before the engine starts (before it takes the lock or talks to an
 * exchange). Throws with a clear message for an unknown name or an unsafe leverage setting.
 * Outside paper mode a weight strategy must cap each leg at the 2% rule (maxLegRisk <= 2%).
 */
export function validateEngineStrategy(name: string, maxLeverage: number, resolveTrades: (n: string) => unknown, mode: "paper" | "testnet" | "live"): void {
  if (isWeightStrategy(name)) {
    const ws = WEIGHT_STRATEGIES[name]!();
    const g = ws.maxGross;
    if (g !== undefined && g > maxLeverage) throw new Error(`strategy ${name} can hold gross ${g}x equity; MAX_LEVERAGE ${maxLeverage} is below that`);
    if (mode !== "paper" && !(ws.maxLegRisk !== undefined && ws.maxLegRisk <= MAX_LEG_RISK)) {
      throw new Error(`strategy ${name} does not cap each leg at ${MAX_LEG_RISK * 100}% risk; outside paper mode use a capped variant (e.g. donchianls2)`);
    }
    return;
  }
  resolveTrades(name); // throws "unknown strategy ..." for anything else
}
