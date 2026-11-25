/**
 * The Space Shuttle orbiter: a 37-metre spaceplane with a double-delta wing,
 * white above and black-tiled below, a tall swept tail, three main engines in
 * a triangle at the stern and the two pods of its orbital engines beside the
 * tail.
 *
 * The fuselage is a body of revolution with its lower half flattened, which
 * gives the orbiter's slab belly; the payload bay's doors are lines in the
 * paint. No lettering and no flags.
 */
import * as THREE from 'three';
import type { ShipOverride } from '../../PlayerShip';
import {
  FLAMES, HULL_WHITE, HullBuilder, NAV_LIGHTS, Raster, bell, bulb, createFlames, disc, lathe, paint, shipRoot, wing,
} from './fleetKit';

const RADIUS = 0.27;
const STERN = -1.76;
/** How far the belly is flattened. */
const BELLY = 0.72;
/** Tail to nose, as far as the dark nose cap. */
const BODY_PROFILE = [[STERN, RADIUS], [0.64, RADIUS], [0.94, 0.26], [1.19, 0.215], [1.39, 0.15], [1.46, 0.118]] as const;
const CAP_PROFILE = [[1.46, 0.118], [1.52, 0.08], [1.57, 0.045], [1.6, 0]] as const;
/** The upper half of a turn (port, over the back, to starboard) and the lower half. */
const BACK = [0.5, 0.5] as const;
const UNDERSIDE = [0, 0.5] as const;

export function createShuttle(referenceRadiusAU: number): ShipOverride {
  // The white back, with the payload bay's doors drawn in: two hinge lines,
  // the seam where the doors meet, and the bay's two ends.
  const bayFrom = 0.08;
  const bayTo = 0.7;
  const doors = new Raster(512, HULL_WHITE, 21).panels(4, 12, 0.05, 0.12);
  for (const around of [0.2, 0.5, 0.8]) doors.fill(around - 0.004, bayFrom, around + 0.004, bayTo, 0x2c3036, 0.75);
  for (const along of [bayFrom, bayTo]) doors.fill(0.2, along - 0.003, 0.8, along + 0.003, 0x2c3036, 0.75);
  const white = paint(doors.texture(), { roughness: 0.75 });
  // Wings and tail: white, with the grey carbon leading edge and the hinge
  // line of the elevons (the rudder, on the tail).
  const wingWhite = paint(
    new Raster(256, 0xaab1bb, 23).panels(1, 6, 0.04, 0.1).fill(0, 0, 0.035, 1, 0x4b5057).fill(0.8, 0, 0.808, 1, 0x30343a, 0.6).texture(),
    { roughness: 0.75 },
  );
  const plainWhite = paint(0xaab1bb, { roughness: 0.75 });
  const tiles = paint(new Raster(512, 0x1b1d20, 22).panels(40, 40, 0.3, 0.12).texture(), { roughness: 0.9, metalness: 0 });
  const dark = paint(0x23262b, { roughness: 0.7 });
  const glass = paint(0x0a0f16, { roughness: 0.45, metalness: 0.4, glow: 0.2, glowColour: 0x4a3423 });
  const bellMetal = paint(0x4a4f57, { roughness: 0.5, metalness: 0.45 });
  const flatBelly = { scale: [1, BELLY, 1] } as const;

  const hull = new HullBuilder()
    .add(white, lathe(BODY_PROFILE, { arc: BACK }))
    .add(dark, lathe(CAP_PROFILE, { arc: BACK }))
    .add(tiles, lathe([...BODY_PROFILE, ...CAP_PROFILE.slice(1)], { arc: UNDERSIDE }), flatBelly)
    // The flight deck's windows, a band over the nose.
    .add(glass, lathe([[0.98, 0.26], [1.19, 0.221]], { arc: [0.61, 0.28] }))
    .add(dark, disc(RADIUS), { at: [STERN, 0.038, 0], scale: [1, 0.86, 1] });

  // The wing: a long glove from the nose, then the 45° delta. White above, tiles below.
  const [wingUpper, wingLower] = wing([
    { span: 0.2, lead: 0.54, chord: 2.15, thick: 0.1, lift: -0.13 },
    { span: 0.45, lead: -0.51, chord: 1.1, thick: 0.085, lift: -0.13 },
    { span: 1.19, lead: -1.25, chord: 0.3, thick: 0.03, lift: -0.115 },
  ]);
  hull.pair(wingWhite, wingUpper).pair(tiles, wingLower);
  const [finLeft, finRight] = wing([
    { span: 0.2, lead: -0.95, chord: 0.85, thick: 0.07 },
    { span: 0.98, lead: -1.62, chord: 0.38, thick: 0.035 },
  ]);
  const upright = { turn: [-Math.PI / 2, 0, 0] } as const;
  hull.add(wingWhite, finLeft, upright).add(wingWhite, finRight, upright);

  // The orbital engines' pods beside the tail, and the body flap under the stern.
  hull.pair(plainWhite, new THREE.SphereGeometry(1, 16, 12), { at: [-1.5, 0.21, 0.19], scale: [0.4, 0.12, 0.115] })
    .pair(bellMetal, bell(0.05, 0.1), { at: [-1.86, 0.21, 0.19] })
    .add(tiles, new THREE.BoxGeometry(0.26, 0.03, 0.46), { at: [-1.88, -0.195, 0] });

  // The three main engines.
  const engines = [[0.115, 0], [-0.07, 0.125], [-0.07, -0.125]] as const;
  for (const [up, side] of engines) hull.add(bellMetal, bell(0.115, 0.28), { at: [STERN, up, side] });

  hull.add(NAV_LIGHTS.port(), bulb(), { at: [-1.48, -0.115, -1.2] })
    .add(NAV_LIGHTS.starboard(), bulb(), { at: [-1.48, -0.115, 1.2] })
    .add(NAV_LIGHTS.white(), bulb(0.018), { at: [-1.93, 1.0, 0] });

  const flames = createFlames(
    engines.map(([up, side]) => ({ at: [STERN - 0.28, up, side], radius: 0.1, length: 1.1 })),
    FLAMES.hydrogen,
  );
  return { model: shipRoot(referenceRadiusAU, hull.build(), ...flames.meshes), exhaust: flames.set };
}
