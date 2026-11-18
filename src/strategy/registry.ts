// All strategies by name. The backtest CLI, the research job and the live engine select from here.
import { createFunding, DEFAULT_FUNDING } from "./funding.js";
import { createMeanReversion, DEFAULT_MEAN_REVERSION } from "./meanReversion.js";
import { createPullback, DEFAULT_PULLBACK } from "./pullback.js";
import { createTrendBreakout, DEFAULT_TREND_BREAKOUT } from "./trendBreakout.js";
import { createTsmom, DEFAULT_TSMOM } from "./tsmom.js";
import type { Strategy } from "./types.js";
import { EXIT_PRESETS, withExits } from "./exitOverlays.js";
import {
  createCapitulation, createDailyPullback, createFailedBreakout, createSqueezeBreakout,
  DEFAULT_CAPITULATION, DEFAULT_DAILY_PULLBACK, DEFAULT_FAILED_BREAKOUT, DEFAULT_SQUEEZE,
} from "./oldIdeas.js";

export interface StrategyEntry {
  /** Plan label: A, B, C, ... */
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
  funding: {
    label: "D",
    interval: "1h",
    defaults: { ...DEFAULT_FUNDING },
    integerKeys: new Set(["lookback", "maxBars"]),
    create: (p) => createFunding({ ...DEFAULT_FUNDING, ...p }),
  },
  tsmom: {
    label: "F",
    interval: "1d",
    defaults: { ...DEFAULT_TSMOM },
    // allowShort is a switch, not a magnitude: the robustness sweep must not perturb it.
    integerKeys: new Set(["allowShort"]),
    create: (p) => createTsmom({ ...DEFAULT_TSMOM, ...p }),
  },
  // Cleaned ideas from the old bot (src/strategy/oldIdeas.ts).
  failedbo: {
    label: "S1",
    interval: "1d",
    defaults: { ...DEFAULT_FAILED_BREAKOUT },
    integerKeys: new Set(["lookback", "maxBars"]),
    create: (p) => createFailedBreakout({ ...DEFAULT_FAILED_BREAKOUT, ...p }),
  },
  squeeze: {
    label: "S2",
    interval: "4h",
    defaults: { ...DEFAULT_SQUEEZE },
    integerKeys: new Set(["bbPeriod", "pctLookback"]),
    create: (p) => createSqueezeBreakout({ ...DEFAULT_SQUEEZE, ...p }),
  },
  capit: {
    label: "S3",
    interval: "1d",
    defaults: { ...DEFAULT_CAPITULATION },
    integerKeys: new Set(["dropBars", "maxBars"]),
    create: (p) => createCapitulation({ ...DEFAULT_CAPITULATION, ...p }),
  },
  dpullback: {
    label: "S4",
    interval: "1d",
    defaults: { ...DEFAULT_DAILY_PULLBACK },
    integerKeys: new Set(["emaFast", "emaSlow", "maxBars"]),
    create: (p) => createDailyPullback({ ...DEFAULT_DAILY_PULLBACK, ...p }),
  },
} satisfies Record<string, StrategyEntry>;

export type StrategyName = keyof typeof STRATEGIES;
export const STRATEGY_NAMES = Object.keys(STRATEGIES) as StrategyName[];

/**
 * Resolve a strategy by name. "base+preset" (e.g. "trend+be", "dpullback+lock") wraps the base
 * strategy with an exit overlay from EXIT_PRESETS, so every exit idea can be tested on every strategy.
 */
export function getStrategy(name: string): StrategyEntry {
  const plus = name.indexOf("+");
  if (plus > 0) {
    const base = getStrategy(name.slice(0, plus));
    const preset = name.slice(plus + 1);
    if (!Object.hasOwn(EXIT_PRESETS, preset)) throw new Error(`unknown exit preset "${preset}" (known: ${Object.keys(EXIT_PRESETS).join(", ")})`);
    return { ...base, label: `${base.label}+${preset}`, create: (p) => withExits(base.create(p), EXIT_PRESETS[preset]!, preset) };
  }
  if (!Object.hasOwn(STRATEGIES, name)) throw new Error(`unknown strategy "${name}" (known: ${STRATEGY_NAMES.join(", ")})`);
  return STRATEGIES[name as StrategyName];
}
