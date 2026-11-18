// npm run backtest -- --strategy trend|pullback|meanrev|funding|tsmom|xsmom --split 2025-01-01
//   [--symbols ...] [--risk 0.01] [--max-open 3] [--from ...] [--to ...] [--robustness]
//   [--dd-scale] [--loss-streak]   (risk modifiers, single-symbol strategies only)
//   [--max-same-dir 2] [--cooldown 3]   (portfolio rules: same-side cap, re-entry bars after a stop)
//   [--analyze]   (loss attribution over all data: exit, side, hold time, MFE, regime, worst months)
// Defaults for symbols, risk and max-open come from the strategy (src/backtest/catalog.ts).
//
// Prints in-sample (before --split) and out-of-sample (from --split) results separately.
// Only the out-of-sample block is judged against the acceptance criteria.
// --robustness re-runs out-of-sample with every parameter moved ±20%.
import type { Candle } from "../core/types.js";
import { DEFAULT_BACKTEST, type BacktestConfig } from "../backtest/engine.js";
import { getCatalogEntry } from "../backtest/catalog.js";
import { acceptance, computeMetrics, equityAcceptance, equityMetrics, formatEquity, formatMetrics, formatProfitFactor, groupBy, perturbParam, yearlyConsistency } from "../backtest/metrics.js";
import { lossReport } from "../backtest/analysis.js";
import { csvPath, loadCsv } from "../data/klines.js";
import { attachFunding, fundingCsvPath, loadFundingCsv } from "../data/funding.js";
import type { FundingPoint } from "../exchange/types.js";
import { existsSync } from "node:fs";
import { STRATEGY_WINDOW } from "../strategy/types.js";
import { dateMs, parseArgs, str } from "./args.js";

const a = parseArgs();
/** Optional whole-number flag >= 1; a bad value is an error, not a silent "block everything". */
function positiveInt(flag: string): number | undefined {
  if (a[flag] === undefined) return undefined;
  const n = Number(str(a[flag], ""));
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${flag} needs a whole number >= 1`);
  return n;
}
const strategyName = str(a.strategy, "trend");
const entry = getCatalogEntry(strategyName);
const symbols = typeof a.symbols === "string" ? a.symbols.split(",") : entry.defaultSymbols;
const DEFAULTS = entry.defaults;
type Params = Record<string, number>;
const interval = str(a.interval, entry.interval);
const dir = str(a.dir, "data");
const from = a.from ? dateMs(str(a.from, "")) : 0;
const to = a.to ? dateMs(str(a.to, "")) : Infinity;
const split = dateMs(str(a.split, "2025-01-01"));
const cfg: BacktestConfig = {
  ...DEFAULT_BACKTEST,
  riskPerTrade: Number(str(a.risk, String(entry.defaultRisk))),
  maxOpenPositions: Number(str(a["max-open"], String(entry.defaultMaxOpen))),
  riskModifiers: { ddScale: a["dd-scale"] === true, lossStreak: a["loss-streak"] === true },
  maxSameDirection: positiveInt("max-same-dir"),
  reentryCooldownBars: positiveInt("cooldown"),
};

const all: Record<string, Candle[]> = {};
const fundingRates: Record<string, FundingPoint[]> = {};
const needsFunding = entry.needsFunding;
for (const s of symbols) {
  const kpath = csvPath(dir, s, interval);
  if (!existsSync(kpath)) {
    console.log(`skipping ${s}: ${kpath} missing`);
    continue;
  }
  let candles = (await loadCsv(kpath)).filter((c) => c.openTime >= from && c.openTime < to);
  const fpath = fundingCsvPath(dir, s);
  if (existsSync(fpath)) {
    fundingRates[s] = await loadFundingCsv(fpath);
    if (needsFunding) candles = attachFunding(candles, fundingRates[s]!);
  } else if (needsFunding) {
    throw new Error(`strategy ${strategyName} needs funding data: ${fpath} missing (npm run download -- --funding)`);
  }
  all[s] = candles;
}
// Real signed funding where history exists; the flat conservative rate otherwise.
if (Object.keys(fundingRates).length) cfg.fundingRates = fundingRates;

const slice = (start: number, end: number, warmup: number) => {
  const out: Record<string, Candle[]> = {};
  for (const [s, cs] of Object.entries(all)) {
    const i0 = cs.findIndex((c) => c.openTime >= start);
    if (i0 === -1) continue;
    // Include warm-up candles before the window so indicators are ready on day one,
    // but only trades entered inside the window are counted.
    out[s] = cs.slice(Math.max(0, i0 - warmup)).filter((c) => c.openTime < end);
  }
  return out;
};

function run(params: Params, start: number, end: number) {
  // Warm-up = the full strategy window, so indicators on the first in-window candle match
  // what the live engine computes from its STRATEGY_WINDOW-candle fetch.
  const res = entry.run(params, slice(start, end, STRATEGY_WINDOW), { ...cfg, tradeFromMs: start });
  res.equityCurve = res.equityCurve.filter((p) => p.time >= start);
  return { res, m: computeMetrics(res, cfg.initialEquity), eq: equityMetrics(res.equityCurve) };
}
const isWeights = entry.kind === "weights";

console.log(`strategy ${entry.label}: ${entry.describe(DEFAULTS)}  interval ${interval}  symbols ${Object.keys(all).join(",")}`);
console.log(`costs: taker ${cfg.takerFee * 100}%/side, slippage ${cfg.slippage * 100}%/fill, funding ${cfg.fundingRates ? `historical (${Object.keys(cfg.fundingRates).length} symbols)` : `${cfg.fundingPer8h * 100}%/8h flat`}  risk ${cfg.riskPerTrade * 100}%/trade, max ${cfg.maxOpenPositions} open${cfg.riskModifiers?.ddScale ? ", dd-scale" : ""}${cfg.riskModifiers?.lossStreak ? ", loss-streak" : ""}${cfg.maxSameDirection !== undefined ? `, max ${cfg.maxSameDirection} same side` : ""}${cfg.reentryCooldownBars ? `, cooldown ${cfg.reentryCooldownBars} bars` : ""}\n`);

const ins = run(DEFAULTS, 0, split);
console.log(`== IN-SAMPLE (before ${new Date(split).toISOString().slice(0, 10)}) ==\n${isWeights ? formatEquity(ins.eq) : formatMetrics(ins.m)}\n`);
const oos = run(DEFAULTS, split, Infinity);
console.log(`== OUT-OF-SAMPLE (from ${new Date(split).toISOString().slice(0, 10)}) ==\n${isWeights ? formatEquity(oos.eq) : formatMetrics(oos.m)}\n`);

console.log("per symbol (out-of-sample):");
for (const [s, ts] of groupBy(oos.res.trades, (t) => t.symbol)) {
  const net = ts.reduce((x, t) => x + t.netPnl, 0);
  console.log(`  ${s.padEnd(10)} trades ${String(ts.length).padStart(4)}  net ${net.toFixed(2).padStart(10)}  avgR ${(ts.reduce((x, t) => x + t.r, 0) / ts.length).toFixed(2)}`);
}
console.log("per year (all data):");
const full = run(DEFAULTS, 0, Infinity);
for (const [y, ts] of groupBy(full.res.trades, (t) => new Date(t.entryTime).getUTCFullYear())) {
  console.log(`  ${y}  trades ${String(ts.length).padStart(4)}  net ${ts.reduce((x, t) => x + t.netPnl, 0).toFixed(2).padStart(10)}`);
}

console.log(`== FULL PERIOD (all data, equity view) ==\n${formatEquity(full.eq)}\n`);
if (a.analyze && !isWeights) {
  console.log("== LOSS ANALYSIS (all data) ==");
  for (const line of lossReport(full.res.trades, all)) console.log(line);
  console.log("== LOSS ANALYSIS (out-of-sample) ==");
  for (const line of lossReport(oos.res.trades, all)) console.log(line);
  console.log("");
}

const verdict = isWeights ? equityAcceptance(oos.eq) : acceptance(oos.m);
if (!isWeights) console.log("out-of-sample by year:");
for (const y of isWeights ? [] : yearlyConsistency(oos.res.trades)) {
  console.log(`  ${y.year}  trades ${String(y.trades).padStart(4)}  PF ${formatProfitFactor(y.profitFactor)}`);
  if (!(y.profitFactor > 1)) {
    verdict.pass = false;
    verdict.failures.push(`out-of-sample year ${y.year} not profitable (PF ${formatProfitFactor(y.profitFactor)})`);
  }
}
console.log(`\nACCEPTANCE (out-of-sample): ${verdict.pass ? "PASS" : "FAIL"}${verdict.failures.length ? `\n  - ${verdict.failures.join("\n  - ")}` : ""}`);

if (a.robustness) {
  console.log("\nrobustness (out-of-sample, each parameter ±20%):");
  for (const key of Object.keys(DEFAULTS)) {
    // Switches and zero-valued parameters have no meaningful ±20% neighbour.
    if (entry.switchKeys?.has(key) || DEFAULTS[key] === 0) continue;
    for (const f of [0.8, 1.2]) {
      const base = DEFAULTS[key]!;
      const v = perturbParam(key, base, f, entry.integerKeys);
      if (v === base) continue;
      const { m, eq } = run({ ...DEFAULTS, [key]: v }, split, Infinity);
      if (isWeights) {
        console.log(`  ${key.padEnd(14)} ${String(Number(v.toPrecision(6))).padStart(8)}  Sharpe ${eq.sharpe.toFixed(2)}  CAGR ${(eq.cagr * 100).toFixed(1)}%  DD ${(eq.maxDrawdownPct * 100).toFixed(1)}%`);
        continue;
      }
      console.log(`  ${key.padEnd(14)} ${String(Number(v.toPrecision(6))).padStart(6)}  trades ${String(m.trades).padStart(4)}  PF ${formatProfitFactor(m.profitFactor)}  E ${m.expectancyR.toFixed(2)}R  DD ${(m.maxDrawdownPct * 100).toFixed(1)}%`);
    }
  }
}
process.exitCode = verdict.pass ? 0 : 2;
