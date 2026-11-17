// All strategies by name. The backtest CLI, the research job and the live engine select from here.
import { createMeanReversion, DEFAULT_MEAN_REVERSION } from "./meanReversion.js";
import { createPullback, DEFAULT_PULLBACK } from "./pullback.js";
import { createTrendBreakout, DEFAULT_TREND_BREAKOUT } from "./trendBreakout.js";
import type { Strategy } from "./types.js";

export interface StrategyEntry {
  /** Plan label: A, B, C. */
  label: string;
  interval: string;
  defaults: Record<string, number>;
  /** Parameters that are whole numbers (periods, counts); the robustness sweep rounds only these. */
  integerKeys: ReadonlySet<string>;
  create(params?: Record<string, number>): Strategy;
}

export const STRATEGIES = {
  trend: {
    label: "A",
    interval: "4h",
    defaults: { ...DEFAULT_TREND_BREAKOUT },
    integerKeys: new Set(["entryLookback", "emaFast", "emaSlow", "atrPeriod"]),
    create: (p) => createTrendBreakout({ ...DEFAULT_TREND_BREAKOUT, ...p }),
  },
  pullback: {
    label: "B",
    interval: "1h",
    defaults: { ...DEFAULT_PULLBACK },
    integerKeys: new Set(["trendFast", "trendSlow", "rsiPeriod"]),
    create: (p) => createPullback({ ...DEFAULT_PULLBACK, ...p }),
  },
  meanrev: {
    label: "C",
    interval: "1h",
    defaults: { ...DEFAULT_MEAN_REVERSION },
    integerKeys: new Set(["bbPeriod", "adxPeriod", "maxBars"]),
    create: (p) => createMeanReversion({ ...DEFAULT_MEAN_REVERSION, ...p }),
  },
} satisfies Record<string, StrategyEntry>;

export type StrategyName = keyof typeof STRATEGIES;
export const STRATEGY_NAMES = Object.keys(STRATEGIES) as StrategyName[];

export function getStrategy(name: string): StrategyEntry {
  if (!Object.hasOwn(STRATEGIES, name)) throw new Error(`unknown strategy "${name}" (known: ${STRATEGY_NAMES.join(", ")})`);
  return STRATEGIES[name as StrategyName];
}
