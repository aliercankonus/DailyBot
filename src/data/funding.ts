// Funding-rate history: download, CSV storage, and attaching it to candles without look-ahead.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Candle } from "../core/types.js";
import type { FundingPoint } from "../exchange/types.js";

export async function downloadFunding(
  symbol: string, startMs: number, endMs: number,
  baseUrl = "https://fapi.binance.com", fetchImpl: typeof fetch = fetch,
): Promise<FundingPoint[]> {
  const out: FundingPoint[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${baseUrl}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`fundingRate ${symbol} ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as { fundingTime: number | string; fundingRate: string }[];
    if (!rows.length) break;
    for (const r of rows) out.push({ time: Number(r.fundingTime), rate: Number(r.fundingRate) });
    const next = out.at(-1)!.time + 1;
    if (next <= cursor || rows.length < 1000) break;
    cursor = next;
    await new Promise((r) => setTimeout(r, 200));
  }
  const seen = new Set<number>();
  return out.filter((f) => !seen.has(f.time) && seen.add(f.time)).sort((a, b) => a.time - b.time);
}

export const fundingCsvPath = (dir: string, symbol: string) => `${dir}/${symbol}-funding.csv`;

export async function saveFundingCsv(path: string, pts: FundingPoint[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `time,rate\n${pts.map((p) => `${p.time},${p.rate}`).join("\n")}\n`);
}

export async function loadFundingCsv(path: string): Promise<FundingPoint[]> {
  const text = await readFile(path, "utf8");
  return text.trim().split("\n").slice(1).map((l) => {
    const [time, rate] = l.split(",").map(Number);
    return { time: time!, rate: rate! };
  });
}

/**
 * Returns copies of the candles with `fundingRate` = the last rate settled at or before each
 * candle's close. A settlement after the close is never visible to that candle.
 */
export function attachFunding(candles: Candle[], funding: FundingPoint[]): Candle[] {
  const pts = [...funding].sort((a, b) => a.time - b.time);
  let j = -1;
  return candles.map((c) => {
    while (j + 1 < pts.length && pts[j + 1]!.time <= c.closeTime) j++;
    return j >= 0 ? { ...c, fundingRate: pts[j]!.rate } : { ...c };
  });
}
