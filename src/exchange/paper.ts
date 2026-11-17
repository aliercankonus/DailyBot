// Paper exchange: real public market data, simulated account. Fills at mark price
// plus slippage and taker fee. Stops are triggered from 1m candle highs/lows since the
// last check, so a stop touched between engine ticks is not missed.
import type { Candle } from "../core/types.js";
import { floorToStep } from "../risk/precision.js";
import type { AccountBalance, Exchange, ExchangePosition, Fill, StopOrder, SymbolFilters, TradeFill } from "./types.js";

export interface MarketData {
  getServerTime(): Promise<number>;
  getClosedCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  getFilters(symbol: string): Promise<SymbolFilters>;
  getMarkPrice(symbol: string): Promise<number>;
  getKlinesSince(symbol: string, interval: string, startTime: number): Promise<Candle[]>;
}

export interface PaperState {
  wallet: number;
  positions: Record<string, { side: "LONG" | "SHORT"; quantity: number; entryPrice: number; leverage: number }>;
  stops: StopOrder[];
  orders: Record<string, Fill>;
  fills: Record<string, TradeFill[]>;
  leverage: Record<string, number>;
  lastStopCheck: Record<string, number>;
  seq: number;
}

export const newPaperState = (wallet: number): PaperState => ({
  wallet, positions: {}, stops: [], orders: {}, fills: {}, leverage: {}, lastStopCheck: {}, seq: 1,
});

export class PaperExchange implements Exchange {
  readonly name = "paper";
  constructor(
    private readonly md: MarketData,
    public state: PaperState,
    private readonly cfg: { takerFee: number; slippage: number },
  ) {}

  getServerTime() { return this.md.getServerTime(); }
  getClosedCandles(symbol: string, interval: string, limit: number) { return this.md.getClosedCandles(symbol, interval, limit); }
  getFilters(symbol: string) { return this.md.getFilters(symbol); }

  async getBalance(): Promise<AccountBalance> {
    let unreal = 0;
    let margin = 0;
    for (const [sym, p] of Object.entries(this.state.positions)) {
      const px = await this.md.getMarkPrice(sym);
      unreal += (p.side === "LONG" ? px - p.entryPrice : p.entryPrice - px) * p.quantity;
      margin += (p.entryPrice * p.quantity) / p.leverage;
    }
    return { equity: this.state.wallet + unreal, available: this.state.wallet - margin + Math.min(0, unreal) };
  }

  async getPosition(symbol: string): Promise<ExchangePosition | null> {
    await this.checkStops(symbol);
    const p = this.state.positions[symbol];
    return p ? { symbol, side: p.side, quantity: p.quantity, entryPrice: p.entryPrice } : null;
  }

  async prepareSymbol(symbol: string, leverage: number): Promise<void> {
    this.state.leverage[symbol] = Math.max(1, Math.floor(leverage));
  }

  async marketOrder(p: { symbol: string; side: "BUY" | "SELL"; quantity: number; reduceOnly: boolean; clientOrderId: string }): Promise<Fill> {
    const prev = this.state.orders[p.clientOrderId];
    if (prev) return prev;
    const f = await this.md.getFilters(p.symbol);
    const mark = await this.md.getMarkPrice(p.symbol);
    const px = p.side === "BUY" ? mark * (1 + this.cfg.slippage) : mark * (1 - this.cfg.slippage);
    let qty = floorToStep(p.quantity, f.stepSize);
    const pos = this.state.positions[p.symbol];
    if (p.reduceOnly) qty = Math.min(qty, pos?.quantity ?? 0);
    const fill: Fill = { orderId: `P${this.state.seq++}`, clientOrderId: p.clientOrderId, status: qty > 0 ? "FILLED" : "REJECTED", executedQty: qty, avgPrice: px };
    if (qty > 0) this.apply(p.symbol, p.side, qty, px, Date.now());
    this.state.orders[p.clientOrderId] = fill;
    return fill;
  }

  async placeStop(p: { symbol: string; side: "BUY" | "SELL"; quantity: number; stopPrice: number; clientId: string }): Promise<StopOrder> {
    const existing = this.state.stops.find((s) => s.clientId === p.clientId);
    if (existing) return existing;
    const mark = await this.md.getMarkPrice(p.symbol);
    // Binance rejects a stop that would trigger immediately (-2021). Mirror that.
    if ((p.side === "SELL" && p.stopPrice >= mark) || (p.side === "BUY" && p.stopPrice <= mark)) {
      throw new Error(`paper: stop ${p.stopPrice} would immediately trigger (mark ${mark})`);
    }
    const s: StopOrder = { id: `S${this.state.seq++}`, clientId: p.clientId, symbol: p.symbol, side: p.side, stopPrice: p.stopPrice, quantity: p.quantity };
    this.state.stops.push(s);
    this.state.lastStopCheck[p.symbol] ??= Date.now();
    return s;
  }

  async cancelStop(_symbol: string, id: string): Promise<void> {
    this.state.stops = this.state.stops.filter((s) => s.id !== id);
  }

  async getOpenStops(symbol: string): Promise<StopOrder[]> {
    await this.checkStops(symbol);
    return this.state.stops.filter((s) => s.symbol === symbol);
  }

  async getFills(symbol: string, sinceMs: number): Promise<TradeFill[]> {
    return (this.state.fills[symbol] ?? []).filter((f) => f.time >= sinceMs);
  }

  /** Trigger stops touched by any 1m candle since the last check. */
  async checkStops(symbol: string): Promise<void> {
    const stops = this.state.stops.filter((s) => s.symbol === symbol);
    if (!stops.length) return;
    const since = this.state.lastStopCheck[symbol] ?? Date.now() - 60_000;
    const bars = await this.md.getKlinesSince(symbol, "1m", since);
    for (const b of bars) {
      for (const s of [...this.state.stops.filter((x) => x.symbol === symbol)]) {
        const hit = s.side === "SELL" ? b.low <= s.stopPrice : b.high >= s.stopPrice;
        if (!hit) continue;
        const raw = s.side === "SELL" ? Math.min(b.open, s.stopPrice) : Math.max(b.open, s.stopPrice);
        const px = s.side === "SELL" ? raw * (1 - this.cfg.slippage) : raw * (1 + this.cfg.slippage);
        const pos = this.state.positions[symbol];
        const qty = Math.min(s.quantity, pos?.quantity ?? 0);
        if (qty > 0) this.apply(symbol, s.side, qty, px, b.openTime);
        this.state.stops = this.state.stops.filter((x) => x.id !== s.id);
      }
      if (!this.state.positions[symbol]) {
        // Reduce-only stops for a flat symbol are cancelled, as on Binance.
        this.state.stops = this.state.stops.filter((x) => x.symbol !== symbol);
      }
    }
    const last = bars.at(-1);
    if (last) this.state.lastStopCheck[symbol] = last.openTime; // re-check the forming bar next time
  }

  private apply(symbol: string, side: "BUY" | "SELL", qty: number, px: number, time: number) {
    const fee = px * qty * this.cfg.takerFee;
    const pos = this.state.positions[symbol];
    let realized = 0;
    const opening = !pos || (pos.side === "LONG") === (side === "BUY");
    if (opening) {
      const lev = this.state.leverage[symbol] ?? 1;
      if (!pos) this.state.positions[symbol] = { side: side === "BUY" ? "LONG" : "SHORT", quantity: qty, entryPrice: px, leverage: lev };
      else {
        const q = pos.quantity + qty;
        pos.entryPrice = (pos.entryPrice * pos.quantity + px * qty) / q;
        pos.quantity = q;
      }
    } else {
      realized = (pos.side === "LONG" ? px - pos.entryPrice : pos.entryPrice - px) * qty;
      pos.quantity = Number((pos.quantity - qty).toFixed(12));
      if (pos.quantity <= 0) delete this.state.positions[symbol];
    }
    this.state.wallet += realized - fee;
    (this.state.fills[symbol] ??= []).push({ time, price: px, qty, side, realizedPnl: realized, commission: fee });
  }
}
