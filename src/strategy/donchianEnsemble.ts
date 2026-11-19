// Strategy G: daily Donchian ensemble with trailing midpoint stops and volatility targeting.
// Follows the rules summarised from Zarattini, Pagani & Barbon (2025) "Catching Crypto Trends":
//  * Nine independent sub-systems, one per lookback L in LOOKBACKS (5..360 days).
//  * Sub-system L goes long when the daily close exceeds the highest close of the previous L days.
//  * Its stop trails: stop = max(previous stop, (highest close + lowest close) / 2 over the previous L days).
//    The sub-system exits when a daily close falls below its stop. (Checked on the close; executed next open.)
//  * Coin exposure fraction f = active sub-systems / 9. Raw weight = f / realizedVol(volLookback): equal risk per coin.
//  * The whole raw portfolio is scaled so its realised volatility over the last 60 invested days equals
//    volTarget (portfolio-level volatility targeting); total gross is capped at maxGross.
//  * Long only by default (the paper is long only); allowShort mirrors the rules for shorts.
// Live note: the exits are close-based. Live trading would add a wide exchange-side catastrophic stop.
import type { Candle } from "../core/types.js";
import { atr } from "../core/indicators.js";
import { realizedVol, type WeightInputs, type WeightStrategy } from "./weights.js";

export const DONCHIAN_LOOKBACKS = [5, 10, 20, 30, 60, 90, 150, 250, 360] as const;
const PORT_VOL_LOOKBACK = 60;
const PORT_VOL_MIN_SAMPLES = 20;

export interface DonchianEnsembleParams {
  volTarget: number;
  volLookback: number;
  maxGross: number;
  allowShort: number; // 0 | 1
  /**
   * Largest loss per leg, as a fraction of equity, if the live engine's catastrophic stop
   * (CATASTROPHIC_ATR x ATR14, at most 50% of price) is hit: |w| <= maxLegRisk / stopDistance.
   * 0 = off (the published strategy). 0.02 applies the project's 2% per-trade rule to each leg.
   */
  maxLegRisk?: number;
}

/** Must match WeightsEngine catastrophicAtr / ATR period, so the cap describes the real stop. */
export const CATASTROPHIC_ATR = 4;
export const CATASTROPHIC_ATR_PERIOD = 14;

export const DEFAULT_DONCHIAN_ENSEMBLE: DonchianEnsembleParams = {
  volTarget: 0.25,
  volLookback: 90,
  maxGross: 2,
  allowShort: 0,
};

/** Max (or min) of values[i-L .. i-1] for each i (excludes i). O(n) monotonic deque. NaN until L values exist. */
export function priorRollingExtreme(values: number[], L: number, kind: "max" | "min"): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const dq: number[] = []; // indices, values monotonic
  const better = kind === "max" ? (a: number, b: number) => a >= b : (a: number, b: number) => a <= b;
  for (let i = 0; i < values.length; i++) {
    if (i >= L) out[i] = values[dq[0]!]!;
    // add i for future windows
    while (dq.length && better(values[i]!, values[dq.at(-1)!]!)) dq.pop();
    dq.push(i);
    while (dq[0]! <= i - L) dq.shift();
  }
  return out;
}

/** Net active fraction in [-1, 1] per bar for one symbol's closes. Pure function of closes[0..i]. */
export function ensembleFraction(closes: number[], allowShort: boolean): number[] {
  const n = closes.length;
  const frac = new Array<number>(n).fill(0);
  for (const L of DONCHIAN_LOOKBACKS) {
    const hi = priorRollingExtreme(closes, L, "max");
    const lo = priorRollingExtreme(closes, L, "min");
    let state = 0; // 1 long, -1 short, 0 flat
    let stop = NaN;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(hi[i]!)) continue;
      const mid = (hi[i]! + lo[i]!) / 2;
      const c = closes[i]!;
      if (state === 1) {
        stop = Math.max(stop, mid);
        if (c < stop) state = 0;
      } else if (state === -1) {
        stop = Math.min(stop, mid);
        if (c > stop) state = 0;
      }
      if (state === 0) {
        if (c > hi[i]!) { state = 1; stop = mid; }
        else if (allowShort && c < lo[i]!) { state = -1; stop = mid; }
      }
      frac[i] = frac[i]! + state / DONCHIAN_LOOKBACKS.length;
    }
  }
  return frac;
}

export function createDonchianEnsemble(p: DonchianEnsembleParams = DEFAULT_DONCHIAN_ENSEMBLE): WeightStrategy {
  return {
    name: `donchian-ensemble(${DONCHIAN_LOOKBACKS.join("/")}d, vol ${p.volTarget} over ${p.volLookback}d, gross<=${p.maxGross}${p.allowShort ? ", long+short" : ", long only"}${p.maxLegRisk ? `, leg risk<=${p.maxLegRisk * 100}%` : ""})`,
    interval: "1d",
    rebalanceEvery: 1,
    maxGross: p.maxGross,
    ...(p.maxLegRisk ? { maxLegRisk: p.maxLegRisk } : {}),

    weightSeries({ candles }: WeightInputs) {
      const symbols = Object.keys(candles);
      const N = symbols.length;
      // 1) Risk-parity raw weights: ensemble fraction / coin volatility (equal risk per coin).
      const raw = new Map<number, Record<string, number>>();
      const closeAt = new Map<number, Record<string, number>>();
      const stopAt = new Map<number, Record<string, number>>();
      for (const s of symbols) {
        const cs: Candle[] = candles[s]!;
        const closes = cs.map((c) => c.close);
        const frac = ensembleFraction(closes, p.allowShort === 1);
        const atrs = p.maxLegRisk ? atr(cs, CATASTROPHIC_ATR_PERIOD) : [];
        for (let i = 0; i < cs.length; i++) {
          const vol = realizedVol(closes, i, p.volLookback);
          const t = cs[i]!.openTime;
          if (!raw.has(t)) { raw.set(t, {}); closeAt.set(t, {}); stopAt.set(t, {}); }
          raw.get(t)![s] = Number.isFinite(vol) && vol > 0 ? frac[i]! / vol : 0;
          closeAt.get(t)![s] = closes[i]!;
          if (p.maxLegRisk) {
            const a = atrs[i];
            // Same distance the engine uses: 4 x ATR, at most half the price.
            stopAt.get(t)![s] = a !== undefined && Number.isFinite(a) && a > 0 ? Math.min((CATASTROPHIC_ATR * a) / closes[i]!, 0.5) : 0.5;
          }
        }
      }
      // 2) Portfolio-level volatility targeting: scale the whole raw portfolio so its realised
      //    volatility over the last PORT_VOL_LOOKBACK invested days equals volTarget. Uses only
      //    returns up to and including t. Until enough history exists, fall back to volTarget / N per coin.
      const perTime = new Map<number, Record<string, number>>();
      const rets: number[] = [];
      let prevRaw: Record<string, number> | null = null;
      let prevClose: Record<string, number> | null = null;
      for (const t of [...raw.keys()].sort((a, b) => a - b)) {
        const r = raw.get(t)!;
        const c = closeAt.get(t)!;
        if (prevRaw && prevClose) {
          let ret = 0;
          let invested = false;
          for (const [s, w] of Object.entries(prevRaw)) {
            if (w === 0 || c[s] === undefined || prevClose[s] === undefined) continue;
            ret += w * (c[s]! / prevClose[s]! - 1);
            invested = true;
          }
          if (invested) rets.push(ret);
        }
        const window = rets.slice(-PORT_VOL_LOOKBACK);
        let scale = p.volTarget / N;
        if (window.length >= PORT_VOL_MIN_SAMPLES) {
          const mean = window.reduce((a, b) => a + b, 0) / window.length;
          const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length) * Math.sqrt(365);
          if (sd > 0) scale = p.volTarget / sd;
        }
        const w: Record<string, number> = {};
        for (const [s, x] of Object.entries(r)) w[s] = x * scale;
        const gross = Object.values(w).reduce((a, x) => a + Math.abs(x), 0);
        if (gross > p.maxGross) for (const k of Object.keys(w)) w[k] = (w[k]! * p.maxGross) / gross;
        if (p.maxLegRisk) {
          const st = stopAt.get(t)!;
          for (const k of Object.keys(w)) {
            const cap = p.maxLegRisk / (st[k] ?? 0.5);
            if (Math.abs(w[k]!) > cap) w[k] = Math.sign(w[k]!) * cap;
          }
        }
        perTime.set(t, w);
        prevRaw = r;
        prevClose = { ...(prevClose ?? {}), ...c };
      }
      return perTime;
    },
  };
}
