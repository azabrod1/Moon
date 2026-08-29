import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The atmosphere shell's golden captures (tools/atmo-shell-qa.mjs).
 *
 * The images are a LOCAL gate: CI has no GPU and cannot render them, and they
 * are deliberately out of public/ so they never ship to anyone. What CI can
 * hold is this — that every pose and both tiers are present, and that each
 * capture still records the three things that make it reproducible: the pinned
 * near plane, the pinned exposure and the pinned clock. A pose captured with
 * any of those floating compares against nothing, and the way that fails is
 * silently.
 */
const DIR = fileURLToPath(new URL('../../../tools/goldens/atmosphere/', import.meta.url));

const POSES = [
  'limb-8r',
  'limb-1.05r',
  'terminator-1.5r',
  'night-1.05r',
  'inside-air',
];

interface Golden {
  pose: string;
  tier: string;
  body: string;
  near: number | null;
  exposure: number;
  pixelRatio: number;
  timeUtcMs: number | null;
  width: number;
  height: number;
  grid: [number, number][];
  samples: [number, number, number][];
  limbScanX: number[];
  limbScan: [number, number, number][];
}

const read = (name: string): Golden => JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8'));

describe('the atmosphere goldens', () => {
  it('cover both tiers at every pose, plus the compare ghost', () => {
    const captures = [
      ...POSES.flatMap((pose) => [`${pose}.analytic`, `${pose}.lut`]),
      // The ghost's shell is pinned to the analytic tier in code; captured so
      // that pin cannot rot unnoticed.
      'volume-compare.analytic',
    ];
    for (const name of captures) {
      const golden = read(name);
      expect(golden.tier, name).toMatch(/^(analytic|lut)$/);
      expect(statSync(`${DIR}${name}.png`).size, name).toBeGreaterThan(1000);
    }
  });

  it('records the pins a capture is reproducible through', () => {
    for (const pose of POSES) {
      for (const tier of ['analytic', 'lut']) {
        const golden = read(`${pose}.${tier}`);
        expect(golden.pose).toBe(pose);
        expect(golden.body).toBe('Earth');
        // The near plane no framing hook sets, the exposure the Sun drives, the
        // ratio the display drives, and the clock that turns Earth under the
        // limb.
        expect(golden.near).toBeGreaterThan(0);
        expect(golden.exposure).toBe(1);
        expect(golden.pixelRatio).toBe(1);
        expect(golden.timeUtcMs).toBe(Date.parse('2026-03-20T12:00:00Z'));
        expect(golden.width).toBe(512);
      }
    }
  });

  it('carries 20 sampled radiances and a scan across the limb', () => {
    for (const pose of POSES) {
      for (const tier of ['analytic', 'lut']) {
        const golden = read(`${pose}.${tier}`);
        expect(golden.samples).toHaveLength(20);
        expect(golden.grid).toHaveLength(20);
        // The scan is what tells the two tiers apart: at 8 R the whole
        // atmosphere is about one pixel wide, and a scattered grid walks
        // straight past it.
        expect(golden.limbScan).toHaveLength(41);
        expect(golden.limbScanX).toHaveLength(41);
        for (const rgb of [...golden.samples, ...golden.limbScan]) {
          expect(rgb).toHaveLength(3);
          for (const channel of rgb) {
            expect(Number.isInteger(channel)).toBe(true);
            expect(channel).toBeGreaterThanOrEqual(0);
            expect(channel).toBeLessThanOrEqual(255);
          }
        }
      }
    }
  });

  it('shows the LUT tier drawing a different limb from the analytic one', () => {
    // Not a threshold on the look — that is the local image gate's job. This
    // only holds that the two tiers ARE two tiers: a capture pair that came
    // back identical would mean the swap never happened and the goldens are
    // recording the fallback twice.
    const sum = (g: Golden): number => g.limbScan.reduce((a, [r, gr, b]) => a + r + gr + b, 0);
    const differing = POSES.filter(
      (pose) => sum(read(`${pose}.analytic`)) !== sum(read(`${pose}.lut`)),
    );
    expect(differing.length).toBeGreaterThanOrEqual(3);
  });
});
