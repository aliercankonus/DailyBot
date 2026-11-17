// Decimal-safe rounding to exchange step/tick sizes. Floating point (0.1 + 0.2) must
// never reach the exchange, so results are rounded to the step's decimal count.
export function decimalsOf(step: number): number {
  const s = step.toString();
  const [mantissa = "", exp] = s.split("e");
  const dot = mantissa.indexOf(".");
  const mantissaDecimals = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(0, mantissaDecimals - (exp ? Number(exp) : 0));
}

function snap(value: number, step: number, mode: "floor" | "ceil" | "round"): number {
  if (!(step > 0) || !Number.isFinite(value)) return value;
  const d = decimalsOf(step);
  const ratio = value / step;
  // Tolerate float noise just next to an integer (e.g. 2.9999999999), relative to the ratio's size.
  const eps = Math.max(1e-9, Math.abs(ratio) * 1e-12);
  const n = mode === "floor" ? Math.floor(ratio + eps) : mode === "ceil" ? Math.ceil(ratio - eps) : Math.round(ratio);
  return Number((n * step).toFixed(d));
}

export const floorToStep = (v: number, step: number) => snap(v, step, "floor");
export const ceilToStep = (v: number, step: number) => snap(v, step, "ceil");
export const roundToStep = (v: number, step: number) => snap(v, step, "round");

/** Format for the exchange query string without exponent notation. */
export function fmt(value: number, step: number): string {
  return value.toFixed(decimalsOf(step));
}
