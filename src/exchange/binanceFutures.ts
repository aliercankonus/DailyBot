// Binance USDⓈ-M futures REST client implementing Exchange.
// Assumes one-way position mode and isolated margin (prepareSymbol sets margin type).
//
// VERIFY ON TESTNET BEFORE LIVE: Binance announced moving conditional orders
// (STOP_MARKET etc.) from /fapi/v1/order to a separate Algo Order API. Both paths are
// implemented; pick with stopOrderApi ("algo" | "legacy"). The algo endpoint names below
// follow that announcement and were NOT verifiable from the build environment.
import { createHmac } from "node:crypto";
import type { Candle } from "../core/types.js";
import { ceilToStep, floorToStep, fmt } from "../risk/precision.js";
import type { AccountBalance, Exchange, ExchangePosition, Fill, StopOrder, SymbolFilters, TradeFill } from "./types.js";

export interface BinanceFuturesOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  stopOrderApi: "algo" | "legacy";
  recvWindow?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class BinanceApiError extends Error {
  constructor(public readonly status: number, public readonly code: number | undefined, message: string, public readonly path: string) {
    super(`Binance ${path} ${status}${code !== undefined ? ` code=${code}` : ""}: ${message}`);
  }
}

type Params = Record<string, string | number | boolean | undefined>;

export class BinanceFutures implements Exchange {
  readonly name = "binance-usdm";
  private timeOffset = 0;
  private filtersCache = new Map<string, SymbolFilters>();
  private readonly f: typeof fetch;

  constructor(private readonly o: BinanceFuturesOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  // ---------- transport ----------

  private qs(p: Params): string {
    return Object.entries(p)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
  }

  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, params: Params = {}, signed = false): Promise<T> {
    let query = this.qs(params);
    if (signed) {
      const ts = Date.now() + this.timeOffset;
      query = this.qs({ ...params, recvWindow: this.o.recvWindow ?? 5000, timestamp: ts });
      const sig = createHmac("sha256", this.o.apiSecret).update(query).digest("hex");
      query += `&signature=${sig}`;
    }
    const url = `${this.o.baseUrl}${path}${query ? `?${query}` : ""}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 10_000);
    try {
      const res = await this.f(url, { method, headers: signed ? { "X-MBX-APIKEY": this.o.apiKey } : {}, signal: ctrl.signal });
      const text = await res.text();
      let body: any;
      try { body = text ? JSON.parse(text) : {}; } catch { body = { msg: text }; }
      if (!res.ok || (body && typeof body.code === "number" && body.code < 0)) {
        throw new BinanceApiError(res.status, body?.code, body?.msg ?? text, path);
      }
      return body as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async syncTime(): Promise<void> {
    const t0 = Date.now();
    const server = await this.getServerTime();
    this.timeOffset = server - Math.round((t0 + Date.now()) / 2);
  }

  // ---------- market data ----------

  async getServerTime(): Promise<number> {
    const r = await this.request<{ serverTime: number }>("GET", "/fapi/v1/time");
    return r.serverTime;
  }

  /** Returns only candles whose close time is before server time. */
  async getClosedCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const [rows, now] = await Promise.all([
      this.request<any[][]>("GET", "/fapi/v1/klines", { symbol, interval, limit: Math.min(limit + 1, 1500) }),
      this.getServerTime(),
    ]);
    return rows.map(parseKline).filter((c) => c.closeTime < now).slice(-limit);
  }

  async getMarkPrice(symbol: string): Promise<number> {
    const r = await this.request<{ markPrice: string }>("GET", "/fapi/v1/premiumIndex", { symbol });
    return Number(r.markPrice);
  }

  /** Raw klines including the forming candle (used by the paper simulator for intrabar stops). */
  async getKlinesSince(symbol: string, interval: string, startTime: number): Promise<Candle[]> {
    const rows = await this.request<any[][]>("GET", "/fapi/v1/klines", { symbol, interval, startTime, limit: 1500 });
    return rows.map(parseKline);
  }

  async getFilters(symbol: string): Promise<SymbolFilters> {
    const hit = this.filtersCache.get(symbol);
    if (hit) return hit;
    const info = await this.request<{ symbols: any[] }>("GET", "/fapi/v1/exchangeInfo");
    for (const s of info.symbols) {
      const get = (t: string) => s.filters.find((x: any) => x.filterType === t) ?? {};
      const lot = get("MARKET_LOT_SIZE").stepSize ? get("MARKET_LOT_SIZE") : get("LOT_SIZE");
      this.filtersCache.set(s.symbol, {
        symbol: s.symbol,
        tickSize: Number(get("PRICE_FILTER").tickSize),
        stepSize: Number(lot.stepSize),
        minQty: Number(lot.minQty),
        maxQty: Number(lot.maxQty),
        minNotional: Number(get("MIN_NOTIONAL").notional ?? 5),
      });
    }
    const f = this.filtersCache.get(symbol);
    if (!f) throw new Error(`Unknown symbol ${symbol}`);
    return f;
  }

  // ---------- account ----------

  async getBalance(): Promise<AccountBalance> {
    const a = await this.request<any>("GET", "/fapi/v2/account", {}, true);
    return { equity: Number(a.totalMarginBalance), available: Number(a.availableBalance) };
  }

  async getPosition(symbol: string): Promise<ExchangePosition | null> {
    const rows = await this.request<any[]>("GET", "/fapi/v2/positionRisk", { symbol }, true);
    const r = rows.find((x) => x.symbol === symbol && Number(x.positionAmt) !== 0);
    if (!r) return null;
    const amt = Number(r.positionAmt);
    return { symbol, side: amt > 0 ? "LONG" : "SHORT", quantity: Math.abs(amt), entryPrice: Number(r.entryPrice) };
  }

  async prepareSymbol(symbol: string, leverage: number): Promise<void> {
    try {
      await this.request("POST", "/fapi/v1/marginType", { symbol, marginType: "ISOLATED" }, true);
    } catch (e) {
      // -4046: "No need to change margin type." Anything else is a real error.
      if (!(e instanceof BinanceApiError && e.code === -4046)) throw e;
    }
    await this.request("POST", "/fapi/v1/leverage", { symbol, leverage: Math.max(1, Math.floor(leverage)) }, true);
  }

  // ---------- orders ----------

  async marketOrder(p: { symbol: string; side: "BUY" | "SELL"; quantity: number; reduceOnly: boolean; clientOrderId: string }): Promise<Fill> {
    const existing = await this.findOrder(p.symbol, p.clientOrderId);
    if (existing) return existing;
    const f = await this.getFilters(p.symbol);
    try {
      const r = await this.request<any>("POST", "/fapi/v1/order", {
        symbol: p.symbol, side: p.side, type: "MARKET",
        quantity: fmt(floorToStep(p.quantity, f.stepSize), f.stepSize),
        reduceOnly: p.reduceOnly ? "true" : undefined,
        newClientOrderId: p.clientOrderId, newOrderRespType: "RESULT",
      }, true);
      return toFill(r);
    } catch (e) {
      // Timeout or 5xx: the order may still have been accepted. Look it up before giving up.
      const again = await this.findOrder(p.symbol, p.clientOrderId).catch(() => null);
      if (again) return again;
      throw e;
    }
  }

  private async findOrder(symbol: string, clientOrderId: string): Promise<Fill | null> {
    try {
      const r = await this.request<any>("GET", "/fapi/v1/order", { symbol, origClientOrderId: clientOrderId }, true);
      return toFill(r);
    } catch (e) {
      if (e instanceof BinanceApiError && e.code === -2013) return null; // Order does not exist.
      throw e;
    }
  }

  async placeStop(p: { symbol: string; side: "BUY" | "SELL"; quantity: number; stopPrice: number; clientId: string }): Promise<StopOrder> {
    const f = await this.getFilters(p.symbol);
    // A SELL stop protects a long: round down (further from price). A BUY stop protects a short: round up.
    const price = p.side === "SELL" ? floorToStep(p.stopPrice, f.tickSize) : ceilToStep(p.stopPrice, f.tickSize);
    const qty = fmt(floorToStep(p.quantity, f.stepSize), f.stepSize);
    if (this.o.stopOrderApi === "algo") {
      const r = await this.request<any>("POST", "/fapi/v1/algoOrder", {
        algoType: "CONDITIONAL", symbol: p.symbol, side: p.side, type: "STOP_MARKET",
        quantity: qty, triggerPrice: fmt(price, f.tickSize), reduceOnly: "true",
        workingType: "MARK_PRICE", priceProtect: "true", clientAlgoId: p.clientId,
      }, true);
      return { id: String(r.algoId), clientId: p.clientId, symbol: p.symbol, side: p.side, stopPrice: price, quantity: Number(qty) };
    }
    const r = await this.request<any>("POST", "/fapi/v1/order", {
      symbol: p.symbol, side: p.side, type: "STOP_MARKET", quantity: qty,
      stopPrice: fmt(price, f.tickSize), reduceOnly: "true", workingType: "MARK_PRICE",
      priceProtect: "TRUE", newClientOrderId: p.clientId,
    }, true);
    return { id: String(r.orderId), clientId: p.clientId, symbol: p.symbol, side: p.side, stopPrice: price, quantity: Number(qty) };
  }

  async cancelStop(symbol: string, id: string): Promise<void> {
    if (this.o.stopOrderApi === "algo") await this.request("DELETE", "/fapi/v1/algoOrder", { symbol, algoId: id }, true);
    else await this.request("DELETE", "/fapi/v1/order", { symbol, orderId: id }, true);
  }

  async getOpenStops(symbol: string): Promise<StopOrder[]> {
    if (this.o.stopOrderApi === "algo") {
      const r = await this.request<any>("GET", "/fapi/v1/openAlgoOrders", { symbol }, true);
      const rows: any[] = Array.isArray(r) ? r : (r.orders ?? []);
      return rows.map((x) => ({
        id: String(x.algoId), clientId: String(x.clientAlgoId ?? ""), symbol, side: x.side,
        stopPrice: Number(x.triggerPrice), quantity: Number(x.quantity),
      }));
    }
    const rows = await this.request<any[]>("GET", "/fapi/v1/openOrders", { symbol }, true);
    return rows
      .filter((x) => x.type === "STOP_MARKET")
      .map((x) => ({ id: String(x.orderId), clientId: x.clientOrderId, symbol, side: x.side, stopPrice: Number(x.stopPrice), quantity: Number(x.origQty) }));
  }

  async getFills(symbol: string, sinceMs: number): Promise<TradeFill[]> {
    const rows = await this.request<any[]>("GET", "/fapi/v1/userTrades", { symbol, startTime: sinceMs, limit: 1000 }, true);
    return rows.map((x) => ({
      time: Number(x.time), price: Number(x.price), qty: Number(x.qty), side: x.side,
      realizedPnl: Number(x.realizedPnl), commission: Number(x.commission),
    }));
  }
}

export function parseKline(r: any[]): Candle {
  return {
    openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]),
    close: Number(r[4]), volume: Number(r[5]), closeTime: Number(r[6]),
  };
}

function toFill(r: any): Fill {
  const executedQty = Number(r.executedQty ?? 0);
  const avg = Number(r.avgPrice ?? 0);
  const cum = Number(r.cumQuote ?? 0);
  return {
    orderId: String(r.orderId), clientOrderId: r.clientOrderId, status: r.status,
    executedQty, avgPrice: avg > 0 ? avg : executedQty > 0 ? cum / executedQty : 0,
  };
}
