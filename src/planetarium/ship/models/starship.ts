/**
 * Starship, SpaceX's upper stage: a stainless-steel cylinder nine metres
 * across and fifty long, under an ogive nose. Black heat-shield tiles cover
 * the belly and run up to the hinge lines of its four flaps; six engines sit
 * in the skirt, three small ones around the middle and three wide vacuum
 * bells outside them.
 *
 * The belly faces down here, so the chase camera, behind and above, looks at
 * the steel back with the tiles wrapping in from both sides.
 */
import * as THREE from 'three';
import type { ShipOverride } from '../../PlayerShip';
import {
  FLAMES, HullBuilder, NAV_LIGHTS, Raster, bell, bulb, createFlames, disc, lathe, paint, shipRoot, tube, wing,
  type Ember,
} from './fleetKit';

const RADIUS = 0.32;
const SKIRT_END = -2.15;
const ENGINE_BAY = -1.96;
/** Tail to nose: the straight barrel, then the ogive. */
const HULL_PROFILE = [
  [SKIRT_END, RADIUS], [0.55, RADIUS], [0.8, 0.306], [1.02, 0.268], [1.22, 0.208],
  [1.38, 0.145], [1.5, 0.085], [1.57, 0.04], [1.6, 0],
] as const;
/** The tiled arc: the belly and a little past each hinge line, in turns. */
const TILED_ARC = [-0.04, 0.58] as const;

export function createStarship(referenceRadiusAU: number): ShipOverride {
  // Welded rings of steel sheet, a little uneven, as the real hull is.
  const steel = paint(new Raster(512, 0x8f969e, 11).panels(5, 27, 0.11, 0.2).texture(), { roughness: 0.66, metalness: 0.45 });
  const tiles = paint(new Raster(512, 0x1d1f22, 12).panels(36, 72, 0.3, 0.12).texture(), { roughness: 0.9, metalness: 0 });
  const dark = paint(0x16181b, { roughness: 0.8 });
  const bellMetal = paint(0x4a4f57, { roughness: 0.5, metalness: 0.45 });

  const hull = new HullBuilder()
    .add(tiles, lathe(HULL_PROFILE, { arc: TILED_ARC }))
    .add(steel, lathe(HULL_PROFILE, { arc: [TILED_ARC[0] + TILED_ARC[1], 1 - TILED_ARC[1]] }))
    .add(dark, disc(RADIUS - 0.012), { at: [ENGINE_BAY, 0, 0] })
    // The cable raceway along the back.
    .add(steel, new THREE.BoxGeometry(2.3, 0.022, 0.05), { at: [-0.75, RADIUS + 0.004, 0] });

  // Flaps: steel above, tiled below, hinged just above the hull's widest line.
  const [aftUpper, aftLower] = wing([
    { span: 0.27, lead: -1.12, chord: 0.98, thick: 0.075 },
    { span: 0.62, lead: -1.2, chord: 0.86, thick: 0.055 },
    { span: 0.82, lead: -1.4, chord: 0.6, thick: 0.035 },
  ]);
  const [foreUpper, foreLower] = wing([
    { span: 0.2, lead: 1.22, chord: 0.52, thick: 0.05 },
    { span: 0.46, lead: 1.1, chord: 0.38, thick: 0.035 },
    { span: 0.58, lead: 1.0, chord: 0.25, thick: 0.022 },
  ]);
  const hinge = { at: [0, 0.05, 0] } as const;
  hull.pair(steel, aftUpper, hinge).pair(tiles, aftLower, hinge)
    .pair(steel, foreUpper, hinge).pair(tiles, foreLower, hinge)
    // The fairings over the aft flaps' hinges.
    .pair(steel, tube(0.045, 0.045, 0.98, 12), { at: [-1.6, 0.07, 0.305] });

  // Engines: three sea-level bells around the middle, three vacuum bells outside.
  const embers: Ember[] = [];
  for (let index = 0; index < 3; index++) {
    const inner = (index / 3) * Math.PI * 2;
    const outer = inner + Math.PI / 3;
    const innerAt = [Math.cos(inner) * 0.085, Math.sin(inner) * 0.085] as const;
    const outerAt = [Math.cos(outer) * 0.212, Math.sin(outer) * 0.212] as const;
    hull.add(bellMetal, bell(0.047, 0.15), { at: [ENGINE_BAY, ...innerAt] })
      .add(bellMetal, bell(0.083, 0.18), { at: [ENGINE_BAY, ...outerAt] });
    embers.push({ at: [ENGINE_BAY - 0.04, ...innerAt], radius: 0.022 }, { at: [ENGINE_BAY - 0.05, ...outerAt], radius: 0.034 });
  }

  hull.add(NAV_LIGHTS.port(), bulb(), { at: [-1.72, 0.05, -0.83] })
    .add(NAV_LIGHTS.starboard(), bulb(), { at: [-1.72, 0.05, 0.83] })
    .add(NAV_LIGHTS.white(), bulb(0.018), { at: [-1.9, RADIUS + 0.03, 0] });

  const flames = createFlames([{ at: [SKIRT_END + 0.02, 0, 0], radius: 0.2, length: 1.7 }], FLAMES.methane, embers);
  return { model: shipRoot(referenceRadiusAU, hull.build(), ...flames.meshes), exhaust: flames.set };
}
