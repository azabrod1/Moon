/**
 * The Torchship, our own design: what a fusion-driven liner might look like
 * if it were built from what engineers already draw. From the bow: a dust
 * shield, the bridge, a ring that spins to give its crew weight, a long truss
 * with six fuel tanks round it, four radiators that glow where they are
 * hottest, the reactor behind a shadow shield, and three magnet coils that
 * shape the flame.
 *
 * The ring turns once in fourteen seconds. The radiators run hotter as the
 * throttle opens.
 */
import * as THREE from 'three';
import type { ShipOverride } from '../../PlayerShip';
import {
  FLAMES, HULL_WHITE, HullBuilder, NAV_LIGHTS, Raster, bulb, createFlames, dish, disc, hoop, lamp, lathe, paint,
  rod, shipRoot, tube, wing,
} from './fleetKit';

const RING_AT = 0.72;
const RING_RADIUS = 0.66;
const SPINE_FROM = 0.5;
const SPINE_TO = -1.85;
const RING_TURN_RATE = (Math.PI * 2) / 14;

export function createTorchship(referenceRadiusAU: number): ShipOverride {
  const white = paint(new Raster(256, HULL_WHITE, 61).panels(8, 4, 0.06, 0.2).texture(), { roughness: 0.7 });
  // The truss, the spokes and the struts: too open to hide anything.
  const truss = paint(0x545a63, { roughness: 0.55, metalness: 0.45, fine: true });
  const grey = paint(0x545a63, { roughness: 0.55, metalness: 0.45 });
  const dark = paint(0x24272c, { roughness: 0.7, metalness: 0.2 });
  const foil = paint(0xb8923a, { roughness: 0.64, metalness: 0.5 });
  const copper = paint(0x8a5a33, { roughness: 0.56, metalness: 0.55, fine: true });
  const windows = lamp(0.9, 0.74, 0.45);
  // Radiators: dark panels, glowing red-orange at the root and cooling to the tip.
  const heat = new Raster(128, 0x000000, 62);
  for (let step = 0; step < 32; step++) {
    const cool = 1 - step / 32;
    heat.fill(0, step / 32, 1, (step + 1) / 32, [255 * cool ** 1.5, 92 * cool ** 2.2, 22 * cool ** 3]);
  }
  heat.panels(6, 4, 0, 0.5);
  const radiator = paint(new Raster(128, 0x2b2e34, 63).panels(6, 4, 0.1, 0.3).texture(), {
    roughness: 0.82, metalness: 0.1, glow: 0.35, glowColour: 0xffffff, glowMap: heat.texture(),
  });

  const hull = new HullBuilder()
    // Bow: the dust shield and the bridge behind it, with a lit band of windows.
    .add(white, lathe([[1.47, 0.34], [1.54, 0.22], [1.6, 0.1], [1.62, 0]]))
    .add(dark, disc(0.34), { at: [1.47, 0, 0] })
    .add(white, tube(0.16, 0.16, 0.35, 24), { at: [1.295, 0, 0] })
    .add(windows, tube(0.163, 0.163, 0.035, 24, true), { at: [1.38, 0, 0] })
    .add(grey, tube(0.12, 0.12, 0.62, 16), { at: [0.81, 0, 0] })
    .add(truss, rod([1.2, 0.15, 0], [1.2, 0.4, 0], 0.014))
    .add(white, dish(0.17, 0.05, 16), { at: [1.2, 0.42, 0], turn: [0, 0, -Math.PI / 2] })
    // The truss: a core, three longerons and a frame every so often.
    .add(truss, tube(0.05, 0.05, SPINE_FROM - SPINE_TO, 12), { at: [(SPINE_FROM + SPINE_TO) / 2, 0, 0] })
    .ring(truss, rod([SPINE_FROM, 0.13, 0], [SPINE_TO, 0.13, 0], 0.012, 6), 3)
    // Stern: the shadow shield, the reactor, and the magnet coils on their struts.
    .add(grey, tube(0.3, 0.3, 0.03, 32), { at: [-1.83, 0, 0] })
    .add(dark, tube(0.2, 0.17, 0.2, 24), { at: [-1.95, 0, 0] })
    .ring(truss, rod([-2.02, 0.17, 0], [-2.3, 0.36, 0], 0.012, 6), 3, {}, Math.PI / 3);
  for (let frame = SPINE_FROM - 0.1; frame > SPINE_TO; frame -= 0.35) hull.add(truss, hoop(0.13, 0.012, 'x', 14, 4), { at: [frame, 0, 0] });
  for (const [at, radius] of [[-2.08, 0.2], [-2.19, 0.28], [-2.3, 0.36]] as const) hull.add(copper, hoop(radius, 0.028, 'x', 28), { at: [at, 0, 0] });

  // Six tanks in two rows of three, the second row turned to sit between the first.
  const tank = new THREE.SphereGeometry(0.23, 14, 8);
  hull.ring(foil, tank, 3, { at: [0.1, 0.3, 0] }).ring(foil, tank, 3, { at: [-0.38, 0.3, 0] }, Math.PI / 3);

  // Radiators: a wide pair to the sides, a shorter pair above and below.
  const wide = wing([{ span: 0.08, lead: -0.72, chord: 1.05, thick: 0.025 }, { span: 1.25, lead: -1.15, chord: 0.55, thick: 0.02 }]);
  const short = wing([{ span: 0.08, lead: -0.9, chord: 0.8, thick: 0.025 }, { span: 0.75, lead: -1.2, chord: 0.45, thick: 0.02 }]);
  for (const skin of wide) hull.pair(radiator, skin);
  for (const skin of short) hull.add(radiator, skin, { turn: [-Math.PI / 2, 0, 0] }).add(radiator, skin, { turn: [Math.PI / 2, 0, 0] });

  hull.add(NAV_LIGHTS.port(), bulb(), { at: [-1.45, 0, -1.27] })
    .add(NAV_LIGHTS.starboard(), bulb(), { at: [-1.45, 0, 1.27] })
    .add(NAV_LIGHTS.white(), bulb(0.018), { at: [-1.45, 0.77, 0] });

  // The ring, a part of its own so it can turn: four spokes and a row of windows facing aft.
  const ring = new HullBuilder()
    .add(white, hoop(RING_RADIUS, 0.105, 'x', 40, 8))
    .ring(truss, rod([0, 0.12, 0], [0, RING_RADIUS - 0.09, 0], 0.035), 4)
    .ring(windows, new THREE.BoxGeometry(0.02, 0.05, 0.09), 12, { at: [-0.098, RING_RADIUS, 0] }, Math.PI / 12)
    .build();
  ring.position.x = RING_AT;

  const flames = createFlames([{ at: [-2.06, 0, 0], radius: 0.2, length: 1.9 }], FLAMES.torch);
  return {
    model: shipRoot(referenceRadiusAU, hull.build(), ring, ...flames.meshes),
    exhaust(on, throttle) {
      flames.set(on, throttle);
      radiator.emissiveIntensity = on ? 0.5 + 0.7 * throttle : 0.35;
    },
    tick(dt) {
      ring.rotation.x += dt * RING_TURN_RATE;
    },
  };
}
