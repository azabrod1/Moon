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

/**
 * Perlin's smootherstep, `t³(6t² − 15t + 10)`, clamped to [0, 1]: an ease
 * whose first AND second derivatives are zero at both ends, so something
 * driven by it starts and stops without a visible kick in its rate as well as
 * in its value. The ends are returned as the exact constants 0 and 1, so a
 * caller that multiplies by the result at either end multiplies by exactly
 * that number — and the polynomial is held to [0, 1] as well, because in
 * doubles it rounds to 1.0000000000000002 a hair short of t = 1, and a fade
 * that stops there is not exactly on.
 */
export function smootherstep(t: number): number {
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  return Math.min(1, t * t * t * (t * (6 * t - 15) + 10));
}
