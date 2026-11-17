import type { Candle } from "../src/core/types.js";
import type { AccountBalance, Exchange, ExchangePosition, Fill, StopOrder, SymbolFilters, TradeFill } from "../src/exchange/types.js";

export const H4 = 4 * 3600_000;

/** Candles from a list of closes. high/low = close ± spread. */
export function candlesFromCloses(closes: number[], start = Date.UTC(2024, 0, 1), interval = H4, spread = 0.002): Candle[] {
  return closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1]!;
    return {
      openTime: start + i * interval,
      closeTime: start + (i + 1) * interval - 1,
      open,
      high: Math.max(open, c) * (1 + spread),
      low: Math.min(open, c) * (1 - spread),
      close: c,
      volume: 1000,
    };
  });
}

/** Flat for `flat` bars, then a steady up-trend: guaranteed long breakout. */
export function uptrend(flat = 220, up = 60, base = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < flat; i++) out.push(base + Math.sin(i / 3) * 0.5 + i * 0.01);
  let p = out.at(-1)!;
  for (let i = 0; i < up; i++) out.push((p *= 1.01));
  return out;
}

export const FILTERS: SymbolFilters = { symbol: "BTCUSDT", tickSize: 0.1, stepSize: 0.001, minQty: 0.001, maxQty: 1000, marketStepSize: 0.001, marketMaxQty: 1000, minNotional: 5 };

/** Scriptable in-memory exchange for engine tests. */
export class FakeExchange implements Exchange {
  readonly name = "fake";
  now = Date.UTC(2024, 3, 1);
  candles: Record<string, Candle[]> = {};
  mark: Record<string, number> = {};
  balance: AccountBalance = { equity: 10_000, available: 10_000 };
  positions: Record<string, ExchangePosition> = {};
  stops: StopOrder[] = [];
  orders = new Map<string, Fill>();
  fills: Record<string, TradeFill[]> = {};
  calls: string[] = [];
  failPlaceStop = false;
  /** When set, placeStop throws this error (takes precedence over failPlaceStop). */
  placeStopError: Error | null = null;
  failMarket = false;
  failBalance = false;
  lastCandleLimit = 0;
  leverage: Record<string, number> = {};
  private seq = 1;

  async getServerTime() { return this.now; }
  async getClosedCandles(symbol: string, _i: string, limit: number) {
    this.lastCandleLimit = limit;
    return (this.candles[symbol] ?? []).filter((c) => c.closeTime < this.now).slice(-limit);
  }
  async getFilters(symbol: string) { return { ...FILTERS, symbol }; }
  async getBalance() {
    if (this.failBalance) throw new Error("balance unavailable");
    return { ...this.balance };
  }
  async getPosition(symbol: string) { return this.positions[symbol] ?? null; }
  async prepareSymbol(symbol: string, leverage: number) { this.leverage[symbol] = leverage; this.calls.push(`prepare ${symbol} ${leverage}`); }
  async marketOrder(p: { symbol: string; side: "BUY" | "SELL"; quantity: number; reduceOnly: boolean; clientOrderId: string }) {
    const prev = this.orders.get(p.clientOrderId);
    if (prev) return prev;
    if (this.failMarket) throw new Error("market order failed");
    this.calls.push(`market ${p.side} ${p.quantity} ${p.reduceOnly ? "reduce" : "open"} ${p.clientOrderId}`);
    const px = this.mark[p.symbol]!;
    const pos = this.positions[p.symbol];
    if (p.reduceOnly) {
      if (pos) delete this.positions[p.symbol];
    } else {
      this.positions[p.symbol] = { symbol: p.symbol, side: p.side === "BUY" ? "LONG" : "SHORT", quantity: p.quantity, entryPrice: px };
    }
    const f: Fill = { orderId: `O${this.seq++}`, clientOrderId: p.clientOrderId, status: "FILLED", executedQty: p.quantity, avgPrice: px };
    this.orders.set(p.clientOrderId, f);
    return f;
  }
  async placeStop(p: { symbol: string; side: "BUY" | "SELL"; quantity: number; stopPrice: number; clientId: string }) {
    if (this.placeStopError) throw this.placeStopError;
    if (this.failPlaceStop) throw new Error("stop rejected");
    this.calls.push(`stop ${p.side} ${p.stopPrice.toFixed(2)} ${p.clientId}`);
    const s: StopOrder = { id: `S${this.seq++}`, clientId: p.clientId, symbol: p.symbol, side: p.side, stopPrice: p.stopPrice, quantity: p.quantity };
    this.stops.push(s);
    return s;
  }
  async cancelStop(_symbol: string, id: string) { this.calls.push(`cancel ${id}`); this.stops = this.stops.filter((s) => s.id !== id); }
  async getOpenStops(symbol: string) { return this.stops.filter((s) => s.symbol === symbol); }
  async getFills(symbol: string, since: number) { return (this.fills[symbol] ?? []).filter((f) => f.time >= since); }

  /** Simulate the exchange triggering the stop. */
  triggerStop(symbol: string, price: number) {
    const pos = this.positions[symbol]!;
    const side = pos.side === "LONG" ? "SELL" : "BUY";
    const pnl = (pos.side === "LONG" ? price - pos.entryPrice : pos.entryPrice - price) * pos.quantity;
    (this.fills[symbol] ??= []).push({ time: this.now, price, qty: pos.quantity, side, realizedPnl: pnl, commission: 0.5 });
    delete this.positions[symbol];
    this.stops = this.stops.filter((s) => s.symbol !== symbol);
  }
}
