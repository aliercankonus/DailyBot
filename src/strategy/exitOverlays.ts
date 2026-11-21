// Exit overlays: the well-defined exit ideas from the old bot, rewritten in R units
// (R = |entry - initialStop|) as pure functions of closed candles + position state.
// In the old system they were database-only (never reached the exchange), overlapping and
// partly broken; here an overlay wraps any Strategy so it can be backtested with and without.
//
//  * break-even: once MFE >= beAt R, stop -> entry (+ a small buffer for fees).
//  * lock tiers: peak R 1/1.5/2/2.5/3/4/5 -> lock 0.25/0.5/0.75/1/1.5/2/3 R.
//  * R trailing: once the close is >= trailAt R in profit, stop -> close -/+ trailDist R.
//  * loser time stop: after loserBars candles, exit if the close is worse than -loserR R.
//  * early invalidation: after earlyBars candles, exit if MFE < 0.1 R and close <= -0.4 R.
// Stops only ever tighten: overlays take the more protective of the base and overlay stop.
import type { Candle, OpenPositionView } from "../core/types.js";
import type { Strategy, TakeProfitPlan } from "./types.js";

export interface ExitOverlay {
  breakEvenAt?: number;      // R
  breakEvenBuffer?: number;  // fraction of price, e.g. 0.002
  /** true = the old bot's table (LOCK_TIERS); or a custom table of [peak R, locked R]. */
  lockTiers?: boolean | readonly (readonly [number, number])[];
  trailAt?: number;          // R
  trailDist?: number;        // R
  loserBars?: number;
  loserR?: number;
  earlyBars?: number;
  /** Partial take-profits; executed intrabar by the backtest (see Strategy.takeProfit). */
  takeProfit?: TakeProfitPlan;
}

const LOCK_TIERS: [number, number][] = [[5, 3], [4, 2], [3, 1.5], [2.5, 1], [2, 0.75], [1.5, 0.5], [1, 0.25]];

function sinceEntry(p: OpenPositionView, candles: Candle[]) {
  return candles.filter((k) => k.openTime >= p.entryCandleOpenTime);
}

/** Maximum favourable excursion in R since entry (from highs/lows of closed candles). */
export function mfeR(p: OpenPositionView, candles: Candle[]): number {
  const r = Math.abs(p.entryPrice - p.initialStop);
  const s = sinceEntry(p, candles);
  if (!(r > 0) || !s.length) return 0;
  const best = p.side === "LONG" ? Math.max(...s.map((k) => k.high)) - p.entryPrice : p.entryPrice - Math.min(...s.map((k) => k.low));
  return best / r;
}

/** Close-based P&L in R. */
export function closeR(p: OpenPositionView, candles: Candle[]): number {
  const r = Math.abs(p.entryPrice - p.initialStop);
  const c = candles.at(-1)!.close;
  return r > 0 ? (p.side === "LONG" ? c - p.entryPrice : p.entryPrice - c) / r : 0;
}

export function overlayStop(o: ExitOverlay, p: OpenPositionView, candles: Candle[]): number {
  const r = Math.abs(p.entryPrice - p.initialStop);
  if (!(r > 0)) return p.stop;
  const dir = p.side === "LONG" ? 1 : -1;
  const tighter = (a: number, b: number) => (p.side === "LONG" ? Math.max(a, b) : Math.min(a, b));
  let stop = p.stop;
  const peak = mfeR(p, candles);
  if (o.breakEvenAt !== undefined && peak >= o.breakEvenAt) {
    stop = tighter(stop, p.entryPrice * (1 + dir * (o.breakEvenBuffer ?? 0.002)));
  }
  if (o.lockTiers) {
    const table = o.lockTiers === true ? LOCK_TIERS : [...o.lockTiers].sort((a, b) => b[0] - a[0]);
    const tier = table.find(([at]) => peak >= at);
    if (tier) stop = tighter(stop, p.entryPrice + dir * tier[1] * r);
  }
  if (o.trailAt !== undefined && o.trailDist !== undefined && closeR(p, candles) >= o.trailAt) {
    stop = tighter(stop, candles.at(-1)!.close - dir * o.trailDist * r);
  }
  return stop;
}

export function overlayExit(o: ExitOverlay, p: OpenPositionView, candles: Candle[]): boolean {
  const held = sinceEntry(p, candles).length;
  if (o.loserBars !== undefined && held >= o.loserBars && closeR(p, candles) < -(o.loserR ?? 0.5)) return true;
  if (o.earlyBars !== undefined && held >= o.earlyBars && mfeR(p, candles) < 0.1 && closeR(p, candles) <= -0.4) return true;
  return false;
}

/** Wrap a strategy with an exit overlay. The base strategy's own stop and exits still apply. */
export function withExits(base: Strategy, o: ExitOverlay, tag: string): Strategy {
  return {
    ...base,
    name: `${base.name} + ${tag}`,
    takeProfit: o.takeProfit ?? base.takeProfit,
    updateStop(p, candles) {
      const b = base.updateStop(p, candles);
      return overlayStop(o, { ...p, stop: b }, candles);
    },
    shouldExit(p, candles) {
      return (base.shouldExit?.(p, candles) ?? false) || overlayExit(o, p, candles);
    },
  };
}

/** The overlay presets tested in PROGRESS.md (translated from the old bot's % rules to R). */
export const EXIT_PRESETS: Record<string, ExitOverlay> = {
  be: { breakEvenAt: 1, breakEvenBuffer: 0.002 },
  lock: { lockTiers: true },
  trail: { trailAt: 1.2, trailDist: 0.75 },
  timestop: { loserBars: 6, loserR: 0.5, earlyBars: 3 },
  // Partial take-profits (TP1/TP2); the runner keeps the strategy's trailing stop.
  tp1: { takeProfit: { levels: [{ r: 1, fraction: 0.5 }], breakEvenAfterFirst: true } },
  tp12: { takeProfit: { levels: [{ r: 1, fraction: 1 / 3 }, { r: 2, fraction: 1 / 3 }], breakEvenAfterFirst: true } },
  tp23: { takeProfit: { levels: [{ r: 1.5, fraction: 0.4 }, { r: 3, fraction: 0.3 }], breakEvenAfterFirst: true } },
  // Stepped stop toward a 2R target (the old bot's full TP): at 50% of the target (1R) the stop
  // goes to entry, at 75% to +0.5R, at 100% to +1R, then it stays 1R behind the peak.
  step: { breakEvenAt: 1, breakEvenBuffer: 0.002, lockTiers: [[1.5, 0.5], [2, 1], [2.5, 1.5], [3, 2], [4, 3], [5, 4], [6, 5], [8, 7]] },
  // Same, 0.75R behind the peak.
  steptight: { breakEvenAt: 1, breakEvenBuffer: 0.002, lockTiers: [[1.5, 0.75], [2, 1.25], [2.5, 1.75], [3, 2.25], [4, 3.25], [5, 4.25], [6, 5.25], [8, 7.25]] },
  tp2: { takeProfit: { levels: [{ r: 2, fraction: 0.5 }], breakEvenAfterFirst: true } },
  // The old bot's ladder exactly: full TP = 2R (SL 1.5 ATR, TP 3 ATR); TP1 at 33% of the distance
  // closes 50%, TP2 at 66% closes 60% of the rest (30%), TP3 at 100% closes the last 20%.
  tpold: { takeProfit: { levels: [{ r: 0.66, fraction: 0.5 }, { r: 1.32, fraction: 0.3 }, { r: 2, fraction: 0.2 }], breakEvenAfterFirst: true } },
  // Sensitivity checks without break-even after TP1: removes the pessimistic "TP1 and break-even
  // in the same candle = stopped" assumption, so this is the most favourable case for a ladder.
  tpoldnb: { takeProfit: { levels: [{ r: 0.66, fraction: 0.5 }, { r: 1.32, fraction: 0.3 }, { r: 2, fraction: 0.2 }], breakEvenAfterFirst: false } },
  tp1nb: { takeProfit: { levels: [{ r: 1, fraction: 0.5 }], breakEvenAfterFirst: false } },
  // Round 15 (GC giveback, pre-registered from GC's MFE table: 47 of 59 trades that reached 2-3R and
  // 28 of 60 that reached 3-5R ended as losers). All are wide, so 1h noise should not stop a trend.
  // be2: stop to entry once MFE >= 2R.
  be2: { breakEvenAt: 2, breakEvenBuffer: 0.002 },
  // befee: at MFE 1R the stop goes to entry + 0.3%, enough to cover round-trip fees, slippage and funding
  // (live for A since 2026-11-21; with 0.2% about a third of break-even exits still closed slightly negative).
  befee: { breakEvenAt: 1, breakEvenBuffer: 0.003 },
  // ±20% robustness of be2's trigger.
  be2lo: { breakEvenAt: 1.6, breakEvenBuffer: 0.002 },
  be2hi: { breakEvenAt: 2.4, breakEvenBuffer: 0.002 },
  // lock3: once MFE >= 3R, lock +1R.
  lock3: { lockTiers: [[3, 1]] },
  // wide3: from 3R a stepped stop 3R behind the peak (entry at 3R, +1R at 4R, ... +17R at 20R).
  // Round 16: take one third off at 5R, the rest keeps the strategy's own exits (research only:
  // the live engine refuses takeProfit strategies).
  tp5: { takeProfit: { levels: [{ r: 5, fraction: 1 / 3 }], breakEvenAfterFirst: false } },
  wide3: { lockTiers: [[3, 0], [4, 1], [5, 2], [6, 3], [8, 5], [10, 7], [15, 12], [20, 17]] },
};
