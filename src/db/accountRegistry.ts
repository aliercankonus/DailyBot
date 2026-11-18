// One Binance account per engine. In one-way mode an account holds one net position per
// symbol, so two engines on the same account would trade, size and stop each other's positions.
// Each engine in testnet/live mode registers a fingerprint of its API key (never the key) in the
// shared main database; a second engine with the same key refuses to start.
// Limitation: two different API keys of the same account are not detected; use one Binance
// sub-account per engine.
// Releasing a key (engine retired, key moved or renamed): on the main database run
//   DELETE FROM engine_accounts WHERE bot_name = '<BOT_NAME>';
import { createHash } from "node:crypto";
import type pg from "pg";

export const keyFingerprint = (apiKey: string) => createHash("sha256").update(apiKey).digest("hex").slice(0, 24);

/** `instance` identifies the engine's own database (e.g. its name), so a copied service is caught too. */
export async function registerEngineAccount(pool: pg.Pool, apiKey: string, botName: string, instance: string, now = Date.now()): Promise<void> {
  if (!apiKey) throw new Error("no API key to register");
  const fp = keyFingerprint(apiKey);
  await pool.query(
    "INSERT INTO engine_accounts (fingerprint, bot_name, instance, registered_at) VALUES ($1, $2, $3, $4) ON CONFLICT (fingerprint) DO NOTHING",
    [fp, botName, instance, now],
  );
  const { rows } = await pool.query<{ bot_name: string; instance: string }>("SELECT bot_name, instance FROM engine_accounts WHERE fingerprint = $1", [fp]);
  const owner = rows[0];
  if (!owner || owner.bot_name !== botName || owner.instance !== instance) {
    throw new Error(
      `this Binance API key is already registered by engine ${owner?.bot_name} (database ${owner?.instance}); every engine needs its own (sub-)account and key. ` +
      `If that engine is retired, release the key: DELETE FROM engine_accounts WHERE bot_name = '${owner?.bot_name}';`,
    );
  }
}
