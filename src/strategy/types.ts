import type { Candle, OpenPositionView, Signal } from "../core/types.js";

/**
 * Number of closed candles a strategy is given, live AND in the backtest. A fixed window
 * keeps history-dependent indicators (EMA seed, Wilder ATR) identical in both, and keeps
 * the backtest O(n * window). Must stay below Binance's 1500-candle request limit.
 */
export const STRATEGY_WINDOW = 1000;

/**
 * A strategy is a pure function of CLOSED candles. The backtester and the live
 * engine call exactly the same object, so what is tested is what trades.
 */
export interface Strategy {
  readonly name: string;
  /** Candle interval the strategy is designed for, e.g. "4h". Live and backtest both use it. */
  readonly interval: string;
  /** When true, candles carry `fundingRate` (live engine and backtest both attach it). */
  readonly needsFunding?: boolean;
  /** Minimum number of closed candles needed before evaluate() can return a signal. */
  readonly warmup: number;
  /** Research only: closed candles the BACKTEST gives this strategy (default STRATEGY_WINDOW). The live engine ignores it. */
  readonly window?: number;
  /** Entry decision on the last candle of `candles`. */
  evaluate(symbol: string, candles: Candle[]): Signal | null;
  /**
   * Optional, diagnostics only: a one-line account of the entry conditions on the last candle
   * (which hold, which do not). The live engine logs it when evaluate() returns no signal.
   * Must not influence trading.
   */
  explain?(candles: Candle[]): string;
  /**
   * Stop update after the last candle of `candles` closed. Must never loosen the stop:
   * return a price at least as protective as `position.stop`.
   */
  updateStop(position: OpenPositionView, candles: Candle[]): number;
  /**
   * Optional discretionary exit (target, time stop) decided on the last CLOSED candle.
   * The backtest fills it at the next candle's open; the live engine closes at market.
   */
  shouldExit?(position: OpenPositionView, candles: Candle[]): boolean;
  /**
   * Optional partial take-profits (TP1, TP2, ...). Each level closes `fraction` of the ORIGINAL
   * quantity when price reaches entry +/- r x R (R = |entry - initialStop|). With
   * breakEvenAfterFirst, the stop moves to entry (+ fee buffer) once TP1 has filled.
   * The remainder keeps the strategy's own stop and exits.
   */
  readonly takeProfit?: TakeProfitPlan;
}

export interface TakeProfitPlan {
  levels: readonly { r: number; fraction: number }[];
  breakEvenAfterFirst: boolean;
}
