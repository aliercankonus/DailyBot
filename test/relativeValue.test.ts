import { describe, expect, it } from "vitest";
import { createRelativeValue, DEFAULT_REVERT, DEFAULT_RV_TREND } from "../src/strategy/relativeValue.js";
import { candlesFromCloses } from "./helpers.js";

const D1 = 86_400_000;
const T0 = Date.UTC(2023, 0, 1);

describe("relative value vs BTC", () => {
  const btc = candlesFromCloses(Array.from({ length: 80 }, () => 100), T0, D1);
  // ETH/BTC flat with noise, then a spike up on day 60 (z > 2), then back to normal.
  const ethCloses = Array.from({ length: 80 }, (_, i) => 50 * (1 + 0.002 * Math.sin(i)));
  ethCloses[60] = 56;
  const eth = candlesFromCloses(ethCloses, T0, D1);

  it("shorts the alt and longs BTC on a spike, dollar-neutral, and closes when z crosses 0", () => {
    const w = createRelativeValue("revert", ["ETHUSDT"], DEFAULT_REVERT).weightSeries({ candles: { BTCUSDT: btc, ETHUSDT: eth }, funding: {} });
    const at60 = w.get(eth[60]!.openTime)!;
    expect(at60.ETHUSDT).toBeCloseTo(-1);
    expect(at60.BTCUSDT).toBeCloseTo(1);
    expect(w.get(eth[61]!.openTime)!.ETHUSDT ?? 0).toBe(0); // back below the mean
  });

  it("has no look-ahead: weights up to t do not change when later candles change", () => {
    const s = createRelativeValue("trend", ["ETHUSDT"], DEFAULT_RV_TREND);
    const a = s.weightSeries({ candles: { BTCUSDT: btc, ETHUSDT: eth }, funding: {} });
    const eth2 = candlesFromCloses([...ethCloses.slice(0, 70), ...ethCloses.slice(70).map((x) => x * 3)], T0, D1);
    const b = s.weightSeries({ candles: { BTCUSDT: btc, ETHUSDT: eth2 }, funding: {} });
    for (let i = 0; i < 70; i++) expect(b.get(eth[i]!.openTime)).toEqual(a.get(eth[i]!.openTime));
  });
});
