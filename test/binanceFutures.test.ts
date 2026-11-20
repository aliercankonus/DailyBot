import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BinanceApiError, BinanceFutures, type BinanceFuturesOptions } from "../src/exchange/binanceFutures.js";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; hang?: boolean };
type Handler = (req: { method: string; path: string; params: URLSearchParams; headers: Record<string, string> }) => Reply;
interface Call { method: string; path: string; params: URLSearchParams; headers: Record<string, string>; query: string }

const SERVER_TIME = 1_700_000_000_000;

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call = { method: init.method ?? "GET", path: u.pathname, params: u.searchParams, headers, query: u.search.slice(1) };
    calls.push(call);
    const r = call.path === "/fapi/v1/time" && !handler.length ? { body: { serverTime: SERVER_TIME } } : handler(call);
    if (r.hang) {
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Routes "METHOD /path" to replies; /fapi/v1/time answered by default. Queues allow scripted sequences. */
function router(routes: Record<string, Reply | Reply[] | Handler>) {
  const queues = new Map<string, Reply[]>();
  const h: Handler = (req) => {
    const key = `${req.method} ${req.path}`;
    const r = routes[key];
    if (typeof r === "function") return r(req);
    if (Array.isArray(r)) {
      if (!queues.has(key)) queues.set(key, [...r]);
      const q = queues.get(key)!;
      return q.length > 1 ? q.shift()! : q[0]!;
    }
    if (r) return r;
    if (key === "GET /fapi/v1/time") return { body: { serverTime: SERVER_TIME } };
    return { status: 404, body: { code: -5000, msg: `no route ${key}` } };
  };
  return fakeFetch(h);
}

const sleeps: number[] = [];
function client(fetchImpl: typeof fetch, o: Partial<BinanceFuturesOptions> = {}) {
  sleeps.length = 0;
  return new BinanceFutures({
    apiKey: "KEY", apiSecret: "SECRET", baseUrl: "https://fapi.test", stopOrderApi: "legacy",
    fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); }, ...o,
  });
}

const EXCHANGE_INFO = {
  symbols: [
    {
      symbol: "BTCUSDT",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.10" },
        { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
        { filterType: "MARKET_LOT_SIZE", stepSize: "0.01", minQty: "0.01", maxQty: "120" },
        { filterType: "MIN_NOTIONAL", notional: "100" },
      ],
    },
    {
      symbol: "ETHUSDT",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.01" },
        { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "10000" },
      ],
    },
    { symbol: "BADUSDT", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.01" }] },
  ],
};
const INFO_ROUTE = { "GET /fapi/v1/exchangeInfo": { body: EXCHANGE_INFO } };
const notFound = { status: 400, body: { code: -2013, msg: "Order does not exist." } };
const order = (status: string, extra: object = {}) => ({ body: { orderId: 7, clientOrderId: "cid", status, executedQty: "0.01", avgPrice: "50000", ...extra } });

describe("transport", () => {
  it("signs the query with HMAC-SHA256 and sends X-MBX-APIKEY only on signed calls", async () => {
    const { impl, calls } = router({ "GET /fapi/v2/account": { body: { totalMarginBalance: "100", availableBalance: "80" } } });
    const ex = client(impl);
    expect(await ex.getBalance()).toEqual({ equity: 100, available: 80 });
    const time = calls.find((c) => c.path === "/fapi/v1/time")!;
    const acct = calls.find((c) => c.path === "/fapi/v2/account")!;
    expect(time.headers["X-MBX-APIKEY"]).toBeUndefined();
    expect(acct.headers["X-MBX-APIKEY"]).toBe("KEY");
    const [unsigned, sig] = acct.query.split("&signature=");
    expect(sig).toBe(createHmac("sha256", "SECRET").update(unsigned!).digest("hex"));
    expect(acct.params.get("timestamp")).toBeTruthy();
    expect(acct.params.get("recvWindow")).toBe("5000");
  });

  it("treats body.code < 0 on HTTP 200 as an error", async () => {
    const { impl } = router({ "GET /fapi/v1/premiumIndex": { status: 200, body: { code: -1121, msg: "Invalid symbol." } } });
    const err = await client(impl).getMarkPrice("XXX").catch((e) => e);
    expect(err).toBeInstanceOf(BinanceApiError);
    expect(err.code).toBe(-1121);
    expect(err.status).toBe(200);
  });

  it("times out", async () => {
    const { impl } = router({ "GET /fapi/v1/premiumIndex": { hang: true } });
    const err = await client(impl, { timeoutMs: 20 }).getMarkPrice("BTCUSDT").catch((e) => e);
    expect(err).toBeInstanceOf(BinanceApiError);
    expect(err.message).toMatch(/timeout/);
  });

  it("resyncs time on -1021 and retries once", async () => {
    const { impl, calls } = router({
      "GET /fapi/v2/account": [{ status: 400, body: { code: -1021, msg: "Timestamp outside recvWindow" } }, { body: { totalMarginBalance: "1", availableBalance: "1" } }],
    });
    const ex = client(impl);
    await ex.getBalance();
    expect(calls.filter((c) => c.path === "/fapi/v2/account")).toHaveLength(2);
    expect(calls.filter((c) => c.path === "/fapi/v1/time")).toHaveLength(2); // initial sync + resync
  });

  it("gives up after one -1021 retry", async () => {
    const { impl, calls } = router({ "POST /fapi/v1/leverage": { status: 400, body: { code: -1021, msg: "ts" } }, "POST /fapi/v1/marginType": { body: {} } });
    const err = await client(impl).prepareSymbol("BTCUSDT", 3).catch((e) => e);
    expect(err.code).toBe(-1021);
    expect(calls.filter((c) => c.path === "/fapi/v1/leverage")).toHaveLength(2);
  });

  it("resyncs when the last sync is older than 1h", async () => {
    const { impl, calls } = router({ "GET /fapi/v2/account": { body: { totalMarginBalance: "1", availableBalance: "1" } } });
    const ex = client(impl);
    await ex.getBalance();
    await ex.getBalance();
    expect(calls.filter((c) => c.path === "/fapi/v1/time")).toHaveLength(1);
    (ex as any).lastSync = Date.now() - 3600_001;
    await ex.getBalance();
    expect(calls.filter((c) => c.path === "/fapi/v1/time")).toHaveLength(2);
  });

  it("retries GET on 429 honouring Retry-After (capped at 10s)", async () => {
    const { impl, calls } = router({
      "GET /fapi/v1/premiumIndex": [
        { status: 429, body: { code: -1003, msg: "Too many requests" }, headers: { "Retry-After": "3" } },
        { status: 429, body: { code: -1003, msg: "Too many requests" }, headers: { "Retry-After": "60" } },
        { body: { markPrice: "123.4" } },
      ],
    });
    const ex = client(impl);
    expect(await ex.getMarkPrice("BTCUSDT")).toBe(123.4);
    expect(calls.filter((c) => c.path === "/fapi/v1/premiumIndex")).toHaveLength(3);
    expect(sleeps).toEqual([3000, 10_000]);
  });

  it("stops after 2 GET retries on 5xx and exposes status/retryAfterMs", async () => {
    const { impl, calls } = router({ "GET /fapi/v1/premiumIndex": { status: 503, body: { msg: "busy" }, headers: { "Retry-After": "1" } } });
    const err = await client(impl).getMarkPrice("BTCUSDT").catch((e) => e);
    expect(err).toBeInstanceOf(BinanceApiError);
    expect(err.status).toBe(503);
    expect(err.retryAfterMs).toBe(1000);
    expect(calls.filter((c) => c.path === "/fapi/v1/premiumIndex")).toHaveLength(3);
  });

  it("throws immediately on 418", async () => {
    const { impl, calls } = router({ "GET /fapi/v1/premiumIndex": { status: 418, body: { code: -1003, msg: "banned" }, headers: { "Retry-After": "120" } } });
    const err = await client(impl).getMarkPrice("BTCUSDT").catch((e) => e);
    expect(err.status).toBe(418);
    expect(calls.filter((c) => c.path === "/fapi/v1/premiumIndex")).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("never auto-retries POST on 5xx/429", async () => {
    const { impl, calls } = router({ "POST /fapi/v1/marginType": { status: 503, body: { msg: "busy" } } });
    await expect(client(impl).prepareSymbol("BTCUSDT", 3)).rejects.toThrow(/503/);
    expect(calls.filter((c) => c.path === "/fapi/v1/marginType")).toHaveLength(1);
  });
});

describe("marketOrder", () => {
  const p = { symbol: "BTCUSDT", side: "BUY" as const, quantity: 0.0379, reduceOnly: false, clientOrderId: "cid" };

  it("returns an existing FILLED order without POSTing", async () => {
    const { impl, calls } = router({ ...INFO_ROUTE, "GET /fapi/v1/order": order("FILLED") });
    const fill = await client(impl).marketOrder(p);
    expect(fill).toMatchObject({ orderId: "7", status: "FILLED", executedQty: 0.01, avgPrice: 50000 });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("throws CLIENT_ID_SPENT when the existing order is CANCELED/EXPIRED/REJECTED", async () => {
    for (const s of ["CANCELED", "EXPIRED", "REJECTED"]) {
      const { impl, calls } = router({ ...INFO_ROUTE, "GET /fapi/v1/order": order(s) });
      await expect(client(impl).marketOrder(p)).rejects.toThrow(/CLIENT_ID_SPENT/);
      expect(calls.some((c) => c.method === "POST")).toBe(false);
    }
  });

  it("rounds the quantity down to MARKET_LOT_SIZE step", async () => {
    const { impl, calls } = router({ ...INFO_ROUTE, "GET /fapi/v1/order": notFound, "POST /fapi/v1/order": order("FILLED") });
    await client(impl).marketOrder(p);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.params.get("quantity")).toBe("0.03");
    expect(post.params.get("newClientOrderId")).toBe("cid");
    expect(post.params.get("reduceOnly")).toBeNull();
  });

  it("looks the order up after a POST timeout and returns it", async () => {
    const { impl, calls } = router({ ...INFO_ROUTE, "GET /fapi/v1/order": [notFound, order("FILLED")], "POST /fapi/v1/order": { hang: true } });
    const fill = await client(impl, { timeoutMs: 20 }).marketOrder(p);
    expect(fill.status).toBe("FILLED");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a FILLED order reported with avgPrice 0 is priced from a second lookup, then from the trades", async () => {
    const zero = { body: { orderId: 7, clientOrderId: "cid", status: "FILLED", executedQty: "0.03", avgPrice: "0", cumQuote: "0" } };
    const priced = { body: { orderId: 7, clientOrderId: "cid", status: "FILLED", executedQty: "0.03", avgPrice: "61500.5", cumQuote: "1845.015" } };
    const a = router({ ...INFO_ROUTE, "GET /fapi/v1/order": [notFound, priced], "POST /fapi/v1/order": zero });
    expect((await client(a.impl).marketOrder(p)).avgPrice).toBe(61500.5);
    const b = router({ ...INFO_ROUTE, "GET /fapi/v1/order": [notFound, zero], "POST /fapi/v1/order": zero,
      "GET /fapi/v1/userTrades": { body: [{ id: 1, orderId: 7, time: 1, price: "61000", qty: "0.01", side: "BUY", realizedPnl: "0", commission: "0" }, { id: 2, orderId: 7, time: 2, price: "62000", qty: "0.02", side: "BUY", realizedPnl: "0", commission: "0" }, { id: 3, orderId: 9, time: 3, price: "1", qty: "5", side: "BUY", realizedPnl: "0", commission: "0" }] } });
    expect((await client(b.impl).marketOrder(p)).avgPrice).toBeCloseTo((61000 * 0.01 + 62000 * 0.02) / 0.03);
  });

  it("rethrows the original error when the lookup says -2013", async () => {
    const { impl } = router({ ...INFO_ROUTE, "GET /fapi/v1/order": notFound, "POST /fapi/v1/order": { status: 400, body: { code: -2019, msg: "Margin is insufficient." } } });
    const err = await client(impl).marketOrder(p).catch((e) => e);
    expect(err.code).toBe(-2019);
  });
});

describe("placeStop", () => {
  const base = { symbol: "BTCUSDT", quantity: 0.0379, clientId: "stop1" };

  it("legacy: SELL floors the price, BUY ceils it; qty floors to LOT_SIZE", async () => {
    const { impl, calls } = router({ ...INFO_ROUTE, "POST /fapi/v1/order": { body: { orderId: 11 } } });
    const ex = client(impl);
    const sell = await ex.placeStop({ ...base, side: "SELL", stopPrice: 49_999.97 });
    const buy = await ex.placeStop({ ...base, side: "BUY", stopPrice: 50_000.01 });
    expect(sell).toMatchObject({ id: "11", stopPrice: 49_999.9, quantity: 0.037 });
    expect(buy.stopPrice).toBe(50_000.1);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts[0]!.params.get("stopPrice")).toBe("49999.9");
    expect(posts[1]!.params.get("stopPrice")).toBe("50000.1");
    expect(posts[0]!.params.get("type")).toBe("STOP_MARKET");
    expect(posts[0]!.params.get("quantity")).toBe("0.037");
    expect(posts[0]!.params.get("reduceOnly")).toBe("true");
    expect(posts[0]!.params.get("newClientOrderId")).toBe("stop1");
    expect(posts[0]!.params.get("workingType")).toBe("MARK_PRICE");
  });

  it("algo: posts to /fapi/v1/algoOrder with triggerPrice and clientAlgoId", async () => {
    const { impl, calls } = router({ ...INFO_ROUTE, "POST /fapi/v1/algoOrder": { body: { algoId: 99 } } });
    const s = await client(impl, { stopOrderApi: "algo" }).placeStop({ ...base, side: "SELL", stopPrice: 49_999.97 });
    expect(s.id).toBe("99");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.params.get("algoType")).toBe("CONDITIONAL");
    expect(post.params.get("triggerPrice")).toBe("49999.9");
    expect(post.params.get("clientAlgoId")).toBe("stop1");
    expect(post.params.get("stopPrice")).toBeNull();
  });

  it("algo: response without algoId throws", async () => {
    const { impl } = router({ ...INFO_ROUTE, "POST /fapi/v1/algoOrder": { body: { ok: true } }, "GET /fapi/v1/openAlgoOrders": { body: [] } });
    await expect(client(impl, { stopOrderApi: "algo" }).placeStop({ ...base, side: "SELL", stopPrice: 1 })).rejects.toThrow(/algoId/);
  });

  it("auto: falls back to legacy on algo 404 and remembers the mode", async () => {
    const { impl, calls } = router({ ...INFO_ROUTE, "POST /fapi/v1/algoOrder": { status: 404, body: "" }, "POST /fapi/v1/order": { body: { orderId: 5 } } });
    const ex = client(impl, { stopOrderApi: "auto" });
    expect(ex.resolvedStopApi()).toBe("unresolved");
    expect((await ex.placeStop({ ...base, side: "SELL", stopPrice: 100 })).id).toBe("5");
    expect(ex.resolvedStopApi()).toBe("legacy");
    await ex.placeStop({ ...base, clientId: "stop2", side: "SELL", stopPrice: 100 });
    expect(calls.filter((c) => c.path === "/fapi/v1/algoOrder")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/fapi/v1/order")).toHaveLength(2);
  });

  it("auto: resolves to algo when algo works", async () => {
    const { impl } = router({ ...INFO_ROUTE, "POST /fapi/v1/algoOrder": { body: { algoId: 1 } } });
    const ex = client(impl, { stopOrderApi: "auto" });
    await ex.placeStop({ ...base, side: "SELL", stopPrice: 100 });
    expect(ex.resolvedStopApi()).toBe("algo");
  });

  it("auto: switches to algo when legacy says conditional orders need the algo service", async () => {
    const { impl } = router({
      ...INFO_ROUTE,
      "POST /fapi/v1/algoOrder": { body: { algoId: 42 } },
      "POST /fapi/v1/order": { status: 400, body: { code: -4120, msg: "Order type not supported for this endpoint. Please use the Algo Order API endpoints instead." } },
    });
    const ex = client(impl, { stopOrderApi: "auto" });
    (ex as any).stopApi = "legacy"; // previously resolved to legacy, Binance has since migrated
    const s = await ex.placeStop({ ...base, side: "SELL", stopPrice: 100 });
    expect(s.id).toBe("42");
    expect(ex.resolvedStopApi()).toBe("algo");
  });

  it("returns the stop found in open stops after an error", async () => {
    const { impl, calls } = router({
      ...INFO_ROUTE,
      "POST /fapi/v1/order": { hang: true },
      "GET /fapi/v1/openOrders": { body: [{ orderId: 77, clientOrderId: "stop1", type: "STOP_MARKET", side: "SELL", stopPrice: "100", origQty: "0.037" }] },
    });
    const s = await client(impl, { timeoutMs: 20 }).placeStop({ ...base, side: "SELL", stopPrice: 100 });
    expect(s).toMatchObject({ id: "77", clientId: "stop1", quantity: 0.037 });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("rethrows when the stop is not among open stops", async () => {
    const { impl } = router({ ...INFO_ROUTE, "POST /fapi/v1/order": { status: 400, body: { code: -2021, msg: "Order would immediately trigger." } }, "GET /fapi/v1/openOrders": { body: [] } });
    const err = await client(impl).placeStop({ ...base, side: "SELL", stopPrice: 100 }).catch((e) => e);
    expect(err.code).toBe(-2021);
  });
});

describe("stops in auto mode before resolution", () => {
  it("getOpenStops merges both services and ignores an algo 404", async () => {
    const legacyRow = { orderId: 1, clientOrderId: "a", type: "STOP_MARKET", side: "SELL", stopPrice: "10", origQty: "1" };
    const r1 = router({ "GET /fapi/v1/openOrders": { body: [legacyRow, { ...legacyRow, type: "LIMIT" }] }, "GET /fapi/v1/openAlgoOrders": { body: [{ algoId: 2, clientAlgoId: "b", side: "BUY", triggerPrice: "20", quantity: "2" }] } });
    expect((await client(r1.impl, { stopOrderApi: "auto" }).getOpenStops("BTCUSDT")).map((s) => s.id).sort()).toEqual(["1", "2"]);
    const r2 = router({ "GET /fapi/v1/openOrders": { body: [legacyRow] }, "GET /fapi/v1/openAlgoOrders": { status: 404, body: "" } });
    expect((await client(r2.impl, { stopOrderApi: "auto" }).getOpenStops("BTCUSDT")).map((s) => s.id)).toEqual(["1"]);
  });

  it("cancelStop uses the service that holds the id", async () => {
    const { impl, calls } = router({
      "GET /fapi/v1/openOrders": { body: [] },
      "GET /fapi/v1/openAlgoOrders": { body: [{ algoId: 2, clientAlgoId: "b", side: "BUY", triggerPrice: "20", quantity: "2" }] },
      "DELETE /fapi/v1/algoOrder": { body: {} },
    });
    await client(impl, { stopOrderApi: "auto" }).cancelStop("BTCUSDT", "2");
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe("/fapi/v1/algoOrder");
    expect(del.params.get("algoId")).toBe("2");
  });
});

describe("prepareSymbol", () => {
  it("swallows -4046 only", async () => {
    const ok = router({ "POST /fapi/v1/marginType": { status: 400, body: { code: -4046, msg: "No need to change margin type." } }, "POST /fapi/v1/leverage": { body: {} } });
    await client(ok.impl).prepareSymbol("BTCUSDT", 3.7);
    expect(ok.calls.find((c) => c.path === "/fapi/v1/leverage")!.params.get("leverage")).toBe("3");
    const bad = router({ "POST /fapi/v1/marginType": { status: 400, body: { code: -4047, msg: "open orders" } }, "POST /fapi/v1/leverage": { body: {} } });
    await expect(client(bad.impl).prepareSymbol("BTCUSDT", 3)).rejects.toThrow(/-4047/);
    expect(bad.calls.some((c) => c.path === "/fapi/v1/leverage")).toBe(false);
  });
});

describe("getFilters", () => {
  it("parses LOT_SIZE and MARKET_LOT_SIZE, falls back, and caches", async () => {
    const { impl, calls } = router(INFO_ROUTE);
    const ex = client(impl);
    expect(await ex.getFilters("BTCUSDT")).toEqual({
      symbol: "BTCUSDT", tickSize: 0.1, stepSize: 0.001, minQty: 0.001, maxQty: 1000,
      marketStepSize: 0.01, marketMaxQty: 120, minNotional: 100,
    });
    expect(await ex.getFilters("ETHUSDT")).toMatchObject({ stepSize: 0.001, marketStepSize: 0.001, marketMaxQty: 10000, minNotional: 5 });
    expect(calls.filter((c) => c.path === "/fapi/v1/exchangeInfo")).toHaveLength(1);
  });

  it("throws when a required filter is missing or the symbol is unknown", async () => {
    const { impl } = router(INFO_ROUTE);
    await expect(client(impl).getFilters("BADUSDT")).rejects.toThrow(/LOT_SIZE/);
    await expect(client(impl).getFilters("NOPE")).rejects.toThrow(/Unknown symbol/);
  });
});

describe("account and market data", () => {
  it("getPosition: 0 → null, negative → SHORT", async () => {
    const flat = router({ "GET /fapi/v2/positionRisk": { body: [{ symbol: "BTCUSDT", positionAmt: "0.000", entryPrice: "0" }] } });
    expect(await client(flat.impl).getPosition("BTCUSDT")).toBeNull();
    const short = router({ "GET /fapi/v2/positionRisk": { body: [{ symbol: "BTCUSDT", positionAmt: "-0.5", entryPrice: "50000" }] } });
    expect(await client(short.impl).getPosition("BTCUSDT")).toEqual({ symbol: "BTCUSDT", side: "SHORT", quantity: 0.5, entryPrice: 50000 });
  });

  it("getClosedCandles drops the forming candle", async () => {
    const k = (open: number) => [open, "1", "2", "0.5", "1.5", "10", open + 999];
    const { impl, calls } = router({ "GET /fapi/v1/klines": { body: [k(SERVER_TIME - 3000), k(SERVER_TIME - 2000), k(SERVER_TIME - 500)] } });
    const out = await client(impl).getClosedCandles("BTCUSDT", "4h", 2);
    expect(out.map((c) => c.openTime)).toEqual([SERVER_TIME - 3000, SERVER_TIME - 2000]);
    expect(calls.find((c) => c.path === "/fapi/v1/klines")!.params.get("limit")).toBe("3");
  });

  it("getClosedCandles rejects limit > 1499", async () => {
    const { impl } = router({});
    await expect(client(impl).getClosedCandles("BTCUSDT", "4h", 1500)).rejects.toThrow(/1499/);
  });

  it("getFills paginates by fromId and ignores non-USDT commission", async () => {
    const row = (id: number, asset = "USDT") => ({ id, time: id, price: "1", qty: "1", side: "BUY", realizedPnl: "0", commission: "0.5", commissionAsset: asset });
    const page1 = Array.from({ length: 1000 }, (_, i) => row(i + 1));
    const { impl, calls } = router({
      "GET /fapi/v1/userTrades": (req) => (req.params.get("fromId") ? { body: [row(1001, "BNB"), row(1002)] } : { body: page1 }),
    });
    const fills = await client(impl).getFills("BTCUSDT", 0);
    expect(fills).toHaveLength(1002);
    const reqs = calls.filter((c) => c.path === "/fapi/v1/userTrades");
    expect(reqs[0]!.params.get("startTime")).toBe("0");
    expect(reqs[1]!.params.get("fromId")).toBe("1001");
    expect(reqs[1]!.params.get("startTime")).toBeNull();
    expect(fills[1000]!.commission).toBe(0);
    expect(fills[1001]!.commission).toBe(0.5);
  });
});
