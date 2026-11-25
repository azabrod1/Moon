/**
 * Apollo's command and service module: the silver cone the crew rode in, on
 * a cylinder of tanks and radiators, with the big bell of its one main engine
 * astern. Four clusters of small thrusters ring the cylinder, and a cluster
 * of four dishes on a boom kept it in touch with Earth.
 */
import * as THREE from 'three';
import type { ShipOverride } from '../../PlayerShip';
import {
  FLAMES, HULL_WHITE, HullBuilder, NAV_LIGHTS, Raster, bell, bulb, createFlames, dish, disc, lathe, paint, rod,
  shipRoot, tube,
} from './fleetKit';

const RADIUS = 0.55;
/** Where the cone meets the cylinder, and where the cylinder ends. */
const SHOULDER = 0.57;
const STERN = -0.75;
/** The cone's slope, as a turn about the side axis: a third of a right angle past 30°. */
const CONE_SLOPE = -Math.atan2(0.445, 0.68);

export function createApollo(referenceRadiusAU: number): ShipOverride {
  // The command module: strips of mirrored tape.
  const silver = paint(new Raster(256, 0xa3a9af, 31).panels(20, 5, 0.07, 0.18).texture(), { roughness: 0.64, metalness: 0.5 });
  // The service module: bare aluminium panels with white radiators let into them.
  const panels = new Raster(512, 0xa0a6ad, 32).panels(12, 4, 0.06, 0.2);
  for (let column = 0; column < 12; column++) {
    const [left, right] = [column / 12 + 0.012, (column + 1) / 12 - 0.012];
    const low = column % 6 === 2 || column % 6 === 3;
    panels.fill(left, low ? 0.08 : 0.5, right, low ? 0.44 : 0.93, HULL_WHITE);
  }
  const aluminium = paint(panels.texture(), { roughness: 0.66, metalness: 0.4 });
  const metal = paint(0x60656d, { roughness: 0.5, metalness: 0.5 });
  const bellMetal = paint(0x43464d, { roughness: 0.62, metalness: 0.45 });
  const glass = paint(0x0a0f16, { roughness: 0.45, metalness: 0.4, glow: 0.3, glowColour: 0x4a3423 });

  const hull = new HullBuilder()
    .add(silver, lathe([[0.53, 0.5], [SHOULDER, RADIUS], [0.63, RADIUS], [1.31, 0.105], [1.42, 0.09], [1.44, 0]]))
    .add(metal, tube(0.03, 0.045, 0.14, 12), { at: [1.5, 0, 0] })
    .add(aluminium, lathe([[STERN, RADIUS], [SHOULDER, RADIUS]]))
    .add(metal, disc(RADIUS), { at: [STERN, 0, 0] })
    .add(silver, lathe([[-0.98, 0.2], [STERN, 0.44]]))
    .add(bellMetal, bell(0.36, 0.78, 32), { at: [-0.8, 0, 0] });

  // Three windows on the cone's upper side.
  const windowPane = new THREE.BoxGeometry(0.11, 0.012, 0.075);
  for (const around of [-0.55, 0, 0.55]) {
    hull.ring(glass, windowPane, 1, { at: [0.95, 0.346, 0], turn: [0, 0, CONE_SLOPE] }, around);
  }

  // Four thruster clusters around the cylinder: a block and four small nozzles each.
  const nozzle = tube(0.028, 0.012, 0.06, 10);
  const eighth = Math.PI / 4;
  hull.ring(metal, new THREE.BoxGeometry(0.09, 0.05, 0.09), 4, { at: [0.25, 0.57, 0] }, eighth)
    .ring(metal, nozzle, 4, { at: [0.32, 0.585, 0] }, eighth)
    .ring(metal, nozzle, 4, { at: [0.18, 0.585, 0], turn: [0, Math.PI, 0] }, eighth)
    .ring(metal, nozzle, 4, { at: [0.25, 0.585, 0.07], turn: [0, -Math.PI / 2, 0] }, eighth)
    .ring(metal, nozzle, 4, { at: [0.25, 0.585, -0.07], turn: [0, Math.PI / 2, 0] }, eighth);

  // The high-gain antenna: four dishes on a boom from the stern's rim.
  hull.add(metal, rod([STERN, 0.3, 0.42], [-1.0, 0.55, 0.78], 0.015));
  for (const [up, side] of [[0.11, 0.11], [0.11, -0.11], [-0.11, 0.11], [-0.11, -0.11]] as const) {
    hull.add(metal, dish(0.1, 0.035), { at: [-1.0, 0.55 + up, 0.78 + side] });
  }

  hull.add(NAV_LIGHTS.port(), bulb(), { at: [0.4, 0, -0.565] })
    .add(NAV_LIGHTS.starboard(), bulb(), { at: [0.4, 0, 0.565] })
    .add(NAV_LIGHTS.white(), bulb(0.018), { at: [-0.7, 0.565, 0] });

  const flames = createFlames([{ at: [-1.58, 0, 0], radius: 0.3, length: 1.3 }], FLAMES.storable);
  return { model: shipRoot(referenceRadiusAU, hull.build(), ...flames.meshes), exhaust: flames.set };
}
