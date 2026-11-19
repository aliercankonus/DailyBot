// Portfolio backtester. Rules that keep it honest:
//  * The strategy sees only closed candles [0..i]. Entries fill at the NEXT candle's open.
//  * Stops are checked against each candle's high/low. A gap through the stop fills at the open.
//  * A strategy exit (shouldExit) decided on a close fills at the NEXT candle's open.
//  * Every fill pays taker fee + slippage. Open positions pay funding at each 8h UTC settlement
//    (00:00, 08:00, 16:00) that falls inside a held candle strictly after entry, on mark notional
//    (quantity x that candle's open).
//  * Partial take-profits (Strategy.takeProfit) are checked intrabar AFTER the stop (pessimistic:
//    a candle that touches both is a stop-out). A TP fills at its level minus slippage, never better.
//    If TP1 moves the stop to break-even and the same candle also reaches break-even, the rest is
//    assumed stopped there (the order of high and low inside a candle is unknown).
//    A trade with partial fills is still ONE trade: quantity is the original size, exitPrice the
//    quantity-weighted average, r the net PnL over the original risk.
//  * Sizing and portfolio limits use the same code as live (sizePosition with round-trip costs,
//    maxOpenPositions). Sizing equity is mark-to-market: cash + unrealized - accrued funding.
//  * The strategy receives at most STRATEGY_WINDOW closed candles, exactly like the live engine,
//    so window-dependent indicators (EMA seed, Wilder ATR) produce the same values.
//  * Symbols are processed within each timestamp in the order of Object.keys(data), i.e. the
//    configured symbol order, the same order the live engine loops in. When several symbols
//    signal on the same candle and maxOpenPositions is tight, earlier symbols win.
import type { Candle, Side } from "../core/types.js";
import type { FundingPoint, SymbolFilters } from "../exchange/types.js";
import { sizePosition } from "../risk/sizing.js";
import { STRATEGY_WINDOW, type Strategy, type TakeProfitPlan } from "../strategy/types.js";

export interface BacktestConfig {
  initialEquity: number;
  riskPerTrade: number;
  maxLeverage: number;
  maxOpenPositions: number;
  takerFee: number;          // per side, e.g. 0.0005 (0.05%)
  slippage: number;          // per fill, fraction of price, e.g. 0.0005
  fundingPer8h: number;      // cost per 8h as fraction of notional, charged to both sides (conservative)
  filters?: Record<string, SymbolFilters>;
  /** Entries before this time are ignored (candles before it are indicator warm-up only). */
  tradeFromMs?: number;
  /**
   * Risk modifiers from the old bot, fixed so they can be tested:
   *  ddScale: risk x clamp(1 - drawdown/0.20, 0.5, 1), drawdown from the MTM equity peak.
   *  lossStreak: after 3 consecutive losing trades, risk x 0.5 until a win or a new equity peak.
   */
  riskModifiers?: { ddScale?: boolean; lossStreak?: boolean };
  /**
   * Portfolio rules from the old bot, fixed so they can be tested:
   *  maxSameDirection: at most this many open positions on the same side (crypto moves together).
   *  reentryCooldownBars: after a stop-out, no new entry on that symbol in the same direction for
   *  this many candles (the opposite direction is allowed).
   */
  maxSameDirection?: number;
  reentryCooldownBars?: number;
  /**
   * Historical funding per symbol. When present, each settlement charges the real signed rate
   * (longs pay positive funding, shorts receive it) instead of the flat fundingPer8h cost.
   */
  fundingRates?: Record<string, FundingPoint[]>;
}

export const DEFAULT_BACKTEST: BacktestConfig = {
  initialEquity: 10_000,
  riskPerTrade: 0.01,
  maxLeverage: 3,
  maxOpenPositions: 3,
  takerFee: 0.0005,
  slippage: 0.0005,
  fundingPer8h: 0.0001,
};

export interface BacktestTrade {
  symbol: string;
  side: Side;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  initialStop: number;
  exitReason: "STOP" | "SIGNAL" | "END";
  grossPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
  /** Net PnL in units of initial risk. */
  r: number;
  /** Candles held and best/worst excursion in R from candle highs/lows (single-strategy backtest only). */
  bars?: number;
  mfeR?: number;
  maeR?: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  equityCurve: { time: number; equity: number }[];
  finalEquity: number;
}

interface OpenPos {
  symbol: string;
  side: Side;
  entryTime: number;
  entryCandleOpenTime: number;
  entryPrice: number;
  quantity: number;
  leverage: number;
  stop: number;
  initialStop: number;
  fees: number;
  funding: number;
  /** Last known close of this symbol (entry price until the first close is seen). */
  mark: number;
  /** Strategy asked to exit on the previous close; filled at this candle's open. */
  exitPending: boolean;
  /** Size at entry; `quantity` is what is still open after partial take-profits. */
  originalQuantity: number;
  tpFilled: number;
  /** Gross PnL and exit notional already realized by partial take-profits. */
  partialGross: number;
  partialExitValue: number;
  /** Best and worst price seen since entry, and candles held. */
  best: number;
  worst: number;
  bars: number;
}

const EIGHT_HOURS = 8 * 3600_000;
const LOOSE_FILTERS = (symbol: string): SymbolFilters => ({ symbol, tickSize: 1e-8, stepSize: 1e-8, minQty: 0, maxQty: Number.MAX_SAFE_INTEGER, marketStepSize: 1e-8, marketMaxQty: Number.MAX_SAFE_INTEGER, minNotional: 0 });

export function runBacktest(strategy: Strategy, data: Record<string, Candle[]>, cfg: BacktestConfig = DEFAULT_BACKTEST): BacktestResult {
  const symbols = Object.keys(data); // insertion order = configured order (see header)
  const index: Record<string, Map<number, number>> = {};
  const times = new Set<number>();
  for (const s of symbols) {
    index[s] = new Map(data[s]!.map((c, i) => [c.openTime, i]));
    for (const c of data[s]!) times.add(c.openTime);
  }
  const timeline = [...times].sort((a, b) => a - b);
  // Settlement times are snapped to the 8h grid (Binance fundingTime can be a few ms late).
  const rateLookup = new Map<string, Map<number, number>>();
  for (const [sym, pts] of Object.entries(cfg.fundingRates ?? {})) {
    rateLookup.set(sym, new Map(pts.map((f) => [Math.round(f.time / EIGHT_HOURS) * EIGHT_HOURS, f.rate])));
  }

  let cash = cfg.initialEquity; // realized equity
  let equityPeak = cfg.initialEquity;
  let lossStreak = 0;
  const open = new Map<string, OpenPos>();
  const pending = new Map<string, { side: Side; stop: number }>();
  /** Per symbol: side and time until which a same-direction entry is blocked after a stop-out. */
  const cooldown = new Map<string, { side: Side; until: number }>();
  const trades: BacktestTrade[] = [];
  const equityCurve: { time: number; equity: number }[] = [];

  const closePos = (p: OpenPos, rawPrice: number, time: number, reason: BacktestTrade["exitReason"]) => {
    const exitPrice = p.side === "LONG" ? rawPrice * (1 - cfg.slippage) : rawPrice * (1 + cfg.slippage);
    const exitFee = exitPrice * p.quantity * cfg.takerFee;
    const restGross = (p.side === "LONG" ? exitPrice - p.entryPrice : p.entryPrice - exitPrice) * p.quantity;
    const gross = p.partialGross + restGross;
    const fees = p.fees + exitFee;
    const net = gross - fees - p.funding;
    const risk = Math.abs(p.entryPrice - p.initialStop) * p.originalQuantity;
    cash += restGross - exitFee - p.funding; // entry and partial-exit fees were already deducted
    lossStreak = net > 0 ? 0 : lossStreak + 1;
    if (reason === "STOP" && cfg.reentryCooldownBars) {
      const k = data[p.symbol]!;
      const iv = k.length > 1 ? k[1]!.openTime - k[0]!.openTime : 0;
      cooldown.set(p.symbol, { side: p.side, until: time + cfg.reentryCooldownBars * iv });
    }
    const avgExit = (p.partialExitValue + exitPrice * p.quantity) / p.originalQuantity;
    const unit = Math.abs(p.entryPrice - p.initialStop);
    const dirSign = p.side === "LONG" ? 1 : -1;
    const mfeR = unit > 0 ? Math.max(0, dirSign * ((p.side === "LONG" ? p.best : p.worst) - p.entryPrice) / unit) : 0;
    const maeR = unit > 0 ? Math.max(0, -dirSign * ((p.side === "LONG" ? p.worst : p.best) - p.entryPrice) / unit) : 0;
    trades.push({
      symbol: p.symbol, side: p.side, entryTime: p.entryTime, exitTime: time,
      entryPrice: p.entryPrice, exitPrice: avgExit, quantity: p.originalQuantity, initialStop: p.initialStop,
      exitReason: reason, grossPnl: gross, fees, funding: p.funding, netPnl: net, r: risk > 0 ? net / risk : 0,
      bars: p.bars, mfeR, maeR,
    });
    open.delete(p.symbol);
  };

  for (const t of timeline) {
    for (const s of symbols) {
      const i = index[s]!.get(t);
      if (i === undefined) continue;
      const candles = data[s]!;
      const c = candles[i]!;

      // 1) Pending entry from the previous closed candle fills at this candle's open.
      const pend = pending.get(s);
      if (pend) {
        pending.delete(s);
        const sameSide = [...open.values()].filter((o) => o.side === pend.side).length;
        const cool = cooldown.get(s);
        const blocked = (cfg.maxSameDirection !== undefined && sameSide >= cfg.maxSameDirection)
          || (cool !== undefined && cool.side === pend.side && c.openTime <= cool.until);
        if (!blocked && !open.has(s) && open.size < cfg.maxOpenPositions && c.openTime >= (cfg.tradeFromMs ?? -Infinity)) {
          const fillPrice = pend.side === "LONG" ? c.open * (1 + cfg.slippage) : c.open * (1 - cfg.slippage);
          // Skip if the open already gapped beyond the stop.
          const invalid = pend.side === "LONG" ? fillPrice <= pend.stop : fillPrice >= pend.stop;
          if (!invalid) {
            const equity = markToMarket();
            equityPeak = Math.max(equityPeak, equity);
            if (equity >= equityPeak) lossStreak = 0;
            let risk = cfg.riskPerTrade;
            if (cfg.riskModifiers?.ddScale) risk *= Math.min(1, Math.max(0.5, 1 - (equityPeak - equity) / equityPeak / 0.2));
            if (cfg.riskModifiers?.lossStreak && lossStreak >= 3) risk *= 0.5;
            const size = sizePosition({
              equity, availableBalance: equity - marginInUse(open), entryPrice: fillPrice,
              stopPrice: pend.stop, riskPerTrade: risk, maxLeverage: cfg.maxLeverage,
              filters: cfg.filters?.[s] ?? LOOSE_FILTERS(s),
              roundTripCostPct: 2 * (cfg.takerFee + cfg.slippage),
            });
            if (size.ok) {
              const fee = fillPrice * size.quantity * cfg.takerFee;
              cash -= fee;
              open.set(s, {
                symbol: s, side: pend.side, entryTime: c.openTime, entryCandleOpenTime: c.openTime,
                entryPrice: fillPrice, quantity: size.quantity, leverage: size.leverage, stop: pend.stop, initialStop: pend.stop,
                fees: fee, funding: 0, mark: fillPrice, exitPending: false,
                originalQuantity: size.quantity, tpFilled: 0, partialGross: 0, partialExitValue: 0,
                best: fillPrice, worst: fillPrice, bars: 0,
              });
            }
          }
        }
      }

      // 1b) Strategy exit decided on the previous close fills at this candle's open.
      const exiting = open.get(s);
      if (exiting?.exitPending) {
        exiting.funding += fundingCost(exiting, c.openTime, c.openTime, c.open);
        closePos(exiting, c.open, c.openTime, "SIGNAL");
      }

      // 2) Intrabar stop check (pessimistic: the stop is assumed hit before any favourable move).
      const pos = open.get(s);
      if (pos) {
        // Pessimistic: settlements inside this candle are charged even if the stop hits in it.
        pos.funding += fundingCost(pos, c.openTime, c.closeTime, c.open);
        // Excursions for analysis only. A stop candle counts its full range (order inside is unknown).
        pos.bars++;
        pos.best = Math.max(pos.best, c.high);
        pos.worst = Math.min(pos.worst, c.low);
        if (pos.side === "LONG" && c.low <= pos.stop) closePos(pos, Math.min(c.open, pos.stop), c.openTime, "STOP");
        else if (pos.side === "SHORT" && c.high >= pos.stop) closePos(pos, Math.max(c.open, pos.stop), c.openTime, "STOP");
        else if (strategy.takeProfit) takeProfits(pos, c, strategy.takeProfit);
      }

      // 3) Candle closed: trail the stop, or look for a new entry.
      const history = candles.slice(Math.max(0, i + 1 - (strategy.window ?? STRATEGY_WINDOW)), i + 1);
      const still = open.get(s);
      if (still) {
        const view = {
          side: still.side, entryPrice: still.entryPrice, stop: still.stop, initialStop: still.initialStop,
          entryCandleOpenTime: still.entryCandleOpenTime,
        };
        // Same order as the live engine: a strategy exit takes precedence over a stop update.
        if (strategy.shouldExit?.(view, history) && i + 1 < candles.length) still.exitPending = true;
        else still.stop = strategy.updateStop(view, history);
      } else if (i + 1 < candles.length) {
        const sig = strategy.evaluate(s, history);
        if (sig) pending.set(s, { side: sig.side, stop: sig.stop });
      }
    }

    // Mark-to-market equity at the end of this timestamp. A symbol with no candle at t keeps
    // its last known close.
    for (const p of open.values()) {
      const i = index[p.symbol]!.get(t);
      if (i !== undefined) p.mark = data[p.symbol]![i]!.close;
    }
    equityCurve.push({ time: t, equity: markToMarket() });
  }

  for (const p of [...open.values()]) {
    const last = data[p.symbol]!.at(-1)!;
    closePos(p, last.close, last.closeTime, "END");
  }
  // Final point after the END closes (exit fees/slippage paid) so the curve ends at finalEquity.
  if (timeline.length > 0) {
    const endTime = Math.max(timeline.at(-1)!, ...symbols.map((s) => data[s]!.at(-1)?.closeTime ?? -Infinity));
    equityCurve.push({ time: endTime, equity: cash });
  }
  return { trades, equityCurve, finalEquity: cash };

  /** Fill every take-profit level this candle reached; then apply the break-even rule. */
  function takeProfits(p: OpenPos, c: Candle, plan: TakeProfitPlan) {
    const r = Math.abs(p.entryPrice - p.initialStop);
    const dir = p.side === "LONG" ? 1 : -1;
    while (p.tpFilled < plan.levels.length) {
      const lvl = plan.levels[p.tpFilled]!;
      const target = p.entryPrice + dir * lvl.r * r;
      if (dir === 1 ? c.high < target : c.low > target) break;
      const qty = Math.min(p.quantity, p.originalQuantity * lvl.fraction);
      const exitPrice = target * (1 - dir * cfg.slippage);
      const fee = exitPrice * qty * cfg.takerFee;
      const gross = dir * (exitPrice - p.entryPrice) * qty;
      cash += gross - fee;
      p.fees += fee;
      p.partialGross += gross;
      p.partialExitValue += exitPrice * qty;
      p.quantity -= qty;
      p.tpFilled++;
      if (p.quantity <= p.originalQuantity * 1e-9) {
        // Nothing left: book the trade (zero remaining quantity adds no fill or fee).
        p.quantity = 0;
        closePos(p, target, c.openTime, "SIGNAL");
        return;
      }
      if (p.tpFilled === 1 && plan.breakEvenAfterFirst) {
        // Break-even covers the round-trip cost of the remainder.
        const be = p.entryPrice * (1 + dir * 2 * (cfg.takerFee + cfg.slippage));
        p.stop = dir === 1 ? Math.max(p.stop, be) : Math.min(p.stop, be);
        if (dir === 1 ? c.low <= p.stop : c.high >= p.stop) {
          closePos(p, p.stop, c.openTime, "STOP");
          return;
        }
      }
    }
  }

  /** Funding paid (positive) or received (negative) for settlements in [from, to] after entry. */
  function fundingCost(p: OpenPos, from: number, to: number, price: number): number {
    const rates = rateLookup.get(p.symbol);
    let cost = 0;
    for (const t of settlementTimes(from, to, p.entryTime)) {
      const rate = rates ? (rates.get(t) ?? 0) : cfg.fundingPer8h;
      // Without data the flat rate is charged to both sides (conservative); with data it is signed.
      cost += rates ? (p.side === "LONG" ? rate : -rate) * price * p.quantity : rate * price * p.quantity;
    }
    return cost;
  }

  /** cash + unrealized PnL at each position's last known mark - accrued funding. */
  function markToMarket(): number {
    let eq = cash;
    for (const p of open.values()) {
      eq += (p.side === "LONG" ? p.mark - p.entryPrice : p.entryPrice - p.mark) * p.quantity - p.funding;
    }
    return eq;
  }
}

/** Number of 8h UTC funding settlements t (t % 8h == 0) with fromMs <= t <= toMs and t > afterMs. */
export function fundingSettlements(fromMs: number, toMs: number, afterMs: number): number {
  const lo = Math.max(fromMs, afterMs + 1);
  if (toMs < lo) return 0;
  const first = Math.ceil(lo / EIGHT_HOURS) * EIGHT_HOURS;
  return first > toMs ? 0 : Math.floor((toMs - first) / EIGHT_HOURS) + 1;
}

/** The settlement timestamps counted by fundingSettlements, in order. */
export function settlementTimes(fromMs: number, toMs: number, afterMs: number): number[] {
  const n = fundingSettlements(fromMs, toMs, afterMs);
  if (n === 0) return [];
  const first = Math.ceil(Math.max(fromMs, afterMs + 1) / EIGHT_HOURS) * EIGHT_HOURS;
  return Array.from({ length: n }, (_, k) => first + k * EIGHT_HOURS);
}

function marginInUse(open: Map<string, OpenPos>): number {
  let m = 0;
  for (const p of open.values()) m += (p.entryPrice * p.quantity) / p.leverage;
  return m;
}
