import { describe, expect, it } from 'vitest';
import {
  LENS_INVERSE_ITERATIONS,
  applyDesignFov,
  lensCornerTheta,
  lensDisplayHalfTan,
  lensEffectiveStrength,
  lensOverscanFovDeg,
  lensPassFragmentShader,
  lensRadial,
  lensRadialInverse,
  lensUnwarpNdc,
  lensWarpNdc,
} from './lensProjection';

const DEG = Math.PI / 180;

/** Replicate the GPU fragment's inverse exactly (same start, same fixed
 *  iteration budget, no early-out) so its convergence can be checked against the
 *  CPU seam without a real GL context. */
function shaderRadialInverse(r: number, strength: number): number {
  let theta = Math.atan(r);
  for (let i = 0; i < LENS_INVERSE_ITERATIONS; i++) {
    const t = Math.tan(theta);
    const th = Math.tan(theta / 2);
    const f = (1 - strength) * t + strength * 2 * th - r;
    const df = (1 - strength) * (1 + t * t) + strength * (1 + th * th);
    theta -= f / df;
  }
  return theta;
}

describe('lensRadial / lensRadialInverse', () => {
  it('reduces to rectilinear at strength 0 and stereographic at 1', () => {
    const theta = 0.6;
    expect(lensRadial(theta, 0)).toBeCloseTo(Math.tan(theta), 12);
    expect(lensRadial(theta, 1)).toBeCloseTo(2 * Math.tan(theta / 2), 12);
  });

  it('round-trips through the inverse across the working range', () => {
    for (const s of [0, 0.35, 0.7, 1]) {
      for (let theta = 0.05; theta < 1.2; theta += 0.1) {
        const r = lensRadial(theta, s);
        expect(lensRadialInverse(r, s)).toBeCloseTo(theta, 9);
      }
    }
  });
});

describe('lensOverscanFovDeg', () => {
  it('is identity at strength 0 and covers the warped corner otherwise', () => {
    expect(lensOverscanFovDeg(60, 16 / 9, 0)).toBe(60);
    const aspect = 16 / 9;
    for (const s of [0.35, 0.7, 1]) {
      const overscan = lensOverscanFovDeg(60, aspect, s);
      expect(overscan).toBeGreaterThan(60);
      // The render frustum's corner must reach the output frame's corner angle.
      const tanHalfV = Math.tan((overscan / 2) * DEG);
      const renderCorner = Math.atan(tanHalfV * Math.hypot(aspect, 1));
      expect(renderCorner).toBeGreaterThanOrEqual(lensCornerTheta(60, aspect, s) - 1e-9);
    }
  });
});

describe('lensEffectiveStrength', () => {
  it('honours full strength at the cruise FOV and yields at extreme design FOVs', () => {
    const aspect = 16 / 9;
    expect(lensEffectiveStrength(60, aspect, 1)).toBe(1);
    // A fill-based dev pose can ask for >100°: full stereographic would need
    // source rays past 90° off-axis, which a pinhole render cannot produce.
    const wide = lensEffectiveStrength(103, aspect, 1);
    expect(wide).toBeLessThan(1);
    expect(wide).toBeGreaterThanOrEqual(0);
    // Whatever strength is granted must keep the overscan usable.
    const overscan = lensOverscanFovDeg(103, aspect, wide);
    expect(overscan).toBeGreaterThan(102);
    expect(overscan).toBeLessThan(178);
    expect(Number.isFinite(overscan)).toBe(true);
  });

  it('keeps the corner solve finite even for absurd requests', () => {
    for (const fov of [30, 60, 90, 120, 150]) {
      const s = lensEffectiveStrength(fov, 21 / 9, 1);
      const overscan = lensOverscanFovDeg(fov, 21 / 9, s);
      expect(Number.isFinite(overscan)).toBe(true);
      expect(overscan).toBeGreaterThan(0);
      expect(overscan).toBeLessThan(178);
    }
  });
});

describe('lensWarpNdc', () => {
  const aspect = 16 / 9;
  const out = { x: 0, y: 0 };

  it('is identity at strength 0', () => {
    lensWarpNdc(0.4, -0.3, 60, 60, aspect, 0, out);
    expect(out.x).toBe(0.4);
    expect(out.y).toBe(-0.3);
  });

  it('keeps the design vertical FOV pinned to the frame edge', () => {
    const s = 0.7;
    const renderFov = lensOverscanFovDeg(60, aspect, s);
    // A ray at exactly the design half-FOV off-axis vertically: in the
    // render frame it sits at tan(30)/tan(renderHalf); warped it must land
    // exactly on the output edge y = 1.
    const srcY = Math.tan(30 * DEG) / Math.tan((renderFov / 2) * DEG);
    lensWarpNdc(0, srcY, 60, renderFov, aspect, s, out);
    expect(out.y).toBeCloseTo(1, 9);
    expect(out.x).toBeCloseTo(0, 12);
  });

  it('renders an off-axis sphere round at full strength (conformality)', () => {
    // A small circular cone of directions 35° off-axis: compare the warped
    // image's radial vs tangential extents. Rectilinear stretches the radial
    // axis by 1/cos(35°) ≈ 1.22; stereographic must be 1.00.
    const s = 1;
    const renderFov = lensOverscanFovDeg(60, aspect, s);
    const tanHalfR = Math.tan((renderFov / 2) * DEG);
    const off = 35 * DEG;
    const halfAng = 2 * DEG;
    const project = (theta: number, phi: number) => {
      // Direction at polar angle theta from the axis, azimuth phi, mapped to
      // the render camera's rectilinear NDC.
      const x = Math.tan(theta) * Math.cos(phi);
      const y = Math.tan(theta) * Math.sin(phi);
      return { x: x / (tanHalfR * aspect), y: y / tanHalfR };
    };
    const centre = project(off, 0);
    const inner = project(off - halfAng, 0);
    const outer = project(off + halfAng, 0);
    const pC = lensWarpNdc(centre.x, centre.y, 60, renderFov, aspect, s, { x: 0, y: 0 });
    const pI = lensWarpNdc(inner.x, inner.y, 60, renderFov, aspect, s, { x: 0, y: 0 });
    const pO = lensWarpNdc(outer.x, outer.y, 60, renderFov, aspect, s, { x: 0, y: 0 });
    // Radial extent in view units (undo the per-axis aspect normalization).
    const radial = Math.hypot((pO.x - pI.x) * aspect, pO.y - pI.y);
    // Tangential extent: the cone's width at the centre angle is
    // 2·sin(halfAng)·... — measure via an azimuthal step instead.
    const sideSrc = (() => {
      const x = Math.tan(off);
      const yAng = Math.atan(Math.tan(halfAng) / Math.cos(off));
      return { x: x / (tanHalfR * aspect), y: Math.tan(yAng) / tanHalfR };
    })();
    const pS = lensWarpNdc(sideSrc.x, sideSrc.y, 60, renderFov, aspect, s, { x: 0, y: 0 });
    const tangential = 2 * Math.hypot((pS.x - pC.x) * aspect, pS.y - pC.y);
    const ratio = radial / tangential;
    expect(ratio).toBeGreaterThan(0.97);
    expect(ratio).toBeLessThan(1.03);
  });
});

describe('applyDesignFov / lensDisplayHalfTan', () => {
  it('writes the overscan to the camera and keeps the design on userData', () => {
    const camera = {
      fov: 60,
      aspect: 16 / 9,
      userData: { lens: { strength: 0.7, designFovDeg: 60 } },
      updated: 0,
      updateProjectionMatrix() { this.updated++; },
    };
    applyDesignFov(camera, 45);
    expect(camera.userData.lens.designFovDeg).toBe(45);
    expect(camera.fov).toBeCloseTo(lensOverscanFovDeg(45, camera.aspect, 0.7), 9);
    expect(camera.updated).toBe(1);
    // Without lens params the write is a plain fov set.
    const bare = {
      fov: 60, aspect: 1, userData: {} as { lens?: never },
      updateProjectionMatrix() { /* noop */ },
    };
    applyDesignFov(bare, 50);
    expect(bare.fov).toBe(50);
  });

  it('display half-tangent reduces to tan(fov/2) at strength 0', () => {
    expect(lensDisplayHalfTan(60, 0)).toBeCloseTo(Math.tan(30 * DEG), 12);
    expect(lensDisplayHalfTan(60, 1)).toBeCloseTo(2 * Math.tan(15 * DEG), 12);
  });
});

describe('CPU/GPU inverse convergence', () => {
  it('the shader shares the CPU iteration budget', () => {
    // The shader interpolates LENS_INVERSE_ITERATIONS into its loop bound.
    expect(lensPassFragmentShader).toContain(`i < ${LENS_INVERSE_ITERATIONS};`);
  });

  it('shader and CPU inverse agree to <0.01° across the frame at the wide-FOV cap', () => {
    // The reviewer measured 0.636° (103°) and 2.032° (110°) disagreement when
    // the shader ran 4 Newton steps against the CPU's 8. With a shared budget
    // they must converge to the same theta at every frame radius.
    const aspect = 16 / 9;
    for (const designFov of [60, 90, 103, 110, 150]) {
      const strength = lensEffectiveStrength(designFov, aspect, 1);
      if (strength <= 0) continue;
      const rEdge = lensRadial((designFov / 2) * DEG, strength);
      // centre -> edge -> corner radii of the output frame.
      for (const frac of [0.05, 0.25, 0.5, 0.75, 1, Math.hypot(aspect, 1)]) {
        const rOut = rEdge * frac;
        const cpu = lensRadialInverse(rOut, strength);
        const gpu = shaderRadialInverse(rOut, strength);
        expect(Math.abs(cpu - gpu)).toBeLessThan(0.01 * DEG);
      }
    }
  });

  it('lensUnwarpNdc is the exact inverse of lensWarpNdc', () => {
    const aspect = 16 / 9;
    const strength = 1;
    const renderFov = lensOverscanFovDeg(60, aspect, strength);
    const out = { x: 0, y: 0 };
    const back = { x: 0, y: 0 };
    for (const [sx, sy] of [[0.2, 0.1], [0.6, -0.4], [-0.9, 0.5], [0, 0.8], [0.95, 0]]) {
      lensWarpNdc(sx, sy, 60, renderFov, aspect, strength, out);
      lensUnwarpNdc(out.x, out.y, 60, renderFov, aspect, strength, back);
      expect(back.x).toBeCloseTo(sx, 9);
      expect(back.y).toBeCloseTo(sy, 9);
    }
  });
});
