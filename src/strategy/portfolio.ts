import type { Candle, Side } from "../core/types.js";

/** One desired position after a rebalance. */
export interface PortfolioTarget {
  symbol: string;
  side: Side;
  /** Catastrophic stop price, set at entry and never moved. */
  stop: number;
}

/**
 * A portfolio strategy decides the whole target book at once from CLOSED candles only.
 * Each array in `candlesBySymbol` holds the last <= STRATEGY_WINDOW closed candles of that
 * symbol, all ending at the same decision time. Symbols without a candle at that time are absent.
 */
export interface PortfolioStrategy {
  readonly name: string;
  readonly interval: "1d";
  /** Minimum number of closed candles a symbol needs before it can be ranked. */
  readonly warmup: number;
  /** Rebalance every N bars of the union timeline. */
  readonly rebalanceEvery: number;
  /** Stop distance in ATR multiples. */
  readonly stopAtr: number;
  /** Maximum simultaneous positions (long + short). */
  readonly maxPositions: number;
  targets(candlesBySymbol: Record<string, Candle[]>): PortfolioTarget[];
}
