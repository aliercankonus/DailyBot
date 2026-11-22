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

/** Why-no-order categories for the trend breakout (A); one candle can carry several. */
export function decisionTags(detail: string): string[] {
  const tags: string[] = [];
  if (/BLOCKED: weak break/.test(detail)) tags.push("weak break");
  if (/BLOCKED: \w+ side crowded/.test(detail)) tags.push("funding block");
  if (/atr [\d.]+% \(BLOCKED/.test(detail)) tags.push("atr block");
  if (/trend mixed/.test(detail)) tags.push("no trend");
  if (!tags.length && /needs close (above|below)/.test(detail)) tags.push("no break");
  return tags.length ? tags : ["other"];
}

export function tagCounts(rows: DecisionRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) for (const t of decisionTags(r.detail)) out[t] = (out[t] ?? 0) + 1;
  return out;
}
