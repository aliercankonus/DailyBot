import { z } from "zod";

const INTERVAL_MS: Record<string, number> = {
  "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000,
  "8h": 28_800_000, "12h": 43_200_000, "1d": 86_400_000,
};

const pct = z.coerce.number().gt(0).lt(1);

const Env = z.object({
  MODE: z.enum(["paper", "testnet", "live"]).default("paper"),
  CONFIRM_LIVE: z.string().optional(),
  BINANCE_API_KEY: z.string().default(""),
  BINANCE_API_SECRET: z.string().default(""),
  BINANCE_BASE_URL: z.string().url().optional(),
  BINANCE_STOP_API: z.enum(["algo", "legacy", "auto"]).default("auto"),
  SYMBOLS: z.string().default("BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT"),
  INTERVAL: z.string().refine((v) => Object.hasOwn(INTERVAL_MS, v), "unsupported interval").default("4h"),
  RISK_PER_TRADE: pct.max(0.02, "risk per trade above 2% is refused").default(0.005),
  MAX_LEVERAGE: z.coerce.number().int().min(1).max(5).default(3),
  MAX_OPEN_POSITIONS: z.coerce.number().int().min(1).max(10).default(3),
  DAILY_LOSS_LIMIT: pct.default(0.03),
  MAX_DRAWDOWN: pct.default(0.15),
  PAPER_START_BALANCE: z.coerce.number().positive().default(10_000),
  TAKER_FEE: z.coerce.number().min(0).max(0.01, "TAKER_FEE above 1% is not plausible").default(0.0005),
  SLIPPAGE: z.coerce.number().min(0).max(0.05, "SLIPPAGE above 5% is not plausible").default(0.0005),
  DATABASE_URL: z.string().default("postgres://trader:trader@localhost:5432/trader"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  API_TOKEN: z.string().min(24, "API_TOKEN must be at least 24 characters").optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TICK_SECONDS: z.coerce.number().int().min(15).default(60),
});

/**
 * Which process is loading the config. Each container only receives the secrets it needs
 * (see docker-compose.vps.yml), so role-specific requirements are checked per role:
 * - engine: MODE=live needs CONFIRM_LIVE; testnet/live need Binance keys.
 * - api: needs API_TOKEN.
 * - migrate: only DATABASE_URL.
 */
export type ConfigRole = "engine" | "api" | "migrate";

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, role: ConfigRole = "engine") {
  // Treat empty values (KEY= in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const e = Env.parse(cleaned);
  if (role === "engine") {
    if (e.MODE === "live" && e.CONFIRM_LIVE !== "I_UNDERSTAND_REAL_MONEY") {
      throw new Error("MODE=live requires CONFIRM_LIVE=I_UNDERSTAND_REAL_MONEY");
    }
    if (e.MODE !== "paper" && (!e.BINANCE_API_KEY || !e.BINANCE_API_SECRET)) {
      throw new Error(`MODE=${e.MODE} requires BINANCE_API_KEY and BINANCE_API_SECRET`);
    }
  }
  if (role === "api" && !e.API_TOKEN) throw new Error("API_TOKEN is required for the API process");
  const defaultBase = e.MODE === "testnet" ? "https://demo-fapi.binance.com" : "https://fapi.binance.com";
  return {
    ...e,
    baseUrl: e.BINANCE_BASE_URL ?? defaultBase,
    symbols: e.SYMBOLS.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    intervalMs: INTERVAL_MS[e.INTERVAL]!,
  };
}

export { INTERVAL_MS };
