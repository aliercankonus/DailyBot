// Weight strategies the live engine can run (STRATEGY=<name>), built exactly like the backtest catalog.
import { createDonchianEnsemble, DEFAULT_DONCHIAN_ENSEMBLE } from "./donchianEnsemble.js";
import type { WeightStrategy } from "./weights.js";

export const WEIGHT_STRATEGIES: Record<string, () => WeightStrategy> = {
  donchian: () => createDonchianEnsemble({ ...DEFAULT_DONCHIAN_ENSEMBLE }),
  donchianls: () => createDonchianEnsemble({ ...DEFAULT_DONCHIAN_ENSEMBLE, allowShort: 1 }),
};

export const isWeightStrategy = (name: string) => Object.hasOwn(WEIGHT_STRATEGIES, name);

/**
 * Checks a STRATEGY value before the engine starts (before it takes the lock or talks to an
 * exchange). Throws with a clear message for an unknown name or an unsafe leverage setting.
 */
export function validateEngineStrategy(name: string, maxLeverage: number, resolveTrades: (n: string) => unknown): void {
  if (isWeightStrategy(name)) {
    const g = WEIGHT_STRATEGIES[name]!().maxGross;
    if (g !== undefined && g > maxLeverage) throw new Error(`strategy ${name} can hold gross ${g}x equity; MAX_LEVERAGE ${maxLeverage} is below that`);
    return;
  }
  resolveTrades(name); // throws "unknown strategy ..." for anything else
}
