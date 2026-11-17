/** One closed (or forming) candle. Times are epoch milliseconds. */
export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Side = "LONG" | "SHORT";

/** An entry intent produced by a strategy from closed candles only. */
export interface Signal {
  symbol: string;
  side: Side;
  /** Close of the signal candle. The real fill happens later (next bar open / market order). */
  refPrice: number;
  /** Initial protective stop price. */
  stop: number;
  /** Optional fixed take-profit price. Trend strategies usually leave it undefined. */
  takeProfit?: number;
  /** openTime of the candle that produced the signal. Used for idempotent order ids. */
  candleOpenTime: number;
  reason: string;
}

export interface OpenPositionView {
  side: Side;
  entryPrice: number;
  stop: number;
  /** openTime of the candle on which the position was entered. */
  entryCandleOpenTime: number;
}

export const isClosed = (c: Candle, nowMs: number): boolean => c.closeTime < nowMs;
