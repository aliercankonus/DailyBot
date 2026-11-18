// All strategies by name. The backtest CLI, the research job and the live engine select from here.
import { createFunding, DEFAULT_FUNDING } from "./funding.js";
import { createMeanReversion, DEFAULT_MEAN_REVERSION } from "./meanReversion.js";
import { createPullback, DEFAULT_PULLBACK } from "./pullback.js";
import { createTrendBreakout, DEFAULT_TREND_BREAKOUT } from "./trendBreakout.js";
import { createTsmom, DEFAULT_TSMOM } from "./tsmom.js";
import type { Strategy } from "./types.js";
import { EXIT_PRESETS, withExits } from "./exitOverlays.js";
import {
  createConnorsRsi2, createGoldenCross, createIchimoku, createMacd200, createMaxMin10, createNightSeason,
  createSqueezeLazyBear, createSupertrend, createTurtle55, createVolBreakout,
} from "./popular.js";
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
  // A with the volatility filter: no new entries when ATR >= 3% of price at the signal candle.
  trendlv: {
    label: "A-LV",
    interval: "4h",
    defaults: { ...DEFAULT_TREND_BREAKOUT, maxAtrPct: 0.03 },
    integerKeys: new Set(["entryLookback", "emaFast", "emaSlow", "atrPeriod"]),
    create: (p) => createTrendBreakout({ ...DEFAULT_TREND_BREAKOUT, maxAtrPct: 0.03, ...p }),
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
  // Round 9: the most recommended public strategies, at their published settings (src/strategy/popular.ts).
  st4h: { label: "P1-4h", interval: "4h", defaults: {}, integerKeys: new Set<string>(), create: () => createSupertrend("4h") },
  st1d: { label: "P1-1d", interval: "1d", defaults: {}, integerKeys: new Set<string>(), create: () => createSupertrend("1d") },
  macd: { label: "P2", interval: "4h", defaults: {}, integerKeys: new Set<string>(), create: () => createMacd200() },
  sqzlb: { label: "P3", interval: "4h", defaults: {}, integerKeys: new Set<string>(), create: () => createSqueezeLazyBear() },
  ichi: { label: "P4", interval: "1d", defaults: {}, integerKeys: new Set<string>(), create: () => createIchimoku() },
  maxmin: { label: "P5", interval: "1d", defaults: {}, integerKeys: new Set<string>(), create: () => createMaxMin10() },
  volbo: { label: "P6", interval: "1h", defaults: {}, integerKeys: new Set<string>(), create: () => createVolBreakout() },
  night: { label: "P7", interval: "1h", defaults: {}, integerKeys: new Set<string>(), create: () => createNightSeason() },
  turtle: { label: "P8", interval: "1d", defaults: {}, integerKeys: new Set<string>(), create: () => createTurtle55() },
  gcross: { label: "P9", interval: "1d", defaults: {}, integerKeys: new Set<string>(), create: () => createGoldenCross() },
  rsi2: { label: "P10", interval: "1d", defaults: {}, integerKeys: new Set<string>(), create: () => createConnorsRsi2() },
} satisfies Record<string, StrategyEntry>;

export type StrategyName = keyof typeof STRATEGIES;
export const STRATEGY_NAMES = Object.keys(STRATEGIES) as StrategyName[];

/**
 * Resolve a strategy by name. "base+preset" (e.g. "trend+be", "dpullback+lock") wraps the base
 * strategy with an exit overlay from EXIT_PRESETS, so every exit idea can be tested on every strategy.
 */
export function getStrategy(name: string): StrategyEntry {
  // lastIndexOf: presets compose left to right, e.g. "trend+tp12+timestop".
  const plus = name.lastIndexOf("+");
  if (plus > 0) {
    const base = getStrategy(name.slice(0, plus));
    const preset = name.slice(plus + 1);
    if (!Object.hasOwn(EXIT_PRESETS, preset)) throw new Error(`unknown exit preset "${preset}" (known: ${Object.keys(EXIT_PRESETS).join(", ")})`);
    return { ...base, label: `${base.label}+${preset}`, create: (p) => withExits(base.create(p), EXIT_PRESETS[preset]!, preset) };
  }
  if (!Object.hasOwn(STRATEGIES, name)) throw new Error(`unknown strategy "${name}" (known: ${STRATEGY_NAMES.join(", ")})`);
  return STRATEGIES[name as StrategyName];
}
