// Cleaned versions of ideas from the old bot (dailytradingbot), reviewed 2026-11-18.
// In the old system these were either dead code (never reached a trade) or buried under
// dozens of gates. Here each is a pure function of closed candles with <= 6 parameters,
// symmetric long/short, next-open fills in the backtest. See PROGRESS.md for results.
import { atr, bollinger, ema, priorHighest, priorLowest, rsi } from "../core/indicators.js";
import type { Candle, OpenPositionView, Signal } from "../core/types.js";
import type { Strategy } from "./types.js";

const heldBars = (p: OpenPositionView, candles: Candle[]) => candles.filter((k) => k.openTime >= p.entryCandleOpenTime).length;
const lastAtr = (candles: Candle[], period = 14) => atr(candles.slice(-200), period).at(-1)!;

// ---------------------------------------------------------------------------
// S1: failed-breakout reversal (old "liquidity sweep" module), daily.
// A bar pierces the prior N-bar low but closes back above it, in the upper part of its range -> long.
// Mirror at the prior N-bar high -> short. Stop beyond the sweep extreme. Exit at the channel
// midpoint or after maxBars.
export interface FailedBreakoutParams { lookback: number; stopBuffer: number; closeRank: number; maxBars: number }
export const DEFAULT_FAILED_BREAKOUT: FailedBreakoutParams = { lookback: 20, stopBuffer: 0.5, closeRank: 0.5, maxBars: 10 };

export function createFailedBreakout(p: FailedBreakoutParams = DEFAULT_FAILED_BREAKOUT): Strategy {
  const warmup = Math.max(p.lookback + 2, 20);
  const channel = (candles: Candle[]) => {
    const tail = candles.slice(-(p.lookback + 1));
    return { lo: priorLowest(tail, p.lookback).at(-1)!, hi: priorHighest(tail, p.lookback).at(-1)! };
  };
  return {
    name: `failed-breakout(${p.lookback}d, stop +${p.stopBuffer} ATR, close rank ${p.closeRank}, ${p.maxBars} bars)`,
    interval: "1d",
    warmup,
    evaluate(symbol, candles): Signal | null {
      if (candles.length < warmup) return null;
      const c = candles.at(-1)!;
      const { lo, hi } = channel(candles);
      const range = c.high - c.low;
      const a = lastAtr(candles);
      if (!(range > 0) || !Number.isFinite(a) || a <= 0) return null;
      if (c.low < lo && c.close > lo && (c.close - c.low) / range >= p.closeRank) {
        return { symbol, side: "LONG", refPrice: c.close, stop: c.low - p.stopBuffer * a, candleOpenTime: c.openTime,
          reason: `swept ${p.lookback}d low ${lo} and closed back above` };
      }
      if (c.high > hi && c.close < hi && (c.high - c.close) / range >= p.closeRank) {
        return { symbol, side: "SHORT", refPrice: c.close, stop: c.high + p.stopBuffer * a, candleOpenTime: c.openTime,
          reason: `swept ${p.lookback}d high ${hi} and closed back below` };
      }
      return null;
    },
    updateStop: (pos) => pos.stop,
    shouldExit(pos, candles) {
      if (heldBars(pos, candles) >= p.maxBars) return true;
      const { lo, hi } = channel(candles);
      const mid = (lo + hi) / 2;
      const close = candles.at(-1)!.close;
      return pos.side === "LONG" ? close >= mid : close <= mid;
    },
  };
}

// ---------------------------------------------------------------------------
// S2: volatility squeeze breakout (what the old SQUEEZE_BREAKOUT meant to be), 4h.
// Squeeze = Bollinger width at or below its `pct` percentile of the previous `pctLookback` bars,
// at any time in the last 5 bars. Then a close outside the band enters in that direction.
// Stop stopAtr * ATR, chandelier trail at trailAtr * ATR (never loosens).
export interface SqueezeParams { bbPeriod: number; bbStd: number; pct: number; pctLookback: number; stopAtr: number; trailAtr: number }
export const DEFAULT_SQUEEZE: SqueezeParams = { bbPeriod: 20, bbStd: 2, pct: 0.2, pctLookback: 120, stopAtr: 2, trailAtr: 3 };

export function createSqueezeBreakout(p: SqueezeParams = DEFAULT_SQUEEZE): Strategy {
  const warmup = p.bbPeriod + p.pctLookback + 6;
  return {
    name: `squeeze-breakout(bb${p.bbPeriod}x${p.bbStd}, width<=p${p.pct * 100} of ${p.pctLookback}, atr ${p.stopAtr}/${p.trailAtr})`,
    interval: "4h",
    warmup,
    evaluate(symbol, candles): Signal | null {
      if (candles.length < warmup) return null;
      const closes = candles.slice(-(warmup)).map((k) => k.close);
      const bb = bollinger(closes, p.bbPeriod, p.bbStd);
      const width = bb.mid.map((m, i) => (Number.isFinite(m) && m > 0 ? (bb.upper[i]! - bb.lower[i]!) / m : NaN));
      const n = width.length;
      let squeezed = false;
      for (let k = n - 6; k < n - 1 && !squeezed; k++) {
        const hist = width.slice(k - p.pctLookback, k).filter(Number.isFinite).sort((a, b) => a - b);
        if (hist.length < p.pctLookback * 0.9) continue;
        const cut = hist[Math.floor(p.pct * (hist.length - 1))]!;
        if (width[k]! <= cut) squeezed = true;
      }
      if (!squeezed) return null;
      const c = candles.at(-1)!;
      const a = lastAtr(candles);
      if (!Number.isFinite(a) || a <= 0) return null;
      if (c.close > bb.upper.at(-1)!) {
        return { symbol, side: "LONG", refPrice: c.close, stop: c.close - p.stopAtr * a, candleOpenTime: c.openTime, reason: "squeeze then close above upper band" };
      }
      if (c.close < bb.lower.at(-1)!) {
        return { symbol, side: "SHORT", refPrice: c.close, stop: c.close + p.stopAtr * a, candleOpenTime: c.openTime, reason: "squeeze then close below lower band" };
      }
      return null;
    },
    updateStop(pos, candles) {
      const a = lastAtr(candles);
      if (!Number.isFinite(a)) return pos.stop;
      const since = candles.filter((k) => k.openTime >= pos.entryCandleOpenTime);
      if (!since.length) return pos.stop;
      if (pos.side === "LONG") return Math.max(pos.stop, Math.max(...since.map((k) => k.high)) - p.trailAtr * a);
      return Math.min(pos.stop, Math.min(...since.map((k) => k.low)) + p.trailAtr * a);
    },
  };
}

// ---------------------------------------------------------------------------
// S3: capitulation / blow-off reversal (old flash-crash, capitulation, exhaustion probes), daily.
// A drop of at least k * ATR over dropBars, then an up-closing bar -> long. Mirror -> short.
// Stop below the low of the move minus stopBuffer * ATR. Exit at entry + target * ATR or after maxBars.
export interface CapitulationParams { dropBars: number; k: number; stopBuffer: number; target: number; maxBars: number }
export const DEFAULT_CAPITULATION: CapitulationParams = { dropBars: 3, k: 3, stopBuffer: 0.5, target: 2, maxBars: 5 };

export function createCapitulation(p: CapitulationParams = DEFAULT_CAPITULATION): Strategy {
  const warmup = 30;
  return {
    name: `capitulation(${p.dropBars} bars >= ${p.k} ATR, target ${p.target} ATR, ${p.maxBars} bars)`,
    interval: "1d",
    warmup,
    evaluate(symbol, candles): Signal | null {
      if (candles.length < warmup) return null;
      const n = candles.length;
      const c = candles[n - 1]!;
      const a = atr(candles.slice(-200, -1), 14).at(-1)!; // ATR before the signal bar
      if (!Number.isFinite(a) || a <= 0) return null;
      const before = candles[n - 2 - p.dropBars]!.close; // close before the move
      const moveEnd = candles[n - 2]!.close;
      const window = candles.slice(n - 1 - p.dropBars, n);
      const move = moveEnd - before;
      if (move <= -p.k * a && c.close > c.open) {
        const low = Math.min(...window.map((k) => k.low));
        return { symbol, side: "LONG", refPrice: c.close, stop: low - p.stopBuffer * a, candleOpenTime: c.openTime,
          reason: `${p.dropBars}-bar drop ${(move / a).toFixed(1)} ATR, then an up close` };
      }
      if (move >= p.k * a && c.close < c.open) {
        const high = Math.max(...window.map((k) => k.high));
        return { symbol, side: "SHORT", refPrice: c.close, stop: high + p.stopBuffer * a, candleOpenTime: c.openTime,
          reason: `${p.dropBars}-bar rally ${(move / a).toFixed(1)} ATR, then a down close` };
      }
      return null;
    },
    updateStop: (pos) => pos.stop,
    shouldExit(pos, candles) {
      if (heldBars(pos, candles) >= p.maxBars) return true;
      const a = lastAtr(candles);
      const close = candles.at(-1)!.close;
      return pos.side === "LONG" ? close >= pos.entryPrice + p.target * a : close <= pos.entryPrice - p.target * a;
    },
  };
}

// ---------------------------------------------------------------------------
// S4: pullback in trend, daily (B moved off 1h; covers the old trend-follower templates' intent).
// Trend: close > EMA(slow) and EMA(fast) > EMA(slow). Entry when RSI(3) < rsiEntry (short: mirror).
// Stop stopAtr * ATR. Exit when RSI(3) recovers past 70 (short: below 30) or after maxBars.
export interface DailyPullbackParams { emaFast: number; emaSlow: number; rsiEntry: number; stopAtr: number; maxBars: number }
export const DEFAULT_DAILY_PULLBACK: DailyPullbackParams = { emaFast: 20, emaSlow: 100, rsiEntry: 15, stopAtr: 2.5, maxBars: 10 };

export function createDailyPullback(p: DailyPullbackParams = DEFAULT_DAILY_PULLBACK): Strategy {
  const warmup = p.emaSlow + 5;
  const rsi3 = (candles: Candle[]) => rsi(candles.slice(-60).map((k) => k.close), 3).at(-1)!;
  return {
    name: `daily-pullback(ema${p.emaFast}/${p.emaSlow}, rsi3<${p.rsiEntry}, atr x${p.stopAtr}, ${p.maxBars} bars)`,
    interval: "1d",
    warmup,
    evaluate(symbol, candles): Signal | null {
      if (candles.length < warmup) return null;
      const closes = candles.map((k) => k.close);
      const fast = ema(closes, p.emaFast).at(-1)!;
      const slow = ema(closes, p.emaSlow).at(-1)!;
      const r = rsi3(candles);
      const a = lastAtr(candles);
      const c = candles.at(-1)!;
      if (![fast, slow, r, a].every(Number.isFinite) || a <= 0) return null;
      if (c.close > slow && fast > slow && r < p.rsiEntry) {
        return { symbol, side: "LONG", refPrice: c.close, stop: c.close - p.stopAtr * a, candleOpenTime: c.openTime, reason: `up-trend pullback, rsi3 ${r.toFixed(1)}` };
      }
      if (c.close < slow && fast < slow && r > 100 - p.rsiEntry) {
        return { symbol, side: "SHORT", refPrice: c.close, stop: c.close + p.stopAtr * a, candleOpenTime: c.openTime, reason: `down-trend bounce, rsi3 ${r.toFixed(1)}` };
      }
      return null;
    },
    updateStop: (pos) => pos.stop,
    shouldExit(pos, candles) {
      if (heldBars(pos, candles) >= p.maxBars) return true;
      const r = rsi3(candles);
      return pos.side === "LONG" ? r > 70 : r < 30;
    },
  };
}
