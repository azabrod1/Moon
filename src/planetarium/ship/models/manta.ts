/**
 * The Manta, our own design: a flying wing shaped like the ray, with no
 * fuselage and no fins. One smooth surface runs from a thick middle to thin
 * upturned tips, dark on its back and pale beneath; a low canopy sits forward,
 * two flat engines exhaust through slots at the trailing edge, and a long
 * thin tail trails behind with a lamp at its end.
 */
import * as THREE from 'three';
import type { ShipOverride } from '../../PlayerShip';
import {
  FLAMES, HullBuilder, NAV_LIGHTS, Raster, bulb, createFlames, paint, shipRoot, tube, wing,
  type WingSection,
} from './fleetKit';

/** Half the wing, from the middle out to the tip. */
const HALF_WING: readonly WingSection[] = [
  { span: 0, lead: 1.35, chord: 2.4, thick: 0.36 },
  { span: 0.22, lead: 1.24, chord: 2.22, thick: 0.33 },
  { span: 0.45, lead: 0.98, chord: 1.92, thick: 0.24 },
  { span: 0.72, lead: 0.58, chord: 1.52, thick: 0.15 },
  { span: 1.0, lead: 0.12, chord: 1.1, thick: 0.09, lift: 0.02 },
  { span: 1.25, lead: -0.36, chord: 0.75, thick: 0.055, lift: 0.06 },
  { span: 1.45, lead: -0.78, chord: 0.46, thick: 0.035, lift: 0.11 },
  { span: 1.6, lead: -1.15, chord: 0.2, thick: 0.02, lift: 0.17 },
];
const ENGINE_SIDE = 0.3;
const TAIL_FROM = -1.0;
const TAIL_LENGTH = 1.25;

export function createManta(referenceRadiusAU: number): ShipOverride {
  // The back: deep blue-grey panels, with a paler band along the leading edge.
  const backPattern = new Raster(512, 0x3b4858, 71).panels(5, 14, 0.12, 0.25).fill(0, 0, 0.035, 1, 0x7d8896, 0.7);
  const back = paint(backPattern.texture(), { roughness: 0.76, metalness: 0.15 });
  const belly = paint(0x8f98a3, { roughness: 0.76 });
  const dark = paint(0x15181d, { roughness: 0.7 });
  const glass = paint(0x0a1018, { roughness: 0.45, metalness: 0.4, glow: 0.12, glowColour: 0x3fb6d8 });

  // One surface from tip to tip, so the middle is smooth: the half wing and its mirror image.
  const port = HALF_WING.slice(1).reverse().map((section) => ({ ...section, span: -section.span }));
  const [upper, lower] = wing([...port, ...HALF_WING], 12);
  const pod = new THREE.SphereGeometry(1, 20, 12);
  const hull = new HullBuilder()
    .add(back, upper).add(belly, lower)
    .add(glass, pod, { at: [0.55, 0.15, 0], scale: [0.42, 0.1, 0.17] })
    // The engines: a low fairing each side of the middle, ending in a slot.
    .pair(back, pod, { at: [-0.58, 0.1, ENGINE_SIDE], scale: [0.56, 0.06, 0.13] })
    .pair(dark, new THREE.BoxGeometry(0.03, 0.04, 0.24), { at: [-1.0, 0.035, ENGINE_SIDE] })
    .add(dark, tube(0.035, 0.006, TAIL_LENGTH, 8), { at: [TAIL_FROM - TAIL_LENGTH / 2, 0, 0] });

  const tip = HALF_WING[HALF_WING.length - 1];
  const tipAt = [tip.lead - 0.1, tip.lift ?? 0] as const;
  hull.add(NAV_LIGHTS.port(), bulb(), { at: [...tipAt, -tip.span] })
    .add(NAV_LIGHTS.starboard(), bulb(), { at: [...tipAt, tip.span] })
    .add(NAV_LIGHTS.white(), bulb(0.02), { at: [TAIL_FROM - TAIL_LENGTH - 0.01, 0, 0] });

  const flames = createFlames(
    [ENGINE_SIDE, -ENGINE_SIDE].map((side) => ({ at: [-1.02, 0.035, side], radius: 0.14, length: 1.0, flat: 0.3 })),
    FLAMES.torch,
  );
  return { model: shipRoot(referenceRadiusAU, hull.build(), ...flames.meshes), exhaust: flames.set };
}
