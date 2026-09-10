/**
 * PHASE-0 SPIKE DATA. Four hard-coded interior models so the cut, the faces
 * and the Readable remap can be judged on real proportions. Every number
 * here is PROVISIONAL: a round figure from the standard literature, chosen
 * to be the right order and shape, and not yet sourced, reviewed or carried
 * with its uncertainty. Phase 2 replaces this file with the reviewed schema
 * (plan §7) and its per-body models; nothing below should ship to a user.
 *
 * Regions are listed OUTSIDE-IN, as the legend reads them. Radii are outer
 * radii in km; a region's inner radius is the next region's outer radius,
 * and the last region reaches the centre. `referenceRadiusKm` is the radius
 * the model's own radii are measured against (the drawn surface).
 */
import type { MaterialFamily, MaterialPhase } from './artParams';

export interface SpikeRegion {
  key: string;
  name: string;
  family: MaterialFamily;
  phase: MaterialPhase;
  outerRadiusKm: number;
  /** One line for the legend row. */
  composition: string;
  /** Presentation override: draw the region hot. Art, not a temperature. */
  glow?: number;
}

export interface SpikeModel {
  bodyId: string;
  referenceRadiusKm: number;
  regions: SpikeRegion[];
}

export const SPIKE_MODELS: Readonly<Record<string, SpikeModel>> = {
  Earth: {
    bodyId: 'Earth',
    referenceRadiusKm: 6371,
    regions: [
      { key: 'crust', name: 'Crust', family: 'rock', phase: 'solid', outerRadiusKm: 6371, composition: 'Granitic and basaltic rock', glow: 0 },
      { key: 'upperMantle', name: 'Upper mantle', family: 'rock', phase: 'solid', outerRadiusKm: 6336, composition: 'Peridotite, olivine and pyroxene', glow: 0.04 },
      { key: 'lowerMantle', name: 'Lower mantle', family: 'rock', phase: 'solid', outerRadiusKm: 5711, composition: 'Bridgmanite and ferropericlase', glow: 0.06 },
      { key: 'outerCore', name: 'Outer core', family: 'metal', phase: 'liquid', outerRadiusKm: 3480, composition: 'Liquid iron and nickel with light elements' },
      { key: 'innerCore', name: 'Inner core', family: 'metal', phase: 'solid', outerRadiusKm: 1221, composition: 'Solid iron and nickel' },
    ],
  },
  Europa: {
    bodyId: 'Europa',
    referenceRadiusKm: 1560.8,
    regions: [
      { key: 'iceShell', name: 'Ice shell', family: 'ice', phase: 'solid', outerRadiusKm: 1560.8, composition: 'Water ice' },
      { key: 'ocean', name: 'Ocean', family: 'water', phase: 'liquid', outerRadiusKm: 1540, composition: 'Salty liquid water' },
      { key: 'mantle', name: 'Rocky mantle', family: 'rock', phase: 'solid', outerRadiusKm: 1440, composition: 'Silicate rock', glow: 0 },
      { key: 'core', name: 'Metallic core', family: 'metal', phase: 'solid', outerRadiusKm: 500, composition: 'Iron and iron sulphide, size poorly constrained', glow: 0.14 },
    ],
  },
  Jupiter: {
    bodyId: 'Jupiter',
    referenceRadiusKm: 69_911,
    regions: [
      { key: 'atmosphere', name: 'Outer atmosphere', family: 'hydrogen', phase: 'gas', outerRadiusKm: 69_911, composition: 'Hydrogen and helium with ammonia clouds' },
      { key: 'molecularEnvelope', name: 'Molecular hydrogen envelope', family: 'hydrogen', phase: 'supercritical', outerRadiusKm: 69_000, composition: 'Supercritical hydrogen and helium' },
      { key: 'metallicHydrogen', name: 'Metallic hydrogen', family: 'metallicHydrogen', phase: 'liquid', outerRadiusKm: 59_000, composition: 'Liquid metallic hydrogen', glow: 0.08 },
      { key: 'diluteCore', name: 'Dilute core', family: 'mixed', phase: 'mixed', outerRadiusKm: 31_500, composition: 'Rock and ice mixed into hydrogen, no sharp boundary', glow: 0.12 },
    ],
  },
  Phobos: {
    bodyId: 'Phobos',
    referenceRadiusKm: 11.3,
    regions: [
      { key: 'regolith', name: 'Regolith', family: 'mixed', phase: 'solid', outerRadiusKm: 11.3, composition: 'Loose dust and rubble, about 100 m deep' },
      { key: 'interior', name: 'Fractured interior', family: 'unresolved', phase: 'solid', outerRadiusKm: 11.2, composition: 'Porous rock, roughly a third empty space; composition unresolved' },
    ],
  },
};

export const SPIKE_BODY_IDS: readonly string[] = Object.keys(SPIKE_MODELS);

export const SPIKE_DEFAULT_BODY = 'Earth';

/** The spike's model for a body, or Earth's for a body it does not carry. */
export function spikeModelFor(bodyId: string): SpikeModel {
  return SPIKE_MODELS[bodyId] ?? SPIKE_MODELS[SPIKE_DEFAULT_BODY];
}

/** Outer radii as fractions of the reference radius, INSIDE-OUT and
 *  increasing, the order the shader and the remap want; the last is 1. */
export function outerFractionsInsideOut(model: SpikeModel): number[] {
  const fractions = model.regions.map((region) => region.outerRadiusKm / model.referenceRadiusKm);
  fractions.reverse();
  fractions[fractions.length - 1] = 1;
  return fractions;
}
