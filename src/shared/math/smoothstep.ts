/**
 * Hermite smoothstep WITHOUT input clamping: `t*t*(3-2*t)`.
 *
 * Named to make the no-clamp behaviour explicit (unlike GLSL/lodash
 * `smoothstep(edge0, edge1, x)`, which clamps). Every call site already
 * pre-clamps t to [0,1] (e.g. `Math.min(1, Math.max(0, …))`), so this mirrors
 * the inlined polynomial it replaced. Pass only values already in [0,1].
 */
export function smoothstepUnclamped(t: number): number {
  return t * t * (3 - 2 * t);
}
