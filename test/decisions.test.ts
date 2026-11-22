import { describe, expect, it } from "vitest";
import { decisionTags, distinctReasons, reasonTemplate } from "../src/report/decisions.js";

describe("distinct decision reasons", () => {
  it("collapses candles with the same reason and keeps the latest example", () => {
    const rows = [
      { symbol: "BTCUSDT", gate: "NO_SIGNAL", candleOpenTime: 2, detail: "momentum score -0.78 (entry >= 0.6); up vs 1/9 lookbacks [5]" },
      { symbol: "BTCUSDT", gate: "NO_SIGNAL", candleOpenTime: 1, detail: "momentum score -0.56 (entry >= 0.6); up vs 2/9 lookbacks [5,10]" },
      { symbol: "BTCUSDT", gate: "NO_SIGNAL", candleOpenTime: 3, detail: "atr 3.15% (BLOCKED, max 3.00%)" },
      { symbol: "ETHUSDT", gate: "NO_SIGNAL", candleOpenTime: 3, detail: "atr 2.55% (ok, max 3.00%)" },
    ];
    const g = distinctReasons(rows);
    expect(g).toHaveLength(3);
    expect(g[0]).toMatchObject({ symbol: "BTCUSDT", count: 2, firstCandle: 1, lastCandle: 2 });
    expect(g[0]!.example).toContain("-0.78");
    expect(reasonTemplate("atr 3.15% (BLOCKED, max 3.00%)")).toBe("atr #% (BLOCKED, max #%)");
  });
});

describe("decision tags", () => {
  it("tags the reasons a candle carries", () => {
    expect(decisionTags("trend down; atr 3.15% (BLOCKED, max 3.00%); funding -0.01% (BLOCKED: short side crowded); short needs close below the low")).toEqual(["funding block", "atr block"]);
    expect(decisionTags("trend down; break 0.10 ATR; BLOCKED: weak break (close 1 below the low but above 0.9 = low - 0.25 ATR); short needs close below the low by 0.25 ATR")).toEqual(["weak break"]);
    expect(decisionTags("trend down; atr 2.4% (ok, max 3.00%); short needs close below the low")).toEqual(["no break"]);
    expect(decisionTags("momentum score -0.56 (entry >= 0.6)")).toEqual(["other"]);
  });
});
