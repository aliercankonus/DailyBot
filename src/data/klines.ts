// Historical candle download (Binance USDⓈ-M public klines) and local CSV storage.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Candle } from "../core/types.js";
import { parseKline } from "../exchange/binanceFutures.js";

export async function downloadKlines(
  symbol: string, interval: string, startMs: number, endMs: number,
  baseUrl = "https://fapi.binance.com", fetchImpl: typeof fetch = fetch,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${baseUrl}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1500`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`klines ${symbol} ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as unknown[][];
    if (!rows.length) break;
    for (const r of rows) out.push(parseKline(r));
    const next = out.at(-1)!.openTime + 1;
    if (next <= cursor) break;
    cursor = next;
    await new Promise((r) => setTimeout(r, 150)); // stay far below the weight limit
  }
  // Drop the still-forming candle and duplicates.
  const now = Date.now();
  const seen = new Set<number>();
  return out.filter((c) => c.closeTime < now && !seen.has(c.openTime) && seen.add(c.openTime));
}

const HEADER = "openTime,open,high,low,close,volume,closeTime,takerBuyVolume,openInterest";

export async function saveCsv(path: string, candles: Candle[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = candles.map((c) => [c.openTime, c.open, c.high, c.low, c.close, c.volume, c.closeTime, c.takerBuyVolume ?? "", c.openInterest ?? ""].join(",")).join("\n");
  await writeFile(path, `${HEADER}\n${body}\n`);
}

export async function loadCsv(path: string): Promise<Candle[]> {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const f = line.split(",");
      const [openTime, open, high, low, close, volume, closeTime] = f.map(Number);
      const c: Candle = { openTime: openTime!, open: open!, high: high!, low: low!, close: close!, volume: volume!, closeTime: closeTime! };
      // Optional 8th column (older CSVs have 7).
      if (f[7] !== undefined && f[7] !== "") c.takerBuyVolume = Number(f[7]);
      if (f[8] !== undefined && f[8] !== "") c.openInterest = Number(f[8]);
      return c;
    });
}

export const csvPath = (dir: string, symbol: string, interval: string) => `${dir}/${symbol}-${interval}.csv`;

/** Gaps larger than one interval indicate missing data (exchange outage or bad download). */
export function findGaps(candles: Candle[], intervalMs: number): { after: number; missing: number }[] {
  const gaps: { after: number; missing: number }[] = [];
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i]!.openTime - candles[i - 1]!.openTime;
    if (d > intervalMs) gaps.push({ after: candles[i - 1]!.openTime, missing: d / intervalMs - 1 });
  }
  return gaps;
}
