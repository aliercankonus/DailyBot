import { describe, expect, it } from "vitest";
import { highestHigh, linreg, lowestLow, macd, supertrend } from "../src/core/indicators.js";
import type { Candle, OpenPositionView } from "../src/core/types.js";
import {
  createConnorsRsi2, createGoldenCross, createIchimoku, createMacd200, createMaxMin10, createNightSeason,
  createSqueezeLazyBear, createSupertrend, createTurtle55, createVolBreakout,
} from "../src/strategy/popular.js";
import type { Strategy } from "../src/strategy/types.js";
import { candlesFromCloses } from "./helpers.js";

const H1 = 3_600_000, H4 = 4 * H1, D1 = 24 * H1;
const T0 = Date.UTC(2023, 0, 1);

describe("new indicators have no look-ahead", () => {
  const closes = Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 7) * 8 + Math.cos(i / 3));
  const a = candlesFromCloses(closes, T0, H4);
  const b = candlesFromCloses([...closes.slice(0, 300), ...closes.slice(300).map((x) => x * 2)], T0, H4);
  it.each([60, 150, 299])("index %i unchanged by future candles", (i) => {
    expect(supertrend(b, 10, 3).line[i]).toBe(supertrend(a, 10, 3).line[i]);
    expect(supertrend(b, 10, 3).dir[i]).toBe(supertrend(a, 10, 3).dir[i]);
    expect(macd(b.map((c) => c.close)).signal[i]).toBe(macd(a.map((c) => c.close)).signal[i]);
    expect(linreg(b.map((c) => c.close), 20)[i]).toBe(linreg(a.map((c) => c.close), 20)[i]);
    expect(highestHigh(b, 20)[i]).toBe(highestHigh(a, 20)[i]);
    expect(lowestLow(b, 20)[i]).toBe(lowestLow(a, 20)[i]);
  });

  it("linreg of a straight line is the line", () => {
    expect(linreg([1, 2, 3, 4, 5], 3)[4]).toBeCloseTo(5);
  });

  it("supertrend is up in a rising market and down in a falling one", () => {
    const up = candlesFromCloses(Array.from({ length: 100 }, (_, i) => 100 * 1.01 ** i), T0, H4);
    const dn = candlesFromCloses(Array.from({ length: 100 }, (_, i) => 100 * 0.99 ** i), T0, H4);
    expect(supertrend(up, 10, 3).dir.at(-1)).toBe(1);
    expect(supertrend(dn, 10, 3).dir.at(-1)).toBe(-1);
    expect(supertrend(up, 10, 3).line.at(-1)!).toBeLessThan(up.at(-1)!.close);
  });
});

function firstSignal(s: Strategy, c: Candle[]) {
  for (let i = s.warmup; i <= c.length; i++) {
    const x = s.evaluate("X", c.slice(0, i));
    if (x) return { i: i - 1, sig: x };
  }
  return null;
}

/** Long decline, then a strong rise: every trend system should flip long at some point. */
const vShape = (n = 300, interval = H4) => candlesFromCloses([
  ...Array.from({ length: n }, (_, i) => 200 * 0.997 ** i),
  ...Array.from({ length: n }, (_, i) => 200 * 0.997 ** n * 1.006 ** i),
], T0, interval, 0.003);

describe("popular strategies", () => {
  it.each([
    ["supertrend 4h", createSupertrend("4h")],
    ["supertrend 1d", createSupertrend("1d")],
    ["turtle", createTurtle55()],
    ["golden cross", createGoldenCross()],
  ] as [string, Strategy][])("%s goes long after the turn, with a stop below the price", (_n, s) => {
    const c = vShape(300, s.interval === "1d" ? D1 : H4);
    const hits: string[] = [];
    for (let i = s.warmup; i <= c.length; i++) {
      const x = s.evaluate("X", c.slice(0, i));
      if (x) {
        hits.push(x.side);
        if (x.side === "LONG") expect(x.stop).toBeLessThan(x.refPrice);
        else expect(x.stop).toBeGreaterThan(x.refPrice);
      }
    }
    expect(hits).toContain("LONG");
  });

  it("supertrend exits when the direction flips and only tightens its stop", () => {
    const s = createSupertrend("4h");
    const c = vShape();
    const pos: OpenPositionView = { side: "SHORT", entryPrice: 150, stop: 1000, initialStop: 1000, entryCandleOpenTime: c[100]!.openTime };
    expect(s.shouldExit!(pos, c)).toBe(true); // the series ends in an up-trend
    expect(s.updateStop(pos, c)).toBeLessThanOrEqual(1000);
  });

  it("max-min 10d buys a 10-day high and exits after one day", () => {
    const s = createMaxMin10();
    const c = candlesFromCloses(Array.from({ length: 40 }, (_, i) => 100 + i), T0, D1);
    const x = s.evaluate("X", c);
    expect(x?.side).toBe("LONG");
    const pos: OpenPositionView = { side: "LONG", entryPrice: 140, stop: 130, initialStop: 130, entryCandleOpenTime: c.at(-1)!.openTime };
    expect(s.shouldExit!(pos, c)).toBe(true);
    expect(s.shouldExit!({ ...pos, entryCandleOpenTime: c.at(-1)!.openTime + D1 }, c)).toBe(false);
  });

  it("volatility breakout triggers above open + 0.5 x yesterday's range and exits at 23:00", () => {
    const s = createVolBreakout();
    const start = Date.UTC(2024, 0, 1);
    // day 0 and day 1: range 98..102 (4). Day 2 opens at 100; trigger 102. Hour 5 closes at 103.
    const k: Candle[] = [];
    for (let h = 0; h < 48; h++) k.push({ openTime: start + h * H1, closeTime: start + (h + 1) * H1 - 1, open: 100, high: 102, low: 98, close: 100, volume: 1 });
    for (let h = 0; h < 5; h++) k.push({ openTime: start + (48 + h) * H1, closeTime: start + (49 + h) * H1 - 1, open: 100, high: 101, low: 99.5, close: 100.5, volume: 1 });
    k.push({ openTime: start + 53 * H1, closeTime: start + 54 * H1 - 1, open: 100.5, high: 103.5, low: 100.4, close: 103, volume: 1 });
    const x = s.evaluate("X", k);
    expect(x?.side).toBe("LONG");
    expect(x!.stop).toBe(100);
    const at23 = [...k.slice(0, 48), { ...k[0]!, openTime: start + 71 * H1 }];
    expect(s.shouldExit!({ side: "LONG", entryPrice: 103, stop: 100, initialStop: 100, entryCandleOpenTime: 0 }, at23)).toBe(true);
  });

  it("intraday season buys after the 20:00 candle and exits after the 22:00 candle", () => {
    const s = createNightSeason();
    const start = Date.UTC(2024, 0, 1);
    const c = candlesFromCloses(Array.from({ length: 45 }, () => 100), start, H1); // last candle opens 20:00 on day 2
    expect(new Date(c.at(-1)!.openTime).getUTCHours()).toBe(20);
    expect(s.evaluate("X", c)?.side).toBe("LONG");
    expect(s.evaluate("X", c.slice(0, -1))).toBeNull();
    const c22 = candlesFromCloses(Array.from({ length: 47 }, () => 100), start, H1);
    expect(s.shouldExit!({ side: "LONG", entryPrice: 100, stop: 90, initialStop: 90, entryCandleOpenTime: 0 }, c22)).toBe(true);
  });

  it("connors rsi2 buys a sharp dip above the 200-day average and exits above the 5-day average", () => {
    const s = createConnorsRsi2();
    const up = Array.from({ length: 250 }, (_, i) => 100 * 1.003 ** i);
    const dip = [...up, up.at(-1)! * 0.96, up.at(-1)! * 0.92];
    const c = candlesFromCloses(dip, T0, D1);
    expect(s.evaluate("X", c)?.side).toBe("LONG");
    const rec = candlesFromCloses([...dip, up.at(-1)! * 1.02], T0, D1);
    expect(s.shouldExit!({ side: "LONG", entryPrice: 100, stop: 90, initialStop: 90, entryCandleOpenTime: 0 }, rec)).toBe(true);
  });

  it("macd, squeeze and ichimoku produce valid signals on a trending series", () => {
    for (const s of [createMacd200(), createSqueezeLazyBear(), createIchimoku()]) {
      const c = candlesFromCloses(Array.from({ length: 600 }, (_, i) => 100 * 1.002 ** i + Math.sin(i / 5) * 3), T0, s.interval === "1d" ? D1 : H4, 0.004);
      const hit = firstSignal(s, c);
      if (hit) {
        if (hit.sig.side === "LONG") expect(hit.sig.stop).toBeLessThan(hit.sig.refPrice);
        else expect(hit.sig.stop).toBeGreaterThan(hit.sig.refPrice);
      }
    }
  });
});
