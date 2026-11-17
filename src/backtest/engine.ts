// Portfolio backtester. Rules that keep it honest:
//  * The strategy sees only closed candles [0..i]. Entries fill at the NEXT candle's open.
//  * Stops are checked against each candle's high/low. A gap through the stop fills at the open.
//  * Every fill pays taker fee + slippage. Open positions pay funding every 8 hours.
//  * Sizing and portfolio limits use the same code as live (sizePosition, maxOpenPositions).
import type { Candle, Side } from "../core/types.js";
import type { SymbolFilters } from "../exchange/types.js";
import { sizePosition } from "../risk/sizing.js";
import type { Strategy } from "../strategy/types.js";

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
  exitReason: "STOP" | "END";
  grossPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
  /** Net PnL in units of initial risk. */
  r: number;
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
  lastFundingTime: number;
}

const EIGHT_HOURS = 8 * 3600_000;
const LOOSE_FILTERS = (symbol: string): SymbolFilters => ({ symbol, tickSize: 1e-8, stepSize: 1e-8, minQty: 0, maxQty: Number.MAX_SAFE_INTEGER, minNotional: 0 });

export function runBacktest(strategy: Strategy, data: Record<string, Candle[]>, cfg: BacktestConfig = DEFAULT_BACKTEST): BacktestResult {
  const symbols = Object.keys(data).sort();
  const index: Record<string, Map<number, number>> = {};
  const times = new Set<number>();
  for (const s of symbols) {
    index[s] = new Map(data[s]!.map((c, i) => [c.openTime, i]));
    for (const c of data[s]!) times.add(c.openTime);
  }
  const timeline = [...times].sort((a, b) => a - b);

  let cash = cfg.initialEquity; // realized equity
  const open = new Map<string, OpenPos>();
  const pending = new Map<string, { side: Side; stop: number }>();
  const trades: BacktestTrade[] = [];
  const equityCurve: { time: number; equity: number }[] = [];

  const closePos = (p: OpenPos, rawPrice: number, time: number, reason: BacktestTrade["exitReason"]) => {
    const exitPrice = p.side === "LONG" ? rawPrice * (1 - cfg.slippage) : rawPrice * (1 + cfg.slippage);
    const exitFee = exitPrice * p.quantity * cfg.takerFee;
    const gross = (p.side === "LONG" ? exitPrice - p.entryPrice : p.entryPrice - exitPrice) * p.quantity;
    const fees = p.fees + exitFee;
    const net = gross - fees - p.funding;
    const risk = Math.abs(p.entryPrice - p.initialStop) * p.quantity;
    cash += gross - exitFee - p.funding; // entry fee was already deducted at entry
    trades.push({
      symbol: p.symbol, side: p.side, entryTime: p.entryTime, exitTime: time,
      entryPrice: p.entryPrice, exitPrice, quantity: p.quantity, initialStop: p.initialStop,
      exitReason: reason, grossPnl: gross, fees, funding: p.funding, netPnl: net, r: risk > 0 ? net / risk : 0,
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
        if (!open.has(s) && open.size < cfg.maxOpenPositions && c.openTime >= (cfg.tradeFromMs ?? -Infinity)) {
          const fillPrice = pend.side === "LONG" ? c.open * (1 + cfg.slippage) : c.open * (1 - cfg.slippage);
          // Skip if the open already gapped beyond the stop.
          const invalid = pend.side === "LONG" ? fillPrice <= pend.stop : fillPrice >= pend.stop;
          if (!invalid) {
            const size = sizePosition({
              equity: cash, availableBalance: cash - marginInUse(open), entryPrice: fillPrice,
              stopPrice: pend.stop, riskPerTrade: cfg.riskPerTrade, maxLeverage: cfg.maxLeverage,
              filters: cfg.filters?.[s] ?? LOOSE_FILTERS(s),
            });
            if (size.ok) {
              const fee = fillPrice * size.quantity * cfg.takerFee;
              cash -= fee;
              open.set(s, {
                symbol: s, side: pend.side, entryTime: c.openTime, entryCandleOpenTime: c.openTime,
                entryPrice: fillPrice, quantity: size.quantity, leverage: size.leverage, stop: pend.stop, initialStop: pend.stop,
                fees: fee, funding: 0, lastFundingTime: c.openTime,
              });
            }
          }
        }
      }

      // 2) Intrabar stop check (pessimistic: the stop is assumed hit before any favourable move).
      const pos = open.get(s);
      if (pos) {
        while (c.openTime - pos.lastFundingTime >= EIGHT_HOURS) {
          pos.funding += pos.entryPrice * pos.quantity * cfg.fundingPer8h;
          pos.lastFundingTime += EIGHT_HOURS;
        }
        if (pos.side === "LONG" && c.low <= pos.stop) closePos(pos, Math.min(c.open, pos.stop), c.openTime, "STOP");
        else if (pos.side === "SHORT" && c.high >= pos.stop) closePos(pos, Math.max(c.open, pos.stop), c.openTime, "STOP");
      }

      // 3) Candle closed: trail the stop, or look for a new entry.
      const history = candles.slice(0, i + 1);
      const still = open.get(s);
      if (still) {
        still.stop = strategy.updateStop(
          { side: still.side, entryPrice: still.entryPrice, stop: still.stop, entryCandleOpenTime: still.entryCandleOpenTime },
          history,
        );
      } else if (i + 1 < candles.length) {
        const sig = strategy.evaluate(s, history);
        if (sig) pending.set(s, { side: sig.side, stop: sig.stop });
      }
    }

    // Mark-to-market equity at the end of this timestamp.
    let unreal = 0;
    for (const p of open.values()) {
      const i = index[p.symbol]!.get(t);
      const px = i === undefined ? p.entryPrice : data[p.symbol]![i]!.close;
      unreal += (p.side === "LONG" ? px - p.entryPrice : p.entryPrice - px) * p.quantity - p.funding;
    }
    const eq = cash + unreal;
    equityCurve.push({ time: t, equity: eq });
  }

  for (const p of [...open.values()]) {
    const last = data[p.symbol]!.at(-1)!;
    closePos(p, last.close, last.closeTime, "END");
  }
  return { trades, equityCurve, finalEquity: cash };
}

function marginInUse(open: Map<string, OpenPos>): number {
  let m = 0;
  for (const p of open.values()) m += (p.entryPrice * p.quantity) / p.leverage;
  return m;
}
