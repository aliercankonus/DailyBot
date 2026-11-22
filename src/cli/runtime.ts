// Wiring shared by the engine and API processes.
import pg from "pg";
import type { AppConfig } from "../config.js";
import { PgRepo } from "../db/pgRepo.js";
import { BinanceFutures } from "../exchange/binanceFutures.js";
import { newPaperState, PaperExchange, type PaperState } from "../exchange/paper.js";
import type { Exchange } from "../exchange/types.js";
import { MarketDataSplit } from "../exchange/marketDataSplit.js";
import { consoleNotifier, telegramNotifier, type Notifier } from "../notify/notifier.js";

export function makePool(cfg: Pick<AppConfig, "DATABASE_URL">) {
  const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 5, keepAlive: true });
  // An idle client losing its connection emits 'error' on the pool; unhandled, it would crash the process.
  pool.on("error", (e) => {
    console.error(JSON.stringify({ level: "error", msg: "postgres pool error", error: e.message, time: new Date().toISOString() }));
  });
  return pool;
}

export function makeNotifier(cfg: AppConfig): Notifier {
  return cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID ? telegramNotifier(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_CHAT_ID) : consoleNotifier;
}

/** Returns the exchange plus a hook that persists paper-account state after each tick. */
export async function makeExchange(cfg: AppConfig, repo: PgRepo): Promise<{ exchange: Exchange; persist: () => Promise<void> }> {
  if (cfg.MODE === "paper") {
    // Paper mode uses PUBLIC live market data only; no API key is sent.
    // stopOrderApi is unused here: the paper exchange simulates stops itself.
    const md = new BinanceFutures({ apiKey: "", apiSecret: "", baseUrl: "https://fapi.binance.com", stopOrderApi: "legacy" });
    const state = (await repo.getState<PaperState>("paperState")) ?? newPaperState(cfg.PAPER_START_BALANCE);
    const ex = new PaperExchange(md, state, { takerFee: cfg.TAKER_FEE, slippage: cfg.SLIPPAGE });
    return { exchange: ex, persist: () => repo.setState("paperState", ex.state) };
  }
  const ex = new BinanceFutures({
    apiKey: cfg.BINANCE_API_KEY, apiSecret: cfg.BINANCE_API_SECRET, baseUrl: cfg.baseUrl, stopOrderApi: cfg.BINANCE_STOP_API,
  });
  await ex.syncTime();
  if (cfg.MODE === "testnet" && cfg.MARKET_DATA_BASE_URL) {
    // Public data only (no key is sent): decisions on real prices, orders on the demo account.
    const md = new BinanceFutures({ apiKey: "", apiSecret: "", baseUrl: cfg.MARKET_DATA_BASE_URL, stopOrderApi: "legacy" });
    return { exchange: new MarketDataSplit(ex, md), persist: async () => {} };
  }
  return { exchange: ex, persist: async () => {} };
}
