// Trend-following breakout (Donchian channel + EMA trend filter + ATR stops).
// Entry: the closed candle breaks the prior N-bar high (long) or low (short)
//        while the fast EMA is on the same side of the slow EMA and price is beyond the slow EMA.
// Stop:  entry -/+ stopAtr * ATR. Then a chandelier trailing stop that only tightens.
// Six parameters, all listed in DEFAULT_TREND_BREAKOUT.
import { atr, ema, priorHighest, priorLowest } from "../core/indicators.js";
import type { Candle, OpenPositionView, Signal } from "../core/types.js";
import type { Strategy } from "./types.js";

export interface TrendBreakoutParams {
  entryLookback: number;
  emaFast: number;
  emaSlow: number;
  atrPeriod: number;
  stopAtr: number;
  trailAtr: number;
}

export const DEFAULT_TREND_BREAKOUT: TrendBreakoutParams = {
  entryLookback: 20,
  emaFast: 50,
  emaSlow: 200,
  atrPeriod: 14,
  stopAtr: 2,
  trailAtr: 3,
};

export function createTrendBreakout(p: TrendBreakoutParams = DEFAULT_TREND_BREAKOUT): Strategy {
  const warmup = Math.max(p.emaSlow, p.entryLookback + 1, p.atrPeriod) + 1;

  return {
    name: `trend-breakout(${p.entryLookback},${p.emaFast}/${p.emaSlow},atr${p.atrPeriod}x${p.stopAtr}/${p.trailAtr})`,
    warmup,

    evaluate(symbol: string, candles: Candle[]): Signal | null {
      if (candles.length < warmup) return null;
      const i = candles.length - 1;
      const c = candles[i]!;
      const closes = candles.map((k) => k.close);
      const fast = ema(closes, p.emaFast)[i]!;
      const slow = ema(closes, p.emaSlow)[i]!;
      const a = atr(candles, p.atrPeriod)[i]!;
      const hi = priorHighest(candles, p.entryLookback)[i]!;
      const lo = priorLowest(candles, p.entryLookback)[i]!;
      if (![fast, slow, a, hi, lo].every(Number.isFinite) || a <= 0) return null;

      if (c.close > hi && fast > slow && c.close > slow) {
        return {
          symbol,
          side: "LONG",
          refPrice: c.close,
          stop: c.close - p.stopAtr * a,
          candleOpenTime: c.openTime,
          reason: `close ${c.close} > ${p.entryLookback}-bar high ${hi}; ema${p.emaFast} > ema${p.emaSlow}`,
        };
      }
      if (c.close < lo && fast < slow && c.close < slow) {
        return {
          symbol,
          side: "SHORT",
          refPrice: c.close,
          stop: c.close + p.stopAtr * a,
          candleOpenTime: c.openTime,
          reason: `close ${c.close} < ${p.entryLookback}-bar low ${lo}; ema${p.emaFast} < ema${p.emaSlow}`,
        };
      }
      return null;
    },

    updateStop(position: OpenPositionView, candles: Candle[]): number {
      const i = candles.length - 1;
      const a = atr(candles, p.atrPeriod)[i];
      if (a === undefined || !Number.isFinite(a)) return position.stop;
      // Extremes since entry (inclusive of the entry candle and the latest closed candle).
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i; j >= 0 && candles[j]!.openTime >= position.entryCandleOpenTime; j--) {
        hh = Math.max(hh, candles[j]!.high);
        ll = Math.min(ll, candles[j]!.low);
      }
      if (!Number.isFinite(hh)) return position.stop;
      if (position.side === "LONG") return Math.max(position.stop, hh - p.trailAtr * a);
      return Math.min(position.stop, ll + p.trailAtr * a);
    },
  };
}
