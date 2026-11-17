// Everything the backtest CLI can run: single-symbol strategies (registry.ts) and portfolio
// strategies (E). Each entry knows how to run itself, so the CLI treats them all the same.
import type { Candle } from "../core/types.js";
import { getStrategy, STRATEGY_NAMES } from "../strategy/registry.js";
import { createXsMomentum, DEFAULT_XS_MOMENTUM } from "../strategy/xsMomentum.js";
import { runBacktest, type BacktestConfig, type BacktestResult } from "./engine.js";
import { runPortfolioBacktest } from "./portfolio.js";

/** Liquid USDⓈ-M perpetuals that traded on Binance through 2021-2026. Survivorship-biased: chosen today. */
export const UNIVERSE_20 = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "LTCUSDT", "BCHUSDT", "TRXUSDT", "ATOMUSDT", "ETCUSDT", "XLMUSDT", "FILUSDT", "UNIUSDT", "NEARUSDT", "AAVEUSDT",
];
export const CORE_5 = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];

export interface CatalogEntry {
  label: string;
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

export function getCatalogEntry(name: string): CatalogEntry {
  if (name === "xsmom") {
    return {
      label: "E",
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

export const CATALOG_NAMES = [...STRATEGY_NAMES, "xsmom"];
