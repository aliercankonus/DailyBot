// Wiring shared by the engine and API processes.
import pg from "pg";
import type { AppConfig } from "../config.js";
import { PgRepo } from "../db/pgRepo.js";
import { BinanceFutures } from "../exchange/binanceFutures.js";
import { newPaperState, PaperExchange, type PaperState } from "../exchange/paper.js";
import type { Exchange } from "../exchange/types.js";
import { consoleNotifier, telegramNotifier, type Notifier } from "../notify/notifier.js";

export function makePool(cfg: AppConfig) {
  return new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 5 });
}

export function makeNotifier(cfg: AppConfig): Notifier {
  return cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID ? telegramNotifier(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_CHAT_ID) : consoleNotifier;
}

/** Returns the exchange plus a hook that persists paper-account state after each tick. */
export async function makeExchange(cfg: AppConfig, repo: PgRepo): Promise<{ exchange: Exchange; persist: () => Promise<void> }> {
  if (cfg.MODE === "paper") {
    // Paper mode uses PUBLIC live market data only; no API key is sent.
    const md = new BinanceFutures({ apiKey: "", apiSecret: "", baseUrl: "https://fapi.binance.com", stopOrderApi: cfg.BINANCE_STOP_API });
    const state = (await repo.getState<PaperState>("paperState")) ?? newPaperState(cfg.PAPER_START_BALANCE);
    const ex = new PaperExchange(md, state, { takerFee: cfg.TAKER_FEE, slippage: cfg.SLIPPAGE });
    return { exchange: ex, persist: () => repo.setState("paperState", ex.state) };
  }
  const ex = new BinanceFutures({
    apiKey: cfg.BINANCE_API_KEY, apiSecret: cfg.BINANCE_API_SECRET, baseUrl: cfg.baseUrl, stopOrderApi: cfg.BINANCE_STOP_API,
  });
  await ex.syncTime();
  return { exchange: ex, persist: async () => {} };
}
