// Weight strategies hold a target fraction of equity in each symbol (signed: + long, - short)
// and are rebalanced periodically. Used for volatility-targeted ensembles (G), dollar-neutral
// funding carry (H) and buy-and-hold benchmarks.
import type { Candle } from "../core/types.js";
import type { FundingPoint } from "../exchange/types.js";

export interface WeightInputs {
  /** Closed candles per symbol (full history in the backtest). */
  candles: Record<string, Candle[]>;
  /** Settled funding per symbol, oldest first (may be empty). */
  funding: Record<string, FundingPoint[]>;
}

export interface WeightStrategy {
  readonly name: string;
  readonly interval: string;
  readonly needsFunding?: boolean;
  /** Rebalance every N bars. */
  readonly rebalanceEvery: number;
  /**
   * Target weights decided at the CLOSE of each bar, keyed by that bar's openTime.
   * The weight for time t may only use candles with openTime <= t and funding with time <= t's close;
   * it is executed at the next bar's open. Computed in one pass for speed; look-ahead is tested.
   */
  weightSeries(inputs: WeightInputs): Map<number, Record<string, number>>;
}

/** Realized annualized volatility of daily log returns over the `lookback` closes ending at i. */
export function realizedVol(closes: number[], i: number, lookback: number, periodsPerYear = 365): number {
  if (i < lookback) return NaN;
  let sum = 0;
  let sumSq = 0;
  for (let k = i - lookback + 1; k <= i; k++) {
    const r = Math.log(closes[k]! / closes[k - 1]!);
    sum += r;
    sumSq += r * r;
  }
  const mean = sum / lookback;
  const variance = Math.max(0, sumSq / lookback - mean * mean);
  return Math.sqrt(variance * periodsPerYear);
}
