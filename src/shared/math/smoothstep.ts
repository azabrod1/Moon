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

/**
 * Clamped smoothstep, matching GLSL `smoothstep(edge0, edge1, x)` — including
 * the degenerate equal-edges case, which resolves as a hard step rather than
 * a 0/0. Was privately re-implemented byte-for-byte by two modules; this is
 * the one definition.
 */
export function smoothstepEdges(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return smoothstepUnclamped(t);
}
