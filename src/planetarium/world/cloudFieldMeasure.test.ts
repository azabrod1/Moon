import { describe, expect, it } from 'vitest';
import {
  CLOUD_FIELD_GRID,
  CLOUD_FIELD_GUARD_TEXELS,
  CLOUD_FIELD_LEVEL_WIDTH,
  CLOUD_FIELD_LOWEST_RUNG,
  CLOUD_FIELD_RELEASE_TEXELS,
  CLOUD_FIELD_SAFETY_TEXELS,
  cloudFieldGuardWeight,
  cloudFieldMajor,
  cloudPageIndexOf,
} from './cloudField';
import {
  CLOUD_FIELD_KEEP_GRID,
  CLOUD_FIELD_KEEP_RAYS,
  CLOUD_SHADOW_DEMAND_PENUMBRA_TEXELS,
  CloudFieldMeasure,
  CloudShadowDemand,
  cloudPageKeepTexelsAll,
  fieldDisplayed,
  fieldPagePoint,
  fieldProjectPx,
  fieldTexelMajorAt,
  fieldUnproject,
  type FieldCamera,
} from './cloudFieldMeasure';
import { lensEffectiveStrength, lensOverscanFovDeg, lensUnwarpNdc } from '../../shared/math/lensProjection';
import { cloudRayDirection } from './cloudDeck';

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

/** One pose of the release-safety battery: a camera from low orbit to well
 *  past the Moon's distance in deck radii (log-uniform), aimed at a point of
 *  the visible cap so the limb and the frame's edge cut pages as often as
 *  not, at a random lens, frame, tile ratio and rung. */
function randomPose(r: () => number): { cam: FieldCamera; scale: number; dist: number } {
  const dist = Math.exp(Math.log(1.03) + r() * (Math.log(16) - Math.log(1.03)));
  const pos = randomUnit(r).map((v) => v * dist) as V;
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
  return { cam, scale, dist };
}

const env = (k: string) => (typeof process !== 'undefined' ? process.env[k] : undefined);

/**
 * The release rule's promise, checked for one way of measuring: a page whose
 * keep number is past `release` has a guard of zero at every point of it the
 * frame shows (a 25 x 25 grid on the page), at the pose's rung, so a release
 * can never pop a page that is still drawn.
 */
function releaseSafety(poses: number, seed: number, keepsOf: (cam: FieldCamera) => Float64Array, release: number) {
  const r = rng(seed);
  const dense = 25;
  let checkedPages = 0;
  let checkedPoints = 0;
  let worstWeight = 0;
  let lowestT = Number.POSITIVE_INFINITY;
  const failures: string[] = [];
  for (let pose = 0; pose < poses; pose++) {
    const { cam, scale, dist } = randomPose(r);
    const keeps = keepsOf(cam);
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
  return { checkedPages, checkedPoints, worstWeight, lowestT, failures };
}

describe('a released page', () => {
  // Deeper or harsher runs from the shell, never in CI: CLOUD_FIELD_POSES and
  // CLOUD_FIELD_SEED; and, on the reference, the control arm
  // CLOUD_FIELD_KEEP_N / CLOUD_FIELD_KEEP_MARGIN / CLOUD_FIELD_RELEASE,
  // CLOUD_FIELD_KEEP_RAYS=0 (a coarser grid, no margin, no rays through the
  // frame, or a release at the guard's own zero must fail, which is how the
  // test is known to see).
  const poses = Number(env('CLOUD_FIELD_POSES') ?? 160);
  const seed = Number(env('CLOUD_FIELD_SEED') ?? 20261003);
  const timeout = Math.max(120_000, poses * 500);

  function expectSafe(run: ReturnType<typeof releaseSafety>, label: string): void {
    // The bar: zero weight at every in-frame point of every released page.
    expect(run.failures).toEqual([]);
    expect(run.worstWeight).toBe(0);
    // ...and the run actually exercised it.
    expect(run.checkedPages).toBeGreaterThan(poses);
    expect(run.checkedPoints).toBeGreaterThan(poses * 100);
    expect(run.lowestT).toBeGreaterThanOrEqual(CLOUD_FIELD_GUARD_TEXELS[1]);
    console.log(`release safety (${label}): ${poses} poses, ${run.checkedPages} released pages in frame, ${run.checkedPoints} points, lowest in-frame T ${run.lowestT.toFixed(2)}`);
  }

  it('draws with no weight anywhere it is in frame, over random poses, rungs and lenses', () => {
    const keepN = Number(env('CLOUD_FIELD_KEEP_N') ?? CLOUD_FIELD_KEEP_GRID);
    const keepMargin = env('CLOUD_FIELD_KEEP_MARGIN') !== undefined ? Number(env('CLOUD_FIELD_KEEP_MARGIN')) : undefined;
    const release = Number(env('CLOUD_FIELD_RELEASE') ?? CLOUD_FIELD_RELEASE_TEXELS);
    const raysEnv = env('CLOUD_FIELD_KEEP_RAYS');
    const keepRays: [number, number] = raysEnv === undefined ? [...CLOUD_FIELD_KEEP_RAYS] as [number, number]
      : raysEnv === '0' ? [0, 0] : raysEnv.split(',').map(Number) as [number, number];
    expectSafe(releaseSafety(poses, seed, (cam) => cloudPageKeepTexelsAll(cam, keepN, keepMargin, keepRays), release), 'reference');
  }, timeout);

  it('...and so does every page the per-frame measure releases', () => {
    const measure = new CloudFieldMeasure();
    const sun: V = [1, 0, 0];
    expectSafe(releaseSafety(poses, seed, (cam) => { measure.measure(cam, sun); return measure.keepTexels; },
      CLOUD_FIELD_RELEASE_TEXELS), 'per-frame');
  }, timeout);
});

describe('the per-frame measure', () => {
  it('reads the reference\'s number for every page, within a part in a million', () => {
    // The same points read the same way, with the footprint in closed form
    // where the reference differences neighbouring rays. At or under the
    // release line the two must agree; past it the measure may answer with a
    // floor instead of reading the page, and the reference must read past it
    // too, so the floor never undercuts a point.
    const r = rng(Number(env('CLOUD_FIELD_SEED') ?? 20261003) + 1);
    const measure = new CloudFieldMeasure();
    let compared = 0;
    let pastRelease = 0;
    let marginOnly = 0;
    let worst = 0;
    let worstAt = '';
    const mismatched: string[] = [];
    for (let pose = 0; pose < 120; pose++) {
      const { cam } = randomPose(r);
      const ref = cloudPageKeepTexelsAll(cam);
      measure.measure(cam, [0, 1, 0]);
      for (let p = 0; p < ref.length; p++) {
        const a = ref[p];
        const b = measure.keepTexels[p];
        // The displayed points are some of the widened frame's.
        if (!(measure.wantTexels[p] >= b) && mismatched.length < 5) {
          mismatched.push(`pose ${pose} page ${p}: wanted at ${measure.wantTexels[p]}, kept at ${b}`);
        }
        if (Number.isFinite(b) && !Number.isFinite(measure.wantTexels[p])) marginOnly += 1;
        if (!Number.isFinite(a) && !Number.isFinite(b)) continue;
        if (b > CLOUD_FIELD_RELEASE_TEXELS) {
          pastRelease += 1;
          if (!(a > CLOUD_FIELD_RELEASE_TEXELS) && mismatched.length < 5) {
            mismatched.push(`pose ${pose} page ${p}: reference ${a}, per-frame ${b} past the release line`);
          }
          continue;
        }
        if (!Number.isFinite(a)) {
          if (mismatched.length < 5) mismatched.push(`pose ${pose} page ${p}: reference ${a}, per-frame ${b}`);
          continue;
        }
        compared += 1;
        const rel = Math.abs(b - a) / a;
        if (rel > worst) { worst = rel; worstAt = `pose ${pose} page ${p}: reference ${a}, per-frame ${b}`; }
      }
    }
    expect(mismatched).toEqual([]);
    expect(compared).toBeGreaterThan(500);
    expect(marginOnly).toBeGreaterThan(0);
    expect(worst, worstAt).toBeLessThan(1e-6);
    console.log(`per-frame against reference: ${compared} pages compared at or under the release line, worst relative difference ${worst.toExponential(2)}; ${pastRelease} past it in both; ${marginOnly} only in the margin`);
  });

  it('says how central and how lit each page\'s best point is', () => {
    // Straight down from 2 radii over a page's middle: that page holds the
    // frame's centre, and a Sun overhead lights it fully.
    const mid = fieldPagePoint(8, 3, 0.5, 0.5);
    const cam = lookAt(mid.map((v) => v * 2) as V, mid, 0, 40, 1.6, 1, 1600);
    const m = new CloudFieldMeasure();
    m.measure(cam, mid);
    const nadir = cloudPageIndexOf(mid[0], mid[1], mid[2]);
    expect(nadir).toBe(3 * CLOUD_FIELD_GRID[0] + 8);
    expect(m.centrality[nadir]).toBeGreaterThan(0.95);
    expect(m.sunDot[nadir]).toBeCloseTo(1, 6);
    // A page on the far side reads nothing.
    const far = cloudPageIndexOf(-mid[0], -mid[1], -mid[2]);
    expect(m.keepTexels[far]).toBe(Number.POSITIVE_INFINITY);
    expect(m.wantTexels[far]).toBe(Number.POSITIVE_INFINITY);
    expect(m.centrality[far]).toBe(0);
    expect(m.sunDot[far]).toBe(Number.NEGATIVE_INFINITY);
    // With the Sun behind the globe, even the page's most lit point in frame
    // is on the night side.
    m.measure(cam, mid.map((v) => -v) as V);
    expect(m.sunDot[nadir]).toBeLessThan(-0.8);
    // A camera inside the deck sees no front face.
    m.measure(lookAt([0.5, 0, 0], [1, 0, 0], 0, 40, 1.6, 1, 1600), mid);
    expect(m.keepTexels.every((t) => t === Number.POSITIVE_INFINITY)).toBe(true);
  });
});

/** Earth's deck: 10 km over 6371, the ground's radius in deck radii, and the
 *  shader's penumbra numerator for a Sun 0.00465 rad in radius. */
const H_OVER_R = 10 / 6371;
const GROUND = 1 / (1 + H_OVER_R);
const PENUMBRA = H_OVER_R * 2 * 0.00465;

/** The ground point (unit direction) under pixel (x, y), or null. */
function groundUnproject(cam: FieldCamera, x: number, y: number): V | null {
  const h = cam.heightPx;
  const w = h * cam.aspect;
  const t = Math.tan((cam.renderFovDeg * Math.PI) / 360);
  const rx = ((x / w) * 2 - 1) * t * cam.aspect;
  const ry = (1 - (y / h) * 2) * t;
  const d: V = norm([
    cam.right[0] * rx + cam.up[0] * ry - cam.back[0],
    cam.right[1] * rx + cam.up[1] * ry - cam.back[1],
    cam.right[2] * rx + cam.up[2] * ry - cam.back[2],
  ]);
  const b = cam.pos[0] * d[0] + cam.pos[1] * d[1] + cam.pos[2] * d[2];
  const c = cam.pos[0] ** 2 + cam.pos[1] ** 2 + cam.pos[2] ** 2 - GROUND * GROUND;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = -b - Math.sqrt(disc);
  if (!(s > 0)) return null;
  return norm([cam.pos[0] + s * d[0], cam.pos[1] + s * d[1], cam.pos[2] + s * d[2]]);
}

/**
 * The shadow's guard input at pixel (x, y), by the reference's method: the
 * pierce direction (cloudRayDirection) differenced across neighbouring rays,
 * each column widened to the penumbra as the shader widens it, into page
 * texels through the map's uv rule. Null where the ground has no Sun or the
 * penumbra alone is past the demand's line.
 */
function shadowMajorAt(cam: FieldCamera, x: number, y: number, sun: V, stepPx = 0.02): { major: number; q: V } | null {
  const n = groundUnproject(cam, x, y);
  if (!n) return null;
  const mu = n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2];
  if (!(mu > 0)) return null;
  const pen = PENUMBRA / Math.max(mu * mu, 0.01);
  if (pen / ((2 * Math.PI) / CLOUD_FIELD_LEVEL_WIDTH) > CLOUD_SHADOW_DEMAND_PENUMBRA_TEXELS) return null;
  const pierce = (px: number, py: number): V | null => {
    const g = groundUnproject(cam, px, py);
    return g ? cloudRayDirection(g, sun, H_OVER_R) : null;
  };
  const q = pierce(x, y)!;
  const xp = pierce(x + stepPx, y), xm = pierce(x - stepPx, y);
  const yp = pierce(x, y + stepPx), ym = pierce(x, y - stepPx);
  if (!xp || !xm || !yp || !ym) return null;
  const k = 2 * stepPx;
  const widen = (d: V): V => {
    const l = Math.hypot(d[0], d[1], d[2]);
    const f = Math.max(1, pen / Math.max(l, 1e-12));
    return [d[0] * f, d[1] * f, d[2] * f];
  };
  const ddx = widen([(xp[0] - xm[0]) / k, (xp[1] - xm[1]) / k, (xp[2] - xm[2]) / k]);
  const ddy = widen([(yp[0] - ym[0]) / k, (yp[1] - ym[1]) / k, (yp[2] - ym[2]) / k]);
  const cosLat = Math.max(Math.hypot(q[0], q[2]), 1e-4);
  const tu = CLOUD_FIELD_LEVEL_WIDTH;
  const tv = (CLOUD_FIELD_LEVEL_WIDTH * CLOUD_FIELD_GRID[1]) / CLOUD_FIELD_GRID[0];
  const uv = (dd: V): [number, number] => [
    ((q[2] * dd[0] - q[0] * dd[2]) / (cosLat * cosLat) / (2 * Math.PI)) * tu,
    (dd[1] / cosLat / Math.PI) * tv,
  ];
  return { major: cloudFieldMajor(uv(ddx), uv(ddy)), q };
}

/** Every page's shadow demand by the reference: the frame's rays at the ground. */
function shadowDemandReference(cam: FieldCamera, sun: V): Float64Array {
  const [gx, gy] = CLOUD_FIELD_GRID;
  const out = new Float64Array(gx * gy).fill(Number.POSITIVE_INFINITY);
  const ndc = { x: 0, y: 0 };
  const [nx, ny] = CLOUD_FIELD_KEEP_RAYS;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      lensUnwarpNdc((i / (nx - 1)) * 2 - 1, (j / (ny - 1)) * 2 - 1,
        cam.designFovDeg, cam.renderFovDeg, cam.aspect, cam.lensStrength, ndc);
      const hit = shadowMajorAt(cam, (ndc.x + 1) * 0.5 * cam.heightPx * cam.aspect, (1 - ndc.y) * 0.5 * cam.heightPx, sun);
      if (!hit) continue;
      const p = cloudPageIndexOf(hit.q[0], hit.q[1], hit.q[2]);
      if (hit.major < out[p]) out[p] = hit.major;
    }
  }
  return out;
}

describe('the shadow\'s demand', () => {
  it('reads the reference\'s number for every page a shadow in frame reads', () => {
    const r = rng(Number(env('CLOUD_FIELD_SEED') ?? 20261003) + 7);
    const measure = new CloudFieldMeasure();
    const shadow = new CloudShadowDemand();
    let compared = 0;
    let worst = 0;
    let worstAt = '';
    const mismatched: string[] = [];
    for (let pose = 0; pose < 200; pose++) {
      const { cam } = randomPose(r);
      // A Sun over the frame's side of the globe, so most poses have a day.
      const look: V = norm([-cam.back[0] - cam.pos[0] * 0.2, -cam.back[1] - cam.pos[1] * 0.2, -cam.back[2] - cam.pos[2] * 0.2]);
      const sun = norm([cam.pos[0] + look[0] + (r() - 0.5) * 2, cam.pos[1] + look[1] + (r() - 0.5) * 2, cam.pos[2] + look[2] + (r() - 0.5) * 2]);
      measure.measure(cam, sun);
      measure.measureShadow(GROUND, H_OVER_R, PENUMBRA, shadow);
      const ref = shadowDemandReference(cam, sun);
      for (let p = 0; p < ref.length; p++) {
        const a = ref[p];
        const b = shadow.wantTexels[p];
        if (shadow.keepTexels[p] !== b && mismatched.length < 5) mismatched.push(`pose ${pose} page ${p}: kept at ${shadow.keepTexels[p]}, wanted at ${b}`);
        if (!Number.isFinite(a) && !Number.isFinite(b)) continue;
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
          if (mismatched.length < 5) mismatched.push(`pose ${pose} page ${p}: reference ${a}, per-frame ${b}`);
          continue;
        }
        // Past the release line a page is neither wanted nor kept, and a
        // grazing footprint there is beyond what differencing reads well.
        if (a > CLOUD_FIELD_RELEASE_TEXELS && b > CLOUD_FIELD_RELEASE_TEXELS) continue;
        compared += 1;
        const rel = Math.abs(b - a) / a;
        if (rel > worst) { worst = rel; worstAt = `pose ${pose} page ${p}: reference ${a}, per-frame ${b}`; }
      }
    }
    expect(mismatched).toEqual([]);
    expect(compared).toBeGreaterThan(100);
    expect(worst, worstAt).toBeLessThan(1e-4);
  });

  /** Straight down from 400 km at 11° N, the frame's east edge 20 km short of
   *  a page's eastern edge, and the Sun `elevDeg` up in the east or west. */
  function besideAnEdge(elevDeg: number, east: boolean) {
    const kmPerPage = (Math.PI / 8) * 6381 * Math.cos((11.25 * Math.PI) / 180);
    // A 40° frame at 1.6:1 spans tan(20°)·1.6 of the 400 km height each side.
    const halfKm = 400 * Math.tan((20 * Math.PI) / 180) * 1.6;
    const s = 1 - (halfKm + 20) / kmPerPage;
    const target = fieldPagePoint(8, 3, s, 0.5);
    const ahead = fieldPagePoint(8, 3, s + 1e-4, 0.5);
    const eastward = norm(sub(ahead, target));
    const e = (elevDeg * Math.PI) / 180;
    const sign = east ? 1 : -1;
    const sun = norm([
      target[0] * Math.sin(e) + sign * eastward[0] * Math.cos(e),
      target[1] * Math.sin(e) + sign * eastward[1] * Math.cos(e),
      target[2] * Math.sin(e) + sign * eastward[2] * Math.cos(e),
    ]);
    const cam = lookAt(target.map((v) => v * (1 + 400 / 6381)) as V, target, 0, 40, 1.6, 0, 1000);
    // The camera's right must be east, so the frame's east edge is the one
    // beside the page edge.
    if (cam.right[0] * eastward[0] + cam.right[1] * eastward[1] + cam.right[2] * eastward[2] < 0) {
      cam.right = cam.right.map((v) => -v) as V;
      cam.up = cam.up.map((v) => -v) as V;
    }
    const measure = new CloudFieldMeasure();
    const shadow = new CloudShadowDemand();
    measure.measure(cam, sun);
    measure.measureShadow(GROUND, H_OVER_R, PENUMBRA, shadow);
    return { deck: measure, shadow, own: 3 * CLOUD_FIELD_GRID[0] + 8, next: 3 * CLOUD_FIELD_GRID[0] + 9 };
  }

  it('asks for the page across an edge that only a shadow in frame reads', () => {
    // A low Sun in the east puts the pierce points 57 km east of the cloud
    // over each ground point: across the page edge 20 km past the frame.
    const { deck, shadow, own, next } = besideAnEdge(10, true);
    expect(deck.wantTexels[own]).toBeLessThan(1);
    expect(deck.wantTexels[next]).toBe(Number.POSITIVE_INFINITY);
    expect(shadow.wantTexels[next]).toBeLessThan(CLOUD_FIELD_GUARD_TEXELS[0]);
    expect(shadow.wantTexels[own]).toBeLessThan(CLOUD_FIELD_GUARD_TEXELS[0]);
    // In the west the shadows read away from that edge.
    expect(besideAnEdge(10, false).shadow.wantTexels[next]).toBe(Number.POSITIVE_INFINITY);
  });

  it('asks for nothing where the penumbra alone would draw the field at under half its weight', () => {
    // 3.5° at the frame's centre, under 6° at its edge on the Sun's side.
    const low = besideAnEdge(3.5, true);
    expect(low.shadow.samples).toBe(0);
    expect(low.shadow.wantTexels.every((t) => t === Number.POSITIVE_INFINITY)).toBe(true);
    // The line is the guard's midpoint, about 6.4° of Sun for a 10 km deck.
    const sinE = Math.sqrt(PENUMBRA / (CLOUD_SHADOW_DEMAND_PENUMBRA_TEXELS * ((2 * Math.PI) / CLOUD_FIELD_LEVEL_WIDTH)));
    expect((Math.asin(sinE) * 180) / Math.PI).toBeCloseTo(6.4, 1);
    expect(besideAnEdge(7, true).shadow.samples).toBeGreaterThan(0);
  });
});
