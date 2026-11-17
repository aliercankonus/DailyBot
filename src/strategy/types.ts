import type { Candle, OpenPositionView, Signal } from "../core/types.js";

/**
 * A strategy is a pure function of CLOSED candles. The backtester and the live
 * engine call exactly the same object, so what is tested is what trades.
 */
export interface Strategy {
  readonly name: string;
  /** Minimum number of closed candles needed before evaluate() can return a signal. */
  readonly warmup: number;
  /** Entry decision on the last candle of `candles`. */
  evaluate(symbol: string, candles: Candle[]): Signal | null;
  /**
   * Stop update after the last candle of `candles` closed. Must never loosen the stop:
   * return a price at least as protective as `position.stop`.
   */
  updateStop(position: OpenPositionView, candles: Candle[]): number;
}
