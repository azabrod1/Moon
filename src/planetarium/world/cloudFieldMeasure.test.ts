import { describe, expect, it } from 'vitest';
import {
  CLOUD_FIELD_GRID,
  CLOUD_FIELD_GUARD_TEXELS,
  CLOUD_FIELD_LOWEST_RUNG,
  CLOUD_FIELD_RELEASE_TEXELS,
  CLOUD_FIELD_SAFETY_TEXELS,
  cloudFieldGuardWeight,
  cloudFieldMajor,
} from './cloudField';
import {
  CLOUD_FIELD_KEEP_GRID,
  CLOUD_FIELD_KEEP_RAYS,
  cloudPageKeepTexelsAll,
  fieldDisplayed,
  fieldPagePoint,
  fieldProjectPx,
  fieldTexelMajorAt,
  fieldUnproject,
  type FieldCamera,
} from './cloudFieldMeasure';
import { lensEffectiveStrength, lensOverscanFovDeg } from '../../shared/math/lensProjection';

type V = [number, number, number];
const norm = (v: V): V => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** A small seeded generator, so a failure names a pose that comes back. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnit(r: () => number): V {
  const z = r() * 2 - 1;
  const a = r() * 2 * Math.PI;
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(a), z, s * Math.sin(a)];
}

/** A camera at `pos` looking at `target` with a roll, in deck radii. */
function lookAt(pos: V, target: V, roll: number, designFovDeg: number, aspect: number, strength: number, heightPx: number): FieldCamera {
  const back = norm(sub(pos, target));
  let up0: V = Math.abs(back[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
  let right = norm(cross(up0, back));
  up0 = cross(back, right);
  const c = Math.cos(roll), s = Math.sin(roll);
  const r2: V = [right[0] * c + up0[0] * s, right[1] * c + up0[1] * s, right[2] * c + up0[2] * s];
  const u2: V = [up0[0] * c - right[0] * s, up0[1] * c - right[1] * s, up0[2] * c - right[2] * s];
  right = r2;
  const eff = lensEffectiveStrength(designFovDeg, aspect, strength);
  return {
    pos, right, up: u2, back, designFovDeg, lensStrength: eff, aspect, heightPx,
    renderFovDeg: lensOverscanFovDeg(designFovDeg, aspect, eff),
  };
}

describe('the field\'s measure', () => {
  it('takes the true major axis, which a diagonal footprint\'s columns under-read by up to root two', () => {
    expect(cloudFieldMajor([3, 0], [0, 1])).toBeCloseTo(3, 9);
    expect(cloudFieldMajor([1, 1], [1, -1])).toBeCloseTo(Math.SQRT2, 9);
    // A diagonal stretch: both columns are length 1, the footprint 2 long.
    const a: [number, number] = [Math.SQRT1_2 * 1.5 + Math.SQRT1_2 * 0.5, Math.SQRT1_2 * 1.5 - Math.SQRT1_2 * 0.5];
    const major = cloudFieldMajor([Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, Math.SQRT1_2]);
    expect(major).toBeCloseTo(Math.SQRT2, 9);
    expect(a.length).toBe(2);
  });

  it('reads the same number whatever the rung: the guard is in tile-ratio pixels', () => {
    // A footprint of 6 tile-ratio texels a pixel, drawn at three scene ratios.
    for (const scale of [CLOUD_FIELD_LOWEST_RUNG, 1, 1.25, 1.5]) {
      const scene = 6 / scale;
      expect(cloudFieldGuardWeight(scene, scale)).toBeCloseTo(cloudFieldGuardWeight(6, 1), 12);
    }
  });

  it('keeps the safety term off every normal rung, and zero by twelve real texels', () => {
    // At the lowest rung the main guard reaches zero exactly where the safety
    // term starts.
    expect(CLOUD_FIELD_SAFETY_TEXELS[0]).toBeCloseTo(CLOUD_FIELD_GUARD_TEXELS[1] / CLOUD_FIELD_LOWEST_RUNG, 9);
    for (const scale of [0.75, 1, 1.5]) {
      for (let t = 0; t <= 16; t += 0.25) {
        expect(cloudFieldGuardWeight(t / scale, scale)).toBeCloseTo(
          1 - smooth(CLOUD_FIELD_GUARD_TEXELS[0], CLOUD_FIELD_GUARD_TEXELS[1], t), 12);
      }
    }
    // Under a pin far below the ladder (an upscale at half the output ratio),
    // the real footprint is what stops it.
    expect(cloudFieldGuardWeight(12, 0.5)).toBe(0);
    expect(cloudFieldGuardWeight(11, 0.5)).toBeGreaterThan(0);
  });

  it('finds the deck point under a pixel and comes back to that pixel', () => {
    const cam = lookAt([0, 0, 3], [0, 0, 0], 0.3, 50, 1.6, 0.6, 1000);
    for (const [x, y] of [[800, 500], [100, 900], [1500, 120]]) {
      const d = fieldUnproject(cam, x, y);
      if (!d) continue;
      const p = fieldProjectPx(cam, d)!;
      expect(p.x).toBeCloseTo(x, 6);
      expect(p.y).toBeCloseTo(y, 6);
    }
  });

  it('measures a face-on footprint as the texel over the pixel\'s ground size', () => {
    // Straight down from 2 radii out at the equator, centre pixel: one pixel
    // spans (distance to the deck) x (2 tan(half fov) / height) radians.
    const cam = lookAt([0, 0, 2], [0, 0, 0], 0, 40, 1, 0, 1000);
    const d: V = [0, 0, 1];
    const t = fieldTexelMajorAt(cam, d)!;
    const pixelRad = (1 * 2 * Math.tan((20 * Math.PI) / 180)) / 1000;
    const texelRad = (2 * Math.PI) / 32512;
    expect(t).toBeCloseTo(pixelRad / texelRad, 3);
  });
});

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

describe('a released page', () => {
  it('draws with no weight anywhere it is in frame, over random poses, rungs and lenses', () => {
    // The release rule's promise: a page the residency lets go at T > 12 has a
    // guard of zero at every point of it the frame shows, at any scene ratio
    // from the bottom of the ladder to its top and any lens strength, so a
    // release can never pop a page that is still drawn.
    // Deeper or harsher runs from the shell, never in CI: CLOUD_FIELD_POSES,
    // and the control arm CLOUD_FIELD_KEEP_N / CLOUD_FIELD_KEEP_MARGIN /
    // CLOUD_FIELD_RELEASE, CLOUD_FIELD_KEEP_RAYS=0 (a coarser grid, no margin,
    // no rays through the frame, or a release at the
    // guard's own zero must fail, which is how the test is known to see).
    const env = (k: string) => (typeof process !== 'undefined' ? process.env[k] : undefined);
    const r = rng(Number(env('CLOUD_FIELD_SEED') ?? 20261003));
    const poses = Number(env('CLOUD_FIELD_POSES') ?? 160);
    const keepN = Number(env('CLOUD_FIELD_KEEP_N') ?? CLOUD_FIELD_KEEP_GRID);
    const keepMargin = env('CLOUD_FIELD_KEEP_MARGIN') !== undefined ? Number(env('CLOUD_FIELD_KEEP_MARGIN')) : undefined;
    const release = Number(env('CLOUD_FIELD_RELEASE') ?? CLOUD_FIELD_RELEASE_TEXELS);
    const raysEnv = env('CLOUD_FIELD_KEEP_RAYS');
    const keepRays: [number, number] = raysEnv === undefined ? [...CLOUD_FIELD_KEEP_RAYS] as [number, number]
      : raysEnv === '0' ? [0, 0] : raysEnv.split(',').map(Number) as [number, number];
    const dense = 25;
    let checkedPages = 0;
    let checkedPoints = 0;
    let worstWeight = 0;
    let lowestT = Number.POSITIVE_INFINITY;
    const failures: string[] = [];
    for (let pose = 0; pose < poses; pose++) {
      // From low orbit to well past the Moon's distance in deck radii, log-uniform.
      const dist = Math.exp(Math.log(1.03) + r() * (Math.log(16) - Math.log(1.03)));
      const pos = randomUnit(r).map((v) => v * dist) as V;
      // Aim at a point of the visible cap, so the limb and the frame edge cut
      // pages as often as not.
      let target: V;
      for (;;) {
        const d = randomUnit(r);
        if (d[0] * pos[0] + d[1] * pos[1] + d[2] * pos[2] > 1) { target = d; break; }
      }
      const designFov = 25 + r() * 50;
      const aspect = [0.46, 0.75, 1.33, 1.6, 1.78][Math.floor(r() * 5)];
      const strength = [0, 0.5, 1][Math.floor(r() * 3)];
      const cssH = [600, 844, 1000][Math.floor(r() * 3)];
      const tileRatio = [1, 2, 3][Math.floor(r() * 3)];
      const scale = CLOUD_FIELD_LOWEST_RUNG + r() * (1.5 - CLOUD_FIELD_LOWEST_RUNG);
      const cam = lookAt(pos, target, r() * 2 * Math.PI, designFov, aspect, strength, cssH * tileRatio);
      const keeps = cloudPageKeepTexelsAll(cam, keepN, keepMargin, keepRays);
      for (let row = 0; row < CLOUD_FIELD_GRID[1]; row++) {
        for (let col = 0; col < CLOUD_FIELD_GRID[0]; col++) {
          const keep = keeps[row * CLOUD_FIELD_GRID[0] + col];
          if (!(keep > release)) continue;
          let pageChecked = false;
          for (let j = 0; j < dense; j++) {
            for (let i = 0; i < dense; i++) {
              const d = fieldPagePoint(col, row, i / (dense - 1), j / (dense - 1));
              const p = fieldProjectPx(cam, d);
              if (!p || !fieldDisplayed(cam, p.ndcX, p.ndcY)) continue;
              const tOut = fieldTexelMajorAt(cam, d);
              if (tOut === null) continue;
              // The shader reads the same footprint in scene pixels and scales it.
              const w = cloudFieldGuardWeight(tOut / scale, scale);
              checkedPoints += 1;
              pageChecked = true;
              lowestT = Math.min(lowestT, tOut);
              if (w > worstWeight) worstWeight = w;
              if (w > 0 && failures.length < 5) {
                failures.push(`pose ${pose} page ${col}_${row}: keep ${keep.toFixed(2)}, point T ${tOut.toFixed(2)}, w ${w.toFixed(3)}, dist ${dist.toFixed(2)}`);
              }
            }
          }
          if (pageChecked) checkedPages += 1;
        }
      }
    }
    // The bar: zero weight at every in-frame point of every released page.
    expect(failures).toEqual([]);
    expect(worstWeight).toBe(0);
    // ...and the run actually exercised it.
    expect(checkedPages).toBeGreaterThan(poses);
    expect(checkedPoints).toBeGreaterThan(poses * 100);
    expect(lowestT).toBeGreaterThanOrEqual(CLOUD_FIELD_GUARD_TEXELS[1]);
    console.log(`release safety: ${poses} poses, ${checkedPages} released pages in frame, ${checkedPoints} points, lowest in-frame T ${lowestT.toFixed(2)}`);
  }, Math.max(120_000, Number(process.env.CLOUD_FIELD_POSES ?? 0) * 500));
});
