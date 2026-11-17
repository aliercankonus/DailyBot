// Strategy F: time-series momentum ensemble on daily candles.
// Evidence: Liu & Tsyvinski (RFS 2021) time-series momentum in crypto; Zarattini, Pagani & Barbon
// (SSRN 2025) multi-lookback trend ensembles with volatility sizing, net of costs through 2025.
//
// Score = average over LOOKBACKS of sign(close / close[L bars ago] - 1), in [-1, 1].
// Entry:  score >= entryScore -> LONG; if allowShort and score <= -entryScore -> SHORT.
// Exit:   score falls to exitScore or below (long) / rises to -exitScore or above (short).
// Stop:   stopAtr * ATR(14), fixed and wide: it only catches crashes; the score does the exiting.
// Sizing: the engine risks a fixed fraction per position against the ATR stop, i.e. inverse-volatility.
import { atr } from "../core/indicators.js";
import type { Candle, OpenPositionView, Signal } from "../core/types.js";
import type { Strategy } from "./types.js";

/** Fixed, not tuned: a spread of horizons from one week to one year. */
export const TSMOM_LOOKBACKS = [5, 10, 20, 30, 60, 90, 150, 250, 360] as const;

export interface TsmomParams {
  entryScore: number;
  exitScore: number;
  stopAtr: number;
  allowShort: number; // 0 or 1
}

export const DEFAULT_TSMOM: TsmomParams = {
  entryScore: 0.6,
  exitScore: 0,
  stopAtr: 4,
  allowShort: 0,
};

const ATR_PERIOD = 14;

/** Ensemble momentum score of the last candle. Null if there is not enough history. */
export function tsmomScore(candles: Candle[]): number | null {
  const n = candles.length;
  const maxL = TSMOM_LOOKBACKS.at(-1)!;
  if (n < maxL + 1) return null;
  const now = candles[n - 1]!.close;
  let sum = 0;
  for (const L of TSMOM_LOOKBACKS) sum += Math.sign(now / candles[n - 1 - L]!.close - 1);
  return sum / TSMOM_LOOKBACKS.length;
}

export function createTsmom(p: TsmomParams = DEFAULT_TSMOM): Strategy {
  const warmup = TSMOM_LOOKBACKS.at(-1)! + 2;
  return {
    name: `tsmom(${TSMOM_LOOKBACKS.join("/")}d, in ${p.entryScore} out ${p.exitScore}, atr x${p.stopAtr}${p.allowShort ? ", long+short" : ", long only"})`,
    interval: "1d",
    warmup,

    evaluate(symbol: string, candles: Candle[]): Signal | null {
      if (candles.length < warmup) return null;
      const score = tsmomScore(candles);
      if (score === null) return null;
      const c = candles.at(-1)!;
      const a = atr(candles.slice(-200), ATR_PERIOD).at(-1)!;
      if (!Number.isFinite(a) || a <= 0) return null;
      if (score >= p.entryScore) {
        return {
          symbol, side: "LONG", refPrice: c.close, stop: c.close - p.stopAtr * a, candleOpenTime: c.openTime,
          reason: `momentum score ${score.toFixed(2)} >= ${p.entryScore}`,
        };
      }
      if (p.allowShort && score <= -p.entryScore) {
        return {
          symbol, side: "SHORT", refPrice: c.close, stop: c.close + p.stopAtr * a, candleOpenTime: c.openTime,
          reason: `momentum score ${score.toFixed(2)} <= -${p.entryScore}`,
        };
      }
      return null;
    },

    updateStop(position: OpenPositionView): number {
      return position.stop;
    },

    shouldExit(position: OpenPositionView, candles: Candle[]): boolean {
      const score = tsmomScore(candles);
      if (score === null) return false;
      return position.side === "LONG" ? score <= p.exitScore : score >= -p.exitScore;
    },
  };
}
