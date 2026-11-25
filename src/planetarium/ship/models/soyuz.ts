/**
 * Soyuz: three modules in a row. The near-spherical orbital module at the
 * front, the bell-shaped descent module the crew comes home in, and the
 * service module behind, with its flared skirt and two long solar wings. The
 * first two wear a dark quilted blanket; the third is white radiators.
 *
 * It is a small ship (seven and a half metres), drawn here as large as its
 * wings allow: their tips are at the kit's limit to either side.
 */
import * as THREE from 'three';
import type { ShipOverride } from '../../PlayerShip';
import {
  FLAMES, HULL_WHITE, HullBuilder, NAV_LIGHTS, Raster, bell, bulb, createFlames, dish, disc, lathe, paint, rod,
  shipRoot, tube,
} from './fleetKit';

const RADIUS = 0.335;
const STERN = -1.02;
const WING_ROOT = RADIUS + 0.03;
const WING_LENGTH = 1.24;

export function createSoyuz(referenceRadiusAU: number): ShipOverride {
  const blanket = paint(new Raster(256, 0x565b50, 41).panels(9, 6, 0.2, 0.3).texture(), { roughness: 0.85 });
  const radiators = paint(new Raster(256, HULL_WHITE, 42).panels(10, 3, 0.05, 0.22).texture(), { roughness: 0.7 });
  const dark = paint(0x33372f, { roughness: 0.75 });
  const metal = paint(0x70757c, { roughness: 0.5, metalness: 0.5 });
  // The small hardware: the docking probe, the joints' bands, the aerials.
  const fittings = paint(0x70757c, { roughness: 0.5, metalness: 0.5, fine: true });
  // Solar cells: deep blue, with the silver lines between the cells and the
  // three hinged panels of each wing.
  const cells = new Raster(256, 0x121d42, 43).panels(4, 12, 0.3, 0.45, [0, 0, 1, 1], 0x7f8794);
  for (const hingeAt of [1 / 3, 2 / 3]) cells.fill(0, hingeAt - 0.008, 1, hingeAt + 0.008, 0x8a919c);
  const solar = paint(cells.texture(), { roughness: 0.72, metalness: 0.2 });

  const hull = new HullBuilder()
    // Service module: the skirt, the radiator drum, the open frame that joins it on.
    .add(dark, lathe([[STERN, 0.42], [-0.82, RADIUS]]))
    .add(radiators, lathe([[-0.82, RADIUS], [-0.36, RADIUS]]))
    .add(dark, lathe([[-0.36, RADIUS], [-0.355, 0.26], [-0.27, 0.26]]))
    .add(dark, disc(0.42), { at: [STERN, 0, 0] })
    .add(metal, bell(0.1, 0.12, 16), { at: [STERN + 0.03, 0, 0] })
    // Descent module, then the orbital module and its docking ring.
    .add(blanket, lathe([[-0.27, 0.3], [-0.24, 0.337], [-0.12, 0.34], [0.12, 0.3], [0.32, 0.225], [0.42, 0.18]]))
    .add(blanket, lathe([[0.42, 0.17], [0.47, 0.25], [0.56, 0.315], [0.72, 0.342], [0.88, 0.33], [1.02, 0.27], [1.11, 0.19], [1.16, 0.1]]))
    .add(metal, lathe([[1.16, 0.1], [1.22, 0.085], [1.22, 0]]))
    .add(fittings, tube(0.02, 0.03, 0.1, 10), { at: [1.27, 0, 0] })
    // The pale bands where the modules join.
    .add(fittings, tube(0.19, 0.19, 0.03, 32, true), { at: [0.42, 0, 0] })
    .add(fittings, tube(0.305, 0.305, 0.03, 32, true), { at: [-0.27, 0, 0] });

  // The solar wings and their roots.
  hull.pair(solar, new THREE.BoxGeometry(0.42, 0.014, WING_LENGTH), { at: [-0.6, 0, WING_ROOT + WING_LENGTH / 2] })
    .pair(fittings, new THREE.BoxGeometry(0.05, 0.03, 0.06), { at: [-0.6, 0, RADIUS + 0.015] });

  // The rendezvous radar's dish on its stalk, and the periscope under the descent module.
  hull.add(fittings, rod([0.9, 0.3, 0], [1.0, 0.48, 0], 0.012))
    .add(fittings, dish(0.075, 0.03, 14), { at: [1.0, 0.5, 0], turn: [0, Math.PI, 0] })
    .add(fittings, rod([0.0, -0.3, 0.05], [0.12, -0.46, 0.05], 0.018));

  const wingTip = WING_ROOT + WING_LENGTH + 0.005;
  hull.add(NAV_LIGHTS.port(), bulb(), { at: [-0.6, 0, -wingTip] })
    .add(NAV_LIGHTS.starboard(), bulb(), { at: [-0.6, 0, wingTip] })
    .add(NAV_LIGHTS.white(), bulb(0.018), { at: [-0.98, 0.43, 0] });

  const flames = createFlames([{ at: [STERN - 0.09, 0, 0], radius: 0.1, length: 0.8 }], FLAMES.storable);
  return { model: shipRoot(referenceRadiusAU, hull.build(), ...flames.meshes), exhaust: flames.set };
}
