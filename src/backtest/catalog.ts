// Everything the backtest CLI can run: single-symbol strategies (registry.ts) and portfolio
// strategies (E). Each entry knows how to run itself, so the CLI treats them all the same.
import { createRelativeValue, DEFAULT_REVERT, DEFAULT_RV_TREND } from "../strategy/relativeValue.js";
import type { Candle } from "../core/types.js";
import { getStrategy, STRATEGY_NAMES } from "../strategy/registry.js";
import { createXsMomentum, DEFAULT_XS_MOMENTUM } from "../strategy/xsMomentum.js";
import { runBacktest, type BacktestConfig, type BacktestResult } from "./engine.js";
import { runPortfolioBacktest } from "./portfolio.js";
import { runWeightsBacktest } from "./weights.js";
import { createBtcHold, createEqualWeightHold } from "../strategy/benchmarks.js";
import { createDonchianEnsemble, DEFAULT_DONCHIAN_ENSEMBLE } from "../strategy/donchianEnsemble.js";
import { createFundingCarry, DEFAULT_FUNDING_CARRY } from "../strategy/fundingCarry.js";
import type { WeightStrategy } from "../strategy/weights.js";

/** Liquid USDⓈ-M perpetuals that traded on Binance through 2021-2026. Survivorship-biased: chosen today. */
export const UNIVERSE_20 = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "LTCUSDT", "BCHUSDT", "TRXUSDT", "ATOMUSDT", "ETCUSDT", "XLMUSDT", "FILUSDT", "UNIUSDT", "NEARUSDT", "AAVEUSDT",
];
export const CORE_5 = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];

export interface CatalogEntry {
  label: string;
  /** "trades": judged on trade statistics; "weights": judged on the equity curve (Sharpe, drawdown, yearly returns). */
  kind: "trades" | "weights";
  /** Parameters that are on/off switches: the robustness sweep skips them. */
  switchKeys?: ReadonlySet<string>;
  interval: string;
  defaults: Record<string, number>;
  integerKeys: ReadonlySet<string>;
  needsFunding: boolean;
  defaultSymbols: string[];
  /** Suggested portfolio limits: risk per position and max open positions. */
  defaultRisk: number;
  defaultMaxOpen: number;
  describe(params: Record<string, number>): string;
  run(params: Record<string, number>, data: Record<string, Candle[]>, cfg: BacktestConfig): BacktestResult;
}

function weightsEntry(
  label: string, defaults: Record<string, number>, integerKeys: string[], switchKeys: string[],
  make: (p: Record<string, number>) => WeightStrategy, needsFunding = false,
): CatalogEntry {
  return {
    label, kind: "weights", interval: "1d", defaults, needsFunding,
    integerKeys: new Set(integerKeys), switchKeys: new Set(switchKeys),
    defaultSymbols: UNIVERSE_20, defaultRisk: 0.01, defaultMaxOpen: 20,
    describe: (p) => make(p).name,
    run: (p, data, cfg) => runWeightsBacktest(make(p), data, cfg),
  };
}

export function getCatalogEntry(name: string): CatalogEntry {
  if (name === "donchian") {
    return weightsEntry("G", { ...DEFAULT_DONCHIAN_ENSEMBLE }, ["volLookback"], ["allowShort"],
      (p) => createDonchianEnsemble({ ...DEFAULT_DONCHIAN_ENSEMBLE, ...p }));
  }
  if (name === "donchianls") {
    // Pre-registered variant: the same rules mirrored for shorts (the paper is long only).
    return weightsEntry("G-LS", { ...DEFAULT_DONCHIAN_ENSEMBLE, allowShort: 1 }, ["volLookback"], ["allowShort"],
      (p) => createDonchianEnsemble({ ...DEFAULT_DONCHIAN_ENSEMBLE, ...p, allowShort: 1 }));
  }
  if (name === "carry") {
    return weightsEntry("H", { ...DEFAULT_FUNDING_CARRY }, ["lookbackDays", "rebalanceEvery"], [],
      (p) => createFundingCarry({ ...DEFAULT_FUNDING_CARRY, ...p }), true);
  }
  if (name === "ethbtcmr" || name === "altbtcmr" || name === "altbtctrend") {
    // Round 10: market-neutral relative value vs BTC (src/strategy/relativeValue.ts), standard settings.
    const alts = name === "ethbtcmr" ? ["ETHUSDT"] : UNIVERSE_20.filter((x) => x !== "BTCUSDT");
    const mode = name === "altbtctrend" ? "trend" : "revert";
    const defaults = mode === "trend" ? DEFAULT_RV_TREND : DEFAULT_REVERT;
    return weightsEntry(name === "ethbtcmr" ? "R1" : mode === "trend" ? "R3" : "R2", { ...defaults }, ["lookback"], [],
      (p) => createRelativeValue(mode, alts, { ...defaults, ...p } as typeof defaults));
  }
  if (name === "btchold") return weightsEntry("BM1", {}, [], [], () => createBtcHold());
  if (name === "ewhold") return weightsEntry("BM2", {}, [], [], () => createEqualWeightHold());
  if (name === "xsmom") {
    return {
      label: "E",
      kind: "trades",
      switchKeys: new Set(["tsGate"]),
      interval: "1d",
      defaults: { ...DEFAULT_XS_MOMENTUM },
      integerKeys: new Set(["lookback", "topK", "bottomK", "rebalanceEvery", "tsGate"]),
      needsFunding: false,
      defaultSymbols: UNIVERSE_20,
      defaultRisk: 0.005,
      defaultMaxOpen: DEFAULT_XS_MOMENTUM.topK + DEFAULT_XS_MOMENTUM.bottomK,
      describe: (p) => createXsMomentum({ ...DEFAULT_XS_MOMENTUM, ...p }).name,
      run: (p, data, cfg) => runPortfolioBacktest(createXsMomentum({ ...DEFAULT_XS_MOMENTUM, ...p }), data, cfg),
    };
  }
  const e = getStrategy(name);
  const daily = e.interval === "1d";
  return {
    label: e.label,
    kind: "trades",
    switchKeys: new Set(["allowShort"]),
    interval: e.interval,
    defaults: e.defaults,
    integerKeys: e.integerKeys,
    needsFunding: e.create().needsFunding === true,
    // Daily trend strategies are portfolio-style: many coins, small risk each.
    defaultSymbols: daily ? UNIVERSE_20 : CORE_5,
    defaultRisk: daily ? 0.005 : 0.01,
    defaultMaxOpen: daily ? 10 : 3,
    describe: (p) => e.create(p).name,
    run: (p, data, cfg) => runBacktest(e.create(p), data, cfg),
  };
}

export const CATALOG_NAMES = [...STRATEGY_NAMES, "xsmom", "donchian", "donchianls", "carry", "btchold", "ewhold", "ethbtcmr", "altbtcmr", "altbtctrend"];
