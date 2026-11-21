// All strategies by name. The backtest CLI, the research job and the live engine select from here.
import { createIntrabar } from "./intrabar.js";
import { createFunding, DEFAULT_FUNDING } from "./funding.js";
import { createMeanReversion, DEFAULT_MEAN_REVERSION } from "./meanReversion.js";
import { createPullback, DEFAULT_PULLBACK } from "./pullback.js";
import { createTrendBreakout, DEFAULT_TREND_BREAKOUT } from "./trendBreakout.js";
import { createTsmom, DEFAULT_TSMOM } from "./tsmom.js";
import type { Strategy } from "./types.js";
import { EXIT_PRESETS, withExits } from "./exitOverlays.js";
import {
  createConnorsRsi2, createGoldenCross, createIchimoku, createMacd200, createMaxMin10, createNightSeason,
  createSqueezeLazyBear, createSupertrend, createTurtle55, createVolBreakout, createMa2050,
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
  // A-LV plus the funding crowding filter (round 21, pre-registered: 90th percentile over 90 days = 540 4h
  // candles; passed in both halves). Live for A since 2026-11-21 as trendlvfc+timestop+befee.
  trendlvfc: {
    label: "A-LV-FC",
    interval: "4h",
    defaults: { ...DEFAULT_TREND_BREAKOUT, maxAtrPct: 0.03, fundingCrowdPct: 0.9, fundingCrowdBars: 540 },
    integerKeys: new Set(["entryLookback", "emaFast", "emaSlow", "atrPeriod", "fundingCrowdBars"]),
    create: (p) => createTrendBreakout({ ...DEFAULT_TREND_BREAKOUT, maxAtrPct: 0.03, fundingCrowdPct: 0.9, fundingCrowdBars: 540, ...p }),
  },
  // A-LV plus order-flow confirmation (round 13, pre-registered at 0.5: the breakout candle's
  // aggressive volume must be majority on the trade's side). Research only until it passes.
  trendlvtk: {
    label: "A-LV-TK",
    interval: "4h",
    defaults: { ...DEFAULT_TREND_BREAKOUT, maxAtrPct: 0.03, minTakerShare: 0.5 },
    integerKeys: new Set(["entryLookback", "emaFast", "emaSlow", "atrPeriod"]),
    create: (p) => createTrendBreakout({ ...DEFAULT_TREND_BREAKOUT, maxAtrPct: 0.03, minTakerShare: 0.5, ...p }),
  },
  // A-LV plus open-interest confirmation (round 13b, pre-registered at 6 bars = 24h: OI at the
  // breakout close above OI 24h earlier). Research only: live has no OI feed.
  trendlvoi: {
    label: "A-LV-OI",
    interval: "4h",
    defaults: { ...DEFAULT_TREND_BREAKOUT, maxAtrPct: 0.03, oiLookback: 6 },
    integerKeys: new Set(["entryLookback", "emaFast", "emaSlow", "atrPeriod", "oiLookback"]),
    create: (p) => createTrendBreakout({ ...DEFAULT_TREND_BREAKOUT, maxAtrPct: 0.03, oiLookback: 6, ...p }),
  },
  // Round 18 research (backtest only): A-LV + time stop run on 15m candles, entries decided only at
  // 4h closes (control) or at every 15m close on the forming 4h candle.
  trendlv15c: {
    label: "A-LV 15m closed", interval: "15m", defaults: {}, integerKeys: new Set<string>(),
    create: () => createIntrabar(getStrategy("trendlv+timestop").create(), "15m", 900_000, 14_400_000, "closed"),
  },
  trendlv15i: {
    label: "A-LV 15m intrabar", interval: "15m", defaults: {}, integerKeys: new Set<string>(),
    create: () => createIntrabar(getStrategy("trendlv+timestop").create(), "15m", 900_000, 14_400_000, "intrabar"),
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
  // BTC/ETH round 12: F on 4h candles (lookbacks in 4h bars), same pre-registered parameters.
  tsmom4h: {
    label: "F-4h",
    interval: "4h",
    defaults: { ...DEFAULT_TSMOM },
    integerKeys: new Set(["allowShort"]),
    create: (p) => createTsmom({ ...DEFAULT_TSMOM, ...p }, "4h"),
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
  st4h: { label: "P1-4h", interval: "4h", defaults: { period: 10, mult: 3 }, integerKeys: new Set(["period"]), create: (p) => createSupertrend("4h", p?.period ?? 10, p?.mult ?? 3) },
  st1d: { label: "P1-1d", interval: "1d", defaults: { period: 10, mult: 3 }, integerKeys: new Set(["period"]), create: (p) => createSupertrend("1d", p?.period ?? 10, p?.mult ?? 3) },
  macd: { label: "P2", interval: "4h", defaults: {}, integerKeys: new Set<string>(), create: () => createMacd200() },
  sqzlb: { label: "P3", interval: "4h", defaults: {}, integerKeys: new Set<string>(), create: () => createSqueezeLazyBear() },
  ichi: { label: "P4", interval: "1d", defaults: {}, integerKeys: new Set<string>(), create: () => createIchimoku() },
  maxmin: { label: "P5", interval: "1d", defaults: {}, integerKeys: new Set<string>(), create: () => createMaxMin10() },
  volbo: { label: "P6", interval: "1h", defaults: {}, integerKeys: new Set<string>(), create: () => createVolBreakout() },
  night: { label: "P7", interval: "1h", defaults: {}, integerKeys: new Set<string>(), create: () => createNightSeason() },
  turtle: { label: "P8", interval: "1d", defaults: {}, integerKeys: new Set<string>(), create: () => createTurtle55() },
  gcross: { label: "P9", interval: "1d", defaults: {}, integerKeys: new Set<string>(), create: () => createGoldenCross() },
  // BTC/ETH round 12: the same published rules on faster candles (EMA50/200 of 1h closes).
  gcross1h: { label: "P9-1h", interval: "1h", defaults: {}, integerKeys: new Set<string>(), create: () => createGoldenCross("1h") },
  // GC with a 3-ATR chandelier trail (round 14, pre-registered = its own initial stop distance). Research only.
  gcross1htr: {
    label: "P9-1h-TR", interval: "1h", defaults: { trailAtr: 3 }, integerKeys: new Set<string>(),
    create: (p) => createGoldenCross("1h", { trailAtr: p?.trailAtr ?? 3 }),
  },
  // Round 16 (pre-registered): GC with a chandelier trail at 3 x DAILY ATR(14).
  gcross1hdt: {
    label: "P9-1h-DT", interval: "1h", defaults: { dailyTrailAtr: 3 }, integerKeys: new Set<string>(),
    create: (p) => createGoldenCross("1h", { dailyTrailAtr: p?.dailyTrailAtr ?? 3 }),
  },
  // Round 16 (pre-registered): GC exits on a close through EMA50 once the trade has reached 3R.
  gcross1hema: {
    label: "P9-1h-EMA", interval: "1h", defaults: { emaExitAfterR: 3 }, integerKeys: new Set<string>(),
    create: (p) => createGoldenCross("1h", { emaExitAfterR: p?.emaExitAfterR ?? 3 }),
  },
  rsi2: { label: "P10", interval: "1d", defaults: {}, integerKeys: new Set<string>(), create: () => createConnorsRsi2() },
  ma2050: { label: "P11", interval: "1h", defaults: {}, integerKeys: new Set<string>(), create: () => createMa2050() },
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
