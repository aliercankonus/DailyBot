// Database names for EXTRA_DATABASES (one database per engine instance). Names are used as SQL
// identifiers in CREATE DATABASE, which cannot take bind parameters, so only plain lower-case
// identifiers are accepted, and the system databases are refused.
const RESERVED = new Set(["postgres", "template0", "template1"]);

export function parseExtraDatabases(raw: string | undefined): string[] {
  const names = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(n)) throw new Error(`EXTRA_DATABASES: invalid database name "${n}"`);
    if (RESERVED.has(n)) throw new Error(`EXTRA_DATABASES: "${n}" is a system database`);
  }
  return [...new Set(names)];
}

/** Double-quoted SQL identifier (names are already restricted by parseExtraDatabases). */
export const quoteIdent = (n: string) => `"${n.replace(/"/g, '""')}"`;
