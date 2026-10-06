import { describe, expect, it } from 'vitest';
import { parseReliefBalance, RELIEF_SPHERE_FRAME_GLSL } from './reliefFrame';

type Vec3 = [number, number, number];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));
const length = (a: Vec3): number => Math.hypot(...a);

/** three's SphereGeometry: parametric (u, w) at (-cos φ sin θ, cos θ, sin φ sin θ),
 *  φ = 2πu, θ = πw, with uv (u, 1 − w). The point and the partial derivatives
 *  of position by the two UV coordinates. */
function spherePoint(u: number, uvY: number): { p: Vec3; dPdu: Vec3; dPdv: Vec3 } {
  const phi = 2 * Math.PI * u;
  const theta = Math.PI * (1 - uvY);
  const p: Vec3 = [-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta)];
  const dPdu: Vec3 = scale([Math.sin(phi) * Math.sin(theta), 0, Math.cos(phi) * Math.sin(theta)], 2 * Math.PI);
  const dPdTheta: Vec3 = [-Math.cos(phi) * Math.cos(theta), -Math.sin(theta), Math.sin(phi) * Math.cos(theta)];
  return { p, dPdu, dPdv: scale(dPdTheta, -Math.PI) };
}

/** three's getTangentFrame, transcribed (normalmap_pars_fragment), fed the
 *  screen derivatives a pixel step along `stepX` and `stepY` (combinations of
 *  the UV partials) produces, with the UV the map is read through scaled by
 *  `uvScale` as a crop's repeat scales it. */
function threeTangentFrame(
  n: Vec3, dPdu: Vec3, dPdv: Vec3, stepX: [number, number], stepY: [number, number], uvScale: [number, number],
): { t: Vec3; b: Vec3 } {
  const q0 = add(scale(dPdu, stepX[0]), scale(dPdv, stepX[1]));
  let q1 = add(scale(dPdu, stepY[0]), scale(dPdv, stepY[1]));
  // A fragment the camera sees front-on has screen x × screen y along its
  // normal; three's construction is the gradient of u for that handedness,
  // so the steps are oriented the way a drawn pixel's are.
  if (dot(cross(q0, q1), n) < 0) {
    stepY = [-stepY[0], -stepY[1]];
    q1 = scale(q1, -1);
  }
  const st0: [number, number] = [stepX[0] * uvScale[0], stepX[1] * uvScale[1]];
  const st1: [number, number] = [stepY[0] * uvScale[0], stepY[1] * uvScale[1]];
  const q1perp = cross(q1, n);
  const q0perp = cross(n, q0);
  const t = add(scale(q1perp, st0[0]), scale(q0perp, st1[0]));
  const b = add(scale(q1perp, st0[1]), scale(q0perp, st1[1]));
  const det = Math.max(dot(t, t), dot(b, b));
  const s = det === 0 ? 0 : 1 / Math.sqrt(det);
  return { t: scale(t, s), b: scale(b, s) };
}

/** RELIEF_SPHERE_FRAME_GLSL's arithmetic. */
function sphereFrame(pole: Vec3, n: Vec3): { t: Vec3; b: Vec3 } {
  const raw = cross(unit(pole), n);
  const east = scale(raw, 1 / Math.max(length(raw), 1e-6));
  return { t: east, b: cross(n, east) };
}

const expectVec = (got: Vec3, want: Vec3, what: string) => {
  for (let i = 0; i < 3; i++) expect(got[i], `${what}[${i}]`).toBeCloseTo(want[i], 9);
};

// Pixel steps that are skewed and unequal, so the cotangent construction is
// really exercised rather than a step straight along u and v.
const STEPS: Array<[[number, number], [number, number]]> = [
  [[1e-4, 2e-5], [-3e-5, 1.5e-4]],
  [[-2e-5, 7e-5], [9e-5, 1e-5]],
];
const LATITUDES = [-80, -61, -45, -20, 0, 10, 35, 59.9, 60.1, 72, 85];

describe('three\'s relief frame on an equirect sphere', () => {
  it('weights the map\'s east by min(1, 1/(2 cos lat)) and north by min(1, 2 cos lat)', () => {
    // The imbalance the sphere frame exists for: a physically baked map's
    // east-west slopes at half weight at the equator. On the ideal sphere;
    // the drawn mesh's triangles move these by a few per cent.
    for (const latDeg of LATITUDES) {
      const c = Math.cos((latDeg * Math.PI) / 180);
      const { p, dPdu, dPdv } = spherePoint(0.4, 0.5 + latDeg / 180);
      for (const [stepX, stepY] of STEPS) {
        const three = threeTangentFrame(p, dPdu, dPdv, stepX, stepY, [1, 1]);
        const ours = sphereFrame([0, 1, 0], p);
        expectVec(three.t, scale(ours.t, Math.min(1, 1 / (2 * c))), `t at ${latDeg}`);
        expectVec(three.b, scale(ours.b, Math.min(1, 2 * c)), `b at ${latDeg}`);
      }
    }
  });

  it('is unchanged by a uniform crop scale and changed by a one-sector crop\'s, so it reads the globe\'s UV', () => {
    const { p, dPdu, dPdv } = spherePoint(0.31, 0.62);
    const globe = threeTangentFrame(p, dPdu, dPdv, STEPS[0][0], STEPS[0][1], [1, 1]);
    // A two-sector crop scaled u and v alike: the frame the globe had.
    const twoWide = threeTangentFrame(p, dPdu, dPdv, STEPS[0][0], STEPS[0][1], [3.94, 3.94]);
    expectVec(twoWide.t, globe.t, 't');
    expectVec(twoWide.b, globe.b, 'b');
    // A one-sector crop scales u twice as much as v: read through it, the
    // frame would carry another balance than the globe under it.
    const oneWide = threeTangentFrame(p, dPdu, dPdv, STEPS[0][0], STEPS[0][1], [7.88, 3.94]);
    expect(length(oneWide.t) / length(oneWide.b)).not.toBeCloseTo(length(globe.t) / length(globe.b), 3);
  });
});

describe('the sphere\'s own frame', () => {
  it('is orthonormal east and north, pointing the way the UV grows', () => {
    for (const latDeg of LATITUDES) {
      for (const u of [0.03, 0.4, 0.77]) {
        const { p, dPdu, dPdv } = spherePoint(u, 0.5 + latDeg / 180);
        const ours = sphereFrame([0, 1, 0], p);
        expect(length(ours.t)).toBeCloseTo(1, 12);
        expect(length(ours.b)).toBeCloseTo(1, 12);
        expect(dot(ours.t, ours.b)).toBeCloseTo(0, 12);
        expect(dot(ours.t, p)).toBeCloseTo(0, 12);
        expect(dot(ours.t, unit(dPdu))).toBeCloseTo(1, 12);
        expect(dot(ours.b, unit(dPdv))).toBeCloseTo(1, 12);
      }
    }
  });

  it('collapses onto the normal exactly at a pole rather than dividing by zero', () => {
    const ours = sphereFrame([0, 1, 0], [0, 1, 0]);
    for (const v of [...ours.t, ...ours.b]) expect(Number.isFinite(v)).toBe(true);
    expect(length(ours.t)).toBe(0);
  });

  it('is the GLSL\'s arithmetic', () => {
    expect(RELIEF_SPHERE_FRAME_GLSL).toContain('vec3 east = cross( normalize( pole ), n );');
    expect(RELIEF_SPHERE_FRAME_GLSL).toContain('east /= max( length( east ), 1e-6 );');
    expect(RELIEF_SPHERE_FRAME_GLSL).toContain('return mat3( east, cross( n, east ), n );');
  });
});

describe('the balance a page boots with', () => {
  it('is three\'s frame unless the link asks for another', () => {
    expect(parseReliefBalance('')).toBe(0);
    expect(parseReliefBalance('?reliefbalance=1')).toBe(1);
    expect(parseReliefBalance('?moonrelief=8k&reliefbalance=0.5')).toBe(0.5);
    expect(parseReliefBalance('?reliefbalance=7')).toBe(1);
    expect(parseReliefBalance('?reliefbalance=-1')).toBe(0);
    expect(parseReliefBalance('?reliefbalance=yes')).toBe(0);
    expect(parseReliefBalance('?reliefbalance=')).toBe(0);
  });
});
