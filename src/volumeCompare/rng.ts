/**
 * mulberry32 — a tiny, fast, seedable PRNG. Deterministic for a given seed so
 * pours are reproducible: feel tuning and tests must not flake on randomness.
 * Returns a float in [0, 1). The sphere solver draws all of its spawn jitter and
 * spin from an injected `Rng`, so a fixed seed reproduces a pour bit-for-bit.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
