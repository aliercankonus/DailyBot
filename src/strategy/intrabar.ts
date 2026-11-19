// Research harness (round 18): run a strategy designed for a slow interval (e.g. 4h) on fast
// candles (e.g. 15m), to measure what deciding on the still-forming slow candle does.
//
//  * mode "closed":   entries are evaluated only when a slow candle has just closed; the control,
//                     it should reproduce the slow-interval backtest on the fast data.
//  * mode "intrabar": entries are evaluated at every fast close, on the closed slow candles plus
//                     the forming slow candle built from the fast candles so far.
// Stops and strategy exits are updated only at slow closes in both modes, so the comparison
// isolates entry timing. Backtest only: the live engine cannot fetch the long fast window.
import type { Candle, OpenPositionView, Signal } from "../core/types.js";
import type { Strategy } from "./types.js";

/** Aggregate fast candles into slow candles aligned to UTC multiples of slowMs; the last one may be forming. */
export function aggregate(fast: Candle[], slowMs: number): { candles: Candle[]; lastClosed: boolean } {
  const out: Candle[] = [];
  for (const k of fast) {
    const open = Math.floor(k.openTime / slowMs) * slowMs;
    const cur = out.at(-1);
    if (cur && cur.openTime === open) {
      cur.high = Math.max(cur.high, k.high); cur.low = Math.min(cur.low, k.low); cur.close = k.close;
      cur.volume += k.volume; cur.closeTime = k.closeTime;
    } else {
      out.push({ openTime: open, closeTime: k.closeTime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume });
    }
  }
  // Drop a leading partial slow candle (the window may start mid-candle).
  if (out.length && fast.length && fast[0]!.openTime !== out[0]!.openTime) out.shift();
  const last = out.at(-1);
  const lastClosed = !!last && last.closeTime + 1 >= last.openTime + slowMs;
  return { candles: out, lastClosed };
}

export function createIntrabar(base: Strategy, fastInterval: string, fastMs: number, slowMs: number, mode: "closed" | "intrabar"): Strategy {
  const ratio = Math.round(slowMs / fastMs);
  const slowView = (p: OpenPositionView): OpenPositionView => ({ ...p, entryCandleOpenTime: Math.floor(p.entryCandleOpenTime / slowMs) * slowMs });
  const closedOnly = (fast: Candle[]) => {
    const { candles, lastClosed } = aggregate(fast, slowMs);
    return lastClosed ? candles : null;
  };
  return {
    name: `${base.name} [${mode} on ${fastInterval}]`,
    interval: fastInterval,
    warmup: (base.warmup + 2) * ratio,
    window: (base.warmup + 100) * ratio,
    evaluate(symbol: string, fast: Candle[]): Signal | null {
      const { candles, lastClosed } = aggregate(fast, slowMs);
      if (mode === "closed" && !lastClosed) return null;
      const s = base.evaluate(symbol, candles);
      if (!s) return null;
      // The backtest fills at the next FAST open; keep the fast candle as the signal candle.
      const k = fast.at(-1)!;
      return { ...s, refPrice: k.close, candleOpenTime: k.openTime };
    },
    updateStop(p: OpenPositionView, fast: Candle[]): number {
      const slow = closedOnly(fast);
      return slow ? base.updateStop(slowView(p), slow) : p.stop;
    },
    shouldExit(p: OpenPositionView, fast: Candle[]): boolean {
      const slow = closedOnly(fast);
      return !!slow && !!base.shouldExit?.(slowView(p), slow);
    },
  };
}
