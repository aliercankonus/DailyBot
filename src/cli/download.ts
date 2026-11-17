// npm run download -- --symbols BTCUSDT,ETHUSDT --interval 4h --from 2021-01-01 [--to 2026-11-01] [--dir data]
// npm run download -- --funding --from 2021-01-01   (funding-rate history instead of candles)
import { INTERVAL_MS } from "../config.js";
import { csvPath, downloadKlines, findGaps, saveCsv } from "../data/klines.js";
import { downloadFunding, fundingCsvPath, saveFundingCsv } from "../data/funding.js";
import { dateMs, parseArgs, str } from "./args.js";

const a = parseArgs();
const symbols = str(a.symbols, "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT").split(",");
const interval = str(a.interval, "4h");
const from = dateMs(str(a.from, "2021-01-01"));
const to = a.to ? dateMs(str(a.to, "")) : Date.now();
const dir = str(a.dir, "data");

if (a.funding) {
  for (const s of symbols) {
    const pts = await downloadFunding(s, from, to);
    await saveFundingCsv(fundingCsvPath(dir, s), pts);
    console.log(`${s}: ${pts.length} funding settlements -> ${fundingCsvPath(dir, s)}`);
  }
  process.exit(0);
}

for (const s of symbols) {
  const candles = await downloadKlines(s, interval, from, to);
  const path = csvPath(dir, s, interval);
  await saveCsv(path, candles);
  const gaps = findGaps(candles, INTERVAL_MS[interval] ?? 0);
  console.log(`${s}: ${candles.length} candles -> ${path}${gaps.length ? ` (WARNING: ${gaps.length} gaps)` : ""}`);
}
