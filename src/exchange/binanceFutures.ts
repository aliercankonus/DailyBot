// Binance USDⓈ-M futures REST client implementing Exchange.
// Assumes one-way position mode and isolated margin (prepareSymbol sets margin type).
//
// VERIFY ON TESTNET BEFORE LIVE: Binance announced moving conditional orders
// (STOP_MARKET etc.) from /fapi/v1/order to a separate Algo Order API. Both paths are
// implemented; pick with stopOrderApi ("algo" | "legacy" | "auto"). The algo endpoint names
// below follow that announcement and were NOT verifiable from the build environment; "auto"
// tries algo and falls back to legacy when the algo endpoint is unsupported.
import { createHmac } from "node:crypto";
import type { Candle } from "../core/types.js";
import { ceilToStep, floorToStep, fmt } from "../risk/precision.js";
import type { AccountBalance, Exchange, ExchangePosition, Fill, StopOrder, SymbolFilters, TradeFill, FundingPoint } from "./types.js";

export type StopOrderApi = "algo" | "legacy";

export interface BinanceFuturesOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  /** "auto": try the algo API first, fall back to legacy when it is unsupported, remember the result. */
  stopOrderApi: StopOrderApi | "auto";
  recvWindow?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injectable for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class BinanceApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number | undefined,
    message: string,
    public readonly path: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`Binance ${path} ${status}${code !== undefined ? ` code=${code}` : ""}: ${message}`);
    this.name = "BinanceApiError";
  }
}

type Params = Record<string, string | number | boolean | undefined>;
type Method = "GET" | "POST" | "DELETE";

const TIME_RESYNC_MS = 3600_000;
const GET_MAX_RETRIES = 2;
const RETRY_AFTER_CAP_MS = 10_000;
const MAX_KLINES = 1499; // +1 is requested to make room for the forming candle (Binance max 1500).
const FILLS_PAGE = 1000;
const FILLS_MAX_PAGES = 100;

/** Algo endpoint not available on this account/environment: fall back to legacy. */
function algoUnsupported(e: unknown): boolean {
  if (!(e instanceof BinanceApiError)) return false;
  if (e.status === 404) return true;
  // -1116 INVALID_ORDER_TYPE; message checks cover "not supported"/"unsupported" variants.
  return e.code === -1116 || /not supported|unsupported|invalid endpoint/i.test(e.message);
}

/** Legacy /fapi/v1/order refuses conditional orders: they must go through the algo service. */
function legacyRequiresAlgo(e: unknown): boolean {
  if (!(e instanceof BinanceApiError)) return false;
  // -4120: "Order type not supported for this endpoint. Please use the Algo Order API endpoints instead."
  return e.code === -4120 || /algo/i.test(e.message);
}

const LIVE_STATUSES = new Set(["FILLED", "PARTIALLY_FILLED", "NEW"]);

export class BinanceFutures implements Exchange {
  readonly name = "binance-usdm";
  private timeOffset = 0;
  private lastSync = 0;
  private filtersCache = new Map<string, SymbolFilters>();
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private stopApi: StopOrderApi | undefined;

  constructor(private readonly o: BinanceFuturesOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.sleep = o.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.stopApi = o.stopOrderApi === "auto" ? undefined : o.stopOrderApi;
  }

  /** Stop API in use: "algo"/"legacy", or "unresolved" while "auto" has not decided yet. */
  resolvedStopApi(): StopOrderApi | "unresolved" {
    return this.stopApi ?? "unresolved";
  }

  // ---------- transport ----------

  private qs(p: Params): string {
    return Object.entries(p)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
  }

  /**
   * Signed calls resync the clock when the last sync is over 1h old and retry once on -1021.
   * GET retries up to 2 times on 5xx/429 (honouring Retry-After). POST/DELETE are never
   * auto-retried except on -1021 (request rejected before processing); callers own idempotency.
   */
  private async request<T>(method: Method, path: string, params: Params = {}, signed = false): Promise<T> {
    if (signed && Date.now() - this.lastSync > TIME_RESYNC_MS) await this.syncTime();
    let resynced = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send<T>(method, path, params, signed);
      } catch (e) {
        if (!(e instanceof BinanceApiError)) throw e;
        if (signed && e.code === -1021 && !resynced) {
          resynced = true;
          await this.syncTime();
          attempt--; // the resync retry does not consume a 5xx/429 retry
          continue;
        }
        const retryable = method === "GET" && (e.status === 429 || e.status >= 500) && attempt < GET_MAX_RETRIES;
        if (!retryable) throw e; // 418 (IP ban) lands here: never retried.
        await this.sleep(Math.min(e.retryAfterMs ?? 500 * 2 ** attempt, RETRY_AFTER_CAP_MS));
      }
    }
  }

  private async send<T>(method: Method, path: string, params: Params, signed: boolean): Promise<T> {
    let query = this.qs(params);
    if (signed) {
      const ts = Date.now() + this.timeOffset;
      query = this.qs({ ...params, recvWindow: this.o.recvWindow ?? 5000, timestamp: ts });
      const sig = createHmac("sha256", this.o.apiSecret).update(query).digest("hex");
      query += `&signature=${sig}`;
    }
    const url = `${this.o.baseUrl}${path}${query ? `?${query}` : ""}`;
    const ctrl = new AbortController();
    const timeoutMs = this.o.timeoutMs ?? 10_000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let res: Response;
      let text: string;
      try {
        res = await this.f(url, { method, headers: signed ? { "X-MBX-APIKEY": this.o.apiKey } : {}, signal: ctrl.signal });
        text = await res.text();
      } catch (e) {
        if (ctrl.signal.aborted) throw new BinanceApiError(0, undefined, `timeout after ${timeoutMs}ms`, path);
        throw e;
      }
      let body: any;
      try { body = text ? JSON.parse(text) : {}; } catch { body = { msg: text }; }
      if (!res.ok || (body && typeof body.code === "number" && body.code < 0)) {
        const ra = Number(res.headers?.get?.("retry-after"));
        const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined;
        throw new BinanceApiError(res.status, body?.code, body?.msg ?? text, path, retryAfterMs);
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
    this.lastSync = Date.now();
  }

  // ---------- market data ----------

  async getServerTime(): Promise<number> {
    const r = await this.request<{ serverTime: number }>("GET", "/fapi/v1/time");
    return r.serverTime;
  }

  /** Returns only candles whose close time is before server time. */
  async getClosedCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    if (limit > MAX_KLINES) throw new Error(`getClosedCandles: limit ${limit} > ${MAX_KLINES}`);
    const [rows, now] = await Promise.all([
      this.request<any[][]>("GET", "/fapi/v1/klines", { symbol, interval, limit: limit + 1 }),
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
      const get = (t: string): any => (s.filters ?? []).find((x: any) => x.filterType === t);
      const price = get("PRICE_FILTER");
      const lot = get("LOT_SIZE");
      if (!price?.tickSize || !lot?.stepSize) {
        // Only fatal for the symbol asked for; a malformed unrelated symbol must not break others.
        if (s.symbol === symbol) throw new Error(`${symbol}: exchangeInfo missing ${!price?.tickSize ? "PRICE_FILTER" : "LOT_SIZE"}`);
        continue;
      }
      const mkt = get("MARKET_LOT_SIZE");
      const mStep = Number(mkt?.stepSize);
      const mMax = Number(mkt?.maxQty);
      this.filtersCache.set(s.symbol, {
        symbol: s.symbol,
        tickSize: Number(price.tickSize),
        stepSize: Number(lot.stepSize),
        minQty: Number(lot.minQty),
        maxQty: Number(lot.maxQty),
        marketStepSize: mStep > 0 ? mStep : Number(lot.stepSize),
        marketMaxQty: mMax > 0 ? mMax : Number(lot.maxQty),
        minNotional: Number(get("MIN_NOTIONAL")?.notional ?? 5),
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
    if (existing) {
      if (LIVE_STATUSES.has(existing.status)) return existing;
      throw new BinanceApiError(0, undefined,
        `CLIENT_ID_SPENT: order ${p.clientOrderId} already exists with status ${existing.status} (executedQty=${existing.executedQty})`,
        "/fapi/v1/order");
    }
    const f = await this.getFilters(p.symbol);
    try {
      const r = await this.request<any>("POST", "/fapi/v1/order", {
        symbol: p.symbol, side: p.side, type: "MARKET",
        quantity: fmt(floorToStep(p.quantity, f.marketStepSize), f.marketStepSize),
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
    const args = { ...p, price, qty, tickSize: f.tickSize };
    try {
      if (this.stopApi === "algo") return await this.placeAlgoStop(args);
      if (this.stopApi === "legacy") {
        try {
          return await this.placeLegacyStop(args);
        } catch (e) {
          if (this.o.stopOrderApi !== "auto" || !legacyRequiresAlgo(e)) throw e;
          this.stopApi = "algo";
          return await this.placeAlgoStop(args);
        }
      }
      // auto, unresolved: algo first.
      try {
        const r = await this.placeAlgoStop(args);
        this.stopApi = "algo";
        return r;
      } catch (e) {
        if (!algoUnsupported(e)) throw e;
        this.stopApi = "legacy";
        return await this.placeLegacyStop(args);
      }
    } catch (e) {
      // The stop may have been accepted despite the error (timeout, 5xx). Never place a second one.
      const open = await this.getOpenStops(p.symbol).catch(() => null);
      const found = open?.find((s) => s.clientId === p.clientId);
      if (found) return found;
      throw e;
    }
  }

  private async placeAlgoStop(a: { symbol: string; side: "BUY" | "SELL"; clientId: string; price: number; qty: string; tickSize: number }): Promise<StopOrder> {
    const r = await this.request<any>("POST", "/fapi/v1/algoOrder", {
      algoType: "CONDITIONAL", symbol: a.symbol, side: a.side, type: "STOP_MARKET",
      quantity: a.qty, triggerPrice: fmt(a.price, a.tickSize), reduceOnly: "true",
      workingType: "MARK_PRICE", priceProtect: "true", clientAlgoId: a.clientId,
    }, true);
    if (r?.algoId === undefined || r?.algoId === null || r?.algoId === "") {
      throw new BinanceApiError(200, undefined, `algo order response has no algoId: ${JSON.stringify(r)}`, "/fapi/v1/algoOrder");
    }
    return { id: String(r.algoId), clientId: a.clientId, symbol: a.symbol, side: a.side, stopPrice: a.price, quantity: Number(a.qty) };
  }

  private async placeLegacyStop(a: { symbol: string; side: "BUY" | "SELL"; clientId: string; price: number; qty: string; tickSize: number }): Promise<StopOrder> {
    const r = await this.request<any>("POST", "/fapi/v1/order", {
      symbol: a.symbol, side: a.side, type: "STOP_MARKET", quantity: a.qty,
      stopPrice: fmt(a.price, a.tickSize), reduceOnly: "true", workingType: "MARK_PRICE",
      priceProtect: "TRUE", newClientOrderId: a.clientId,
    }, true);
    return { id: String(r.orderId), clientId: a.clientId, symbol: a.symbol, side: a.side, stopPrice: a.price, quantity: Number(a.qty) };
  }

  async cancelStop(symbol: string, id: string): Promise<void> {
    let api = this.stopApi;
    if (!api) {
      // auto, unresolved: find out which service holds this id.
      const tagged = await this.openStopsTagged(symbol);
      api = tagged.find((t) => t.stop.id === id)?.api ?? "legacy";
    }
    if (api === "algo") await this.request("DELETE", "/fapi/v1/algoOrder", { symbol, algoId: id }, true);
    else await this.request("DELETE", "/fapi/v1/order", { symbol, orderId: id }, true);
  }

  async getOpenStops(symbol: string): Promise<StopOrder[]> {
    return (await this.openStopsTagged(symbol)).map((t) => t.stop);
  }

  private async openStopsTagged(symbol: string): Promise<{ api: StopOrderApi; stop: StopOrder }[]> {
    if (this.stopApi === "algo") return (await this.openAlgoStops(symbol)).map((stop) => ({ api: "algo", stop }));
    if (this.stopApi === "legacy") return (await this.openLegacyStops(symbol)).map((stop) => ({ api: "legacy", stop }));
    const [algo, legacy] = await Promise.all([
      this.openAlgoStops(symbol).catch((e) => {
        if (e instanceof BinanceApiError && e.status === 404) return [] as StopOrder[];
        throw e;
      }),
      this.openLegacyStops(symbol),
    ]);
    return [...algo.map((stop) => ({ api: "algo" as const, stop })), ...legacy.map((stop) => ({ api: "legacy" as const, stop }))];
  }

  private async openAlgoStops(symbol: string): Promise<StopOrder[]> {
    const r = await this.request<any>("GET", "/fapi/v1/openAlgoOrders", { symbol }, true);
    const rows: any[] = Array.isArray(r) ? r : (r.orders ?? []);
    return rows.map((x) => ({
      id: String(x.algoId), clientId: String(x.clientAlgoId ?? ""), symbol, side: x.side,
      stopPrice: Number(x.triggerPrice), quantity: Number(x.quantity),
    }));
  }

  private async openLegacyStops(symbol: string): Promise<StopOrder[]> {
    const rows = await this.request<any[]>("GET", "/fapi/v1/openOrders", { symbol }, true);
    return rows
      .filter((x) => x.type === "STOP_MARKET")
      .map((x) => ({ id: String(x.orderId), clientId: x.clientOrderId, symbol, side: x.side, stopPrice: Number(x.stopPrice), quantity: Number(x.origQty) }));
  }

  /**
   * Paginates: first page by startTime, then by fromId (Binance forbids combining them)
   * until a page has fewer than 1000 rows.
   *
   * LIMITATIONS: commission is counted only when commissionAsset is USDT (or absent);
   * commission paid in another asset (e.g. BNB fee discount) is ignored because TradeFill
   * has no asset field, so net PnL is overstated by that fee. Binance may cap a
   * startTime-only query to a 7-day window; callers should not ask for older history.
   */
  async getFundingHistory(symbol: string, startTime: number): Promise<FundingPoint[]> {
    const out: FundingPoint[] = [];
    let cursor = startTime;
    for (let page = 0; page < 50; page++) {
      const rows = await this.request<any[]>("GET", "/fapi/v1/fundingRate", { symbol, startTime: cursor, limit: 1000 });
      for (const r of rows) out.push({ time: Number(r.fundingTime), rate: Number(r.fundingRate) });
      if (rows.length < 1000) break;
      cursor = out.at(-1)!.time + 1;
    }
    return out;
  }

  async getFills(symbol: string, sinceMs: number): Promise<TradeFill[]> {
    const out: TradeFill[] = [];
    let page = await this.request<any[]>("GET", "/fapi/v1/userTrades", { symbol, startTime: sinceMs, limit: FILLS_PAGE }, true);
    for (let i = 0; ; i++) {
      for (const x of page) {
        const asset = x.commissionAsset;
        out.push({
          time: Number(x.time), price: Number(x.price), qty: Number(x.qty), side: x.side,
          realizedPnl: Number(x.realizedPnl),
          commission: asset === undefined || asset === "USDT" ? Number(x.commission) : 0,
        });
      }
      if (page.length < FILLS_PAGE) break;
      if (i + 1 >= FILLS_MAX_PAGES) throw new Error(`getFills ${symbol}: more than ${FILLS_MAX_PAGES} pages`);
      const lastId = Number(page[page.length - 1].id);
      page = await this.request<any[]>("GET", "/fapi/v1/userTrades", { symbol, fromId: lastId + 1, limit: FILLS_PAGE }, true);
    }
    return out;
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
