// Strategy C: mean reversion on 1h in ranging markets.
// Regime: ADX(adxPeriod) below adxMax (no strong trend).
// Entry:  previous close below the lower Bollinger band and this close back above it -> long.
//         Previous close above the upper band and this close back below it -> short.
// Stop:   entry -/+ stopAtr * ATR(14), fixed.
// Exit:   a close back at the middle band, or after maxBars candles (time stop).
import { adx, atr, bollinger } from "../core/indicators.js";
import type { Candle, OpenPositionView, Signal } from "../core/types.js";
import type { Strategy } from "./types.js";

export interface MeanReversionParams {
  bbPeriod: number;
  bbStd: number;
  adxPeriod: number;
  adxMax: number;
  stopAtr: number;
  maxBars: number;
}

export const DEFAULT_MEAN_REVERSION: MeanReversionParams = {
  bbPeriod: 20,
  bbStd: 2,
  adxPeriod: 14,
  adxMax: 20,
  stopAtr: 1.5,
  maxBars: 24,
};

const ATR_PERIOD = 14;
const ADX_LOOKBACK = 300;
const ATR_LOOKBACK = 200;

export function createMeanReversion(p: MeanReversionParams = DEFAULT_MEAN_REVERSION): Strategy {
  const warmup = Math.max(p.bbPeriod + 1, 2 * p.adxPeriod + 50, ATR_PERIOD + 1);
  return {
    name: `mean-reversion(bb${p.bbPeriod}x${p.bbStd}, adx${p.adxPeriod}<${p.adxMax}, atr x${p.stopAtr}, ${p.maxBars} bars)`,
    interval: "1h",
    warmup,

    evaluate(symbol: string, candles: Candle[]): Signal | null {
      if (candles.length < warmup) return null;
      const c = candles.at(-1)!;
      const tail = candles.slice(-(p.bbPeriod + 1)).map((k) => k.close);
      const bb = bollinger(tail, p.bbPeriod, p.bbStd);
      // Band values at the previous candle need bbPeriod values ending there.
      const prevBb = bollinger(tail.slice(0, -1), p.bbPeriod, p.bbStd);
      const lowerNow = bb.lower.at(-1)!;
      const upperNow = bb.upper.at(-1)!;
      const lowerPrev = prevBb.lower.at(-1)!;
      const upperPrev = prevBb.upper.at(-1)!;
      const prevClose = tail.at(-2)!;
      if (![lowerNow, upperNow, lowerPrev, upperPrev].every(Number.isFinite)) return null;
      const longSetup = prevClose < lowerPrev && c.close > lowerNow;
      const shortSetup = prevClose > upperPrev && c.close < upperNow;
      if (!longSetup && !shortSetup) return null;

      const regime = adx(candles.slice(-ADX_LOOKBACK), p.adxPeriod).at(-1)!;
      const a = atr(candles.slice(-ATR_LOOKBACK), ATR_PERIOD).at(-1)!;
      if (!Number.isFinite(regime) || !Number.isFinite(a) || a <= 0 || regime >= p.adxMax) return null;

      if (longSetup) {
        return {
          symbol, side: "LONG", refPrice: c.close, stop: c.close - p.stopAtr * a, candleOpenTime: c.openTime,
          reason: `close back above lower band ${lowerNow.toFixed(4)}; adx ${regime.toFixed(1)} < ${p.adxMax}`,
        };
      }
      return {
        symbol, side: "SHORT", refPrice: c.close, stop: c.close + p.stopAtr * a, candleOpenTime: c.openTime,
        reason: `close back below upper band ${upperNow.toFixed(4)}; adx ${regime.toFixed(1)} < ${p.adxMax}`,
      };
    },

    updateStop(position: OpenPositionView): number {
      return position.stop;
    },

    shouldExit(position: OpenPositionView, candles: Candle[]): boolean {
      const held = candles.filter((k) => k.openTime >= position.entryCandleOpenTime).length;
      if (held >= p.maxBars) return true;
      const tail = candles.slice(-p.bbPeriod).map((k) => k.close);
      if (tail.length < p.bbPeriod) return false;
      const mid = tail.reduce((a, b) => a + b, 0) / p.bbPeriod;
      const close = candles.at(-1)!.close;
      return position.side === "LONG" ? close >= mid : close <= mid;
    },
  };
}
