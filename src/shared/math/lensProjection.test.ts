import { describe, expect, it } from 'vitest';
import {
  LENS_INVERSE_ITERATIONS,
  applyDesignFov,
  displayFovDeg,
  lensCornerTheta,
  lensDisplayHalfTan,
  lensEffectiveStrength,
  lensMaxFrameScale,
  lensOverscanFovDeg,
  lensLocalScale,
  lensPassFragmentShader,
  lensRadial,
  lensSourceBoundOfOutputRect,
  lensSourceUvGlsl,
  lensRadialInverse,
  lensUnwarpNdc,
  lensUnwarpNdcWithContext,
  lensWarpNdc,
  lensWarpNdcWithContext,
  makeLensWarpContext,
  type LensWarpContext,
  type NdcRect,
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

describe('lensUnwarpNdc', () => {
  it('round-trips output points through the source frame', () => {
    for (const aspect of [16 / 9, 390 / 844, 21 / 9]) {
      for (const fov of [45, 60, 103, 110]) {
        const strength = lensEffectiveStrength(fov, aspect, 1);
        const renderFov = lensOverscanFovDeg(fov, aspect, strength);
        for (const [x, y] of [[0, 0], [0.35, -0.2], [-0.8, 0.65], [0.95, -0.9]]) {
          const source = lensUnwarpNdc(
            x, y, fov, renderFov, aspect, strength, { x: 0, y: 0 },
          );
          const output = lensWarpNdc(
            source.x, source.y, fov, renderFov, aspect, strength, { x: 0, y: 0 },
          );
          expect(output.x).toBeCloseTo(x, 9);
          expect(output.y).toBeCloseTo(y, 9);
        }
      }
    }
  });
});

describe('applyDesignFov / displayFovDeg / lensDisplayHalfTan', () => {
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

  it('reads back the design FOV, never the overscan the warp samples from', () => {
    const camera = {
      fov: 60,
      aspect: 16 / 9,
      userData: { lens: { strength: 0.7, designFovDeg: 60 } },
      updateProjectionMatrix() { /* noop */ },
    };
    applyDesignFov(camera, 45);
    expect(displayFovDeg(camera)).toBe(45);
    expect(camera.fov).toBeGreaterThan(45);
    // No lens on the camera: the render FOV is what the frame displays.
    expect(displayFovDeg({ fov: 32, userData: {} })).toBe(32);
  });

  it('folds the proximity factor into the effective strength and the overscan', () => {
    const camera = {
      fov: 60,
      aspect: 16 / 9,
      userData: {
        lens: { strength: 1, designFovDeg: 60, proximityFactor: 1 } as {
          strength: number; designFovDeg: number; effectiveStrength?: number; proximityFactor?: number;
        },
      },
      updateProjectionMatrix() { /* noop */ },
    };
    applyDesignFov(camera, 60);
    const fullOverscan = camera.fov;
    expect(camera.userData.lens.effectiveStrength).toBe(1);
    expect(fullOverscan).toBeGreaterThan(60);
    // Half the request: the overscan narrows with it; the design FOV stays.
    camera.userData.lens.proximityFactor = 0.5;
    applyDesignFov(camera, 60);
    expect(camera.userData.lens.effectiveStrength).toBeCloseTo(0.5, 12);
    expect(camera.fov).toBeCloseTo(lensOverscanFovDeg(60, camera.aspect, 0.5), 9);
    expect(camera.fov).toBeLessThan(fullOverscan);
    expect(displayFovDeg(camera)).toBe(60);
    // Ramped fully off: a pinhole, whose render FOV IS the design FOV.
    camera.userData.lens.proximityFactor = 0;
    applyDesignFov(camera, 60);
    expect(camera.userData.lens.effectiveStrength).toBe(0);
    expect(camera.fov).toBe(60);
    // No factor at all: the requested strength, exactly as before the ramp existed.
    delete camera.userData.lens.proximityFactor;
    applyDesignFov(camera, 60);
    expect(camera.userData.lens.effectiveStrength).toBe(1);
    expect(camera.fov).toBe(fullOverscan);
    // Where the wide-FOV cap binds, the factor is folded in BEFORE the cap:
    // the product is what the cap is applied to, so a request the cap would
    // cut is cut, and one already under it passes through unchanged.
    const wide = 120;
    const cap = lensEffectiveStrength(wide, camera.aspect, 1);
    expect(cap).toBeLessThan(1);
    camera.userData.lens.proximityFactor = 1;
    applyDesignFov(camera, wide);
    expect(camera.userData.lens.effectiveStrength).toBeCloseTo(cap, 12);
    camera.userData.lens.proximityFactor = cap / 2;
    applyDesignFov(camera, wide);
    expect(camera.userData.lens.effectiveStrength).toBeCloseTo(cap / 2, 12);
    camera.userData.lens.proximityFactor = 0;
    applyDesignFov(camera, wide);
    expect(camera.userData.lens.effectiveStrength).toBe(0);
    expect(camera.fov).toBe(wide);
  });

  it('display half-tangent reduces to tan(fov/2) at strength 0', () => {
    expect(lensDisplayHalfTan(60, 0)).toBeCloseTo(Math.tan(30 * DEG), 12);
    expect(lensDisplayHalfTan(60, 1)).toBeCloseTo(2 * Math.tan(15 * DEG), 12);
  });
});

describe('lensMaxFrameScale', () => {
  it('is the corner stretch, and never reports less than the centre scale', () => {
    for (const [designFovDeg, aspect] of [[60, 16 / 9], [60, 390 / 844], [75, 1], [24, 4 / 3]] as const) {
      // Rectilinear: the radial stretch sec^2(theta) at the frame's corner
      // (its tangential stretch, sec(theta), is smaller).
      const flat = lensCornerTheta(designFovDeg, aspect, 0);
      expect(lensMaxFrameScale(designFovDeg, aspect, 0)).toBeCloseTo(1 / Math.cos(flat) ** 2, 9);
      // Stereographic: conformal, so both stretches are sec^2(theta / 2).
      const round = lensCornerTheta(designFovDeg, aspect, 1);
      expect(lensMaxFrameScale(designFovDeg, aspect, 1)).toBeCloseTo(1 / Math.cos(round / 2) ** 2, 9);
      for (const strength of [0, 0.5, 1]) {
        expect(lensMaxFrameScale(designFovDeg, aspect, strength)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('bounds the displayed radius growth measured through the forward warp', () => {
    // Sampled the way a consumer sees it: how much further out the warp puts a
    // point for the same step in view angle, anywhere out to the corner.
    const designFovDeg = 60;
    const aspect = 16 / 9;
    for (const strength of [0.5, 1]) {
      const renderFovDeg = lensOverscanFovDeg(designFovDeg, aspect, strength);
      const tanHalfRender = Math.tan((renderFovDeg / 2) * DEG);
      const corner = lensCornerTheta(designFovDeg, aspect, strength);
      const out = { x: 0, y: 0 };
      const warpedRadius = (theta: number) => {
        lensWarpNdc(0, Math.tan(theta) / tanHalfRender, designFovDeg, renderFovDeg, aspect, strength, out);
        return out.y;
      };
      const centre = (warpedRadius(1e-5) - warpedRadius(0)) / 1e-5;
      let worst = 0;
      for (let i = 1; i <= 40; i++) {
        const theta = (corner * i) / 40;
        worst = Math.max(worst, (warpedRadius(theta) - warpedRadius(theta - 1e-5)) / 1e-5 / centre);
      }
      expect(worst).toBeLessThanOrEqual(lensMaxFrameScale(designFovDeg, aspect, strength) * 1.001);
      expect(worst).toBeGreaterThan(lensMaxFrameScale(designFovDeg, aspect, strength) * 0.99);
    }
  });
});

describe('the shared inverse-map GLSL', () => {
  it('is the pass text’s own definition, verbatim', () => {
    // Three shaders read a scene image through this function — the lens pass,
    // the bloom bright pass and the finishing pass — and a second copy of the
    // arithmetic is a way for them to warp differently. So the pass composes
    // the shared text rather than restating it.
    expect(lensPassFragmentShader).toContain(lensSourceUvGlsl);
    expect(lensPassFragmentShader).toContain('texture2D(tDiffuse, lensSourceUv(vUv))');
  });

  it('declares the four warp uniforms and neither sub-rect uniform', () => {
    // uUvScale/uUvMax belong to whoever composes this text — the pass below, or
    // the insertion app/sceneSubRect.ts makes into three's shaders — and a
    // duplicate declaration does not compile, which a string check cannot see.
    for (const u of ['uStrength', 'uAspect', 'uTanHalfRender', 'uREdge']) {
      expect(lensSourceUvGlsl).toContain(`uniform float ${u};`);
    }
    expect(lensSourceUvGlsl).not.toContain('uniform vec2 uUvScale;');
    expect(lensSourceUvGlsl).not.toContain('uniform vec2 uUvMax;');
    // And the assembled pass declares each of them exactly once.
    for (const declaration of ['uniform vec2 uUvScale;', 'uniform vec2 uUvMax;']) {
      expect(lensPassFragmentShader.split(declaration)).toHaveLength(2);
    }
  });
});

describe('CPU/GPU inverse convergence', () => {
  it('the shader shares the CPU iteration budget', () => {
    // The shader interpolates LENS_INVERSE_ITERATIONS into its loop bound.
    expect(lensPassFragmentShader).toContain(`i < ${LENS_INVERSE_ITERATIONS};`);
    expect(lensSourceUvGlsl).toContain(`i < ${LENS_INVERSE_ITERATIONS};`);
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

describe('lensUnwarpNdcWithContext', () => {
  it('is the same map as lensUnwarpNdc, constants hoisted', () => {
    const ctx: LensWarpContext = { tanHalfRender: 0, aspect: 1, strength: 0, rEdge: 1 };
    for (const [aspect, strength] of [[16 / 9, 1], [0.46, 0.5], [1.5, 0.2], [1, 0]] as const) {
      const design = 60;
      const render = lensOverscanFovDeg(design, aspect, strength);
      makeLensWarpContext(design, render, aspect, strength, ctx);
      for (const [x, y] of [[0.3, -0.2], [-0.9, 0.9], [0, 0], [0.01, 0.99]]) {
        const a = lensUnwarpNdc(x, y, design, render, aspect, strength, { x: 0, y: 0 });
        const b = lensUnwarpNdcWithContext(ctx, x, y, { x: 0, y: 0 });
        expect(b.x).toBe(a.x);
        expect(b.y).toBe(a.y);
      }
    }
  });
});

describe('lensLocalScale', () => {
  it('is the forward map\'s own derivative, radially and tangentially', () => {
    const ctx: LensWarpContext = { tanHalfRender: 0, aspect: 1, strength: 0, rEdge: 1 };
    const design = 60;
    const aspect = 16 / 9;
    const height = 1000;
    for (const strength of [0, 0.5, 1]) {
      const render = lensOverscanFovDeg(design, aspect, strength);
      makeLensWarpContext(design, render, aspect, strength, ctx);
      const centreScale = (height / 2) / lensDisplayHalfTan(design, strength);
      // The render camera's own half-tangent: the context leaves its copy at
      // 0 when the lens is off, since the identity map never reads it.
      const tanHalfRender = Math.tan((render / 2) * DEG);
      const sourceOfAngle = (theta: number, azimuth: number) => ({
        x: (Math.tan(theta) * Math.cos(azimuth)) / (tanHalfRender * aspect),
        y: (Math.tan(theta) * Math.sin(azimuth)) / tanHalfRender,
      });
      const outputPx = (theta: number, azimuth: number) => {
        const s = sourceOfAngle(theta, azimuth);
        const o = lensWarpNdcWithContext(ctx, s.x, s.y, { x: 0, y: 0 });
        return { x: o.x * aspect * (height / 2), y: o.y * (height / 2) };
      };
      for (const thetaDeg of [5, 20, 32]) {
        const theta = thetaDeg * DEG;
        const azimuth = 0.7;
        const scale = lensLocalScale(theta, strength, { radial: 0, tangential: 0 });
        const h = 1e-5;
        const a = outputPx(theta - h, azimuth);
        const b = outputPx(theta + h, azimuth);
        const radialPxPerRad = Math.hypot(b.x - a.x, b.y - a.y) / (2 * h);
        const c = outputPx(theta, azimuth - h);
        const d = outputPx(theta, azimuth + h);
        // An azimuth step dφ at angle θ is an arc of sinθ·dφ on the sky.
        const tangentialPxPerRad = Math.hypot(d.x - c.x, d.y - c.y) / (2 * h * Math.sin(theta));
        expect(scale.radial * centreScale).toBeCloseTo(radialPxPerRad, 3);
        expect(scale.tangential * centreScale).toBeCloseTo(tangentialPxPerRad, 3);
      }
      expect(lensLocalScale(0, strength, { radial: 0, tangential: 0 })).toEqual({ radial: 1, tangential: 1 });
    }
  });

  it('is conformal at full strength and 1/cos²θ by 1/cosθ with the lens off', () => {
    const theta = 32 * DEG;
    const full = lensLocalScale(theta, 1, { radial: 0, tangential: 0 });
    expect(full.radial).toBeCloseTo(full.tangential, 12);
    const off = lensLocalScale(theta, 0, { radial: 0, tangential: 0 });
    expect(off.radial).toBeCloseTo(1 / Math.cos(theta) ** 2, 12);
    expect(off.tangential).toBeCloseTo(1 / Math.cos(theta), 12);
  });
});

describe('lensSourceBoundOfOutputRect', () => {
  const ctx: LensWarpContext = { tanHalfRender: 0, aspect: 1, strength: 0, rEdge: 1 };
  const out: NdcRect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  it('contains the pre-image of every point of the clipped rectangle', () => {
    // A seeded generator: the sweep is a property check, and a failure must
    // reproduce.
    let seed = 20261009;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
    let cases = 0;
    let worst = 0;
    while (cases < 600) {
      const aspect = pick([0.46, 0.75, 0.82, 1, 1.55, 16 / 9, 2.4]);
      const design = pick([30, 45, 60, 75, 90, 110, 130]);
      const strength = lensEffectiveStrength(design, aspect, pick([1, 0.75, 0.5, 0.25, 0.1, 0]));
      makeLensWarpContext(design, lensOverscanFovDeg(design, aspect, strength), aspect, strength, ctx);
      // A support disc anywhere, an off-frame Sun's included.
      const cx = random() * 3.2 - 1.6;
      const cy = random() * 3.2 - 1.6;
      const r = 0.02 + random() * 1.8;
      const rect: NdcRect = { minX: cx - r, maxX: cx + r, minY: cy - r * aspect, maxY: cy + r * aspect };
      if (!lensSourceBoundOfOutputRect(ctx, rect, 0, 0, out)) continue;
      cases++;
      const minX = Math.max(rect.minX, -1);
      const maxX = Math.min(rect.maxX, 1);
      const minY = Math.max(rect.minY, -1);
      const maxY = Math.min(rect.maxY, 1);
      for (let i = 0; i < 120; i++) {
        const x = minX + random() * (maxX - minX);
        const y = minY + random() * (maxY - minY);
        const p = lensUnwarpNdcWithContext(ctx, x, y, { x: 0, y: 0 });
        worst = Math.max(worst, out.minX - p.x, p.x - out.maxX, out.minY - p.y, p.y - out.maxY);
      }
    }
    expect(cases).toBe(600);
    expect(worst).toBeLessThanOrEqual(1e-12);
  });

  it('is the clipped rectangle itself with the lens off, plus the margin', () => {
    makeLensWarpContext(60, 60, 16 / 9, 0, ctx);
    expect(lensSourceBoundOfOutputRect(ctx, { minX: -0.5, maxX: 1.7, minY: 0.2, maxY: 0.4 }, 0.01, 0.02, out)).toBe(true);
    expect(out.minX).toBeCloseTo(-0.51, 12);
    expect(out.maxX).toBeCloseTo(1.01, 12);
    expect(out.minY).toBeCloseTo(0.18, 12);
    expect(out.maxY).toBeCloseTo(0.42, 12);
  });

  it('reports a support wholly off the frame as nothing to draw', () => {
    makeLensWarpContext(60, lensOverscanFovDeg(60, 16 / 9, 1), 16 / 9, 1, ctx);
    expect(lensSourceBoundOfOutputRect(ctx, { minX: 1.2, maxX: 1.9, minY: -0.3, maxY: 0.3 }, 0, 0, out)).toBe(false);
    expect(lensSourceBoundOfOutputRect(ctx, { minX: -0.3, maxX: 0.3, minY: -2, maxY: -1.01 }, 0, 0, out)).toBe(false);
  });

  it('falls back to the whole source frame on a non-finite input, which always covers the frame', () => {
    makeLensWarpContext(60, lensOverscanFovDeg(60, 16 / 9, 1), 16 / 9, 1, ctx);
    expect(lensSourceBoundOfOutputRect(ctx, { minX: NaN, maxX: 0.3, minY: -0.3, maxY: 0.3 }, 0, 0, out)).toBe(true);
    expect(out).toEqual({ minX: -1, minY: -1, maxX: 1, maxY: 1 });
    // The displayed frame's own pre-image never leaves the source square.
    for (const aspect of [0.46, 1, 16 / 9, 2.4]) {
      for (const design of [30, 60, 90, 130]) {
        for (const requested of [1, 0.5, 0]) {
          const strength = lensEffectiveStrength(design, aspect, requested);
          makeLensWarpContext(design, lensOverscanFovDeg(design, aspect, strength), aspect, strength, ctx);
          lensSourceBoundOfOutputRect(ctx, { minX: -1, maxX: 1, minY: -1, maxY: 1 }, 0, 0, out);
          expect(out.minX).toBeGreaterThanOrEqual(-1 - 1e-9);
          expect(out.maxX).toBeLessThanOrEqual(1 + 1e-9);
          expect(out.minY).toBeGreaterThanOrEqual(-1 - 1e-9);
          expect(out.maxY).toBeLessThanOrEqual(1 + 1e-9);
        }
      }
    }
  });
});
