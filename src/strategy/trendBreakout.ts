// Trend-following breakout (Donchian channel + EMA trend filter + ATR stops).
// Entry: the closed candle breaks the prior N-bar high (long) or low (short)
//        while the fast EMA is on the same side of the slow EMA and price is beyond the slow EMA.
// Stop:  entry -/+ stopAtr * ATR. Then a chandelier trailing stop that only tightens.
// Parameters are listed in DEFAULT_TREND_BREAKOUT (maxAtrPct 0 = volatility filter off).
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
  /** Skip signals when ATR/price at the signal candle is at or above this (0 = off). */
  maxAtrPct: number;
  /**
   * Order-flow confirmation (0 = off): the signal candle's taker volume share on the trade's side
   * (taker buy / volume for a long, taker sell / volume for a short) must be at least this.
   * A candle without taker volume data gives no signal while the filter is on.
   */
  minTakerShare: number;
  /**
   * Open-interest confirmation in bars (0 = off): a breakout needs open interest at the signal
   * candle's close above its value oiLookback bars earlier (new positions, not short covering).
   * Research only: when either value is missing the filter does not block (live has no OI data).
   */
  oiLookback: number;
}

export const DEFAULT_TREND_BREAKOUT: TrendBreakoutParams = {
  entryLookback: 20,
  emaFast: 50,
  emaSlow: 200,
  atrPeriod: 14,
  stopAtr: 2,
  trailAtr: 3,
  maxAtrPct: 0,
  minTakerShare: 0,
  oiLookback: 0,
};

export function createTrendBreakout(p: TrendBreakoutParams = DEFAULT_TREND_BREAKOUT): Strategy {
  const warmup = Math.max(p.emaSlow, p.entryLookback + 1, p.atrPeriod) + 1;

  return {
    name: `trend-breakout(${p.entryLookback},${p.emaFast}/${p.emaSlow},atr${p.atrPeriod}x${p.stopAtr}/${p.trailAtr}${p.maxAtrPct > 0 ? `,atr<${p.maxAtrPct * 100}%` : ""}${p.minTakerShare > 0 ? `,taker>=${p.minTakerShare}` : ""}${p.oiLookback > 0 ? `,oi>${p.oiLookback}b` : ""})`,
    interval: "4h",
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
      // Volatility filter: breakouts in very volatile conditions were losers in both periods (PROGRESS.md, round 7).
      if (p.maxAtrPct > 0 && a / c.close >= p.maxAtrPct) return null;

      const buyShare = takerBuyShare(c);
      const oiNow = c.openInterest, oiThen = candles[i - p.oiLookback]?.openInterest;
      const oiOk = p.oiLookback <= 0 || oiNow === undefined || oiThen === undefined || oiNow > oiThen;
      const flowOk = (side: "LONG" | "SHORT") =>
        oiOk && (p.minTakerShare <= 0 || (buyShare !== null && (side === "LONG" ? buyShare : 1 - buyShare) >= p.minTakerShare));

      if (c.close > hi && fast > slow && c.close > slow && flowOk("LONG")) {
        return {
          symbol,
          side: "LONG",
          refPrice: c.close,
          stop: c.close - p.stopAtr * a,
          candleOpenTime: c.openTime,
          reason: `close ${c.close} > ${p.entryLookback}-bar high ${hi}; ema${p.emaFast} > ema${p.emaSlow}`,
        };
      }
      if (c.close < lo && fast < slow && c.close < slow && flowOk("SHORT")) {
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

    explain(candles: Candle[]): string {
      if (candles.length < warmup) return `warming up (${candles.length}/${warmup} candles)`;
      const i = candles.length - 1;
      const c = candles[i]!.close;
      const closes = candles.map((k) => k.close);
      const fast = ema(closes, p.emaFast)[i]!;
      const slow = ema(closes, p.emaSlow)[i]!;
      const a = atr(candles, p.atrPeriod)[i]!;
      const hi = priorHighest(candles, p.entryLookback)[i]!;
      const lo = priorLowest(candles, p.entryLookback)[i]!;
      const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
      const trend = fast > slow && c > slow ? "up" : fast < slow && c < slow ? "down" : "mixed";
      const parts = [
        `close ${fmt(c)}`,
        `trend ${trend} (ema${p.emaFast} ${fmt(fast)} vs ema${p.emaSlow} ${fmt(slow)})`,
        `${p.entryLookback}-bar high ${fmt(hi)} (${pct(hi / c - 1)} away), low ${fmt(lo)} (${pct(1 - lo / c)} away)`,
      ];
      const bs = takerBuyShare(candles[i]!);
      if (p.minTakerShare > 0) parts.push(`taker buy ${bs === null ? "n/a" : pct(bs)} (needs >= ${pct(p.minTakerShare)} on the trade side)`);
      if (p.maxAtrPct > 0) parts.push(`atr ${pct(a / c)} (${a / c >= p.maxAtrPct ? "BLOCKED" : "ok"}, max ${pct(p.maxAtrPct)})`);
      const wait = trend === "up" ? "long needs close above the high" : trend === "down" ? "short needs close below the low" : "no trade until the EMAs and price agree";
      return `${parts.join("; ")}; ${wait}`;
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

/** Compact price for diagnostics (4 significant digits below 1, else 2 decimals). */
export const fmt = (x: number) => (Math.abs(x) < 1 ? x.toPrecision(4) : x.toFixed(2));

/** Taker buy volume / volume of a candle, or null when the data is missing. */
export function takerBuyShare(c: Candle): number | null {
  if (c.takerBuyVolume === undefined || !Number.isFinite(c.takerBuyVolume) || !(c.volume > 0)) return null;
  return c.takerBuyVolume / c.volume;
}
