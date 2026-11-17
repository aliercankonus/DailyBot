// Strategy D: funding-rate crowding (contrarian + carry), 1h candles.
// When the funding rate is extreme versus its own recent history, one side is crowded:
//   funding z-score >= zEntry and funding > 0  -> SHORT (longs are crowded; shorts also COLLECT funding)
//   funding z-score <= -zEntry and funding < 0 -> LONG  (shorts are crowded; longs collect funding)
// Decisions are made only on the candle that carries a newly settled rate (every 8h).
// Exit: |z| back below zExit at a later settlement, or after maxBars candles. Stop: stopAtr * ATR(14), fixed.
import { atr } from "../core/indicators.js";
import type { Candle, OpenPositionView, Signal } from "../core/types.js";
import type { Strategy } from "./types.js";

export interface FundingParams {
  lookback: number; // settlements (3 per day)
  zEntry: number;
  zExit: number;
  stopAtr: number;
  maxBars: number;
}

export const DEFAULT_FUNDING: FundingParams = {
  lookback: 90, // 30 days
  zEntry: 2,
  zExit: 0.5,
  stopAtr: 2,
  maxBars: 48,
};

const EIGHT_HOURS = 8 * 3_600_000;
const ATR_PERIOD = 14;

/** Settled rates as seen by the candles: one value per 8h, taken from the candle that opens at a settlement. */
export function settlementSeries(candles: Candle[]): { time: number; rate: number }[] {
  return candles
    .filter((c) => c.openTime % EIGHT_HOURS === 0 && c.fundingRate !== undefined)
    .map((c) => ({ time: c.openTime, rate: c.fundingRate! }));
}

/** z-score of the latest settlement versus the `lookback` settlements before it. */
export function fundingZ(candles: Candle[], lookback: number): { z: number; rate: number; at: number } | null {
  const s = settlementSeries(candles);
  if (s.length < lookback + 1) return null;
  const cur = s.at(-1)!;
  const hist = s.slice(-lookback - 1, -1).map((x) => x.rate);
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length);
  if (!(sd > 0)) return null;
  return { z: (cur.rate - mean) / sd, rate: cur.rate, at: cur.time };
}

export function createFunding(p: FundingParams = DEFAULT_FUNDING): Strategy {
  // lookback settlements * 8 candles each, plus margin.
  const warmup = (p.lookback + 2) * 8;
  return {
    name: `funding(z${p.zEntry}/${p.zExit} over ${p.lookback}, atr x${p.stopAtr}, ${p.maxBars} bars)`,
    interval: "1h",
    needsFunding: true,
    warmup,

    evaluate(symbol: string, candles: Candle[]): Signal | null {
      if (candles.length < warmup) return null;
      const c = candles.at(-1)!;
      if (c.openTime % EIGHT_HOURS !== 0) return null; // only act on new information
      const f = fundingZ(candles, p.lookback);
      if (!f || f.at !== c.openTime) return null;
      const a = atr(candles.slice(-200), ATR_PERIOD).at(-1)!;
      if (!Number.isFinite(a) || a <= 0) return null;
      const pct = (x: number) => `${(x * 100).toFixed(4)}%`;
      if (f.z >= p.zEntry && f.rate > 0) {
        return {
          symbol, side: "SHORT", refPrice: c.close, stop: c.close + p.stopAtr * a, candleOpenTime: c.openTime,
          reason: `funding ${pct(f.rate)}/8h, z ${f.z.toFixed(2)} >= ${p.zEntry}: longs crowded`,
        };
      }
      if (f.z <= -p.zEntry && f.rate < 0) {
        return {
          symbol, side: "LONG", refPrice: c.close, stop: c.close - p.stopAtr * a, candleOpenTime: c.openTime,
          reason: `funding ${pct(f.rate)}/8h, z ${f.z.toFixed(2)} <= -${p.zEntry}: shorts crowded`,
        };
      }
      return null;
    },

    updateStop(position: OpenPositionView): number {
      return position.stop;
    },

    shouldExit(position: OpenPositionView, candles: Candle[]): boolean {
      const held = candles.filter((k) => k.openTime >= position.entryCandleOpenTime).length;
      if (held >= p.maxBars) return true;
      const c = candles.at(-1)!;
      if (c.openTime % EIGHT_HOURS !== 0) return false;
      const f = fundingZ(candles, p.lookback);
      return f !== null && f.at === c.openTime && Math.abs(f.z) <= p.zExit;
    },
  };
}
