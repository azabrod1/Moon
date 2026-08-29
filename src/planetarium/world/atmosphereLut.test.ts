import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ATMOSPHERE_PASS_WEIGHTS,
  ATMOSPHERE_UNIT_COST_MS,
  AtmosphereLut,
  BAKE_BUDGET_FRACTION,
  BAKE_DEFAULT_INTERVAL_MS,
  SCATTERING_PROBE_SCALE,
  SCATTERING_VALIDATION_BAND,
  SCATTERING_VALIDATION_SAMPLE,
  atmosphereLutProfile,
  atmosphereTierGpuBytes,
  bakePassCostsMs,
  bakeSliceBudgetMs,
  bakeSliceDrawCount,
  createScatteringTarget,
  createTableTarget,
  type AtmospherePass,
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

describe('what a slice of the bake may cost', () => {
  const plan = (): Array<{ kind: string; pass: string; probeSafe: boolean }> => {
    const baker = new AtmosphereLut(
      {} as unknown as THREE.WebGLRenderer,
      { register: false },
    );
    try {
      return baker.bakeStepPlan('Earth');
    } finally {
      baker.dispose();
    }
  };

  it('prices every pass the plan draws, and nothing it does not', () => {
    // A pass with no weight would be priced `undefined` and admit an unbounded
    // slice; a weight for a pass that never draws is a number nobody reads.
    const drawn = new Set(plan().filter((s) => s.kind === 'draw').map((s) => s.pass));
    expect([...drawn].sort()).toEqual(Object.keys(ATMOSPHERE_PASS_WEIGHTS).sort());
  });

  it('weights scattering density and multiple scattering above the quads', () => {
    // The ordering is the whole point of the table: eight layers of the two
    // heavy passes is more GPU than a 120 Hz frame has, eight transmittance
    // quads is nothing. Only the ordering is asserted — the numbers are a
    // starting point a timed device replaces.
    const w = ATMOSPHERE_PASS_WEIGHTS;
    expect(w.scatteringDensity).toBeGreaterThan(w.multipleScattering);
    expect(w.multipleScattering).toBeGreaterThan(w.singleScattering);
    expect(w.singleScattering).toBeGreaterThan(w.indirectIrradiance);
    expect(w.indirectIrradiance).toBeGreaterThan(w.combine);
    expect(w.transmittance).toBe(w.directIrradiance);
    for (const weight of Object.values(w)) expect(weight).toBeGreaterThan(0);
  });

  it('never probes a draw that accumulates', () => {
    // The cost probe re-runs one real draw per pass ahead of the bake. A draw
    // that adds to its target rather than overwriting it would fold its order
    // into the accumulator twice and change the tables.
    const draws = plan().filter((s) => s.kind === 'draw');
    expect(draws.filter((s) => !s.probeSafe).length).toBeGreaterThan(0);
    // Every pass still has at least one probe-safe draw to be measured through.
    const safe = new Set(draws.filter((s) => s.probeSafe).map((s) => s.pass));
    expect([...safe].sort()).toEqual(Object.keys(ATMOSPHERE_PASS_WEIGHTS).sort());
  });

  it('spends a fixed share of the measured frame, not a fixed number of ms', () => {
    expect(bakeSliceBudgetMs(16.7)).toBeCloseTo(16.7 * BAKE_BUDGET_FRACTION, 6);
    expect(bakeSliceBudgetMs(8.33)).toBeCloseTo(8.33 * BAKE_BUDGET_FRACTION, 6);
    // A frame reading outside any plausible refresh rate is a stalled tab or a
    // broken sample, and clamps rather than sizing a slice.
    expect(bakeSliceBudgetMs(400)).toBeCloseTo(40 * BAKE_BUDGET_FRACTION, 6);
    expect(bakeSliceBudgetMs(0.2)).toBeCloseTo(4 * BAKE_BUDGET_FRACTION, 6);
  });

  it('assumes the faster display when it has no measurement', () => {
    // Guessing 60 Hz would hand a 120 Hz frame twice its share and drop it;
    // guessing 120 costs a 60 Hz machine only bake wall time.
    const fallback = BAKE_DEFAULT_INTERVAL_MS * BAKE_BUDGET_FRACTION;
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      expect(bakeSliceBudgetMs(bad)).toBeCloseTo(fallback, 6);
    }
  });

  it('prices an unmeasured device off the weight table', () => {
    const costs = bakePassCostsMs({});
    for (const pass of Object.keys(ATMOSPHERE_PASS_WEIGHTS) as AtmospherePass[]) {
      expect(costs[pass]).toBeCloseTo(ATMOSPHERE_PASS_WEIGHTS[pass] * ATMOSPHERE_UNIT_COST_MS, 9);
    }
  });

  it('believes a timed pass over its weight, and prices the rest from it', () => {
    // One measurement fixes what a weight unit costs on this GPU, so a pass the
    // timer never reached is still planned against the device's own speed.
    const costs = bakePassCostsMs({ singleScattering: 1.2 });
    expect(costs.singleScattering).toBeCloseTo(1.2, 9);
    expect(costs.multipleScattering).toBeCloseTo(
      (1.2 / ATMOSPHERE_PASS_WEIGHTS.singleScattering) * ATMOSPHERE_PASS_WEIGHTS.multipleScattering,
      9,
    );
    // Two measurements that disagree about the unit average, rather than the
    // last one winning.
    const both = bakePassCostsMs({ singleScattering: 2.4, transmittance: 0.2 });
    const unit = ((2.4 / 4) + (0.2 / 1)) / 2;
    expect(unit).toBeGreaterThan(ATMOSPHERE_UNIT_COST_MS);
    expect(both.combine).toBeCloseTo(unit * ATMOSPHERE_PASS_WEIGHTS.combine, 9);
  });

  it('never prices an unmeasured pass below the weight table', () => {
    // A disjoint discards the queries in flight, so a probe can come back with
    // the cheap irradiance quad timed and the density layer not. Pricing the
    // density layer off the quad's unit would put eight of them in one slice.
    const quadOnly = bakePassCostsMs({ directIrradiance: 0.011 });
    expect(quadOnly.directIrradiance).toBeCloseTo(0.011, 9);
    expect(quadOnly.scatteringDensity).toBeCloseTo(
      ATMOSPHERE_PASS_WEIGHTS.scatteringDensity * ATMOSPHERE_UNIT_COST_MS, 9,
    );
    // A fast GPU whose measured unit is genuinely above the constant still
    // prices from its own measurements — the constant is only a floor.
    const fast = bakePassCostsMs({ scatteringDensity: 4 });
    expect(fast.multipleScattering).toBeCloseTo(
      (4 / ATMOSPHERE_PASS_WEIGHTS.scatteringDensity) * ATMOSPHERE_PASS_WEIGHTS.multipleScattering, 9,
    );
  });

  it('ignores a measurement that is not a positive number', () => {
    // A disjoint or unavailable query has no reading; a zero or a NaN reaching
    // the table would price every later slice at nothing and submit the lot.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const costs = bakePassCostsMs({ scatteringDensity: bad });
      expect(costs.scatteringDensity).toBeCloseTo(
        ATMOSPHERE_PASS_WEIGHTS.scatteringDensity * ATMOSPHERE_UNIT_COST_MS, 9,
      );
    }
  });

  it('takes as many draws as fit the budget', () => {
    const costs = bakePassCostsMs({});
    const budget = bakeSliceBudgetMs(8.33);
    const heavy: AtmospherePass[] = Array.from({ length: 16 }, () => 'multipleScattering');
    const light: AtmospherePass[] = Array.from({ length: 16 }, () => 'combine');
    const heavyCount = bakeSliceDrawCount(heavy, costs, budget, 8);
    const lightCount = bakeSliceDrawCount(light, costs, budget, 8);
    expect(heavyCount * costs.multipleScattering).toBeLessThanOrEqual(budget);
    expect(lightCount).toBeGreaterThan(heavyCount);
    // The draw-count ceiling still caps a slice of cheap draws.
    expect(lightCount).toBe(8);
  });

  it('always takes one draw, however far over budget it is', () => {
    // A pass whose single layer costs more than a whole frame's share would
    // otherwise admit nothing, and the bake would spin on a step it never runs.
    const costs = bakePassCostsMs({ scatteringDensity: 50 });
    expect(bakeSliceDrawCount(['scatteringDensity'], costs, bakeSliceBudgetMs(8.33), 8)).toBe(1);
    expect(bakeSliceDrawCount([], costs, bakeSliceBudgetMs(8.33), 8)).toBe(0);
  });

  it('lets a 60 Hz frame take more than a 120 Hz one', () => {
    const costs = bakePassCostsMs({});
    const upcoming: AtmospherePass[] = Array.from({ length: 16 }, () => 'singleScattering');
    expect(bakeSliceDrawCount(upcoming, costs, bakeSliceBudgetMs(16.7), 16))
      .toBeGreaterThan(bakeSliceDrawCount(upcoming, costs, bakeSliceBudgetMs(8.33), 16));
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
