/**
 * Hermite smoothstep of an already-clamped `t` in [0, 1] → `t*t*(3-2*t)`.
 *
 * Intentionally 1-arg and NON-clamping: every call site pre-clamps its input
 * (e.g. `Math.min(1, Math.max(0, …))`), so this mirrors the inlined
 * `t*t*(3-2*t)` it replaces exactly. Do not pass an unclamped value.
 */
export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}
