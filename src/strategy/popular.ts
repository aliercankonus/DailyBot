// The most recommended public strategies (YouTube/TradingView/blogs/papers), coded with the
// settings their sources publish. Nothing here is tuned on our data: the point is to test the
// claims as stated. Sources and the rules as published are listed in PROGRESS.md (round 9).
// All are pure functions of CLOSED candles, like every other strategy.
import { atr, ema, highestHigh, linreg, lowestLow, macd, priorHighest, priorLowest, rsi, sma, supertrend } from "../core/indicators.js";
import type { Candle, OpenPositionView, Side, Signal } from "../core/types.js";
import { fmt } from "./trendBreakout.js";
import type { Strategy } from "./types.js";

const H = 3_600_000;

function sig(symbol: string, side: Side, c: Candle, stop: number, reason: string): Signal {
  return { symbol, side, refPrice: c.close, stop, candleOpenTime: c.openTime, reason };
}
const held = (p: OpenPositionView, candles: Candle[]) => candles.filter((k) => k.openTime >= p.entryCandleOpenTime).length;
const tighten = (p: OpenPositionView, s: number) =>
  !Number.isFinite(s) ? p.stop : p.side === "LONG" ? Math.max(p.stop, s) : Math.min(p.stop, s);

/** P1 Supertrend(10, 3): enter on a direction flip, the Supertrend line is the trailing stop. */
export function createSupertrend(interval: "4h" | "1d", period = 10, mult = 3): Strategy {
  return {
    name: `supertrend(${period},${mult}) ${interval}`, interval, warmup: period + 2,
    evaluate(symbol, candles) {
      const i = candles.length - 1;
      if (i < this.warmup) return null;
      const st = supertrend(candles, period, mult);
      const d = st.dir[i]!, pd = st.dir[i - 1]!;
      if (!Number.isFinite(pd) || d === pd) return null;
      return sig(symbol, d === 1 ? "LONG" : "SHORT", candles[i]!, st.line[i]!, `supertrend flip ${d === 1 ? "up" : "down"}`);
    },
    updateStop(p, candles) {
      return tighten(p, supertrend(candles, period, mult).line.at(-1)!);
    },
    shouldExit(p, candles) {
      const d = supertrend(candles, period, mult).dir.at(-1)!;
      return p.side === "LONG" ? d === -1 : d === 1;
    },
  };
}

/** P2 MACD(12,26,9) cross in the direction of EMA200; exit on the opposite cross; 2.5 ATR stop. */
export function createMacd200(): Strategy {
  return {
    name: "macd(12,26,9)+ema200 4h", interval: "4h", warmup: 230,
    evaluate(symbol, candles) {
      const i = candles.length - 1;
      if (i < this.warmup) return null;
      const cl = candles.map((k) => k.close);
      const m = macd(cl), e = ema(cl, 200)[i]!, a = atr(candles, 14)[i]!;
      const up = m.macd[i - 1]! <= m.signal[i - 1]! && m.macd[i]! > m.signal[i]!;
      const dn = m.macd[i - 1]! >= m.signal[i - 1]! && m.macd[i]! < m.signal[i]!;
      const c = candles[i]!;
      if (up && c.close > e && m.macd[i]! < 0) return sig(symbol, "LONG", c, c.close - 2.5 * a, "macd cross up below zero, above ema200");
      if (dn && c.close < e && m.macd[i]! > 0) return sig(symbol, "SHORT", c, c.close + 2.5 * a, "macd cross down above zero, below ema200");
      return null;
    },
    updateStop: (p) => p.stop,
    shouldExit(p, candles) {
      const m = macd(candles.map((k) => k.close));
      const i = candles.length - 1;
      return p.side === "LONG" ? m.macd[i]! < m.signal[i]! : m.macd[i]! > m.signal[i]!;
    },
  };
}

/** P3 LazyBear Squeeze Momentum: BB(20,2) inside KC(20,1.5) releases; trade the momentum sign; exit when momentum turns. */
export function createSqueezeLazyBear(): Strategy {
  const mom = (candles: Candle[]) => {
    const cl = candles.map((k) => k.close);
    const hh = highestHigh(candles, 20), ll = lowestLow(candles, 20), m = sma(cl, 20);
    return linreg(cl.map((c, i) => c - ((hh[i]! + ll[i]!) / 2 + m[i]!) / 2), 20);
  };
  const sqzOn = (candles: Candle[], i: number) => {
    const cl = candles.map((k) => k.close);
    const m = sma(cl, 20)[i]!;
    let v = 0;
    for (let j = i - 19; j <= i; j++) v += (cl[j]! - m) ** 2;
    const sd = Math.sqrt(v / 20);
    let tr = 0;
    for (let j = i - 19; j <= i; j++) {
      const k = candles[j]!, pc = candles[j - 1]!.close;
      tr += Math.max(k.high - k.low, Math.abs(k.high - pc), Math.abs(k.low - pc));
    }
    const range = tr / 20;
    return m - 2 * sd > m - 1.5 * range && m + 2 * sd < m + 1.5 * range;
  };
  return {
    name: "squeeze-momentum(lazybear) 4h", interval: "4h", warmup: 60,
    evaluate(symbol, candles) {
      const i = candles.length - 1;
      if (i < this.warmup) return null;
      if (!(sqzOn(candles, i - 1) && !sqzOn(candles, i))) return null;
      const v = mom(candles), a = atr(candles, 14)[i]!, c = candles[i]!;
      if (v[i]! > 0 && v[i]! > v[i - 1]!) return sig(symbol, "LONG", c, c.close - 2 * a, "squeeze fired, momentum up");
      if (v[i]! < 0 && v[i]! < v[i - 1]!) return sig(symbol, "SHORT", c, c.close + 2 * a, "squeeze fired, momentum down");
      return null;
    },
    updateStop: (p) => p.stop,
    shouldExit(p, candles) {
      const v = mom(candles), i = candles.length - 1;
      return p.side === "LONG" ? v[i]! < v[i - 1]! : v[i]! > v[i - 1]!;
    },
  };
}

/** P4 Ichimoku(9,26,52) daily: price beyond the cloud, Tenkan/Kijun cross, Chikou confirms; Kijun trails. */
export function createIchimoku(): Strategy {
  const lines = (candles: Candle[]) => {
    const t = (n: number) => { const h = highestHigh(candles, n), l = lowestLow(candles, n); return h.map((x, i) => (x + l[i]!) / 2); };
    return { tenkan: t(9), kijun: t(26), b52: t(52) };
  };
  return {
    name: "ichimoku(9,26,52) 1d", interval: "1d", warmup: 80,
    evaluate(symbol, candles) {
      const i = candles.length - 1;
      if (i < this.warmup) return null;
      const { tenkan, kijun, b52 } = lines(candles);
      const spanA = (tenkan[i - 26]! + kijun[i - 26]!) / 2, spanB = b52[i - 26]!;
      const top = Math.max(spanA, spanB), bot = Math.min(spanA, spanB);
      const c = candles[i]!, a = atr(candles, 14)[i]!;
      const crossUp = tenkan[i - 1]! <= kijun[i - 1]! && tenkan[i]! > kijun[i]!;
      const crossDn = tenkan[i - 1]! >= kijun[i - 1]! && tenkan[i]! < kijun[i]!;
      if (crossUp && c.close > top && c.close > candles[i - 26]!.close) return sig(symbol, "LONG", c, Math.min(kijun[i]!, c.close - 2 * a), "tenkan>kijun above cloud");
      if (crossDn && c.close < bot && c.close < candles[i - 26]!.close) return sig(symbol, "SHORT", c, Math.max(kijun[i]!, c.close + 2 * a), "tenkan<kijun below cloud");
      return null;
    },
    updateStop(p, candles) {
      return tighten(p, lines(candles).kijun.at(-1)!);
    },
  };
}

/** P5 Padysak & Vojtko (2022): long when the close is a 10-day maximum or minimum, hold one day. */
export function createMaxMin10(): Strategy {
  return {
    name: "btc-max-min-10d (padysak-vojtko) 1d", interval: "1d", warmup: 20,
    evaluate(symbol, candles) {
      const i = candles.length - 1;
      if (i < this.warmup) return null;
      const cl = candles.slice(i - 9, i + 1).map((k) => k.close);
      const c = candles[i]!, a = atr(candles, 14)[i]!;
      if (c.close >= Math.max(...cl)) return sig(symbol, "LONG", c, c.close - 3 * a, "10-day max");
      if (c.close <= Math.min(...cl)) return sig(symbol, "LONG", c, c.close - 3 * a, "10-day min");
      return null;
    },
    updateStop: (p) => p.stop,
    shouldExit: (p, candles) => held(p, candles) >= 1,
  };
}

/** P6 Larry Williams volatility breakout, K = 0.5, on 1h candles: trigger = day open ± K × yesterday's range; out at the day's end. */
export function createVolBreakout(k = 0.5): Strategy {
  return {
    name: `volatility-breakout(k=${k}) 1h`, interval: "1h", warmup: 50,
    evaluate(symbol, candles) {
      const i = candles.length - 1;
      if (i < this.warmup) return null;
      const c = candles[i]!;
      const day = Math.floor(c.openTime / (24 * H));
      if (new Date(c.openTime).getUTCHours() === 23) return null; // no entry in the last hour
      const today = candles.filter((x, j) => j >= i - 48 && Math.floor(x.openTime / (24 * H)) === day);
      const yest = candles.filter((x, j) => j >= i - 48 && Math.floor(x.openTime / (24 * H)) === day - 1);
      if (yest.length < 24 || !today.length || new Date(today[0]!.openTime).getUTCHours() !== 0) return null;
      const range = Math.max(...yest.map((x) => x.high)) - Math.min(...yest.map((x) => x.low));
      const open = today[0]!.open;
      const longT = open + k * range, shortT = open - k * range;
      const pc = candles[i - 1]!.close;
      if (range <= 0) return null;
      if (c.close > longT && pc <= longT) return sig(symbol, "LONG", c, open, "close above open + k*range");
      if (c.close < shortT && pc >= shortT) return sig(symbol, "SHORT", c, open, "close below open - k*range");
      return null;
    },
    updateStop: (p) => p.stop,
    shouldExit: (_p, candles) => new Date(candles.at(-1)!.openTime).getUTCHours() === 23,
  };
}

/** P7 Bitcoin intraday seasonality (Quantpedia summary of Padysak & Vojtko): long 21:00-23:00 UTC. */
export function createNightSeason(): Strategy {
  return {
    name: "intraday-season 21-23utc 1h", interval: "1h", warmup: 30,
    evaluate(symbol, candles) {
      const c = candles.at(-1)!;
      if (candles.length < this.warmup || new Date(c.openTime).getUTCHours() !== 20) return null;
      const a = atr(candles, 24).at(-1)!;
      return sig(symbol, "LONG", c, c.close - 3 * a, "buy 21:00 utc");
    },
    updateStop: (p) => p.stop,
    shouldExit: (_p, candles) => new Date(candles.at(-1)!.openTime).getUTCHours() === 22,
  };
}

/** P8 Turtle System 2: 55-day breakout, 2N stop, exit on the 20-day opposite breakout. */
export function createTurtle55(): Strategy {
  return {
    name: "turtle-s2(55/20, 2N) 1d", interval: "1d", warmup: 60,
    evaluate(symbol, candles) {
      const i = candles.length - 1;
      if (i < this.warmup) return null;
      const c = candles[i]!, n = atr(candles, 20)[i]!;
      if (c.close > priorHighest(candles, 55)[i]!) return sig(symbol, "LONG", c, c.close - 2 * n, "55-day high");
      if (c.close < priorLowest(candles, 55)[i]!) return sig(symbol, "SHORT", c, c.close + 2 * n, "55-day low");
      return null;
    },
    updateStop: (p) => p.stop,
    shouldExit(p, candles) {
      const i = candles.length - 1, c = candles[i]!;
      return p.side === "LONG" ? c.close < priorLowest(candles, 20)[i]! : c.close > priorHighest(candles, 20)[i]!;
    },
  };
}

/** P9 Golden / death cross EMA 50/200 daily, always in the market; 3 ATR catastrophic stop. */
export interface GoldenCrossExits {
  /** Chandelier trail: extreme since entry -/+ trailAtr x ATR(14) of the strategy interval (0 = off). Round 14. */
  trailAtr?: number;
  /** Chandelier trail on DAILY volatility: extreme since entry -/+ dailyTrailAtr x daily ATR(14) built from the candles (0 = off). Round 16. */
  dailyTrailAtr?: number;
  /** Once MFE >= emaExitAfterR (in R), exit when the close crosses EMA50 against the position (0 = off). Round 16. */
  emaExitAfterR?: number;
}

/** Simple ATR(n) of complete UTC days built from intraday candles (null with fewer than n+1 days). */
export function dailyAtr(candles: Candle[], n = 14): number | null {
  const DAY = 86_400_000;
  const days: { d: number; h: number; l: number; c: number }[] = [];
  for (const k of candles) {
    const d = Math.floor(k.openTime / DAY);
    const last = days.at(-1);
    if (last && last.d === d) {
      last.h = Math.max(last.h, k.high); last.l = Math.min(last.l, k.low); last.c = k.close;
    } else days.push({ d, h: k.high, l: k.low, c: k.close });
  }
  // Drop the last day unless its final candle closes at the end of that UTC day.
  const lastC = candles.at(-1);
  if (lastC && days.length && lastC.closeTime + 1 < (days.at(-1)!.d + 1) * DAY) days.pop();
  if (days.length < n + 1) return null;
  let sum = 0;
  for (let i = days.length - n; i < days.length; i++) {
    const d = days[i]!, prev = days[i - 1]!.c;
    sum += Math.max(d.h - d.l, Math.abs(d.h - prev), Math.abs(d.l - prev));
  }
  return sum / n;
}

export function createGoldenCross(interval: "1h" | "4h" | "1d" = "1d", exits: GoldenCrossExits | number = {}): Strategy {
  const o: GoldenCrossExits = typeof exits === "number" ? { trailAtr: exits } : exits;
  const trailAtr = o.trailAtr ?? 0, dailyTrailAtr = o.dailyTrailAtr ?? 0, emaExitAfterR = o.emaExitAfterR ?? 0;
  const tags = [trailAtr > 0 ? ` trail ${trailAtr}atr` : "", dailyTrailAtr > 0 ? ` trail ${dailyTrailAtr}x daily atr` : "", emaExitAfterR > 0 ? ` ema50 exit after ${emaExitAfterR}R` : ""].join("");
  const extremes = (p: OpenPositionView, candles: Candle[]) => {
    let hh = -Infinity, ll = Infinity;
    for (let j = candles.length - 1; j >= 0 && candles[j]!.openTime >= p.entryCandleOpenTime; j--) {
      hh = Math.max(hh, candles[j]!.high);
      ll = Math.min(ll, candles[j]!.low);
    }
    return { hh, ll };
  };
  return {
    name: `golden-cross(ema50/200) ${interval}${tags}`, interval, warmup: 210,
    evaluate(symbol, candles) {
      const i = candles.length - 1;
      if (i < this.warmup) return null;
      const cl = candles.map((k) => k.close);
      const f = ema(cl, 50), s = ema(cl, 200), c = candles[i]!, a = atr(candles, 14)[i]!;
      if (f[i - 1]! <= s[i - 1]! && f[i]! > s[i]!) return sig(symbol, "LONG", c, c.close - 3 * a, "golden cross");
      if (f[i - 1]! >= s[i - 1]! && f[i]! < s[i]!) return sig(symbol, "SHORT", c, c.close + 3 * a, "death cross");
      return null;
    },
    explain(candles) {
      const i = candles.length - 1;
      if (i < 210) return `warming up (${candles.length}/211 candles)`;
      const cl = candles.map((k) => k.close);
      const f = ema(cl, 50)[i]!, s = ema(cl, 200)[i]!, gap = (f / s - 1) * 100;
      const side = f > s ? "above" : "below";
      return `ema50 ${fmt(f)} ${side} ema200 ${fmt(s)} (gap ${gap.toFixed(2)}%); trades only on the bar where ema50 crosses ema200 (next: ${f > s ? "death cross -> short" : "golden cross -> long"})`;
    },
    updateStop(p, candles) {
      if (trailAtr <= 0 && dailyTrailAtr <= 0) return p.stop;
      const { hh, ll } = extremes(p, candles);
      if (!Number.isFinite(hh)) return p.stop;
      let stop = p.stop;
      if (trailAtr > 0) {
        const a = atr(candles, 14)[candles.length - 1];
        if (a !== undefined && Number.isFinite(a)) stop = tighten({ ...p, stop }, p.side === "LONG" ? hh - trailAtr * a : ll + trailAtr * a);
      }
      if (dailyTrailAtr > 0) {
        const d = dailyAtr(candles);
        if (d !== null && d > 0) stop = tighten({ ...p, stop }, p.side === "LONG" ? hh - dailyTrailAtr * d : ll + dailyTrailAtr * d);
      }
      return stop;
    },
    shouldExit(p, candles) {
      const cl = candles.map((k) => k.close), i = cl.length - 1;
      const e50 = ema(cl, 50), f = e50[i]!, s = ema(cl, 200)[i]!;
      if (p.side === "LONG" ? f < s : f > s) return true;
      if (emaExitAfterR > 0) {
        const r = Math.abs(p.entryPrice - p.initialStop);
        const { hh, ll } = extremes(p, candles);
        const mfe = r > 0 ? (p.side === "LONG" ? hh - p.entryPrice : p.entryPrice - ll) / r : 0;
        if (mfe >= emaExitAfterR && (p.side === "LONG" ? cl[i]! < f : cl[i]! > f)) return true;
      }
      return false;
    },
  };
}

/** P10 Connors RSI(2): buy RSI2 < 10 above SMA200, exit above SMA5 (short mirrored). */
export function createConnorsRsi2(): Strategy {
  return {
    name: "connors-rsi2 1d", interval: "1d", warmup: 210,
    evaluate(symbol, candles) {
      const i = candles.length - 1;
      if (i < this.warmup) return null;
      const cl = candles.map((k) => k.close);
      const r = rsi(cl, 2)[i]!, s200 = sma(cl, 200)[i]!, c = candles[i]!, a = atr(candles, 14)[i]!;
      if (c.close > s200 && r < 10) return sig(symbol, "LONG", c, c.close - 3 * a, "rsi2 < 10 above sma200");
      if (c.close < s200 && r > 90) return sig(symbol, "SHORT", c, c.close + 3 * a, "rsi2 > 90 below sma200");
      return null;
    },
    updateStop: (p) => p.stop,
    shouldExit(p, candles) {
      const cl = candles.map((k) => k.close), i = cl.length - 1, s5 = sma(cl, 5)[i]!;
      return p.side === "LONG" ? cl[i]! > s5 : cl[i]! < s5;
    },
  };
}

/**
 * P11 "Self-Improving AI Trader" guide baseline: long while SMA20 > SMA50 on 1h candles, else cash.
 * Enter on the cross up, exit on the cross down; a 3 ATR catastrophic stop (the guide has none).
 */
export function createMa2050(): Strategy {
  return {
    name: "ma20/50 long-only 1h (guide baseline)", interval: "1h", warmup: 60,
    evaluate(symbol, candles) {
      const i = candles.length - 1;
      if (i < this.warmup) return null;
      const cl = candles.map((k) => k.close);
      const f = sma(cl, 20), s = sma(cl, 50), c = candles[i]!, a = atr(candles, 14)[i]!;
      if (f[i - 1]! <= s[i - 1]! && f[i]! > s[i]!) return sig(symbol, "LONG", c, c.close - 3 * a, "sma20 crossed above sma50");
      return null;
    },
    updateStop: (p) => p.stop,
    shouldExit(_p, candles) {
      const cl = candles.map((k) => k.close), i = cl.length - 1;
      return sma(cl, 20)[i]! < sma(cl, 50)[i]!;
    },
  };
}
