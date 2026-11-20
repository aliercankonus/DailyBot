// Binance USD-M forced liquidation stream (public, no key). The stream pushes at most the largest
// liquidation per symbol per second, so the data is a lower bound of real liquidation volume.
export interface Liquidation {
  symbol: string;
  side: "BUY" | "SELL"; // SELL = a long position was liquidated
  price: number;
  avgPrice: number;
  quantity: number;
  notional: number;
  status: string;
  tradeTime: number;
}

/**
 * Combined stream URL. `control` adds a stream that always ticks (mark price, 1 s) so a dead route
 * can be told apart from a quiet market (2026-11-20: 0 liquidation messages in 9 h).
 */
export const liquidationStreamUrl = (symbols: string[], base = "wss://fstream.binance.com/market", control = false) =>
  `${base}/stream?streams=${[...symbols.map((s) => `${s.toLowerCase()}@forceOrder`), ...(control ? [`${symbols[0]!.toLowerCase()}@markPrice@1s`] : [])].join("/")}`;

/** Stream name of a combined-stream message ("btcusdt@forceOrder"), or "?" */
export function streamOf(raw: string): string {
  const m = /"stream"\s*:\s*"([^"]+)"/.exec(raw.slice(0, 200));
  return m ? m[1]! : "?";
}

/** Parse one combined-stream message; null for anything that is not a valid forceOrder event. */
export function parseForceOrder(raw: string): Liquidation | null {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = msg?.data?.o ?? msg?.o;
  if (!o || (msg?.data?.e ?? msg?.e) !== "forceOrder") return null;
  const side = o.S === "BUY" || o.S === "SELL" ? o.S : null;
  const price = Number(o.p), avgPrice = Number(o.ap), filled = Number(o.z), qty = Number(o.q), t = Number(o.T);
  if (!side || typeof o.s !== "string" || ![price, avgPrice, qty, t].every(Number.isFinite)) return null;
  const quantity = Number.isFinite(filled) && filled > 0 ? filled : qty;
  return { symbol: o.s, side, price, avgPrice, quantity, notional: (avgPrice || price) * quantity, status: String(o.X ?? ""), tradeTime: t };
}
