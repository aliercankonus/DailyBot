// Indicator series. Every function returns an array aligned with the input:
// out[i] uses only inputs[0..i] (no look-ahead). Values before warm-up are NaN.
import type { Candle } from "./types.js";

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function trueRange(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1]!.close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

/** Wilder ATR. */
export function atr(candles: Candle[], period: number): number[] {
  const tr = trueRange(candles);
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i]!;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** Highest high of the `period` candles BEFORE index i (excludes candle i). */
export function priorHighest(candles: Candle[], period: number): number[] {
  return candles.map((_, i) => {
    if (i < period) return NaN;
    let m = -Infinity;
    for (let j = i - period; j < i; j++) m = Math.max(m, candles[j]!.high);
    return m;
  });
}

/** Lowest low of the `period` candles BEFORE index i (excludes candle i). */
export function priorLowest(candles: Candle[], period: number): number[] {
  return candles.map((_, i) => {
    if (i < period) return NaN;
    let m = Infinity;
    for (let j = i - period; j < i; j++) m = Math.min(m, candles[j]!.low);
    return m;
  });
}

/** Wilder RSI. */
export function rsi(values: number[], period = 14): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  let ag = gain / period;
  let al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/** Simple moving average. */
export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Bollinger bands (population standard deviation, as most charting tools use). */
export function bollinger(values: number[], period: number, mult: number): { mid: number[]; upper: number[]; lower: number[] } {
  const mid = sma(values, period);
  const upper = new Array<number>(values.length).fill(NaN);
  const lower = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j]! - mid[i]!) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = mid[i]! + mult * sd;
    lower[i] = mid[i]! - mult * sd;
  }
  return { mid, upper, lower };
}

/** Wilder ADX. First value at index 2*period - 1. */
export function adx(candles: Candle[], period = 14): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < 2 * period) return out;
  const tr = trueRange(candles);
  let trS = 0, pS = 0, mS = 0;
  const dx = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const up = candles[i]!.high - candles[i - 1]!.high;
    const down = candles[i - 1]!.low - candles[i]!.low;
    const pdm = up > down && up > 0 ? up : 0;
    const mdm = down > up && down > 0 ? down : 0;
    if (i <= period) {
      trS += tr[i]!; pS += pdm; mS += mdm;
      if (i < period) continue;
    } else {
      trS = trS - trS / period + tr[i]!;
      pS = pS - pS / period + pdm;
      mS = mS - mS / period + mdm;
    }
    const pdi = trS > 0 ? (100 * pS) / trS : 0;
    const mdi = trS > 0 ? (100 * mS) / trS : 0;
    dx[i] = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  }
  // ADX: average of the first `period` DX values, then Wilder smoothing.
  let sum = 0;
  for (let i = period; i < 2 * period; i++) sum += dx[i]!;
  let prev = sum / period;
  out[2 * period - 1] = prev;
  for (let i = 2 * period; i < n; i++) {
    prev = (prev * (period - 1) + dx[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Aggregate closed candles into a higher timeframe aligned to UTC multiples of `targetMs`.
 * Only COMPLETE buckets are returned (every sub-candle present), so a bucket that is still
 * forming never leaks into a decision.
 */
export function aggregate(candles: Candle[], sourceMs: number, targetMs: number): Candle[] {
  const per = Math.round(targetMs / sourceMs);
  const out: Candle[] = [];
  let i = 0;
  while (i < candles.length) {
    const start = Math.floor(candles[i]!.openTime / targetMs) * targetMs;
    let j = i;
    while (j < candles.length && candles[j]!.openTime < start + targetMs) j++;
    const group = candles.slice(i, j);
    if (group.length === per && group[0]!.openTime === start) {
      out.push({
        openTime: start,
        closeTime: group.at(-1)!.closeTime,
        open: group[0]!.open,
        high: Math.max(...group.map((c) => c.high)),
        low: Math.min(...group.map((c) => c.low)),
        close: group.at(-1)!.close,
        volume: group.reduce((a, c) => a + c.volume, 0),
      });
    }
    i = j;
  }
  return out;
}
