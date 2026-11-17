// npm run backtest -- --strategy trend|pullback|meanrev --split 2025-01-01 [--interval ..] [--symbols ...] [--from ...] [--to ...] [--robustness]
//
// Prints in-sample (before --split) and out-of-sample (from --split) results separately.
// Only the out-of-sample block is judged against the acceptance criteria.
// --robustness re-runs out-of-sample with every parameter moved ±20%.
import type { Candle } from "../core/types.js";
import { DEFAULT_BACKTEST, runBacktest, type BacktestConfig } from "../backtest/engine.js";
import { acceptance, computeMetrics, formatMetrics, formatProfitFactor, groupBy, perturbParam } from "../backtest/metrics.js";
import { csvPath, loadCsv } from "../data/klines.js";
import { getStrategy } from "../strategy/registry.js";
import { STRATEGY_WINDOW } from "../strategy/types.js";
import { dateMs, parseArgs, str } from "./args.js";

const a = parseArgs();
const symbols = str(a.symbols, "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT").split(",");
const strategyName = str(a.strategy, "trend");
const entry = getStrategy(strategyName);
const DEFAULTS = entry.defaults;
type Params = Record<string, number>;
const interval = str(a.interval, entry.interval);
const dir = str(a.dir, "data");
const from = a.from ? dateMs(str(a.from, "")) : 0;
const to = a.to ? dateMs(str(a.to, "")) : Infinity;
const split = dateMs(str(a.split, "2025-01-01"));
const cfg: BacktestConfig = { ...DEFAULT_BACKTEST, riskPerTrade: Number(str(a.risk, String(DEFAULT_BACKTEST.riskPerTrade))) };

const all: Record<string, Candle[]> = {};
for (const s of symbols) all[s] = (await loadCsv(csvPath(dir, s, interval))).filter((c) => c.openTime >= from && c.openTime < to);

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
  const strat = entry.create(params);
  // Warm-up = the full strategy window, so indicators on the first in-window candle match
  // what the live engine computes from its STRATEGY_WINDOW-candle fetch.
  const res = runBacktest(strat, slice(start, end, STRATEGY_WINDOW), { ...cfg, tradeFromMs: start });
  res.equityCurve = res.equityCurve.filter((p) => p.time >= start);
  return { res, m: computeMetrics(res, cfg.initialEquity) };
}

const strat = entry.create(DEFAULTS);
console.log(`strategy ${entry.label}: ${strat.name}  interval ${interval}  symbols ${symbols.join(",")}`);
console.log(`costs: taker ${cfg.takerFee * 100}%/side, slippage ${cfg.slippage * 100}%/fill, funding ${cfg.fundingPer8h * 100}%/8h  risk ${cfg.riskPerTrade * 100}%/trade\n`);

const ins = run(DEFAULTS, 0, split);
console.log(`== IN-SAMPLE (before ${new Date(split).toISOString().slice(0, 10)}) ==\n${formatMetrics(ins.m)}\n`);
const oos = run(DEFAULTS, split, Infinity);
console.log(`== OUT-OF-SAMPLE (from ${new Date(split).toISOString().slice(0, 10)}) ==\n${formatMetrics(oos.m)}\n`);

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

const verdict = acceptance(oos.m);
console.log(`\nACCEPTANCE (out-of-sample): ${verdict.pass ? "PASS" : "FAIL"}${verdict.failures.length ? `\n  - ${verdict.failures.join("\n  - ")}` : ""}`);

if (a.robustness) {
  console.log("\nrobustness (out-of-sample, each parameter ±20%):");
  for (const key of Object.keys(DEFAULTS)) {
    for (const f of [0.8, 1.2]) {
      const base = DEFAULTS[key]!;
      const v = perturbParam(key, base, f, entry.integerKeys);
      const { m } = run({ ...DEFAULTS, [key]: v }, split, Infinity);
      console.log(`  ${key.padEnd(14)} ${String(Number(v.toPrecision(6))).padStart(6)}  trades ${String(m.trades).padStart(4)}  PF ${formatProfitFactor(m.profitFactor)}  E ${m.expectancyR.toFixed(2)}R  DD ${(m.maxDrawdownPct * 100).toFixed(1)}%`);
    }
  }
}
process.exitCode = verdict.pass ? 0 : 2;
