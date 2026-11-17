// Paper exchange: real public market data, simulated account. Fills at mark price
// plus slippage and taker fee. Models Binance USDⓈ-M futures in one-way mode with
// isolated margin. Stops are triggered from 1m candle highs/lows since the last check,
// so a stop touched between engine ticks is not missed.
//
// Isolated liquidation is APPROXIMATED: liquidation price is
//   long:  entry * (1 - 1/leverage + MAINT_MARGIN_RATE)
//   short: entry * (1 + 1/leverage - MAINT_MARGIN_RATE)
// with a flat 0.5% maintenance margin rate (Binance uses tiered brackets and mark
// price; real liquidation can come slightly earlier on large notionals). A liquidated
// position closes at the liquidation price and never loses more than its margin.
import type { Candle } from "../core/types.js";
import { floorToStep } from "../risk/precision.js";
import { closingSide } from "./types.js";
import type { AccountBalance, Exchange, ExchangePosition, Fill, StopOrder, SymbolFilters, TradeFill, FundingPoint } from "./types.js";

export interface MarketData {
  getServerTime(): Promise<number>;
  getClosedCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  getFilters(symbol: string): Promise<SymbolFilters>;
  getMarkPrice(symbol: string): Promise<number>;
  getKlinesSince(symbol: string, interval: string, startTime: number): Promise<Candle[]>;
  getFundingHistory(symbol: string, startTime: number): Promise<FundingPoint[]>;
}

type PaperPosition = { side: "LONG" | "SHORT"; quantity: number; entryPrice: number; leverage: number };

export interface PaperState {
  wallet: number;
  positions: Record<string, PaperPosition>;
  stops: StopOrder[];
  /** Creation time (ms) per stop id. Bars that closed before a stop existed never trigger it. */
  stopCreatedAt: Record<string, number>;
  orders: Record<string, Fill>;
  fills: Record<string, TradeFill[]>;
  leverage: Record<string, number>;
  lastStopCheck: Record<string, number>;
  seq: number;
}

export const MAINT_MARGIN_RATE = 0.005;
const MINUTE = 60_000;
const minuteStart = (t: number) => Math.floor(t / MINUTE) * MINUTE;

export const newPaperState = (wallet: number): PaperState => ({
  wallet, positions: {}, stops: [], stopCreatedAt: {}, orders: {}, fills: {}, leverage: {}, lastStopCheck: {}, seq: 1,
});

export const liquidationPrice = (p: { side: "LONG" | "SHORT"; entryPrice: number; leverage: number }): number =>
  p.side === "LONG"
    ? p.entryPrice * (1 - 1 / p.leverage + MAINT_MARGIN_RATE)
    : p.entryPrice * (1 + 1 / p.leverage - MAINT_MARGIN_RATE);

export class PaperExchange implements Exchange {
  readonly name = "paper";
  constructor(
    private readonly md: MarketData,
    public state: PaperState,
    private readonly cfg: { takerFee: number; slippage: number },
  ) {
    // State saved before stopCreatedAt existed: missing entries mean "no lower bound".
    this.state.stopCreatedAt ??= {};
  }

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
    await this.checkStops(p.symbol);
    const f = await this.md.getFilters(p.symbol);
    const mark = await this.md.getMarkPrice(p.symbol);
    const px = p.side === "BUY" ? mark * (1 + this.cfg.slippage) : mark * (1 - this.cfg.slippage);
    let qty = floorToStep(p.quantity, f.marketStepSize);
    const pos = this.state.positions[p.symbol];
    const closing = !!pos && closingSide(pos.side) === p.side;
    if (p.reduceOnly) qty = closing ? Math.min(qty, pos.quantity) : 0;
    const reject = (): Fill => ({ orderId: `P${this.state.seq++}`, clientOrderId: p.clientOrderId, status: "REJECTED", executedQty: 0, avgPrice: px });
    // REJECTED fills are not cached: a retry with the same client id may succeed later.
    if (!(qty > 0) || qty > f.marketMaxQty) return reject();

    const closeQty = closing ? Math.min(qty, pos.quantity) : 0;
    const openQty = Number((qty - closeQty).toFixed(12));
    if (openQty > 0) {
      // Binance -2019 "Margin is insufficient": the opening part needs initial margin + fees.
      const lev = this.state.leverage[p.symbol] ?? 1;
      let available = (await this.getBalance()).available;
      if (closeQty > 0 && pos) {
        const pnl = (pos.side === "LONG" ? px - pos.entryPrice : pos.entryPrice - px) * closeQty;
        available += (pos.entryPrice * closeQty) / pos.leverage + pnl;
      }
      const required = (px * openQty) / lev + px * qty * this.cfg.takerFee;
      if (required > available) return reject();
    }

    const fill: Fill = { orderId: `P${this.state.seq++}`, clientOrderId: p.clientOrderId, status: "FILLED", executedQty: qty, avgPrice: px };
    this.apply(p.symbol, p.side, qty, px, Date.now());
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
    const now = Date.now();
    const s: StopOrder = { id: `S${this.state.seq++}`, clientId: p.clientId, symbol: p.symbol, side: p.side, stopPrice: p.stopPrice, quantity: p.quantity };
    this.state.stops.push(s);
    this.state.stopCreatedAt[s.id] = now;
    this.state.lastStopCheck[p.symbol] ??= minuteStart(now);
    return s;
  }

  async cancelStop(_symbol: string, id: string): Promise<void> {
    this.removeStops((s) => s.id === id);
  }

  async getOpenStops(symbol: string): Promise<StopOrder[]> {
    await this.checkStops(symbol);
    return this.state.stops.filter((s) => s.symbol === symbol);
  }

  getFundingHistory(symbol: string, startTime: number): Promise<FundingPoint[]> {
    return this.md.getFundingHistory(symbol, startTime);
  }

  async getFills(symbol: string, sinceMs: number): Promise<TradeFill[]> {
    return (this.state.fills[symbol] ?? []).filter((f) => f.time >= sinceMs);
  }

  /**
   * Replay 1m candles since the last check: trigger stops (reduce-only) and the
   * approximate isolated liquidation, whichever price level is reached first.
   */
  async checkStops(symbol: string): Promise<void> {
    this.dropInvalidStops(symbol);
    if (!this.state.positions[symbol]) {
      // Nothing to protect: start fresh so a later stop never replays old bars.
      this.state.lastStopCheck[symbol] = minuteStart(Date.now());
      return;
    }
    const since = this.state.lastStopCheck[symbol] ?? Date.now() - MINUTE;
    const bars = await this.md.getKlinesSince(symbol, "1m", since);
    for (const b of bars) {
      const pos = this.state.positions[symbol];
      if (!pos) break;
      const long = pos.side === "LONG";
      const liq = liquidationPrice(pos);
      const liqHit = long ? b.low <= liq : b.high >= liq;
      // Stops in trigger order: the one nearest the open is reached first.
      const live = this.state.stops
        .filter((s) => s.symbol === symbol && b.closeTime >= (this.state.stopCreatedAt[s.id] ?? 0))
        .filter((s) => (s.side === "SELL" ? b.low <= s.stopPrice : b.high >= s.stopPrice))
        .sort((a, c) => (long ? c.stopPrice - a.stopPrice : a.stopPrice - c.stopPrice));
      for (const s of live) {
        const cur = this.state.positions[symbol];
        if (!cur) break;
        // Liquidation first if the bar gaps through it or it lies before this stop.
        const gapLiq = long ? b.open <= liq : b.open >= liq;
        const liqBefore = long ? liq > s.stopPrice : liq < s.stopPrice;
        if (liqHit && (gapLiq || liqBefore)) break;
        const raw = s.side === "SELL" ? Math.min(b.open, s.stopPrice) : Math.max(b.open, s.stopPrice);
        const px = s.side === "SELL" ? raw * (1 - this.cfg.slippage) : raw * (1 + this.cfg.slippage);
        this.removeStops((x) => x.id === s.id);
        const qty = Math.min(s.quantity, cur.quantity);
        if (qty > 0) this.apply(symbol, s.side, qty, px, b.openTime);
      }
      if (liqHit && this.state.positions[symbol]) this.liquidate(symbol, b.openTime);
    }
    const last = bars.at(-1);
    if (last) this.state.lastStopCheck[symbol] = last.openTime; // re-check the forming bar next time
    if (!this.state.positions[symbol]) this.state.lastStopCheck[symbol] = minuteStart(Date.now());
  }

  /** Stops are reduce-only: cancel those that cannot close the current position. */
  private dropInvalidStops(symbol: string) {
    const pos = this.state.positions[symbol];
    const keep = pos ? closingSide(pos.side) : null;
    this.removeStops((s) => s.symbol === symbol && s.side !== keep);
  }

  private removeStops(pred: (s: StopOrder) => boolean) {
    for (const s of this.state.stops) if (pred(s)) delete this.state.stopCreatedAt[s.id];
    this.state.stops = this.state.stops.filter((s) => !pred(s));
  }

  private liquidate(symbol: string, time: number) {
    const pos = this.state.positions[symbol]!;
    const px = liquidationPrice(pos);
    const margin = (pos.entryPrice * pos.quantity) / pos.leverage;
    const realized = Math.max(-margin, (pos.side === "LONG" ? px - pos.entryPrice : pos.entryPrice - px) * pos.quantity);
    // Fee (clearance) is capped so the total loss never exceeds the isolated margin.
    const fee = Math.max(0, Math.min(px * pos.quantity * this.cfg.takerFee, margin + realized));
    const side = closingSide(pos.side);
    delete this.state.positions[symbol];
    this.removeStops((s) => s.symbol === symbol);
    this.state.wallet += realized - fee;
    (this.state.fills[symbol] ??= []).push({ time, price: px, qty: pos.quantity, side, realizedPnl: realized, commission: fee });
  }

  /** Execute a fill. An opposite-side qty above the position closes it, then opens the rest. */
  private apply(symbol: string, side: "BUY" | "SELL", qty: number, px: number, time: number) {
    const pos = this.state.positions[symbol];
    const opening = !pos || (pos.side === "LONG") === (side === "BUY");
    if (!opening) {
      const closeQty = Math.min(qty, pos.quantity);
      const realized = (pos.side === "LONG" ? px - pos.entryPrice : pos.entryPrice - px) * closeQty;
      this.book(symbol, side, closeQty, px, time, realized);
      pos.quantity = Number((pos.quantity - closeQty).toFixed(12));
      if (pos.quantity <= 0) {
        delete this.state.positions[symbol];
        this.removeStops((s) => s.symbol === symbol);
      }
      qty = Number((qty - closeQty).toFixed(12));
      if (qty <= 0) return;
    }
    const cur = this.state.positions[symbol];
    if (!cur) {
      const lev = this.state.leverage[symbol] ?? 1;
      this.state.positions[symbol] = { side: side === "BUY" ? "LONG" : "SHORT", quantity: qty, entryPrice: px, leverage: lev };
      this.state.lastStopCheck[symbol] = minuteStart(time);
    } else {
      const q = cur.quantity + qty;
      cur.entryPrice = (cur.entryPrice * cur.quantity + px * qty) / q;
      cur.quantity = q;
    }
    this.book(symbol, side, qty, px, time, 0);
  }

  private book(symbol: string, side: "BUY" | "SELL", qty: number, px: number, time: number, realized: number) {
    const fee = px * qty * this.cfg.takerFee;
    this.state.wallet += realized - fee;
    (this.state.fills[symbol] ??= []).push({ time, price: px, qty, side, realizedPnl: realized, commission: fee });
  }
}
