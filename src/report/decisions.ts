// Distinct "why no order" reasons from the signals table (decision log): every number in the detail
// is replaced by '#', so candles that failed for the same reason collapse into one line with a count,
// the first and last candle, and the most recent concrete example.

export interface DecisionRow {
  symbol: string;
  gate: string | null;
  detail: string;
  candleOpenTime: number;
}

export interface DecisionGroup {
  symbol: string;
  gate: string;
  template: string;
  count: number;
  firstCandle: number;
  lastCandle: number;
  example: string;
}

export const reasonTemplate = (detail: string) =>
  detail.replace(/\[[\d,\s]*\]/g, "[#]").replace(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi, "#");

export function distinctReasons(rows: DecisionRow[]): DecisionGroup[] {
  const groups = new Map<string, DecisionGroup>();
  for (const r of [...rows].sort((a, b) => a.candleOpenTime - b.candleOpenTime)) {
    const gate = r.gate ?? "-";
    const template = reasonTemplate(r.detail);
    const key = `${r.symbol}\u0000${gate}\u0000${template}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.lastCandle = r.candleOpenTime;
      g.example = r.detail;
    } else {
      groups.set(key, { symbol: r.symbol, gate, template, count: 1, firstCandle: r.candleOpenTime, lastCandle: r.candleOpenTime, example: r.detail });
    }
  }
  return [...groups.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || b.count - a.count);
}
