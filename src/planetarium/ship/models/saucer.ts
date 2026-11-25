/**
 * A flying saucer, our own drawing of the old idea: a lens of brushed metal
 * under a glass dome, a ring of lamps round its rim and a soft light beneath.
 *
 * It has no flame. Under way it leans into its heading, its dome and the
 * light beneath brighten with the throttle, and a glow travels round the
 * rim. That glow is slow and stays well under the bloom's threshold: a lamp
 * that pulses across the threshold reads as throbbing.
 */
import * as THREE from 'three';
import type { ShipOverride } from '../../PlayerShip';
import { HullBuilder, Raster, bulb, hoop, lamp, lathe, paint, shipRoot, type Triple } from './fleetKit';

const RADIUS = 1.6;
const RIM_HEIGHT = -0.03;
/** The rim's lamps come in this many groups, lit one after another. */
const LAMP_GROUPS = 3;
const LAMPS_PER_GROUP = 6;
const LAMP_COLOUR = [0.45, 0.9, 1.0] as const;
const DRIVE_COLOUR = [0.6, 0.95, 1.0] as const;
/** The dome's own light, parked: dim, so it reads as glass and not as a lamp. */
const DOME_GLOW = 0.1;

export function createSaucer(referenceRadiusAU: number): ShipOverride {
  const skin = paint(new Raster(512, 0x8a9097, 51).panels(24, 6, 0.1, 0.22).texture(), { roughness: 0.68, metalness: 0.45 });
  // The trim rings and the pods beneath are too slight to hide anything.
  const trim = paint(0x3a3f47, { roughness: 0.64, metalness: 0.4, fine: true });
  const dome = paint(0x0b1a1f, { roughness: 0.5, metalness: 0.4, glow: DOME_GLOW, glowColour: 0x2bd4c8 });
  const drive = lamp(0, 0, 0);
  const rimLamps = Array.from({ length: LAMP_GROUPS }, () => lamp(0, 0, 0));
  const about = { axis: 'y' } as const;
  /** A point on a circle about the saucer's own axis, `turns` round from dead ahead. */
  const around = (radius: number, height: number, turns: number): Triple =>
    [radius * Math.cos(turns * Math.PI * 2), height, radius * Math.sin(turns * Math.PI * 2)];

  const hull = new HullBuilder()
    // The upper skin, the lower skin (flat in the middle), and the dome.
    .add(skin, lathe([[RIM_HEIGHT, RADIUS], [0, 1.59], [0.05, 1.47], [0.12, 1.16], [0.19, 0.84], [0.24, 0.62], [0.26, 0.55]], about))
    .add(skin, lathe([[-0.3, 0], [-0.3, 0.32], [-0.26, 0.55], [-0.19, 0.86], [-0.11, 1.22], [-0.05, 1.52], [RIM_HEIGHT, RADIUS]], about))
    .add(dome, lathe([[0.26, 0.5], [0.36, 0.47], [0.47, 0.38], [0.55, 0.26], [0.595, 0.13], [0.61, 0]], about))
    .add(trim, hoop(0.53, 0.035, 'y'), { at: [0, 0.26, 0] })
    // A raised band part-way out, where the upper skin steepens.
    .add(trim, hoop(1.16, 0.016, 'y', 64), { at: [0, 0.122, 0] })
    .add(trim, hoop(RADIUS, 0.028, 'y', 64), { at: [0, RIM_HEIGHT, 0] })
    // Beneath: the light in the middle inside its collar, and three pods.
    .add(drive, new THREE.CircleGeometry(0.26, 32).rotateX(Math.PI / 2), { at: [0, -0.302, 0] })
    .add(trim, hoop(0.29, 0.03, 'y'), { at: [0, -0.3, 0] });
  const pod = new THREE.SphereGeometry(0.15, 14, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  for (let index = 0; index < 3; index++) hull.add(trim, pod, { at: around(0.8, -0.2, index / 3) });
  const lampCount = LAMP_GROUPS * LAMPS_PER_GROUP;
  for (let index = 0; index < lampCount; index++) {
    hull.add(rimLamps[index % LAMP_GROUPS], bulb(0.03), { at: around(RADIUS + 0.012, RIM_HEIGHT, index / lampCount) });
  }

  const body = hull.build();
  let seconds = 0;
  let power = 0;
  let lean = 0;
  const show = () => {
    rimLamps.forEach((material, group) => {
      const wave = 0.5 + 0.5 * Math.cos(Math.PI * 2 * (seconds * 0.35 - group / LAMP_GROUPS));
      material.color.setRGB(...LAMP_COLOUR).multiplyScalar(0.25 + 0.6 * wave);
    });
    drive.color.setRGB(...DRIVE_COLOUR).multiplyScalar(0.3 + 0.6 * power);
    dome.emissiveIntensity = DOME_GLOW + 0.18 * power;
    // Nose down into the heading, with a slow sway on top.
    body.rotation.set(0.025 * Math.sin(seconds * 0.7 + 1), 0, -0.16 * lean + 0.025 * Math.sin(seconds * 0.9));
  };
  show();

  return {
    model: shipRoot(referenceRadiusAU, body),
    exhaust(on, throttle) {
      power = on ? 0.35 + 0.65 * throttle : 0;
      show();
    },
    // Told the throttle every frame, and that is what redraws; its own time
    // only moves while the clock does.
    tick(dt) {
      seconds += dt;
      lean += (power - lean) * Math.min(1, dt * 2);
    },
  };
}
