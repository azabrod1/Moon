/**
 * The kit the fleet's ships are built from (ship/fleet.ts): a builder that
 * merges a hull into one mesh per material, the two smooth shapes most ships
 * are made of (a body of revolution and a wing), textures made from numbers
 * instead of a canvas, and the materials and flames every ship shares.
 *
 * The frame, for every ship built here: +X forward, +Y up, +Z starboard, in
 * plain authoring units. The ship's root carries the scale (SHIP_UNIT
 * reference radii per unit, the default ship's own unit), so the numbers in a
 * model file are the ship's proportions and nothing else.
 *
 * How big a ship may be, in those units (fleet.test.ts measures each one):
 *  - nothing more than 1.66 ahead of the origin or out to either side: a
 *    parked ship's origin stops that far from a body's surface
 *    (cruiseView.ts SHIP_CLEARANCE_AU), so anything longer would be in the
 *    ground;
 *  - nothing more than 2.44 from the origin at all, which in practice bounds
 *    the tail: the camera's near plane and zoom floor are set from that
 *    (SHIP_HULL_MAX_EXTENT_AU).
 *
 * Three rules the materials here encode, all learned on the default ship
 * (defaultShip.ts):
 *  - The Sun is the scene's only light and there is no fill, so a hull keeps
 *    a faint glow of its own colour (NIGHT_FLOOR); without it the unlit half
 *    is a black hole in the stars.
 *  - A sunlit hull must stay under the bloom's threshold even at the spawn
 *    point, 0.05 AU from the Sun. Paint is never brighter than HULL_WHITE and
 *    never glossy: with no surroundings to reflect, polished metal is black
 *    but for the Sun's own image, and a broad surface with a roughness under
 *    about 0.65 mirrors that image into the chase camera whenever the ship
 *    flies sunward (tools/ship-gallery.mjs, the back-lit view). "Metal" here
 *    is a colour and a soft sheen.
 *  - Everything is opaque except the flames, which are the default ship's own
 *    additive recipe. Nothing else may blend: Earth's ground marks its sea in
 *    the alpha channel, and a blended mesh drawn over it would disturb that.
 *
 * Nothing here needs a document or a canvas, so every ship builds in a test.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Reference radii per authoring unit: the default ship's unit. */
export const SHIP_UNIT = 1.8;

/** The brightest paint a hull may wear (the default hull's own base tone). */
export const HULL_WHITE = 0xb9c0ca;

/** How much of its own colour a hull shows where no sunlight falls. */
const NIGHT_FLOOR = 0.035;

export type Triple = readonly [number, number, number];

/** Where a part goes: its position, its turn (XYZ Euler angles, radians) and
 *  its scale. A negative scale mirrors the part. */
export interface Placement {
  at?: Triple;
  turn?: Triple;
  scale?: number | Triple;
}

const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchEuler = new THREE.Euler();
const scratchScale = new THREE.Vector3();
const MIRROR_Z = new THREE.Matrix4().makeScale(1, 1, -1);

function placementMatrix(placement: Placement): THREE.Matrix4 {
  const [x, y, z] = placement.at ?? [0, 0, 0];
  const [turnX, turnY, turnZ] = placement.turn ?? [0, 0, 0];
  const scale = placement.scale ?? 1;
  if (typeof scale === 'number') scratchScale.setScalar(scale);
  else scratchScale.set(scale[0], scale[1], scale[2]);
  return scratchMatrix.compose(
    scratchPosition.set(x, y, z),
    scratchQuaternion.setFromEuler(scratchEuler.set(turnX, turnY, turnZ)),
    scratchScale,
  );
}

/** Turn every triangle of an unindexed geometry to face the other way. */
function flipFaces(geometry: THREE.BufferGeometry): void {
  for (const attribute of Object.values(geometry.attributes)) {
    const { array, itemSize } = attribute as THREE.BufferAttribute;
    for (let triangle = 0; triangle + 3 * itemSize <= array.length; triangle += 3 * itemSize) {
      for (let component = 0; component < itemSize; component++) {
        const second = triangle + itemSize + component;
        const third = triangle + 2 * itemSize + component;
        const held = array[second];
        array[second] = array[third];
        array[third] = held;
      }
    }
  }
}

/**
 * A ship's solid parts, collected per material and merged into one mesh each
 * when the ship is built: a hull of fifty parts in five paints is five draws.
 * Parts that move (a spinning ring, a flame) are added to the built group as
 * meshes of their own instead.
 */
export class HullBuilder {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();

  /** Add one part. The geometry is copied, so one shape can be placed many times. */
  add(material: THREE.Material, geometry: THREE.BufferGeometry, placement: Placement = {}): this {
    return this.place(material, geometry, placementMatrix(placement).clone());
  }

  /** Add a part and its mirror image on the other side of the ship (z → -z). */
  pair(material: THREE.Material, geometry: THREE.BufferGeometry, placement: Placement = {}): this {
    const matrix = placementMatrix(placement).clone();
    this.place(material, geometry, matrix);
    return this.place(material, geometry, matrix.clone().premultiply(MIRROR_Z));
  }

  /** Add a part `count` times, evenly turned about the ship's long axis (or
   *  about `y`, for a disc), the first of them turned by `startTurn` radians. */
  ring(
    material: THREE.Material, geometry: THREE.BufferGeometry, count: number,
    placement: Placement = {}, startTurn = 0, axis: 'x' | 'y' = 'x',
  ): this {
    const matrix = placementMatrix(placement).clone();
    for (let index = 0; index < count; index++) {
      const angle = startTurn + (index / count) * Math.PI * 2;
      const about = axis === 'x' ? new THREE.Matrix4().makeRotationX(angle) : new THREE.Matrix4().makeRotationY(angle);
      this.place(material, geometry, matrix.clone().premultiply(about));
    }
    return this;
  }

  private place(material: THREE.Material, geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): this {
    const placed = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    for (const name of Object.keys(placed.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') placed.deleteAttribute(name);
    }
    placed.applyMatrix4(matrix);
    if (matrix.determinant() < 0) flipFaces(placed);
    const list = this.parts.get(material);
    if (list) list.push(placed);
    else this.parts.set(material, [placed]);
    return this;
  }

  /** The parts as a group, one mesh per material. */
  build(): THREE.Group {
    const group = new THREE.Group();
    for (const [material, geometries] of this.parts) {
      const merged = mergeGeometries(geometries);
      if (!merged) throw new Error('A ship part carries attributes the others do not');
      group.add(new THREE.Mesh(merged, material));
    }
    return group;
  }
}

/** A ship's root: its parts, at the ship's scale for the app's reference radius. */
export function shipRoot(referenceRadiusAU: number, ...parts: THREE.Object3D[]): THREE.Group {
  const root = new THREE.Group();
  root.scale.setScalar(referenceRadiusAU * SHIP_UNIT);
  root.add(...parts);
  return root;
}

/**
 * A body of revolution about the ship's long axis (or about `y` for a disc).
 * `profile` is a list of [distance along the axis, radius]. Run it from the
 * tail to the nose for a surface seen from outside, and from the nose to the
 * tail for one seen from inside (a nozzle's throat). The texture's `v` runs
 * 0 to 1 along the axis and `u` once across the arc. Around the long axis the
 * turn starts at starboard and passes the belly at a quarter, port at a half
 * and the back at three quarters; `arc` is [where it starts, how far it goes]
 * in turns, for a hull that is one paint above and another below.
 */
export function lathe(
  profile: ReadonlyArray<readonly [along: number, radius: number]>,
  options: { segments?: number; axis?: 'x' | 'y'; arc?: readonly [start: number, turns: number] } = {},
): THREE.BufferGeometry {
  const [start, turns] = options.arc ?? [0, 1];
  const geometry = new THREE.LatheGeometry(
    profile.map(([along, radius]) => new THREE.Vector2(Math.max(radius, 1e-4), along)),
    Math.max(3, Math.round((options.segments ?? 48) * turns)),
    start * Math.PI * 2,
    turns * Math.PI * 2,
  );
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  let low = Infinity;
  let high = -Infinity;
  for (const [along] of profile) {
    low = Math.min(low, along);
    high = Math.max(high, along);
  }
  for (let index = 0; index < position.count; index++) {
    uv.setY(index, (position.getY(index) - low) / Math.max(high - low, 1e-9));
  }
  if (options.axis !== 'y') geometry.rotateZ(-Math.PI / 2);
  return geometry;
}

/** A straight or tapered tube along the long axis, centred on the origin. */
export function tube(radiusFront: number, radiusBack: number, length: number, segments = 32, open = false): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radiusFront, radiusBack, length, segments, 1, open).rotateZ(-Math.PI / 2);
}

/** A flat disc across the long axis, facing aft (or forward). */
export function disc(radius: number, facing: 'aft' | 'forward' = 'aft', segments = 32): THREE.BufferGeometry {
  return new THREE.CircleGeometry(radius, segments).rotateY(facing === 'aft' ? -Math.PI / 2 : Math.PI / 2);
}

/** A straight rod from one point to another. */
export function rod(from: Triple, to: Triple, radius: number, segments = 8): THREE.BufferGeometry {
  const start = new THREE.Vector3(...from);
  const span = new THREE.Vector3(...to).sub(start);
  const length = span.length();
  const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), span.clone().normalize());
  return new THREE.CylinderGeometry(radius, radius, length, segments)
    .applyQuaternion(turn)
    .translate(start.x + span.x / 2, start.y + span.y / 2, start.z + span.z / 2);
}

/** A hoop around the long axis (or around `y`), centred on the origin. */
export function hoop(radius: number, thickness: number, axis: 'x' | 'y' = 'x', segments = 48): THREE.BufferGeometry {
  const torus = new THREE.TorusGeometry(radius, thickness, 10, segments);
  return axis === 'x' ? torus.rotateY(Math.PI / 2) : torus.rotateX(Math.PI / 2);
}

/** A thin bowl about the long axis with both its faces solid: `curve` is a
 *  list of [along, radius] from its rim to its middle, as a profile is. */
function shell(curve: ReadonlyArray<readonly [number, number]>, segments: number): THREE.BufferGeometry {
  const inside = [...curve].reverse().map(([along, radius]) => [along, radius * 0.93] as const);
  return mergeGeometries([lathe(curve, { segments }), lathe(inside, { segments })]);
}

/** A rocket engine's bell with its throat at the origin, opening aft:
 *  `radius` at the exit, `depth` from the throat back to it. */
export function bell(radius: number, depth: number, segments = 24): THREE.BufferGeometry {
  const curve = [[-1, 1], [-0.8, 0.8], [-0.55, 0.57], [-0.3, 0.38], [-0.1, 0.27], [0, 0.26]] as const;
  return shell(curve.map(([along, wide]) => [along * depth, wide * radius] as const), segments);
}

/** A radio dish with its middle at the origin, looking aft. Turn it with a placement. */
export function dish(radius: number, depth: number, segments = 24): THREE.BufferGeometry {
  const curve = [[-1, 1], [-0.64, 0.8], [-0.36, 0.6], [-0.16, 0.4], [-0.04, 0.2], [0, 0.02]] as const;
  return shell(curve.map(([along, wide]) => [along * depth, wide * radius] as const), segments);
}

/** A small round lamp, for a `lamp` material. */
export function bulb(radius = 0.022): THREE.BufferGeometry {
  return new THREE.SphereGeometry(radius, 8, 6);
}

/** One station of a wing: where it is along the span, where its leading edge
 *  is, how long the chord is, how thick it is at its thickest, and how high
 *  it sits. */
export interface WingSection {
  span: number;
  lead: number;
  chord: number;
  thick: number;
  lift?: number;
}

/** Half the thickness of a symmetric aerofoil at `fraction` of the chord from
 *  the leading edge, as a share of its greatest thickness (NACA's four-digit
 *  law with a closed trailing edge): a round nose, thickest at 30 %. */
function aerofoilHalfThickness(fraction: number): number {
  return 5 * (0.2969 * Math.sqrt(fraction) - 0.126 * fraction - 0.3516 * fraction ** 2
    + 0.2843 * fraction ** 3 - 0.1036 * fraction ** 4);
}

/**
 * A wing, fin or flap: a closed surface through `sections`, which run along
 * +Z (starboard) with the chord along X. The leading edge is round and the
 * trailing edge sharp. Returned as its upper and lower skins, so a wing can
 * be white above and tiled below; the end caps come with the upper skin.
 * Turn it with a placement for a fin (`turn: [-Math.PI / 2, 0, 0]` stands it
 * up) and use `HullBuilder.pair` for the other wing.
 */
export function wing(sections: readonly WingSection[], samples = 10): [upper: THREE.BufferGeometry, lower: THREE.BufferGeometry] {
  const around = 2 * samples + 1;
  const positions: number[] = [];
  const uvs: number[] = [];
  sections.forEach((section, sectionIndex) => {
    for (let step = 0; step < around; step++) {
      // Trailing edge, over the top to the leading edge, back underneath.
      const upper = step <= samples;
      const fraction = (1 - Math.cos((Math.PI * Math.abs(step - samples)) / samples)) / 2;
      const half = aerofoilHalfThickness(fraction) * section.thick;
      positions.push(section.lead - fraction * section.chord, (section.lift ?? 0) + (upper ? half : -half), section.span);
      uvs.push(fraction, sectionIndex / (sections.length - 1));
    }
  });
  const skins: [number[], number[]] = [[], []];
  for (let sectionIndex = 0; sectionIndex + 1 < sections.length; sectionIndex++) {
    for (let step = 0; step + 1 < around; step++) {
      const near = sectionIndex * around + step;
      const far = near + around;
      skins[step < samples ? 0 : 1].push(near, far, near + 1, near + 1, far, far + 1);
    }
  }
  const whole = new THREE.BufferGeometry();
  whole.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  whole.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  whole.setIndex([...skins[0], ...skins[1]]);
  // Normals from the whole surface, so the leading edge the skins share is round.
  whole.computeVertexNormals();
  const skin = (indices: number[]): THREE.BufferGeometry => {
    const part = whole.clone();
    part.setIndex(indices);
    return part.toNonIndexed();
  };
  const [upper, lower] = [skin(skins[0]), skin(skins[1])];
  // The two ends, flat: a strip joining the upper skin to the lower one.
  const caps: number[] = [];
  for (const [sectionIndex, outward] of [[0, false], [sections.length - 1, true]] as const) {
    const base = sectionIndex * around;
    for (let step = 0; step < samples; step++) {
      const quad = [base + step, base + step + 1, base + around - 2 - step, base + around - 1 - step];
      const order = outward ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
      for (const corner of order) caps.push(...positions.slice(quad[corner] * 3, quad[corner] * 3 + 3));
    }
  }
  const capGeometry = new THREE.BufferGeometry();
  capGeometry.setAttribute('position', new THREE.Float32BufferAttribute(caps, 3));
  capGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((caps.length / 3) * 2).fill(0), 2));
  capGeometry.computeVertexNormals();
  return [mergeGeometries([upper, capGeometry]), lower];
}

type Colour = number | Triple;

function colourBytes(colour: Colour): Triple {
  if (typeof colour !== 'number') return colour;
  return [(colour >> 16) & 255, (colour >> 8) & 255, colour & 255];
}

/** A texture drawn as numbers: rectangles in the texture's own 0..1 square,
 *  with `v` up. Small and repeatable, and it needs no canvas. */
export class Raster {
  readonly data: Uint8Array;
  private state: number;

  constructor(readonly size: number, base: Colour, seed = 1) {
    this.data = new Uint8Array(size * size * 4);
    this.state = seed;
    this.fill(0, 0, 1, 1, base);
  }

  /** The next number in 0..1 of a fixed sequence, so a hull looks the same every session. */
  random(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  }

  /** Blend `colour` over a rectangle at `strength` (1 replaces what is there). */
  fill(u0: number, v0: number, u1: number, v1: number, colour: Colour, strength = 1): this {
    const [red, green, blue] = colourBytes(colour);
    const clamp = (value: number) => Math.min(this.size, Math.max(0, Math.round(value * this.size)));
    for (let row = clamp(v0); row < clamp(v1); row++) {
      for (let column = clamp(u0); column < clamp(u1); column++) {
        const offset = (row * this.size + column) * 4;
        this.data[offset] += (red - this.data[offset]) * strength;
        this.data[offset + 1] += (green - this.data[offset + 1]) * strength;
        this.data[offset + 2] += (blue - this.data[offset + 2]) * strength;
        this.data[offset + 3] = 255;
      }
    }
    return this;
  }

  /**
   * A grid of panels over a rectangle (`region`: u0, v0, u1, v1): each panel
   * darker than what is there by up to `shade`, with a seam between panels
   * drawn at `seam` strength in `seamColour`.
   */
  panels(
    columns: number, rows: number, shade: number, seam: number,
    region: readonly [number, number, number, number] = [0, 0, 1, 1], seamColour: Colour = 0x000000,
  ): this {
    const [u0, v0, u1, v1] = region;
    const width = (u1 - u0) / columns;
    const height = (v1 - v0) / rows;
    const line = 1 / this.size;
    for (let column = 0; column < columns; column++) {
      for (let row = 0; row < rows; row++) {
        const left = u0 + column * width;
        const bottom = v0 + row * height;
        this.fill(left, bottom, left + width, bottom + height, 0x000000, this.random() * shade);
        this.fill(left, bottom, left + line, bottom + height, seamColour, seam);
        this.fill(left, bottom, left + width, bottom + line, seamColour, seam);
      }
    }
    return this;
  }

  /** The texture, as colour. It repeats around a hull. */
  texture(): THREE.DataTexture {
    const texture = new THREE.DataTexture(this.data, this.size, this.size, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    return texture;
  }
}

export interface PaintOptions {
  roughness?: number;
  metalness?: number;
  /** Light of its own, as a share of `glowColour`: a lit window, a hot radiator. */
  glow?: number;
  /** The colour of that light, where it is not the paint's own. */
  glowColour?: number;
  /** Where that light shows, where it is not everywhere (a radiator hot at its root). */
  glowMap?: THREE.Texture;
}

/**
 * A hull paint: lit by the Sun, with the faint glow of its own colour that
 * keeps its dark side readable. `look` is a colour or a pattern (a Raster's
 * texture); with a pattern the colour stays white, so it is not darkened twice.
 */
export function paint(look: number | THREE.Texture, options: PaintOptions = {}): THREE.MeshStandardMaterial {
  const map = typeof look === 'number' ? null : look;
  const colour = typeof look === 'number' ? look : 0xffffff;
  return new THREE.MeshStandardMaterial({
    color: colour,
    map,
    roughness: options.roughness ?? 0.7,
    metalness: options.metalness ?? 0.05,
    emissive: options.glowColour ?? colour,
    emissiveMap: options.glowMap ?? (options.glowColour === undefined ? map : null),
    emissiveIntensity: options.glow ?? NIGHT_FLOOR,
  });
}

/** An unlit light: a navigation lamp, a window, an engine's throat. One that
 *  is always on stays well under the bloom's threshold (app/bloomConfig.ts
 *  BLOOM_THRESHOLD, in luminance), so it reads as a dot and not a glare;
 *  fleet.test.ts holds every parked ship to that. */
export function lamp(red: number, green: number, blue: number): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial();
  material.color.setRGB(red, green, blue);
  material.toneMapped = false;
  return material;
}

/** The lamps every ship carries, by the convention the default ship set:
 *  red to port, green to starboard, white aft. */
export const NAV_LIGHTS = {
  port: () => lamp(1.6, 0.12, 0.08),
  starboard: () => lamp(0.08, 0.55, 0.18),
  white: () => lamp(0.85, 0.85, 0.85),
} as const;

/** A flame's colours: the bright core and the wider haze around it. */
export interface FlameTint {
  core: Triple;
  haze: Triple;
}

export const FLAMES = {
  /** The default ship's torch: blue-white. */
  torch: { core: [1.45, 1.95, 2.85], haze: [0.7, 1.15, 2.5] },
  /** Methane and oxygen: violet-blue. */
  methane: { core: [1.9, 1.55, 2.7], haze: [1.0, 0.7, 2.3] },
  /** Hydrogen and oxygen: pale blue, almost clear. */
  hydrogen: { core: [1.2, 1.7, 2.5], haze: [0.5, 0.9, 1.9] },
  /** Storable propellants: a faint warm orange. */
  storable: { core: [2.6, 1.6, 1.0], haze: [1.7, 0.8, 0.4] },
} as const satisfies Record<string, FlameTint>;

/** Where a flame leaves the ship: the middle of the nozzle's exit, the
 *  flame's radius there and its length at full burn. `flat` squashes it for a
 *  slot-shaped exhaust. */
export interface Nozzle {
  at: Triple;
  radius: number;
  length: number;
  flat?: number;
}

/** A glow inside an engine: where, and how wide. */
export interface Ember {
  at: Triple;
  radius: number;
}

export interface Flames {
  meshes: THREE.Mesh[];
  /** Each frame: whether the engines burn, and the throttle in 0..1. */
  set(on: boolean, throttle: number): void;
}

/**
 * The flames for a set of nozzles: two additive cones each, a core inside a
 * haze, and one mesh of embers, a disc glowing in each throat. This is the
 * default ship's recipe and its ramp (defaultShip.ts, PlayerShip.update): the
 * geometry is authored at full-burn size over the ramp's greatest scale, and
 * the opacities keep the stacked surfaces under the bloom's threshold until
 * the burn is nearly full. `embers` adds throats that glow without a flame of
 * their own, so a cluster of engines can share one flame.
 */
export function createFlames(nozzles: readonly Nozzle[], tint: FlameTint = FLAMES.torch, embers: readonly Ember[] = []): Flames {
  const flameMaterial = (colour: Triple): THREE.MeshBasicMaterial => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    material.color.setRGB(colour[0], colour[1], colour[2]);
    material.toneMapped = false;
    return material;
  };
  const core = flameMaterial(tint.core);
  const haze = flameMaterial(tint.haze);
  const cores: THREE.Mesh[] = [];
  const hazes: THREE.Mesh[] = [];
  for (const nozzle of nozzles) {
    for (const [material, radius, length, list] of [
      [core, nozzle.radius * 0.55, nozzle.length / 1.15, cores],
      [haze, nozzle.radius / 0.85, (nozzle.length * 0.72) / 1.05, hazes],
    ] as const) {
      // A cone with its base at the nozzle and its point astern.
      const geometry = new THREE.ConeGeometry(radius, length, 20, 1, true)
        .rotateX(Math.PI).translate(0, -length / 2, 0).rotateZ(-Math.PI / 2);
      const flame = new THREE.Mesh(geometry, material);
      flame.position.set(nozzle.at[0], nozzle.at[1], nozzle.at[2]);
      flame.userData.flat = nozzle.flat ?? 1;
      list.push(flame);
    }
  }
  const glows = [...nozzles.map((nozzle) => ({ at: nozzle.at, radius: nozzle.radius * 0.6 })), ...embers];
  const emberMesh = new THREE.Mesh(
    mergeGeometries(glows.map((glow) => disc(glow.radius, 'aft', 20).translate(glow.at[0], glow.at[1], glow.at[2]))),
    core,
  );
  const meshes = [...hazes, ...cores, emberMesh];
  for (const mesh of meshes) {
    // After the transparent starfield, so no star sorts over a flame.
    mesh.renderOrder = 1;
    mesh.visible = false;
  }
  return {
    meshes,
    set(on, throttle) {
      const intensity = 0.2 + throttle * 0.28;
      haze.opacity = intensity * 0.1;
      core.opacity = intensity * 0.35;
      emberMesh.visible = on;
      for (const flame of hazes) {
        flame.visible = on;
        const wide = 0.5 + throttle * 0.35;
        flame.scale.set(0.4 + throttle * 0.65, wide * flame.userData.flat, wide);
      }
      for (const flame of cores) {
        flame.visible = on;
        const wide = 0.6 + throttle * 0.25;
        flame.scale.set(0.3 + throttle * 0.85, wide * flame.userData.flat, wide);
      }
    },
  };
}
