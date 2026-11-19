/** One closed (or forming) candle. Times are epoch milliseconds. */
export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Taker (aggressive) buy volume in base units, from the kline. Absent in old CSVs. */
  takerBuyVolume?: number;
  /** Open interest (base units) at the candle's close. Research data only; the live engine does not fetch it. */
  openInterest?: number;
  /**
   * Last funding rate SETTLED at or before this candle's close (fraction per 8h, e.g. 0.0001).
   * Only set for strategies that need it (see Strategy.needsFunding).
   */
  fundingRate?: number;
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
  /** Stop at entry; entryPrice - initialStop is the position's 1R. */
  initialStop: number;
  /** openTime of the candle during which the position was entered (the candle after the signal). */
  entryCandleOpenTime: number;
}

export const isClosed = (c: Candle, nowMs: number): boolean => c.closeTime < nowMs;
