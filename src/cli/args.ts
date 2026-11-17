/** Minimal `--key value` / `--flag` parser. */
export function parseArgs(argv = process.argv.slice(2)): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

export const str = (v: string | true | undefined, d: string) => (typeof v === "string" ? v : d);
export const dateMs = (s: string) => {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`bad date: ${s}`);
  return t;
};
