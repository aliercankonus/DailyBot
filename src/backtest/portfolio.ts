// Portfolio backtester for PortfolioStrategy (e.g. cross-sectional momentum). Same honesty rules
// and cost model as src/backtest/engine.ts:
//  * Decisions happen at the CLOSE of a rebalance bar of the union timeline (bar k with
//    (k - firstTradable) % rebalanceEvery === 0). The strategy sees, per symbol, only candles
//    that closed by then (at most STRATEGY_WINDOW), and only symbols with a candle at that bar.
//  * Orders fill at each symbol's NEXT candle open with slippage + taker fee. Positions not in the
//    new target set (or whose side flips) close there (reason SIGNAL); new targets open there.
//    Same-side targets already held are kept as is (no resizing). Closes run before opens.
//  * Each new position is sized with sizePosition (MTM equity, free margin, round-trip costs),
//    so every position risks the same fraction of equity (implicit volatility scaling).
//  * Catastrophic stops are checked on each candle's high/low; a gap through the stop fills at the
//    open. A stopped symbol is not re-entered before the next rebalance.
//  * Funding is charged at 8h UTC settlements exactly like engine.ts.
//  * SURVIVORSHIP BIAS: the universe is today's liquid coins; delisted coins are missing, so
//    results are optimistic.
import type { Candle, Side } from "../core/types.js";
import type { SymbolFilters } from "../exchange/types.js";
import { sizePosition } from "../risk/sizing.js";
import type { PortfolioStrategy, PortfolioTarget } from "../strategy/portfolio.js";
import { STRATEGY_WINDOW } from "../strategy/types.js";
import { fundingSettlements, type BacktestConfig, type BacktestResult, type BacktestTrade } from "./engine.js";

interface Pos {
  symbol: string;
  side: Side;
  entryTime: number;
  entryPrice: number;
  quantity: number;
  leverage: number;
  stop: number;
  fees: number;
  funding: number;
  mark: number;
}

interface Pending {
  /** Close the held position at the next open (dropped from the target set or side flip). */
  close: boolean;
  open?: { side: Side; stop: number };
}

const LOOSE_FILTERS = (symbol: string): SymbolFilters => ({ symbol, tickSize: 1e-8, stepSize: 1e-8, minQty: 0, maxQty: Number.MAX_SAFE_INTEGER, marketStepSize: 1e-8, marketMaxQty: Number.MAX_SAFE_INTEGER, minNotional: 0 });

export function runPortfolioBacktest(strategy: PortfolioStrategy, data: Record<string, Candle[]>, cfg: BacktestConfig): BacktestResult {
  const symbols = Object.keys(data);
  const index: Record<string, Map<number, number>> = {};
  const times = new Set<number>();
  for (const s of symbols) {
    index[s] = new Map(data[s]!.map((c, i) => [c.openTime, i]));
    for (const c of data[s]!) times.add(c.openTime);
  }
  const timeline = [...times].sort((a, b) => a - b);
  const tradeFrom = cfg.tradeFromMs ?? -Infinity;
  const firstTradable = timeline.findIndex((t) => t >= tradeFrom);
  const maxOpen = strategy.maxPositions; // topK + bottomK; cfg.maxOpenPositions is for single-symbol strategies

  let cash = cfg.initialEquity;
  const open = new Map<string, Pos>();
  let pending = new Map<string, Pending>();
  const trades: BacktestTrade[] = [];
  const equityCurve: { time: number; equity: number }[] = [];

  const closePos = (p: Pos, rawPrice: number, time: number, reason: BacktestTrade["exitReason"]) => {
    const exitPrice = p.side === "LONG" ? rawPrice * (1 - cfg.slippage) : rawPrice * (1 + cfg.slippage);
    const exitFee = exitPrice * p.quantity * cfg.takerFee;
    const gross = (p.side === "LONG" ? exitPrice - p.entryPrice : p.entryPrice - exitPrice) * p.quantity;
    const fees = p.fees + exitFee;
    const net = gross - fees - p.funding;
    const risk = Math.abs(p.entryPrice - p.stop) * p.quantity;
    cash += gross - exitFee - p.funding;
    trades.push({
      symbol: p.symbol, side: p.side, entryTime: p.entryTime, exitTime: time,
      entryPrice: p.entryPrice, exitPrice, quantity: p.quantity, initialStop: p.stop,
      exitReason: reason, grossPnl: gross, fees, funding: p.funding, netPnl: net, r: risk > 0 ? net / risk : 0,
    });
    open.delete(p.symbol);
  };

  for (let k = 0; k < timeline.length; k++) {
    const t = timeline[k]!;
    const here = symbols.filter((s) => index[s]!.has(t));
    const candle = (s: string) => data[s]![index[s]!.get(t)!]!;

    // 1) Rebalance closes at this open (all symbols first, to free margin for the opens).
    for (const s of here) {
      const pend = pending.get(s);
      const p = open.get(s);
      if (!pend?.close || !p) continue;
      const c = candle(s);
      p.funding += fundingSettlements(c.openTime, c.openTime, p.entryTime) * c.open * p.quantity * cfg.fundingPer8h;
      closePos(p, c.open, c.openTime, "SIGNAL");
    }
    // 2) Rebalance opens at this open.
    for (const s of here) {
      const pend = pending.get(s);
      if (!pend) continue;
      pending.delete(s);
      const c = candle(s);
      if (!pend.open || open.has(s) || open.size >= maxOpen || c.openTime < tradeFrom) continue;
      const { side, stop } = pend.open;
      const fillPrice = side === "LONG" ? c.open * (1 + cfg.slippage) : c.open * (1 - cfg.slippage);
      if (side === "LONG" ? fillPrice <= stop : fillPrice >= stop) continue; // gapped beyond the stop
      const equity = markToMarket();
      const size = sizePosition({
        equity, availableBalance: equity - marginInUse(), entryPrice: fillPrice, stopPrice: stop,
        riskPerTrade: cfg.riskPerTrade, maxLeverage: cfg.maxLeverage,
        filters: cfg.filters?.[s] ?? LOOSE_FILTERS(s), roundTripCostPct: 2 * (cfg.takerFee + cfg.slippage),
      });
      if (!size.ok) continue;
      const fee = fillPrice * size.quantity * cfg.takerFee;
      cash -= fee;
      open.set(s, { symbol: s, side, entryTime: c.openTime, entryPrice: fillPrice, quantity: size.quantity, leverage: size.leverage, stop, fees: fee, funding: 0, mark: fillPrice });
    }
    // 3) Funding + intrabar catastrophic stop (pessimistic, as in engine.ts).
    for (const s of here) {
      const p = open.get(s);
      if (!p) continue;
      const c = candle(s);
      p.funding += fundingSettlements(c.openTime, c.closeTime, p.entryTime) * c.open * p.quantity * cfg.fundingPer8h;
      if (p.side === "LONG" && c.low <= p.stop) closePos(p, Math.min(c.open, p.stop), c.openTime, "STOP");
      else if (p.side === "SHORT" && c.high >= p.stop) closePos(p, Math.max(c.open, p.stop), c.openTime, "STOP");
    }
    // 4) Mark to market at this close.
    for (const p of open.values()) {
      const i = index[p.symbol]!.get(t);
      if (i !== undefined) p.mark = data[p.symbol]![i]!.close;
    }
    equityCurve.push({ time: t, equity: markToMarket() });

    // 5) Rebalance decision at this close; orders fill at each symbol's next open.
    if (firstTradable >= 0 && k >= firstTradable && (k - firstTradable) % strategy.rebalanceEvery === 0 && k + 1 < timeline.length) {
      const view: Record<string, Candle[]> = {};
      for (const s of here) {
        const i = index[s]!.get(t)!;
        view[s] = data[s]!.slice(Math.max(0, i + 1 - STRATEGY_WINDOW), i + 1);
      }
      pending = planOrders(strategy.targets(view).slice(0, maxOpen));
    }
  }

  for (const p of [...open.values()]) {
    const last = data[p.symbol]!.at(-1)!;
    closePos(p, last.close, last.closeTime, "END");
  }
  if (timeline.length > 0) {
    const endTime = Math.max(timeline.at(-1)!, ...symbols.map((s) => data[s]!.at(-1)?.closeTime ?? -Infinity));
    equityCurve.push({ time: endTime, equity: cash });
  }
  return { trades, equityCurve, finalEquity: cash };

  function planOrders(targets: PortfolioTarget[]): Map<string, Pending> {
    const want = new Map(targets.map((x) => [x.symbol, x]));
    const out = new Map<string, Pending>();
    for (const p of open.values()) {
      const w = want.get(p.symbol);
      if (!w || w.side !== p.side) out.set(p.symbol, { close: true, open: w ? { side: w.side, stop: w.stop } : undefined });
    }
    for (const w of targets) {
      if (!open.has(w.symbol)) out.set(w.symbol, { close: false, open: { side: w.side, stop: w.stop } });
    }
    return out;
  }

  function markToMarket(): number {
    let eq = cash;
    for (const p of open.values()) eq += (p.side === "LONG" ? p.mark - p.entryPrice : p.entryPrice - p.mark) * p.quantity - p.funding;
    return eq;
  }

  function marginInUse(): number {
    let m = 0;
    for (const p of open.values()) m += (p.entryPrice * p.quantity) / p.leverage;
    return m;
  }
}
