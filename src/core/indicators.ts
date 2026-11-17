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
