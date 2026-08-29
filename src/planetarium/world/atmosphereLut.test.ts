import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AtmosphereLut,
  SCATTERING_PROBE_SCALE,
  SCATTERING_VALIDATION_BAND,
  SCATTERING_VALIDATION_SAMPLE,
  atmosphereLutProfile,
  atmosphereTierGpuBytes,
  createScatteringTarget,
  createTableTarget,
} from './atmosphereLut';
import {
  ATMOSPHERE_TABLE_SIZES_FULL,
  ATMOSPHERE_TABLE_SIZES_HALF,
  atmosphereParams,
  computeSingleScattering,
  scatteringTextureWidth,
  scatteringUvwzFromRMuMuSNu,
} from './atmosphereModel';

describe('atmosphere table targets', () => {
  it('configures the 3D scattering target so a layer render can reach it', () => {
    const target = createScatteringTarget(ATMOSPHERE_TABLE_SIZES_FULL);
    try {
      // One output only: only slot 0 of a 3D render target is a Data3DTexture,
      // and the layer attach walks every attachment.
      expect(target.textures.length).toBe(1);
      expect((target.texture as THREE.Data3DTexture).isData3DTexture).toBe(true);
      expect(target.width).toBe(scatteringTextureWidth(ATMOSPHERE_TABLE_SIZES_FULL));
      expect(target.height).toBe(ATMOSPHERE_TABLE_SIZES_FULL.scatteringMu);
      expect(target.depth).toBe(ATMOSPHERE_TABLE_SIZES_FULL.scatteringR);
      expect(target.texture.type).toBe(THREE.HalfFloatType);
      // magFilter is only copied when the caller passes it, and a Data3DTexture
      // is born Nearest on both — the default is a banded lookup.
      expect(target.texture.magFilter).toBe(THREE.LinearFilter);
      expect(target.texture.minFilter).toBe(THREE.LinearFilter);
      expect(target.texture.generateMipmaps).toBe(false);
      expect(target.texture.wrapS).toBe(THREE.ClampToEdgeWrapping);
      expect(target.texture.wrapT).toBe(THREE.ClampToEdgeWrapping);
      expect(target.texture.wrapR).toBe(THREE.ClampToEdgeWrapping);
      // A depth renderbuffer is allocated per target, and samples > 0 routes
      // the bind into the multisample framebuffer before the 3D branch runs.
      expect(target.depthBuffer).toBe(false);
      expect(target.stencilBuffer).toBe(false);
      expect(target.samples).toBe(0);
    } finally {
      target.dispose();
    }
  });

  it('configures the 2D tables the same way', () => {
    const target = createTableTarget(256, 64);
    try {
      expect(target.texture.type).toBe(THREE.HalfFloatType);
      expect(target.texture.magFilter).toBe(THREE.LinearFilter);
      expect(target.texture.minFilter).toBe(THREE.LinearFilter);
      expect(target.depthBuffer).toBe(false);
      expect(target.stencilBuffer).toBe(false);
      expect(target.samples).toBe(0);
    } finally {
      target.dispose();
    }
  });

  it('sizes the scattering table so nu and mu_s share the x axis', () => {
    for (const sizes of [ATMOSPHERE_TABLE_SIZES_FULL, ATMOSPHERE_TABLE_SIZES_HALF]) {
      const target = createScatteringTarget(sizes);
      try {
        expect(target.width).toBe(sizes.scatteringNu * sizes.scatteringMuS);
        // The mu axis folds in half, so it must be even.
        expect(sizes.scatteringMu % 2).toBe(0);
      } finally {
        target.dispose();
      }
    }
  });

  it('gives touch devices half tables at two orders', () => {
    expect(atmosphereLutProfile(false)).toEqual({ sizes: ATMOSPHERE_TABLE_SIZES_FULL, orders: 4 });
    expect(atmosphereLutProfile(true)).toEqual({ sizes: ATMOSPHERE_TABLE_SIZES_HALF, orders: 2 });
    // The touch scattering table is a quarter of the desktop one.
    const full = createScatteringTarget(ATMOSPHERE_TABLE_SIZES_FULL);
    const half = createScatteringTarget(ATMOSPHERE_TABLE_SIZES_HALF);
    try {
      const texels = (t: THREE.WebGL3DRenderTarget) => t.width * t.height * t.depth;
      expect(texels(full) / texels(half)).toBe(4);
      expect(texels(full) * 8).toBe(8 * 1024 * 1024);
    } finally {
      full.dispose();
      half.dispose();
    }
  });
});

describe('the bake step list', () => {
  // The plan is built entirely on the CPU — materials, targets and closures —
  // so the ordering contract is readable without a GPU. The renderer is only
  // touched once a step runs.
  const plan = (options: { orders?: number } = {}): Array<{ kind: string; program: string }> => {
    const baker = new AtmosphereLut(
      {} as unknown as THREE.WebGLRenderer,
      { register: false, ...options },
    );
    try {
      return baker.bakeStepPlan('Earth');
    } finally {
      baker.dispose();
    }
  };

  it('links every program it draws with before the first layer draw, one to a step', () => {
    const steps = plan();
    const firstDraw = steps.findIndex((step) => step.kind === 'draw');
    expect(firstDraw).toBeGreaterThan(0);
    // Nothing links after a draw has run: a link sharing a frame with layer
    // draws is the dropped frame the phase exists to remove, and a link waited
    // out by a draw is the same cost under another name.
    expect(steps.slice(firstDraw).every((step) => step.kind === 'draw')).toBe(true);
    // One program to a step, in first-use order, and no program twice.
    const links = steps.slice(0, firstDraw).map((step) => step.program);
    expect(links).toEqual([
      'transmittance', 'irradiance', 'singleScattering', 'combine',
      'scatteringDensity', 'multipleScattering', 'probe',
    ]);
    expect(new Set(links).size).toBe(links.length);
  });

  it('leaves out the programs an order count never reaches', () => {
    // A single-order bake draws no scattering density and no multiple
    // scattering, and a link for a program that never draws is a frame spent
    // on nothing. The probe stays: every bake validates through it.
    expect(plan({ orders: 1 }).filter((step) => step.kind === 'link').map((s) => s.program))
      .toEqual(['transmittance', 'irradiance', 'singleScattering', 'combine', 'probe']);
  });

  it('adds no draws and drops none', () => {
    // Bruneton's passes at four orders over the full tables: transmittance and
    // the direct irradiance, the two single-scattering deltas and their
    // combine over 32 layers, then per further order a density, two
    // irradiance steps, a multiple-scattering pass and a combine.
    const layers = ATMOSPHERE_TABLE_SIZES_FULL.scatteringR;
    const perOrder = layers + 1 + 1 + layers + layers;
    expect(plan().filter((step) => step.kind === 'draw').length)
      .toBe(2 + 2 * layers + layers + 3 * perOrder);
  });
});

describe('table validation probe', () => {
  it('reads the validated sample well inside the probe window, on both profiles', () => {
    // The probe blit clamps to [0, 1]: a channel that reaches the ceiling is
    // compared against the ceiling and not against the table, and the tier then
    // turns on or off for the wrong reason. Nothing about the sample is
    // size-dependent, so the same margin has to hold for both table profiles.
    const earth = atmosphereParams('Earth');
    const s = SCATTERING_VALIDATION_SAMPLE;
    const r = earth.bottomRadius + s.altitudeFraction * (earth.topRadius - earth.bottomRadius);
    const expected = computeSingleScattering(earth, r, s.mu, s.muS, s.nu, false, 32, 200).rayleigh;
    for (const sizes of [ATMOSPHERE_TABLE_SIZES_FULL, ATMOSPHERE_TABLE_SIZES_HALF]) {
      const uvwz = scatteringUvwzFromRMuMuSNu(earth, r, s.mu, s.muS, s.nu, false, sizes);
      // A sky ray: the upper half of the folded mu axis.
      expect(uvwz.uMu).toBeGreaterThan(0.5);
      // Blue can reach the probe's ceiling before the top of the accepted band;
      // the upper test is carried by the smallest channel, which must not.
      const smallest = Math.min(...expected);
      expect(smallest * SCATTERING_PROBE_SCALE * SCATTERING_VALIDATION_BAND.max)
        .toBeLessThan(0.95);
      for (const channel of expected) {
        const read = channel * SCATTERING_PROBE_SCALE;
        expect(read).toBeGreaterThan(0.05);
        expect(read).toBeLessThan(0.95);
        // The bottom of the accepted band has to stay readable too.
        expect(read * SCATTERING_VALIDATION_BAND.min).toBeGreaterThan(0.002);
      }
    }
  });
});

describe('what the tier costs the memory envelope', () => {
  /** The bytes one render target really holds, read off the target the bake
   *  creates rather than off a size table — the same expression the LUT's own
   *  live counter uses. */
  const bytesOf = (t: THREE.WebGLRenderTarget, depth: number): number =>
    t.width * t.height * depth * (t.texture.type === THREE.HalfFloatType ? 8 : 4);

  it('states the resident and the peak the bake really allocates', () => {
    for (const sizes of [ATMOSPHERE_TABLE_SIZES_FULL, ATMOSPHERE_TABLE_SIZES_HALF]) {
      const transmittance = createTableTarget(sizes.transmittanceW, sizes.transmittanceH);
      const irradiance = createTableTarget(sizes.irradianceW, sizes.irradianceH);
      const scattering = createScatteringTarget(sizes);
      try {
        const resident = bytesOf(transmittance, 1) + bytesOf(irradiance, 1)
          + bytesOf(scattering, sizes.scatteringR);
        // The bake holds the resident three plus deltaIrradiance and the three
        // 3D deltas; the multiple-scattering delta aliases the single-Rayleigh
        // one, which is what keeps the peak at four 3D targets and not five.
        const peak = resident + bytesOf(irradiance, 1) + bytesOf(scattering, sizes.scatteringR) * 3;
        expect(atmosphereTierGpuBytes(sizes)).toEqual({ resident, bakePeak: peak });
      } finally {
        transmittance.dispose();
        irradiance.dispose();
        scattering.dispose();
      }
    }
  });

  it('is 8 MiB resident and 32 at the peak on a desktop, a quarter of that on touch', () => {
    // The numbers the envelope was written against. A change to either is a
    // change to what every device may hold beside the tables, so it is stated
    // here rather than left to be discovered on a phone.
    const MiB = 1024 * 1024;
    const full = atmosphereTierGpuBytes(ATMOSPHERE_TABLE_SIZES_FULL);
    expect(full.resident / MiB).toBeCloseTo(8.13, 2);
    expect(full.bakePeak / MiB).toBeCloseTo(32.14, 2);
    const half = atmosphereTierGpuBytes(ATMOSPHERE_TABLE_SIZES_HALF);
    expect(half.resident / MiB).toBeCloseTo(2.04, 2);
    expect(half.bakePeak / MiB).toBeCloseTo(8.04, 2);
  });

  it('is charged to the same envelope the globe maps and the sector tiles share', () => {
    // The tables are an optional tier a device opts into and holds for the
    // session, out of the one pool. Asked of the LUT per frame, not added as a
    // constant: the tier may never arrive, and during the bake ~32 MiB is
    // really allocated — a rung admitted against 8 would be admitted against
    // memory that is not there. Read as text because the ledger is a private
    // method on the mode, which has no seam to call.
    const mode = readFileSync(resolve(__dirname, '../PlanetariumMode.ts'), 'utf8');
    expect(mode).toContain('let bytes = this.atmosphereLut?.gpuBytes() ?? 0;');
    // And that figure is what the sector budget and the ladder's admission are
    // both measured against.
    expect(mode).toContain('sectors.setGlobalMapBytes(this.liveGlobalMapBytes());');
    expect(mode).toContain('const others = this.liveGlobalMapBytes() - appliedTierHeldBytes(up);');
  });
});
