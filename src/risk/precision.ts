// Decimal-safe rounding to exchange step/tick sizes. Floating point (0.1 + 0.2) must
// never reach the exchange, so results are rounded to the step's decimal count.
export function decimalsOf(step: number): number {
  const s = step.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

function snap(value: number, step: number, mode: "floor" | "ceil" | "round"): number {
  if (!(step > 0) || !Number.isFinite(value)) return value;
  const d = decimalsOf(step);
  const ratio = value / step;
  // Tolerate float noise just below an integer (e.g. 2.9999999999).
  const n = mode === "floor" ? Math.floor(ratio + 1e-9) : mode === "ceil" ? Math.ceil(ratio - 1e-9) : Math.round(ratio);
  return Number((n * step).toFixed(d));
}

export const floorToStep = (v: number, step: number) => snap(v, step, "floor");
export const ceilToStep = (v: number, step: number) => snap(v, step, "ceil");
export const roundToStep = (v: number, step: number) => snap(v, step, "round");

/** Format for the exchange query string without exponent notation. */
export function fmt(value: number, step: number): string {
  return value.toFixed(decimalsOf(step));
}
