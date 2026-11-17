import type { Candle, Side } from "../core/types.js";

export interface SymbolFilters {
  symbol: string;
  tickSize: number;
  /** LOT_SIZE filter: applies to stop (conditional) orders. */
  stepSize: number;
  minQty: number;
  maxQty: number;
  /** MARKET_LOT_SIZE filter: applies to market orders. Equal to the LOT_SIZE values when absent. */
  marketStepSize: number;
  marketMaxQty: number;
  minNotional: number;
}

export interface AccountBalance {
  /** Wallet balance + unrealized PnL, USDT. */
  equity: number;
  /** Free margin, USDT. */
  available: number;
}

export interface ExchangePosition {
  symbol: string;
  side: Side;
  quantity: number; // always positive
  entryPrice: number;
}

export interface Fill {
  orderId: string;
  clientOrderId: string;
  status: "FILLED" | "PARTIALLY_FILLED" | "NEW" | "CANCELED" | "REJECTED" | "EXPIRED";
  executedQty: number;
  avgPrice: number;
}

export interface StopOrder {
  id: string;
  clientId: string;
  symbol: string;
  /** Side of the closing order (SELL closes a long). */
  side: "BUY" | "SELL";
  stopPrice: number;
  quantity: number;
}

export interface FundingPoint {
  /** Settlement time (ms). */
  time: number;
  /** Fraction per 8h; positive means longs pay shorts. */
  rate: number;
}

export interface TradeFill {
  time: number;
  price: number;
  qty: number;
  side: "BUY" | "SELL";
  realizedPnl: number;
  commission: number;
}

/**
 * Everything the engine needs from an exchange. Binance futures and the paper
 * simulator both implement it, so the engine code is identical in every mode.
 * One-way position mode and isolated margin are assumed.
 */
export interface Exchange {
  readonly name: string;
  getServerTime(): Promise<number>;
  getClosedCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  getFilters(symbol: string): Promise<SymbolFilters>;
  getBalance(): Promise<AccountBalance>;
  getPosition(symbol: string): Promise<ExchangePosition | null>;
  /** Isolated margin + leverage. Idempotent. */
  prepareSymbol(symbol: string, leverage: number): Promise<void>;
  /**
   * Market order with a deterministic client id. If an order with this client id
   * already exists, returns it instead of placing a second one.
   */
  marketOrder(p: { symbol: string; side: "BUY" | "SELL"; quantity: number; reduceOnly: boolean; clientOrderId: string }): Promise<Fill>;
  /** Reduce-only stop-market order closing `quantity`. Triggered by mark price. */
  placeStop(p: { symbol: string; side: "BUY" | "SELL"; quantity: number; stopPrice: number; clientId: string }): Promise<StopOrder>;
  cancelStop(symbol: string, id: string): Promise<void>;
  getOpenStops(symbol: string): Promise<StopOrder[]>;
  /** Fills for the symbol since `sinceMs`, oldest first. */
  getFills(symbol: string, sinceMs: number): Promise<TradeFill[]>;
  /** Settled funding rates since `startTime`, oldest first (public data). */
  getFundingHistory(symbol: string, startTime: number): Promise<FundingPoint[]>;
}

export const closingSide = (side: Side): "BUY" | "SELL" => (side === "LONG" ? "SELL" : "BUY");
export const openingSide = (side: Side): "BUY" | "SELL" => (side === "LONG" ? "BUY" : "SELL");
