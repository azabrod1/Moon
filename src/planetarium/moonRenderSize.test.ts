import { describe, expect, it } from 'vitest';
import { KM_PER_AU } from '../astronomy/constants';
import { MOONS } from './planets/moonData';
import { PLANETARIUM_BODIES } from './planets/planetData';
import {
  MOON_RENDER_ANCHOR_RATIO,
  MOON_RENDER_ANCHOR_RATIO_OBSERVING,
  MOON_RENDER_GAMMA,
  renderedMoonRadiusAU,
} from './moonRenderSize';

/** Every (moon, parent) pair in the catalog — the sweep domain for the
 *  property tests, so a catalog addition is covered automatically. */
const PAIRS = MOONS.map((moon) => {
  const parent = PLANETARIUM_BODIES.find((b) => b.name === moon.parentPlanet);
  if (!parent) throw new Error(`no parent body for ${moon.name}`);
  return { moon, parent };
});

/** The properties must hold for any plausible tuning, not just the shipped
 *  one — a γ retune must never be able to break a consumer invariant. */
const GAMMAS = [0.25, MOON_RENDER_GAMMA, 0.6];
const RATIOS = [MOON_RENDER_ANCHOR_RATIO, MOON_RENDER_ANCHOR_RATIO_OBSERVING];

describe('renderedMoonRadiusAU properties (γ-independent)', () => {
  it('never shrinks a moon and never exceeds the anchor', () => {
    for (const gamma of GAMMAS) {
      for (const ratio of RATIOS) {
        for (const { moon, parent } of PAIRS) {
          const anchorAU = parent.radiusAU * ratio;
          const rendered = renderedMoonRadiusAU(moon.radiusAU, parent.radiusAU, ratio, gamma);
          expect(rendered).toBeGreaterThanOrEqual(moon.radiusAU);
          expect(rendered).toBeLessThanOrEqual(Math.max(anchorAU, moon.radiusAU));
        }
      }
    }
  });

  it('preserves size ordering within each system (strict for unequal radii)', () => {
    const byParent = new Map<string, number[]>();
    for (const { moon } of PAIRS) {
      const list = byParent.get(moon.parentPlanet) ?? [];
      list.push(moon.radiusAU);
      byParent.set(moon.parentPlanet, list);
    }
    for (const gamma of GAMMAS) {
      for (const ratio of RATIOS) {
        for (const [parentName, radii] of byParent) {
          const parent = PLANETARIUM_BODIES.find((b) => b.name === parentName)!;
          const sorted = [...radii].sort((a, b) => a - b);
          for (let i = 1; i < sorted.length; i++) {
            const lo = renderedMoonRadiusAU(sorted[i - 1], parent.radiusAU, ratio, gamma);
            const hi = renderedMoonRadiusAU(sorted[i], parent.radiusAU, ratio, gamma);
            // Equal true radii (Rosalind/Caliban) must render equal; unequal strictly ordered.
            if (sorted[i] === sorted[i - 1]) expect(hi).toBe(lo);
            else expect(hi).toBeGreaterThan(lo);
          }
        }
      }
    }
  });

  it('meets identity exactly at the anchor and stays identity above it', () => {
    for (const gamma of GAMMAS) {
      for (const ratio of RATIOS) {
        for (const { parent } of PAIRS) {
          const anchorAU = parent.radiusAU * ratio;
          expect(renderedMoonRadiusAU(anchorAU, parent.radiusAU, ratio, gamma)).toBeCloseTo(anchorAU, 12);
          expect(renderedMoonRadiusAU(anchorAU * 1.5, parent.radiusAU, ratio, gamma)).toBe(anchorAU * 1.5);
        }
      }
    }
  });

  it('anchorRatio 0 (surface view) is the identity across the catalog', () => {
    for (const { moon, parent } of PAIRS) {
      expect(renderedMoonRadiusAU(moon.radiusAU, parent.radiusAU, 0)).toBe(moon.radiusAU);
    }
  });

  it('bodies already above the anchor render true (Moon, Triton, Charon)', () => {
    for (const name of ['Moon', 'Triton', 'Charon']) {
      const { moon, parent } = PAIRS.find((p) => p.moon.name === name)!;
      expect(renderedMoonRadiusAU(moon.radiusAU, parent.radiusAU, MOON_RENDER_ANCHOR_RATIO)).toBe(
        moon.radiusAU,
      );
    }
  });
});

describe('current tuning (γ = 0.4, anchors 5% / 2.5%)', () => {
  // A deliberate retune of the knobs in moonRenderSize.ts updates exactly the
  // expectations in this block; the property suite above is tuning-independent.
  const renderedKm = (moonName: string, ratio: number) => {
    const { moon, parent } = PAIRS.find((p) => p.moon.name === moonName)!;
    return renderedMoonRadiusAU(moon.radiusAU, parent.radiusAU, ratio) * KM_PER_AU;
  };

  it('pins the flythrough curve at Saturn', () => {
    expect(renderedKm('Titan', MOON_RENDER_ANCHOR_RATIO)).toBeCloseTo(2830, 0);
    expect(renderedKm('Calypso', MOON_RENDER_ANCHOR_RATIO)).toBeCloseTo(316, 0);
  });

  it('pins the observing curve letting Titan through at true size', () => {
    expect(renderedKm('Titan', MOON_RENDER_ANCHOR_RATIO_OBSERVING)).toBeCloseTo(2574.7, 1);
  });
});
