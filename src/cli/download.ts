// npm run download -- --symbols BTCUSDT,ETHUSDT --interval 4h --from 2021-01-01 [--to 2026-11-01] [--dir data]
import { INTERVAL_MS } from "../config.js";
import { csvPath, downloadKlines, findGaps, saveCsv } from "../data/klines.js";
import { dateMs, parseArgs, str } from "./args.js";

const a = parseArgs();
const symbols = str(a.symbols, "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT").split(",");
const interval = str(a.interval, "4h");
const from = dateMs(str(a.from, "2021-01-01"));
const to = a.to ? dateMs(str(a.to, "")) : Date.now();
const dir = str(a.dir, "data");

for (const s of symbols) {
  const candles = await downloadKlines(s, interval, from, to);
  const path = csvPath(dir, s, interval);
  await saveCsv(path, candles);
  const gaps = findGaps(candles, INTERVAL_MS[interval] ?? 0);
  console.log(`${s}: ${candles.length} candles -> ${path}${gaps.length ? ` (WARNING: ${gaps.length} gaps)` : ""}`);
}
