// One Binance account per engine. In one-way mode an account holds one net position per
// symbol, so two engines on the same account would trade, size and stop each other's positions.
// Each engine in testnet/live mode registers a fingerprint of its API key (never the key) in the
// shared main database; a second engine with the same key refuses to start.
// Limitation: two different API keys of the same account are not detected; use one Binance
// sub-account per engine.
import { createHash } from "node:crypto";
import type pg from "pg";

export const keyFingerprint = (apiKey: string) => createHash("sha256").update(apiKey).digest("hex").slice(0, 24);

export async function registerEngineAccount(pool: pg.Pool, apiKey: string, botName: string, now = Date.now()): Promise<void> {
  if (!apiKey) throw new Error("no API key to register");
  const fp = keyFingerprint(apiKey);
  await pool.query(
    "INSERT INTO engine_accounts (fingerprint, bot_name, registered_at) VALUES ($1, $2, $3) ON CONFLICT (fingerprint) DO NOTHING",
    [fp, botName, now],
  );
  const { rows } = await pool.query<{ bot_name: string }>("SELECT bot_name FROM engine_accounts WHERE fingerprint = $1", [fp]);
  const owner = rows[0]?.bot_name;
  if (owner !== botName) {
    throw new Error(`this Binance API key is already registered by engine ${owner}; every engine needs its own (sub-)account and key`);
  }
}
