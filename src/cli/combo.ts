// npm run combo -- --legs "trendlv+timestop:0.5,donchianls:0.5" [--dir data] [--split 2025-01-01]
// Runs each leg over all data with its own default symbols, interval and risk (catalog), then
// prints each leg and the daily-rebalanced portfolio: full period, from --split, yearly, and the
// correlation of the legs' daily returns. The "from split" block is the full-run curve from that
// date (positions open at the split carry over), not a fresh out-of-sample run.
import { existsSync } from "node:fs";
import { DEFAULT_BACKTEST, type BacktestConfig } from "../backtest/engine.js";
import { getCatalogEntry } from "../backtest/catalog.js";
import { blend, correlation, rebaseFrom, type Curve } from "../backtest/combine.js";
import { equityMetrics, formatEquity } from "../backtest/metrics.js";
import type { Candle } from "../core/types.js";
import { attachFunding, fundingCsvPath, loadFundingCsv } from "../data/funding.js";
import { csvPath, loadCsv } from "../data/klines.js";
import type { FundingPoint } from "../exchange/types.js";
import { dateMs, parseArgs, str } from "./args.js";

const a = parseArgs();
const dir = str(a.dir, "data");
const split = dateMs(str(a.split, "2025-01-01"));
const legs = str(a.legs, "").split(",").filter(Boolean).map((s) => {
  const [name, w] = s.split(":");
  const weight = Number(w ?? "1");
  if (!name || !Number.isFinite(weight) || weight < 0) throw new Error(`bad leg "${s}" (use name:weight)`);
  return { name, weight };
});
if (!legs.length) throw new Error('--legs "a:0.5,b:0.5" is required');

const curves: Curve[] = [];
for (const leg of legs) {
  const entry = getCatalogEntry(leg.name);
  const data: Record<string, Candle[]> = {};
  const fundingRates: Record<string, FundingPoint[]> = {};
  for (const s of entry.defaultSymbols) {
    const k = csvPath(dir, s, entry.interval);
    if (!existsSync(k)) continue;
    let candles = await loadCsv(k);
    const f = fundingCsvPath(dir, s);
    if (existsSync(f)) {
      fundingRates[s] = await loadFundingCsv(f);
      if (entry.needsFunding) candles = attachFunding(candles, fundingRates[s]!);
    }
    data[s] = candles;
  }
  const cfg: BacktestConfig = {
    ...DEFAULT_BACKTEST, riskPerTrade: entry.defaultRisk, maxOpenPositions: entry.defaultMaxOpen,
    ...(Object.keys(fundingRates).length ? { fundingRates } : {}),
  };
  const res = entry.run(entry.defaults, data, cfg);
  curves.push(res.equityCurve);
  const full = equityMetrics(res.equityCurve);
  const oos = equityMetrics(rebaseFrom(res.equityCurve, split));
  console.log(`== leg ${leg.name} (${entry.label}), weight ${leg.weight}, ${entry.interval}, ${Object.keys(data).length} symbols ==`);
  console.log(`full: ${formatEquity(full)}`);
  console.log(`from split: CAGR ${(oos.cagr * 100).toFixed(1)}%  Sharpe ${oos.sharpe.toFixed(2)}  max DD ${(oos.maxDrawdownPct * 100).toFixed(1)}%\n`);
}

for (let i = 0; i < curves.length; i++) {
  for (let j = i + 1; j < curves.length; j++) {
    console.log(`correlation of daily returns ${legs[i]!.name} vs ${legs[j]!.name}: ${correlation(curves[i]!, curves[j]!).toFixed(2)}`);
  }
}
const combo = blend(curves, legs.map((l) => l.weight));
const full = equityMetrics(combo);
const oos = equityMetrics(rebaseFrom(combo, split));
console.log(`\n== PORTFOLIO ${legs.map((l) => `${l.name}:${l.weight}`).join(" + ")} (daily rebalanced) ==`);
console.log(`full: ${formatEquity(full)}`);
console.log(`from split: ${formatEquity(oos)}`);
