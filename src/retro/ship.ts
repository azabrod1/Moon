/**
 * The Retro look's ship: a delta fighter, flown in place of the app's own
 * ship while the look is on (index.ts `ship`).
 *
 * The app's ship is a slim needle of white and graphite lit only by the Sun:
 * from the chase view, behind and above, most of it is dark, and its thin
 * highlights break up on a 240-line picture. This one is built for big
 * pixels the way an early-1990s 3D game built its ships:
 *  - a wide silhouette (the wings span almost the ship's length), so from
 *    behind it is a readable triangle;
 *  - flat-shaded faces with no gloss, so each face is one tone and no sun
 *    glint blooms;
 *  - colours that sit on the palette's ramps: white hull, steel underside,
 *    red wingtips and fins, a yellow canopy;
 *  - a little light of its own on every face, so it never turns black when
 *    the Sun is behind it, and two orange engines that always show.
 *
 * Built in the app's ship frame and units: nose along +Y, up along -X,
 * starboard along +Z, in units of 1.8 reference radii, then turned -90°
 * about Z as the app's own ship is. Its farthest solid point, a wingtip, is
 * 1.82 units from the middle, as far as the app's own nozzle: inside the
 * app's camera-safety extent once its half-size group applies (retro.test.ts).
 */
import * as THREE from 'three';

export interface RetroShip {
  model: THREE.Group;
  /** Each frame: whether the engines burn, and the throttle in 0..1. */
  exhaust(on: boolean, throttle: number): void;
}

type Point = readonly [forward: number, up: number, side: number];

/** Flat-shaded faces, one material each: a face is a list of points around it. */
class FacetBuilder {
  private readonly positions: number[] = [];
  constructor(private readonly unit: number) {}

  face(...points: Point[]): this {
    for (let index = 1; index + 1 < points.length; index++) {
      for (const [forward, up, side] of [points[0], points[index], points[index + 1]]) {
        this.positions.push(-up * this.unit, forward * this.unit, side * this.unit);
      }
    }
    return this;
  }

  /** The same face on both sides of the ship (side → -side). */
  mirrored(...points: Point[]): this {
    this.face(...points);
    return this.face(...points.map(([forward, up, side]) => [forward, up, -side] as const));
  }

  mesh(material: THREE.Material): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  }
}

/** Lit by the Sun, one tone per face, with `glow` of its own colour always. */
function hullMaterial(hex: number, glow: number): THREE.MeshLambertMaterial {
  const colour = new THREE.Color(hex);
  return new THREE.MeshLambertMaterial({
    color: colour, emissive: colour, emissiveIntensity: glow, flatShading: true, side: THREE.DoubleSide,
  });
}

/** Unlit, above what the Sun lights, for the engines and the lights. */
function lampMaterial(red: number, green: number, blue: number, additive = false): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  material.color.setRGB(red, green, blue);
  material.toneMapped = false;
  if (additive) {
    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
  }
  return material;
}

export function createRetroShip(referenceRadiusAU: number): RetroShip {
  const unit = referenceRadiusAU * 1.8;
  const white = hullMaterial(0xc8ced6, 0.3);
  const steel = hullMaterial(0x5e6672, 0.3);
  const dark = hullMaterial(0x353b45, 0.2);
  const red = hullMaterial(0xc4402e, 0.32);
  const canopy = hullMaterial(0xf0c030, 0.55);
  const model = new THREE.Group();

  // The hull: a six-sided wedge from the nose to a flat stern.
  const nose: Point = [1.65, 0, 0];
  const front = { top: [0.55, 0.24, 0], upper: [0.55, 0.13, 0.27], lower: [0.55, -0.09, 0.24], bottom: [0.55, -0.15, 0] } as const;
  const rear = { top: [-1.15, 0.3, 0], upper: [-1.15, 0.17, 0.4], lower: [-1.15, -0.11, 0.36], bottom: [-1.15, -0.19, 0] } as const;
  const flip = ([forward, up, side]: Point): Point => [forward, up, -side];
  model.add(new FacetBuilder(unit)
    .mirrored(nose, front.top, front.upper)
    .mirrored(nose, front.upper, front.lower)
    .mirrored(front.top, rear.top, rear.upper, front.upper)
    .mirrored(front.upper, rear.upper, rear.lower, front.lower)
    .mesh(white));
  model.add(new FacetBuilder(unit)
    .mirrored(nose, front.lower, front.bottom)
    .mirrored(front.lower, rear.lower, rear.bottom, front.bottom)
    .mesh(steel));
  model.add(new FacetBuilder(unit)
    .face(rear.top, rear.upper, rear.lower, rear.bottom, flip(rear.lower), flip(rear.upper))
    .mesh(dark));

  // The canopy, rising out of the hull's top ahead of the wings.
  model.add(new FacetBuilder(unit)
    .face([1.05, 0.11, 0], [0.35, 0.16, 0.17], [0.45, 0.37, 0])
    .face([1.05, 0.11, 0], [0.45, 0.37, 0], [0.35, 0.16, -0.17])
    .face([0.45, 0.37, 0], [0.35, 0.16, 0.17], [0.05, 0.22, 0])
    .face([0.45, 0.37, 0], [0.05, 0.22, 0], [0.35, 0.16, -0.17])
    .mesh(canopy));

  // The wings: a cropped delta, white inboard and red at the tips.
  const wingUp = -0.04;
  const rootLeading: Point = [0.25, wingUp, 0.22];
  const rootTrailing: Point = [-1.1, wingUp, 0.3];
  const splitLeading: Point = [-0.35, wingUp, 0.98];
  const splitTrailing: Point = [-1.1, wingUp, 0.98];
  const tipLeading: Point = [-0.72, wingUp, 1.45];
  const tipTrailing: Point = [-1.1, wingUp, 1.45];
  model.add(new FacetBuilder(unit).mirrored(rootLeading, splitLeading, splitTrailing, rootTrailing).mesh(white));
  model.add(new FacetBuilder(unit).mirrored(splitLeading, tipLeading, tipTrailing, splitTrailing).mesh(red));

  // Two tail fins, canted out, swept back.
  model.add(new FacetBuilder(unit).mirrored([-0.5, 0.25, 0.2], [-1.15, 0.27, 0.22], [-1.28, 0.8, 0.46], [-0.92, 0.8, 0.46]).mesh(red));

  // Two engines along the stern's lower sides, each an eight-sided can with
  // an orange throat and a yellow core that always show from behind.
  const engineFrom = -0.72;
  const engineTo = -1.4;
  const engineRadius = 0.15;
  const ember = lampMaterial(0.8, 0.26, 0.04);
  const core = lampMaterial(1.0, 0.78, 0.3);
  const flameOuter = lampMaterial(1.0, 0.4, 0.08, true);
  const flameInner = lampMaterial(1.05, 0.85, 0.35, true);
  const flames: THREE.Mesh[] = [];
  for (const side of [0.3, -0.3]) {
    const engineUp = -0.05;
    const can = new FacetBuilder(unit);
    for (let facet = 0; facet < 8; facet++) {
      const angle = (facet / 8) * Math.PI * 2;
      const next = ((facet + 1) / 8) * Math.PI * 2;
      const ring = (forward: number, at: number): Point => [forward, engineUp + Math.cos(at) * engineRadius, side + Math.sin(at) * engineRadius];
      can.face(ring(engineFrom, angle), ring(engineTo, angle), ring(engineTo, next), ring(engineFrom, next));
    }
    model.add(can.mesh(steel));
    for (const [radius, behind, material] of [[0.75, 0.005, ember], [0.38, 0.01, core]] as const) {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(engineRadius * radius * unit, 8), material);
      disc.rotation.x = Math.PI / 2;
      disc.position.set(-engineUp * unit, (engineTo - behind) * unit, side * unit);
      model.add(disc);
    }
    // The flame: two cones from the nozzle, stretched by the throttle.
    for (const [radius, length, material] of [[0.13, 1.1, flameOuter], [0.07, 0.8, flameInner]] as const) {
      const geometry = new THREE.ConeGeometry(radius * unit, length * unit, 8, 1, true);
      geometry.rotateX(Math.PI);
      geometry.translate(0, (-length / 2) * unit, 0);
      const flame = new THREE.Mesh(geometry, material);
      flame.position.set(-engineUp * unit, engineTo * unit, side * unit);
      flame.renderOrder = 1;
      flame.visible = false;
      model.add(flame);
      flames.push(flame);
    }
  }

  // Navigation lights on the wingtips, big enough to be a big pixel each:
  // red to port, green to starboard.
  for (const [side, material] of [[-1.47, lampMaterial(1.5, 0.15, 0.1)], [1.47, lampMaterial(0.15, 1.1, 0.3)]] as const) {
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.06 * unit, 6, 4), material);
    light.position.set(-wingUp * unit, -0.95 * unit, side * unit);
    model.add(light);
  }

  model.rotation.z = -Math.PI / 2;

  return {
    model,
    exhaust(on, throttle) {
      for (const flame of flames) {
        flame.visible = on;
        if (on) flame.scale.set(0.8 + throttle * 0.3, 0.45 + throttle * 0.9, 0.8 + throttle * 0.3);
      }
      flameOuter.opacity = 0.35 + throttle * 0.2;
      flameInner.opacity = 0.55 + throttle * 0.3;
    },
  };
}
