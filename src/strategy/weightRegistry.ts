// Weight strategies the live engine can run (STRATEGY=<name>), built exactly like the backtest catalog.
import { createDonchianEnsemble, DEFAULT_DONCHIAN_ENSEMBLE } from "./donchianEnsemble.js";
import type { WeightStrategy } from "./weights.js";

export const WEIGHT_STRATEGIES: Record<string, () => WeightStrategy> = {
  donchian: () => createDonchianEnsemble({ ...DEFAULT_DONCHIAN_ENSEMBLE }),
  donchianls: () => createDonchianEnsemble({ ...DEFAULT_DONCHIAN_ENSEMBLE, allowShort: 1 }),
};

export const isWeightStrategy = (name: string) => Object.hasOwn(WEIGHT_STRATEGIES, name);
