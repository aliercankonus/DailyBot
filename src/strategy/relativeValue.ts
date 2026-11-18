// Market-neutral relative value against BTC (round 10). For each alt, x = log(alt / BTC):
//  * mode "revert": z = (x - mean20) / sd20; short the alt and long BTC when z > 2, the reverse
//    when z < -2; close when z crosses 0. (Classic pairs/stat-arb rules, standard 20/2/0.)
//  * mode "trend": long the alt and short BTC when x is above its 50-day average, the reverse below.
// Each alt gets gross / (number of alts) of equity per leg; BTC carries the net offset, so the
// book is dollar-neutral. Daily, decided at the close, executed at the next open.
import type { WeightInputs, WeightStrategy } from "./weights.js";

export interface RelativeValueParams {
  lookback: number;
  entryZ: number;
  gross: number;
}

export const DEFAULT_REVERT: RelativeValueParams = { lookback: 20, entryZ: 2, gross: 1 };
export const DEFAULT_RV_TREND: RelativeValueParams = { lookback: 50, entryZ: 0, gross: 1 };

export function createRelativeValue(mode: "revert" | "trend", alts: string[], p: RelativeValueParams): WeightStrategy {
  return {
    name: `rel-value ${mode} vs BTC (${alts.join(",").replace(/USDT/g, "")}; ${p.lookback}${mode === "revert" ? `, z ${p.entryZ}` : ""})`,
    interval: "1d",
    rebalanceEvery: 1,
    weightSeries({ candles }: WeightInputs) {
      const out = new Map<number, Record<string, number>>();
      const btc = candles.BTCUSDT ?? [];
      const btcAt = new Map(btc.map((c) => [c.openTime, c.close]));
      const series = alts.filter((a) => candles[a]).map((a) => ({
        alt: a,
        x: new Map(candles[a]!.filter((c) => btcAt.has(c.openTime)).map((c) => [c.openTime, Math.log(c.close / btcAt.get(c.openTime)!)])),
        hist: [] as number[],
        pos: 0,
      }));
      const per = series.length ? p.gross / series.length : 0;
      for (const b of btc) {
        const w: Record<string, number> = { BTCUSDT: 0 };
        for (const s of series) {
          const x = s.x.get(b.openTime);
          if (x === undefined) continue;
          s.hist.push(x);
          if (s.hist.length > p.lookback) s.hist.shift();
          if (s.hist.length < p.lookback) continue;
          const mean = s.hist.reduce((a, v) => a + v, 0) / p.lookback;
          if (mode === "trend") {
            s.pos = x > mean ? 1 : x < mean ? -1 : s.pos;
          } else {
            const sd = Math.sqrt(s.hist.reduce((a, v) => a + (v - mean) ** 2, 0) / p.lookback);
            const z = sd > 0 ? (x - mean) / sd : 0;
            if (s.pos === 0 && z > p.entryZ) s.pos = -1;
            else if (s.pos === 0 && z < -p.entryZ) s.pos = 1;
            else if ((s.pos === -1 && z <= 0) || (s.pos === 1 && z >= 0)) s.pos = 0;
          }
          if (s.pos !== 0) {
            w[s.alt] = s.pos * per;
            w.BTCUSDT! -= s.pos * per;
          }
        }
        out.set(b.openTime, w);
      }
      return out;
    },
  };
}
