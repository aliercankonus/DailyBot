// Strategy B: trend pullback on 1h with a 4h trend filter.
// Trend:  4h EMA(fast) vs EMA(slow), built ONLY from complete 4h buckets of the 1h candles.
// Entry:  in a 4h up-trend, 1h RSI crosses back UP through rsiLevel (pullback ends) -> long.
//         In a 4h down-trend, 1h RSI crosses back DOWN through 100 - rsiLevel -> short.
// Stop:   entry -/+ stopAtr * ATR(14, 1h), fixed.
// Exit:   a 1h close at or beyond targetR * initial risk (filled at the next open / at market).
import { aggregate, atr, ema, rsi } from "../core/indicators.js";
import type { Candle, OpenPositionView, Signal } from "../core/types.js";
import type { Strategy } from "./types.js";

export interface PullbackParams {
  trendFast: number;  // 4h EMA
  trendSlow: number;  // 4h EMA
  rsiPeriod: number;  // 1h
  rsiLevel: number;   // long trigger; short trigger is 100 - rsiLevel
  stopAtr: number;
  targetR: number;
}

export const DEFAULT_PULLBACK: PullbackParams = {
  trendFast: 20,
  trendSlow: 50,
  rsiPeriod: 14,
  rsiLevel: 35,
  stopAtr: 1.5,
  targetR: 2,
};

const H1 = 3_600_000;
const H4 = 4 * H1;
const ATR_PERIOD = 14;
// Sub-windows keep each evaluation cheap; results are still a pure function of the window.
const RSI_LOOKBACK = 300;
const ATR_LOOKBACK = 200;

export function createPullback(p: PullbackParams = DEFAULT_PULLBACK): Strategy {
  const warmup = (p.trendSlow + 5) * 4;
  return {
    name: `pullback(4h ema${p.trendFast}/${p.trendSlow}, rsi${p.rsiPeriod}@${p.rsiLevel}, atr x${p.stopAtr}, ${p.targetR}R)`,
    interval: "1h",
    warmup,

    evaluate(symbol: string, candles: Candle[]): Signal | null {
      if (candles.length < warmup) return null;
      const c = candles.at(-1)!;
      const closes = candles.slice(-RSI_LOOKBACK).map((k) => k.close);
      const r = rsi(closes, p.rsiPeriod);
      const now = r.at(-1)!;
      const prev = r.at(-2)!;
      if (!Number.isFinite(now) || !Number.isFinite(prev)) return null;
      const crossUp = prev < p.rsiLevel && now >= p.rsiLevel;
      const crossDown = prev > 100 - p.rsiLevel && now <= 100 - p.rsiLevel;
      if (!crossUp && !crossDown) return null;

      const h4 = aggregate(candles, H1, H4);
      if (h4.length < p.trendSlow + 1) return null;
      const h4c = h4.map((k) => k.close);
      const fast = ema(h4c, p.trendFast).at(-1)!;
      const slow = ema(h4c, p.trendSlow).at(-1)!;
      const last4h = h4c.at(-1)!;
      const a = atr(candles.slice(-ATR_LOOKBACK), ATR_PERIOD).at(-1)!;
      if (![fast, slow, a].every(Number.isFinite) || a <= 0) return null;

      if (crossUp && fast > slow && last4h > slow) {
        return {
          symbol, side: "LONG", refPrice: c.close, stop: c.close - p.stopAtr * a, candleOpenTime: c.openTime,
          reason: `4h up-trend (ema${p.trendFast} ${fast.toFixed(2)} > ema${p.trendSlow} ${slow.toFixed(2)}); 1h rsi ${prev.toFixed(1)} -> ${now.toFixed(1)}`,
        };
      }
      if (crossDown && fast < slow && last4h < slow) {
        return {
          symbol, side: "SHORT", refPrice: c.close, stop: c.close + p.stopAtr * a, candleOpenTime: c.openTime,
          reason: `4h down-trend (ema${p.trendFast} ${fast.toFixed(2)} < ema${p.trendSlow} ${slow.toFixed(2)}); 1h rsi ${prev.toFixed(1)} -> ${now.toFixed(1)}`,
        };
      }
      return null;
    },

    updateStop(position: OpenPositionView): number {
      return position.stop;
    },

    shouldExit(position: OpenPositionView, candles: Candle[]): boolean {
      const close = candles.at(-1)!.close;
      const risk = Math.abs(position.entryPrice - position.initialStop);
      if (!(risk > 0)) return false;
      return position.side === "LONG"
        ? close >= position.entryPrice + p.targetR * risk
        : close <= position.entryPrice - p.targetR * risk;
    },
  };
}
