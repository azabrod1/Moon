/**
 * Player-selectable spacecraft beyond the default Moon needle.
 *
 * These are deliberately procedural rather than downloaded assets: every
 * silhouette remains crisp at chase-camera scale, materials react to the real
 * solar light, and the models add no network or loading gate to ship changes.
 * All builders face +X, the PlayerShip forward axis, and fit the same roughly
 * six-reference-radius visual envelope as the default craft.
 */
import * as THREE from 'three';
import type { PlayerShipProfile } from '../shipProfiles';
import { addFleetSurfaceDetail } from './fleetSurfaceDetail';
import { createEngineBell, createParabolicDishGeometry, createRodBetween } from './shipPrimitives';

type Mat = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial | THREE.MeshBasicMaterial;

function standard(
  color: number,
  roughness: number,
  metalness: number,
  emissive = 0x000000,
  emissiveIntensity = 0,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });
}

function glow(color: number, intensity = 1): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: intensity });
  material.toneMapped = false;
  return material;
}

interface PartOpts {
  name?: string;
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number] | number;
  renderOrder?: number;
  emitter?: boolean;
}

/** Apply the common name/transform/flags to an existing mesh, add it to the
 *  group, and return it. Only the options passed take effect, so a mesh from
 *  `cylinderX`/`discX` (which bake in their own rotation) keeps it unless `rot`
 *  is given — the composed matrix is identical to the explicit block form. */
function place(group: THREE.Group, mesh: THREE.Mesh, opts: PartOpts = {}): THREE.Mesh {
  if (opts.name) mesh.name = opts.name;
  if (opts.pos) mesh.position.set(opts.pos[0], opts.pos[1], opts.pos[2]);
  if (opts.rot) mesh.rotation.set(opts.rot[0], opts.rot[1], opts.rot[2]);
  if (typeof opts.scale === 'number') mesh.scale.setScalar(opts.scale);
  else if (opts.scale) mesh.scale.set(opts.scale[0], opts.scale[1], opts.scale[2]);
  if (opts.renderOrder !== undefined) mesh.renderOrder = opts.renderOrder;
  if (opts.emitter) mesh.userData.fleetPropulsionEmitter = true;
  group.add(mesh);
  return mesh;
}

/** `place` for a fresh mesh built straight from geometry + material — collapses
 *  the repeated `new Mesh → set pos/rot → group.add` blocks the builders are
 *  dense with. */
function part(group: THREE.Group, geometry: THREE.BufferGeometry, material: Mat, opts: PartOpts = {}): THREE.Mesh {
  return place(group, new THREE.Mesh(geometry, material), opts);
}

function cylinderX(
  radiusTop: number,
  radiusBottom: number,
  length: number,
  segments: number,
  material: Mat,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, length, segments),
    material,
  );
  mesh.rotation.z = -Math.PI / 2;
  return mesh;
}

function discX(radius: number, thickness: number, material: Mat, segments = 48): THREE.Mesh {
  return cylinderX(radius, radius, thickness, segments, material);
}

/** Horizontal planform disc: broad in X/Z, shallow in the scene's Y-up axis. */
function discY(radiusTop: number, radiusBottom: number, thickness: number, material: Mat, segments = 48): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, thickness, segments),
    material,
  );
}

/** Double-sided plate authored in the X/Z plane with a shallow Y thickness. */
function plateXZ(
  points: Array<[number, number]>,
  thickness: number,
  material: Mat,
  bevelSize = 0,
): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: bevelSize > 0,
    bevelSegments: bevelSize > 0 ? 2 : 0,
    bevelSize,
    bevelThickness: bevelSize,
    steps: 1,
  });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, thickness / 2, 0);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function addWindows(
  group: THREE.Group,
  xs: number[],
  y: number,
  z: number,
  size: number,
  material: Mat,
): void {
  for (const x of xs) {
    const window = new THREE.Mesh(new THREE.SphereGeometry(size, 10, 6), material);
    window.scale.set(0.45, 0.22, 1);
    window.position.set(x, y, z);
    group.add(window);
  }
}

function addEngineGlow(group: THREE.Group, x: number, y: number, z: number, radius: number, material: Mat): void {
  const engine = new THREE.Mesh(new THREE.CircleGeometry(radius, 24), material);
  engine.userData.fleetPropulsionEmitter = true;
  engine.rotation.y = -Math.PI / 2;
  engine.position.set(x, y, z);
  engine.renderOrder = 1;
  group.add(engine);
}

/**
 * The planetarium intentionally has no ambient light, which is physically
 * honest for planets but can erase a small metal ship against empty space.
 * Give selectable craft a restrained material-tinted night floor: enough to
 * preserve their silhouette, still far below the authored windows/engines.
 */
function boostDeepSpaceReadability(model: THREE.Group): THREE.Group {
  const adjusted = new Set<THREE.Material>();
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (adjusted.has(material) || !(material instanceof THREE.MeshStandardMaterial)) continue;
      adjusted.add(material);
      const floor = material.color.clone();
      floor.setRGB(
        Math.max(0.035, floor.r * 0.22),
        Math.max(0.035, floor.g * 0.22),
        Math.max(0.035, floor.b * 0.22),
      );
      material.emissive.setRGB(
        Math.max(material.emissive.r, floor.r),
        Math.max(material.emissive.g, floor.g),
        Math.max(material.emissive.b, floor.b),
      );
      material.emissiveIntensity = Math.max(material.emissiveIntensity, 0.24);
    }
  });
  return model;
}

function createSpaceShuttle(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const white = standard(0xd9dde0, 0.72, 0.05);
  const warmWhite = standard(0xbfc3c3, 0.88, 0.03);
  const black = standard(0x111417, 0.88, 0.08);
  const darkSteel = standard(0x3c4145, 0.52, 0.58);
  const windowMat = standard(0x07131b, 0.18, 0.3, 0x14344b, 0.34);
  const red = standard(0x9c2625, 0.6, 0.08);
  const engineGlow = glow(0x78baff, 0.86);

  place(group, cylinderX(0.47 * U, 0.51 * U, 2.8 * U, 40, white), { name: 'shuttle-orbiter-fuselage', pos: [-0.15 * U, 0, 0] });
  part(group, new THREE.SphereGeometry(0.51 * U, 40, 24), white, { scale: [1.65, 1, 1], pos: [1.35 * U, 0, 0] });
  part(group, new THREE.SphereGeometry(0.505 * U, 32, 18), black, { scale: [0.35, 0.96, 0.96], pos: [1.72 * U, 0, 0] });

  // The delta wing and black belly establish the orbiter silhouette from the
  // everyday elevated chase view; the white inset leaves a visible tile edge.
  place(group, plateXZ([
    [0.72 * U, -0.42 * U], [-0.78 * U, -1.72 * U], [-1.48 * U, -1.62 * U],
    [-0.98 * U, -0.42 * U], [-1.35 * U, 0.42 * U], [-0.78 * U, 1.72 * U],
    [0.72 * U, 0.42 * U],
  ], 0.12 * U, black, 0.015 * U), { name: 'shuttle-delta-wing', pos: [0, -0.05 * U, 0] });
  place(group, plateXZ([
    [0.58 * U, -0.39 * U], [-0.76 * U, -1.56 * U], [-1.25 * U, -1.48 * U],
    [-0.86 * U, -0.4 * U], [-1.17 * U, 0.4 * U], [-0.76 * U, 1.56 * U],
    [0.58 * U, 0.39 * U],
  ], 0.045 * U, warmWhite, 0.01 * U), { pos: [0, 0.09 * U, 0] });

  // Split payload doors, hinges, and bay seam.
  for (const z of [-0.27, 0.27]) {
    part(group, new THREE.BoxGeometry(1.45 * U, 0.08 * U, 0.42 * U), warmWhite,
      { pos: [-0.15 * U, 0.45 * U, z * U], rot: [z < 0 ? -0.08 : 0.08, 0, 0] });
    for (const x of [-0.72, -0.32, 0.08, 0.48]) {
      part(group, new THREE.BoxGeometry(0.07 * U, 0.035 * U, 0.07 * U), darkSteel, { pos: [x * U, 0.505 * U, z * U] });
    }
  }

  // Cockpit panes are separate, recessed pieces rather than one painted band.
  for (const [x, y, z, rz] of [
    [1.47, 0.36, -0.22, -0.32], [1.47, 0.36, 0.22, 0.32],
    [1.22, 0.43, -0.31, -0.18], [1.22, 0.43, 0.31, 0.18],
  ] as Array<[number, number, number, number]>) {
    part(group, new THREE.BoxGeometry(0.29 * U, 0.035 * U, 0.22 * U), windowMat, { pos: [x * U, y * U, z * U], rot: [0, rz, 0] });
  }

  place(group, plateXZ([
    [-0.6 * U, 0], [-1.52 * U, 0], [-1.32 * U, 0.93 * U], [-0.96 * U, 0.88 * U],
  ], 0.12 * U, white, 0.012 * U), { rot: [Math.PI / 2, 0, 0], pos: [0, 0.03 * U, -0.06 * U] });
  part(group, new THREE.BoxGeometry(0.48 * U, 0.055 * U, 0.08 * U), red, { pos: [-1.08 * U, 0.66 * U, 0], rot: [0, 0, -0.3] });

  for (const z of [-0.29, 0, 0.29]) {
    place(group, new THREE.Mesh(createEngineBell(0.14 * U, 0.5 * U), darkSteel),
      { name: `shuttle-main-engine-${z}`, rot: [0, 0, -Math.PI / 2], pos: [-1.7 * U, -0.08 * U, z * U] });
    addEngineGlow(group, -1.91 * U, -0.08 * U, z * U, 0.105 * U, engineGlow);
  }
  for (const z of [-0.46, 0.46]) {
    place(group, cylinderX(0.16 * U, 0.2 * U, 0.63 * U, 24, white), { pos: [-1.18 * U, 0.29 * U, z * U] });
  }
  return group;
}

function createSoyuz(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const foil = new THREE.MeshPhysicalMaterial({
    color: 0x8d7750, roughness: 0.72, metalness: 0.52, clearcoat: 0.08,
    emissive: 0x171107, emissiveIntensity: 0.16,
  });
  const pale = standard(0xc8c3ac, 0.78, 0.18);
  const charcoal = standard(0x31332e, 0.68, 0.3);
  const solar = standard(0x17395d, 0.36, 0.34, 0x07182b, 0.22);
  const solarGrid = standard(0x7894a3, 0.48, 0.45);
  const windowMat = standard(0x071821, 0.18, 0.22, 0x0a3146, 0.3);
  const antenna = standard(0xd9d4c4, 0.35, 0.48);

  place(group, cylinderX(0.48 * U, 0.48 * U, 1.18 * U, 28, foil), { name: 'soyuz-instrumentation-propulsion-module', pos: [-0.77 * U, 0, 0] });
  for (const x of [-1.28, -0.93, -0.58, -0.23]) {
    part(group, new THREE.TorusGeometry(0.49 * U, 0.025 * U, 8, 32), charcoal, { rot: [0, Math.PI / 2, 0], pos: [x * U, 0, 0] });
  }

  place(group, cylinderX(0.34 * U, 0.59 * U, 0.76 * U, 32, pale), { name: 'soyuz-descent-module', pos: [0.2 * U, 0, 0] });
  place(group, discX(0.59 * U, 0.08 * U, charcoal, 32), { pos: [-0.19 * U, 0, 0] });

  part(group, new THREE.SphereGeometry(0.56 * U, 36, 24), foil, { name: 'soyuz-orbital-module', scale: [1.14, 1, 1], pos: [0.96 * U, 0, 0] });
  place(group, cylinderX(0.13 * U, 0.13 * U, 0.45 * U, 20, charcoal), { pos: [1.6 * U, 0, 0] });
  part(group, new THREE.TorusGeometry(0.15 * U, 0.025 * U, 8, 24), pale, { rot: [0, Math.PI / 2, 0], pos: [1.83 * U, 0, 0] });
  for (const z of [-0.34, 0.34]) {
    place(group, cylinderX(0.095 * U, 0.095 * U, 0.035 * U, 16, windowMat), { pos: [0.98 * U, 0.25 * U, z * U], rot: [Math.PI / 2, 0, 0] });
  }

  // Four-section solar wings, with raised silver cell borders and hinges.
  for (const zSign of [-1, 1]) {
    const wing = new THREE.Group();
    wing.name = `soyuz-solar-wing-${zSign < 0 ? 'port' : 'starboard'}`;
    wing.position.set(-0.72 * U, 0, zSign * 0.5 * U);
    for (let i = 0; i < 4; i++) {
      const z = zSign * (0.25 + i * 0.5) * U;
      part(wing, new THREE.BoxGeometry(0.63 * U, 0.055 * U, 0.48 * U), solar, { pos: [0, 0, z] });
      part(wing, new THREE.BoxGeometry(0.65 * U, 0.018 * U, 0.025 * U), solarGrid, { pos: [0, 0.04 * U, z] });
      for (const dx of [-0.2, 0, 0.2]) {
        part(wing, new THREE.BoxGeometry(0.012 * U, 0.061 * U, 0.45 * U), solarGrid, { pos: [dx * U, 0.005 * U, z] });
      }
    }
    group.add(wing);
  }

  part(group, createParabolicDishGeometry(0.22 * U, 0.08 * U), antenna, { rot: [0, 0, -Math.PI / 2], pos: [-1.05 * U, 0.5 * U, 0] });
  const mastStart = new THREE.Vector3(-1.05 * U, 0.4 * U, 0);
  const mastEnd = new THREE.Vector3(-1.05 * U, 0.78 * U, 0);
  group.add(createRodBetween(mastStart, mastEnd, 0.018 * U, antenna, 8));
  for (const z of [-0.25, 0, 0.25]) {
    place(group, cylinderX(0.055 * U, 0.075 * U, 0.16 * U, 14, charcoal), { pos: [-1.45 * U, -0.18 * U, z * U] });
  }
  return group;
}

function createFalcon(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const hull = standard(0xb2afa5, 0.78, 0.2, 0x201e1a, 0.16);
  const lightHull = standard(0xcfcbc0, 0.72, 0.16, 0x24221d, 0.12);
  const dark = standard(0x343735, 0.62, 0.42);
  const rust = standard(0x874a36, 0.72, 0.22);
  const glass = standard(0x08151c, 0.16, 0.32, 0x0c3345, 0.28);
  const blue = glow(0x78c8ff, 0.92);
  const engineCore = glow(0xe5f8ff, 1);
  blue.depthWrite = false;
  engineCore.depthWrite = false;

  // A real open U-shaped planform replaces the old complete disc. Tracing the
  // outer rim into both mandibles and back through the notch means black space
  // is physically visible between them from above and below.
  const outline: Array<[number, number]> = [
    [-1.68 * U, 0], [-1.6 * U, -0.52 * U], [-1.36 * U, -0.96 * U],
    [-0.82 * U, -1.3 * U], [-0.15 * U, -1.46 * U], [0.5 * U, -1.32 * U],
    [0.86 * U, -1.08 * U], [1.9 * U, -0.92 * U], [2.02 * U, -0.52 * U],
    [1.94 * U, -0.38 * U], [0.66 * U, -0.32 * U], [0.38 * U, -0.18 * U],
    [0.38 * U, 0.18 * U], [0.66 * U, 0.32 * U], [1.94 * U, 0.38 * U],
    [2.02 * U, 0.52 * U], [1.9 * U, 0.92 * U], [0.86 * U, 1.08 * U],
    [0.5 * U, 1.32 * U], [-0.15 * U, 1.46 * U], [-0.82 * U, 1.3 * U],
    [-1.36 * U, 0.96 * U], [-1.6 * U, 0.52 * U],
  ];
  place(group, plateXZ(outline, 0.16 * U, dark, 0.018 * U), { name: 'falcon-lower-forked-hull', pos: [0, -0.14 * U, 0] });
  place(group, plateXZ(outline, 0.18 * U, hull, 0.025 * U), { name: 'falcon-forked-hull', pos: [0, -0.01 * U, 0] });

  const upperOutline: Array<[number, number]> = [
    [-1.46 * U, 0], [-1.34 * U, -0.48 * U], [-1.08 * U, -0.83 * U],
    [-0.58 * U, -1.08 * U], [0.02 * U, -1.18 * U], [0.5 * U, -1.04 * U],
    [0.75 * U, -0.82 * U], [1.75 * U, -0.73 * U], [1.79 * U, -0.48 * U],
    [0.58 * U, -0.4 * U], [0.28 * U, -0.16 * U], [0.28 * U, 0.16 * U],
    [0.58 * U, 0.4 * U], [1.79 * U, 0.48 * U], [1.75 * U, 0.73 * U],
    [0.75 * U, 0.82 * U], [0.5 * U, 1.04 * U], [0.02 * U, 1.18 * U],
    [-0.58 * U, 1.08 * U], [-1.08 * U, 0.83 * U], [-1.34 * U, 0.48 * U],
  ];
  place(group, plateXZ(upperOutline, 0.09 * U, lightHull, 0.018 * U), { name: 'falcon-upper-forked-hull', pos: [0, 0.17 * U, 0] });

  // Shallow center saucer and recessed circular machinery well. Neither
  // reaches far enough forward to refill the physical notch.
  place(group, discY(0.88 * U, 0.96 * U, 0.12 * U, lightHull, 64), { pos: [-0.42 * U, 0.25 * U, 0] });
  place(group, discY(0.31 * U, 0.34 * U, 0.035 * U, dark, 40), { pos: [-0.36 * U, 0.34 * U, 0] });
  place(group, discY(0.16 * U, 0.19 * U, 0.07 * U, hull, 28), { pos: [-0.36 * U, 0.39 * U, 0] });

  // Raised mandible armor, inset service trenches, and a dark notch bulkhead.
  const portArmorOutline: Array<[number, number]> = [
    [0.52 * U, -0.39 * U], [1.86 * U, -0.46 * U],
    [1.78 * U, -0.79 * U], [0.76 * U, -0.86 * U],
  ];
  for (const zSign of [-1, 1]) {
    // Mirroring a polygon reverses its winding. Reverse the starboard points
    // as well so ExtrudeGeometry gives both mandibles identical visible top,
    // side, bevel, and thickness geometry.
    const armorOutline: Array<[number, number]> = zSign < 0
      ? portArmorOutline
      : portArmorOutline.map(([x, z]) => [x, -z] as [number, number]).reverse();
    place(group, plateXZ(armorOutline, 0.065 * U, hull, 0.01 * U), { name: `falcon-mandible-armor-${zSign < 0 ? 'port' : 'starboard'}`, pos: [0, 0.25 * U, 0] });
    part(group, new THREE.BoxGeometry(1.12 * U, 0.035 * U, 0.16 * U), dark, { name: `falcon-mandible-trench-${zSign < 0 ? 'port' : 'starboard'}`, pos: [1.2 * U, 0.31 * U, zSign * 0.63 * U] });
    for (let i = 0; i < 7; i++) {
      const x = 0.68 + i * 0.18;
      part(group, new THREE.BoxGeometry(0.105 * U, 0.024 * U, 0.12 * U),
        i === 2 || i === 6 ? rust : i % 2 ? dark : lightHull, { pos: [x * U, 0.345 * U, zSign * 0.63 * U] });
    }
  }
  part(group, new THREE.BoxGeometry(0.12 * U, 0.16 * U, 0.34 * U), dark, { name: 'falcon-forward-notch-bulkhead', pos: [0.35 * U, 0.08 * U, 0] });

  // Starboard-offset cockpit corridor and compact multi-pane canopy. The
  // cockpit pieces come from cylinderX/discX (baked z = -π/2), so their rot
  // arrays carry that alongside the -0.1 yaw.
  place(group, cylinderX(0.145 * U, 0.19 * U, 1.08 * U, 24, hull), { name: 'falcon-offset-cockpit-boom', pos: [0.72 * U, 0.07 * U, -1.25 * U], rot: [0, -0.1, -Math.PI / 2] });
  place(group, cylinderX(0.17 * U, 0.22 * U, 0.54 * U, 24, hull), { name: 'falcon-offset-cockpit', pos: [1.38 * U, 0.07 * U, -1.38 * U], rot: [0, -0.1, -Math.PI / 2] });
  place(group, discX(0.175 * U, 0.025 * U, glass, 20), { pos: [1.66 * U, 0.07 * U, -1.41 * U], rot: [0, -0.1, -Math.PI / 2] });
  part(group, new THREE.TorusGeometry(0.185 * U, 0.018 * U, 6, 20), lightHull, { rot: [0, Math.PI / 2 - 0.1, 0], pos: [1.66 * U, 0.07 * U, -1.41 * U] });
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    group.add(createRodBetween(
      new THREE.Vector3(1.675 * U, 0.07 * U, -1.41 * U),
      new THREE.Vector3(1.675 * U, (0.07 + Math.cos(angle) * 0.16) * U, (-1.41 + Math.sin(angle) * 0.16) * U),
      0.009 * U,
      lightHull,
      6,
    ));
  }

  // Dorsal sensor dish, docking collar, and exposed conduits are deliberately
  // fine enough to read as machinery rather than oversized blocks.
  part(group, createParabolicDishGeometry(0.27 * U, 0.095 * U), lightHull, { name: 'falcon-dorsal-radar-dish', pos: [-0.56 * U, 0.47 * U, 0.4 * U], rot: [0, 0, -0.38] });
  group.add(createRodBetween(
    new THREE.Vector3(-0.56 * U, 0.31 * U, 0.4 * U),
    new THREE.Vector3(-0.56 * U, 0.5 * U, 0.4 * U),
    0.018 * U,
    dark,
    8,
  ));
  part(group, new THREE.CylinderGeometry(0.22 * U, 0.22 * U, 0.16 * U, 28), hull, { name: 'falcon-port-docking-collar', rot: [Math.PI / 2, 0, 0], pos: [-0.22 * U, 0.03 * U, 1.48 * U] });
  part(group, new THREE.TorusGeometry(0.22 * U, 0.025 * U, 8, 28), dark, { pos: [-0.22 * U, 0.03 * U, 1.57 * U] });

  // Partial rear arcs keep the surface layered without drawing full toy-like
  // concentric hoops across the forward fork.
  for (const [arcIndex, radius] of [0.52, 0.82, 1.12].entries()) {
    const arcPoints: THREE.Vector3[] = [];
    for (let i = 0; i <= 18; i++) {
      const angle = THREE.MathUtils.lerp(Math.PI * 0.56, Math.PI * 1.44, i / 18);
      arcPoints.push(new THREE.Vector3(
        (-0.36 + Math.cos(angle) * radius) * U,
        (0.345 + arcIndex * 0.008) * U,
        Math.sin(angle) * radius * U,
      ));
    }
    part(group, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arcPoints), 48, 0.014 * U, 6, false), dark,
      { name: `falcon-dorsal-trench-arc-${arcIndex + 1}` });
  }
  for (let i = 0; i < 32; i++) {
    const angle = (i / 32) * Math.PI * 2;
    const radius = (0.43 + (i % 4) * 0.16) * U;
    part(group, new THREE.BoxGeometry((i % 5 === 0 ? 0.14 : 0.095) * U, 0.022 * U, 0.055 * U),
      i % 11 === 0 ? rust : i % 3 === 0 ? lightHull : dark,
      { pos: [-0.36 * U + Math.cos(angle) * radius, 0.36 * U, Math.sin(angle) * radius], rot: [0, -angle, 0] });
  }
  for (const [index, [sx, sz, ex, ez]] of [
    [-1.05, -0.42, -0.46, -0.25], [-0.98, 0.48, -0.38, 0.26],
    [-0.2, -0.76, 0.3, -0.58], [-0.12, 0.78, 0.38, 0.58],
    [-0.7, -0.12, -0.12, -0.05], [-0.68, 0.16, -0.12, 0.07],
  ].entries()) {
    place(group, createRodBetween(
      new THREE.Vector3(sx * U, 0.38 * U, sz * U),
      new THREE.Vector3(ex * U, 0.38 * U, ez * U),
      0.011 * U,
      index % 3 === 0 ? rust : dark,
      6,
    ), { name: `falcon-dorsal-conduit-${index + 1}` });
  }

  // The drive is a recessed ARC, not a straight bar with floating bulbs. Each
  // path point lies on the saucer's real aft circle, so even the outer ends
  // remain seated inside the hull silhouette. The dark tube is offset slightly
  // forward while the luminous faces sit aft of it: this creates a visible
  // recessed blue bank with a dark border instead of hiding the light inside a
  // closed solid tube (the old geometry passed containment tests but occluded
  // the light from the chase camera).
  const engineArcPoints: THREE.Vector3[] = [];
  for (let i = 0; i <= 20; i++) {
    const z = THREE.MathUtils.lerp(-1.08, 1.08, i / 20);
    const aftX = -0.12 - Math.sqrt(1.52 * 1.52 - z * z);
    engineArcPoints.push(new THREE.Vector3(aftX * U, 0, z * U));
  }
  const engineArc = new THREE.CatmullRomCurve3(engineArcPoints);
  part(group, new THREE.TubeGeometry(engineArc, 64, 0.14 * U, 10, false), dark,
    { name: 'falcon-engine-housing', pos: [0.025 * U, 0, 0], scale: [1, 0.7, 1] });
  part(group, new THREE.TubeGeometry(engineArc, 64, 0.105 * U, 12, false), blue,
    { name: 'falcon-engine-light', emitter: true, pos: [-0.045 * U, -0.012 * U, 0], scale: [1, 0.65, 1], renderOrder: 3 });
  part(group, new THREE.TubeGeometry(engineArc, 64, 0.042 * U, 10, false), engineCore,
    { name: 'falcon-engine-hot-core', emitter: true, pos: [-0.052 * U, -0.014 * U, 0], scale: [1, 0.61, 1], renderOrder: 4 });
  return group;
}

function createEnterprise(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const pearl = new THREE.MeshPhysicalMaterial({
    color: 0xcfd5d7, roughness: 0.44, metalness: 0.28, clearcoat: 0.35, clearcoatRoughness: 0.55,
  });
  const hullDark = standard(0x56616a, 0.5, 0.46);
  const windowMat = glow(0xd6f0ff, 0.8);
  const blue = glow(0x65c8ff, 0.88);
  const red = glow(0xff523f, 0.72);

  place(group, discY(1.3 * U, 1.3 * U, 0.19 * U, pearl, 72), { name: 'enterprise-primary-saucer', pos: [0.87 * U, 0, 0] });
  part(group, new THREE.SphereGeometry(0.64 * U, 40, 18), pearl, { scale: [1, 0.19, 1], pos: [0.87 * U, 0.09 * U, 0] });
  part(group, new THREE.SphereGeometry(0.17 * U, 24, 12), pearl, { scale: [1, 0.34, 1], pos: [0.98 * U, 0.24 * U, 0] });
  part(group, new THREE.TorusGeometry(1.29 * U, 0.045 * U, 10, 72), hullDark, { rot: [Math.PI / 2, 0, 0], pos: [0.87 * U, 0, 0] });

  // Neck and secondary hull.
  place(group, plateXZ([
    [0.42 * U, -0.14 * U], [-0.45 * U, -0.22 * U], [-0.62 * U, 0.22 * U], [0.18 * U, 0.18 * U],
  ], 0.16 * U, pearl, 0.015 * U), { rot: [Math.PI / 2, 0, 0], pos: [0, -0.18 * U, 0] });
  place(group, cylinderX(0.45 * U, 0.63 * U, 1.72 * U, 36, pearl), { name: 'enterprise-secondary-hull', pos: [-0.52 * U, -0.48 * U, 0] });
  part(group, new THREE.SphereGeometry(0.52 * U, 30, 18), pearl, { scale: [1.35, 0.75, 0.8], pos: [-1.29 * U, -0.48 * U, 0] });
  place(group, discX(0.36 * U, 0.055 * U, blue, 36), { pos: [0.37 * U, -0.48 * U, 0] });
  part(group, new THREE.TorusGeometry(0.39 * U, 0.045 * U, 10, 36), hullDark, { rot: [0, Math.PI / 2, 0], pos: [0.37 * U, -0.48 * U, 0] });

  // Swept pylons and twin warp nacelles.
  for (const zSign of [-1, 1]) {
    place(group, plateXZ([
      [-1.05 * U, 0.2 * U], [-0.63 * U, zSign * 1.18 * U], [-0.27 * U, zSign * 1.22 * U],
      [-0.57 * U, 0.19 * U],
    ], 0.13 * U, pearl, 0.012 * U), { pos: [0, 0.03 * U, 0] });
    place(group, cylinderX(0.19 * U, 0.24 * U, 2.18 * U, 28, pearl), { name: `enterprise-warp-nacelle-${zSign < 0 ? 'port' : 'starboard'}`, pos: [-0.68 * U, 0.36 * U, zSign * 1.28 * U] });
    part(group, new THREE.SphereGeometry(0.245 * U, 24, 16), red, { emitter: true, scale: [0.42, 1, 1], pos: [0.43 * U, 0.36 * U, zSign * 1.28 * U] });
    part(group, new THREE.BoxGeometry(1.3 * U, 0.08 * U, 0.12 * U), blue, { emitter: true, pos: [-0.72 * U, 0.51 * U, zSign * 1.28 * U] });
    for (const x of [-1.48, -1.1, -0.72, -0.34, 0.04]) {
      part(group, new THREE.TorusGeometry(0.247 * U, 0.016 * U, 6, 24), hullDark, { rot: [0, Math.PI / 2, 0], pos: [x * U, 0.36 * U, zSign * 1.28 * U] });
    }
  }

  const saucerWindowXs = [0.15, 0.5, 0.85, 1.2, 1.55].map((x) => x * U);
  addWindows(group, saucerWindowXs, 0.02 * U, 1.24 * U, 0.045 * U, windowMat);
  addWindows(group, saucerWindowXs, 0.02 * U, -1.24 * U, 0.045 * U, windowMat);
  for (const x of [-1.2, -0.9, -0.6, -0.3]) {
    addWindows(group, [x * U], -0.25 * U, 0.43 * U, 0.035 * U, windowMat);
    addWindows(group, [x * U], -0.25 * U, -0.43 * U, 0.035 * U, windowMat);
  }
  return group;
}

function createKlingonBirdOfPrey(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const green = standard(0x52694d, 0.64, 0.42, 0x122015, 0.14);
  const darkGreen = standard(0x293a2b, 0.68, 0.48);
  const bronze = standard(0x826b3f, 0.58, 0.54, 0x261705, 0.12);
  const dark = standard(0x232928, 0.64, 0.5);
  const red = glow(0xff563f, 0.82);
  const amber = glow(0xffae43, 0.76);

  part(group, new THREE.SphereGeometry(0.48 * U, 30, 18), green, { name: 'klingon-command-head', scale: [1.35, 0.42, 0.78], pos: [1.48 * U, 0.08 * U, 0] });
  part(group, new THREE.ConeGeometry(0.28 * U, 0.72 * U, 20), bronze, { name: 'klingon-forward-beak', rot: [0, 0, -Math.PI / 2], pos: [2.12 * U, 0.02 * U, 0] });
  part(group, new THREE.SphereGeometry(0.19 * U, 20, 12), darkGreen, { scale: [1.1, 0.48, 0.72], pos: [1.38 * U, 0.38 * U, 0] });
  part(group, new THREE.BoxGeometry(1.25 * U, 0.22 * U, 0.34 * U), darkGreen, { name: 'klingon-long-neck', pos: [0.48 * U, -0.03 * U, 0] });
  part(group, new THREE.SphereGeometry(0.78 * U, 32, 18), green, { scale: [1.15, 0.5, 0.9], pos: [-0.52 * U, 0.02 * U, 0] });
  place(group, plateXZ([
    [-0.1 * U, -0.62 * U], [-1.6 * U, -0.88 * U], [-1.92 * U, 0],
    [-1.6 * U, 0.88 * U], [-0.1 * U, 0.62 * U],
  ], 0.2 * U, darkGreen, 0.025 * U), { pos: [0, -0.1 * U, 0] });

  for (const zSign of [-1, 1]) {
    const wingAssembly = new THREE.Group();
    wingAssembly.name = `klingon-swept-wing-${zSign < 0 ? 'port' : 'starboard'}`;
    // The K'vort/B'rel family can articulate its wings. A shallow attack-mode
    // droop makes the bird silhouette unmistakable without hiding the dorsal
    // feather plating from the chase camera.
    wingAssembly.rotation.x = zSign * 0.14;
    group.add(wingAssembly);
    place(wingAssembly, plateXZ([
      [-0.2 * U, zSign * 0.36 * U], [-0.72 * U, zSign * 1.72 * U],
      [-1.58 * U, zSign * 1.95 * U], [-1.32 * U, zSign * 0.58 * U],
    ], 0.16 * U, green, 0.025 * U), { pos: [0, -0.05 * U, 0] });
    wingAssembly.add(createRodBetween(
      new THREE.Vector3(-0.2 * U, 0.05 * U, zSign * 0.36 * U),
      new THREE.Vector3(-0.72 * U, 0.05 * U, zSign * 1.72 * U),
      0.055 * U,
      bronze,
      8,
    ));
    place(wingAssembly, cylinderX(0.14 * U, 0.19 * U, 0.72 * U, 18, dark), { pos: [-1.3 * U, 0, zSign * 1.86 * U] });
    place(wingAssembly, cylinderX(0.045 * U, 0.075 * U, 1.05 * U, 12, bronze), { name: `klingon-wingtip-cannon-${zSign < 0 ? 'port' : 'starboard'}`, pos: [-0.5 * U, -0.04 * U, zSign * 1.84 * U] });
    part(wingAssembly, new THREE.SphereGeometry(0.075 * U, 12, 8), red, { pos: [0.04 * U, -0.04 * U, zSign * 1.84 * U] });
    for (let i = 0; i < 6; i++) {
      part(wingAssembly, new THREE.BoxGeometry(0.46 * U, 0.035 * U, 0.2 * U), i % 2 ? darkGreen : bronze,
        { pos: [(-0.5 - i * 0.14) * U, 0.07 * U, zSign * (0.62 + i * 0.19) * U], rot: [0, zSign * -0.38, 0] });
    }
    addEngineGlow(wingAssembly, -1.92 * U, 0, zSign * 0.54 * U, 0.16 * U, amber);
  }
  for (const z of [-0.28, 0, 0.28]) {
    part(group, new THREE.BoxGeometry(0.36 * U, 0.07 * U, 0.12 * U), dark, { pos: [-1.28 * U, 0.3 * U, z * U] });
  }
  return group;
}

function createFlyingSaucer(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const alloy = new THREE.MeshPhysicalMaterial({
    color: 0x8d9a9e, roughness: 0.24, metalness: 0.9, clearcoat: 0.52, clearcoatRoughness: 0.24,
  });
  const dark = standard(0x1d272a, 0.36, 0.76);
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x66b9cf, roughness: 0.08, metalness: 0.08, transmission: 0.28,
    transparent: true, opacity: 0.82, emissive: 0x123c4e, emissiveIntensity: 0.45,
  });
  const cyan = glow(0x65efff, 0.72);
  const amber = glow(0xffb24d, 0.85);

  group.add(discY(1.7 * U, 1.7 * U, 0.21 * U, alloy, 72));
  part(group, new THREE.SphereGeometry(1.48 * U, 56, 22), alloy, { scale: [1, 0.19, 1], pos: [0, 0.12 * U, 0] });
  part(group, new THREE.SphereGeometry(1.28 * U, 48, 20), dark, { scale: [1, 0.16, 1], pos: [0, -0.14 * U, 0] });
  part(group, new THREE.SphereGeometry(0.67 * U, 40, 22, 0, Math.PI * 2, 0, Math.PI / 2), glass, { scale: [1.18, 0.76, 1], pos: [0, 0.18 * U, 0] });
  part(group, new THREE.TorusGeometry(0.73 * U, 0.055 * U, 10, 48), dark, { rot: [Math.PI / 2, 0, 0], pos: [0, 0.18 * U, 0] });

  for (const radius of [0.92, 1.28, 1.62]) {
    part(group, new THREE.TorusGeometry(radius * U, 0.025 * U, 8, 64), dark, { rot: [Math.PI / 2, 0, 0], pos: [0, radius === 1.62 ? 0 : 0.24 * U, 0] });
  }
  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * Math.PI * 2;
    part(group, new THREE.SphereGeometry(0.055 * U, 12, 8), i % 3 === 0 ? amber : cyan,
      { scale: [1, 0.4, 1], pos: [Math.cos(angle) * 1.38 * U, -0.23 * U, Math.sin(angle) * 1.38 * U] });
  }
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    part(group, new THREE.BoxGeometry(0.28 * U, 0.055 * U, 0.09 * U), dark,
      { pos: [Math.cos(angle) * 1.08 * U, 0.28 * U, Math.sin(angle) * 1.08 * U], rot: [0, -angle, 0] });
  }
  part(group, new THREE.CylinderGeometry(0.42 * U, 0.15 * U, 0.35 * U, 32, 1, true), cyan, { emitter: true, pos: [0, -0.31 * U, 0] });
  return group;
}

function createStarship(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const steel = new THREE.MeshPhysicalMaterial({
    color: 0xcbd3d5, roughness: 0.42, metalness: 0.72, clearcoat: 0.22, clearcoatRoughness: 0.38,
    emissive: 0x26343a, emissiveIntensity: 0.2,
  });
  const heatShield = standard(0x242728, 0.86, 0.16, 0x281511, 0.18);
  const darkSteel = standard(0x444b4d, 0.48, 0.72);
  const engineGlow = glow(0x9fdcff, 0.82);

  place(group, cylinderX(0.48 * U, 0.48 * U, 2.72 * U, 48, steel), { name: 'starship-stainless-hull', pos: [-0.28 * U, 0, 0] });
  part(group, new THREE.CylinderGeometry(0.492 * U, 0.492 * U, 2.72 * U, 48, 1, true, 0, Math.PI), heatShield, { rot: [0, 0, -Math.PI / 2], pos: [-0.28 * U, 0, 0] });
  part(group, new THREE.ConeGeometry(0.48 * U, 1.3 * U, 48), steel, { rot: [0, 0, -Math.PI / 2], pos: [1.73 * U, 0, 0] });
  part(group, new THREE.ConeGeometry(0.492 * U, 1.3 * U, 48, 1, true, 0, Math.PI), heatShield, { rot: [0, 0, -Math.PI / 2], pos: [1.73 * U, 0, 0] });
  place(group, cylinderX(0.53 * U, 0.48 * U, 0.46 * U, 48, steel), { pos: [-1.85 * U, 0, 0] });
  part(group, new THREE.CylinderGeometry(0.542 * U, 0.492 * U, 0.46 * U, 48, 1, true, 0, Math.PI), heatShield, { rot: [0, 0, -Math.PI / 2], pos: [-1.85 * U, 0, 0] });

  // Belly heat-shield shell plus overlapping faceted strips: the shell keeps
  // the windward half continuous through the nose while the strips break up
  // the surface into readable tile bands at chase-camera scale.
  for (let i = 0; i < 13; i++) {
    const x = (-1.5 + i * 0.25) * U;
    part(group, new THREE.BoxGeometry(0.21 * U, 0.035 * U, 0.58 * U), heatShield,
      { pos: [x, -0.465 * U, 0], rot: [0, i % 2 ? 0.018 : -0.018, 0] });
  }
  for (const x of [-1.45, -0.9, -0.35, 0.2, 0.75]) {
    part(group, new THREE.TorusGeometry(0.485 * U, 0.012 * U, 6, 40), darkSteel, { rot: [0, Math.PI / 2, 0], pos: [x * U, 0, 0] });
  }

  for (const zSign of [-1, 1]) {
    const side = zSign < 0 ? 'port' : 'starboard';
    place(group, plateXZ([
      [1.35 * U, zSign * 0.34 * U], [0.78 * U, zSign * 0.93 * U],
      [0.36 * U, zSign * 0.82 * U], [0.62 * U, zSign * 0.36 * U],
    ], 0.09 * U, heatShield, 0.012 * U), { name: `starship-forward-flap-${side}`, pos: [0, -0.03 * U, 0] });
    place(group, plateXZ([
      [-1.35 * U, zSign * 0.36 * U], [-1.92 * U, zSign * 1.0 * U],
      [-2.13 * U, zSign * 0.83 * U], [-1.75 * U, zSign * 0.34 * U],
    ], 0.11 * U, heatShield, 0.015 * U), { name: `starship-aft-flap-${side}`, pos: [0, -0.02 * U, 0] });
  }

  // Six Raptors: three compact sea-level engines in the center and three
  // larger vacuum bells around them. Keeping the two rings distinct is the
  // characteristic Starship aft view (and avoids the old seven-engine cluster).
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2 + Math.PI / 2;
    const y = Math.cos(angle) * 0.16 * U;
    const z = Math.sin(angle) * 0.16 * U;
    place(group, cylinderX(0.07 * U, 0.105 * U, 0.25 * U, 18, darkSteel), { name: `starship-sea-level-engine-${i + 1}`, pos: [-2.18 * U, y, z] });
    addEngineGlow(group, -2.315 * U, y, z, 0.066 * U, engineGlow);
  }
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2 - Math.PI / 2;
    const y = Math.cos(angle) * 0.34 * U;
    const z = Math.sin(angle) * 0.34 * U;
    place(group, cylinderX(0.105 * U, 0.17 * U, 0.31 * U, 22, darkSteel), { name: `starship-vacuum-engine-${i + 1}`, pos: [-2.2 * U, y, z] });
    addEngineGlow(group, -2.37 * U, y, z, 0.105 * U, engineGlow);
  }
  return group;
}

function createDragon(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const ceramic = new THREE.MeshPhysicalMaterial({
    color: 0xe5e8e6, roughness: 0.62, metalness: 0.08, clearcoat: 0.18, clearcoatRoughness: 0.58,
  });
  const trunkMetal = standard(0x7e8888, 0.48, 0.68);
  const solar = standard(0x18374b, 0.38, 0.42, 0x071823, 0.18);
  const black = standard(0x1d2222, 0.78, 0.22);
  const blue = standard(0x286fa1, 0.54, 0.18);
  const glass = standard(0x07161e, 0.14, 0.24, 0x164057, 0.34);
  const engineGlow = glow(0xa9dcff, 0.82);

  place(group, cylinderX(0.47 * U, 0.69 * U, 1.32 * U, 48, ceramic), { name: 'dragon-crew-capsule', pos: [0.4 * U, 0, 0] });
  part(group, new THREE.SphereGeometry(0.48 * U, 36, 20), ceramic, { scale: [0.52, 1, 1], pos: [1.08 * U, 0, 0] });
  place(group, discX(0.69 * U, 0.1 * U, black, 48), { pos: [-0.3 * U, 0, 0] });
  place(group, cylinderX(0.22 * U, 0.22 * U, 0.2 * U, 28, trunkMetal), { pos: [1.35 * U, 0, 0] });
  part(group, new THREE.TorusGeometry(0.235 * U, 0.035 * U, 8, 28), ceramic, { rot: [0, Math.PI / 2, 0], pos: [1.46 * U, 0, 0] });

  // Four inset cabin windows and the characteristic blue waist markings.
  for (const [y, z] of [[0.34, -0.28], [0.34, 0.28], [0.16, -0.48], [0.16, 0.48]]) {
    part(group, new THREE.BoxGeometry(0.18 * U, 0.14 * U, 0.13 * U), glass, { pos: [0.83 * U, y * U, z * U] });
  }
  for (const zSign of [-1, 1]) {
    part(group, new THREE.BoxGeometry(0.65 * U, 0.035 * U, 0.08 * U), blue, { pos: [0.35 * U, 0.57 * U, zSign * 0.27 * U] });
  }

  // Trunk with dark-blue solar-cell facets and a silver structural grid.
  place(group, cylinderX(0.7 * U, 0.7 * U, 1.22 * U, 32, trunkMetal), { name: 'dragon-unpressurized-trunk', pos: [-0.96 * U, 0, 0] });
  // The flight vehicle does not have deployable solar wings: cells cover one
  // half of Dragon's trunk. Six flush facets keep that exact half-and-half
  // treatment readable while leaving the opposite metallic side exposed.
  for (let i = 0; i < 6; i++) {
    const angle = -Math.PI / 2 + ((i + 0.5) / 6) * Math.PI;
    part(group, new THREE.BoxGeometry(0.8 * U, 0.38 * U, 0.025 * U), solar, {
      name: `dragon-trunk-solar-facet-${i + 1}`,
      pos: [-0.96 * U, Math.cos(angle) * 0.67 * U, Math.sin(angle) * 0.67 * U],
      rot: [angle - Math.PI / 2, 0, 0],
    });
  }
  for (const x of [-1.45, -1.0, -0.51]) {
    part(group, new THREE.TorusGeometry(0.705 * U, 0.025 * U, 7, 32), trunkMetal, { rot: [0, Math.PI / 2, 0], pos: [x * U, 0, 0] });
  }

  // SuperDraco pairs sit flush in black pods around the capsule shoulder.
  for (const ySign of [-1, 1]) {
    for (const zSign of [-1, 1]) {
      part(group, new THREE.SphereGeometry(0.14 * U, 18, 12), black, { scale: [1.35, 0.7, 0.7], pos: [0.18 * U, ySign * 0.5 * U, zSign * 0.35 * U] });
      addEngineGlow(group, 0.1 * U, ySign * 0.5 * U, zSign * 0.35 * U, 0.045 * U, engineGlow);
    }
  }
  return group;
}

function createOrion(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const capsule = standard(0xd8dbd6, 0.7, 0.18, 0x252a29, 0.08);
  const service = standard(0x8b9290, 0.56, 0.62);
  const dark = standard(0x292d2e, 0.72, 0.34);
  const solar = standard(0x173e62, 0.42, 0.36, 0x071a2a, 0.18);
  const glass = standard(0x071820, 0.16, 0.24, 0x173d4d, 0.3);
  const white = standard(0xe7e9e3, 0.68, 0.12);
  const engineGlow = glow(0x9fd8ff, 0.74);

  place(group, cylinderX(0.35 * U, 0.72 * U, 1.0 * U, 48, capsule), { name: 'orion-crew-module', pos: [0.85 * U, 0, 0] });
  place(group, discX(0.73 * U, 0.1 * U, dark, 48), { pos: [0.32 * U, 0, 0] });
  place(group, cylinderX(0.23 * U, 0.23 * U, 0.22 * U, 28, service), { pos: [1.46 * U, 0, 0] });
  part(group, new THREE.TorusGeometry(0.24 * U, 0.035 * U, 8, 28), white, { rot: [0, Math.PI / 2, 0], pos: [1.58 * U, 0, 0] });

  for (const z of [-0.34, 0, 0.34]) {
    part(group, new THREE.BoxGeometry(0.08 * U, 0.15 * U, 0.16 * U), glass, { pos: [1.08 * U, 0.31 * U, z * U] });
  }

  place(group, cylinderX(0.68 * U, 0.68 * U, 1.18 * U, 36, service), { name: 'orion-european-service-module', pos: [-0.34 * U, 0, 0] });
  for (const x of [-0.7, -0.25, 0.12]) {
    part(group, new THREE.TorusGeometry(0.69 * U, 0.02 * U, 6, 36), dark, { rot: [0, Math.PI / 2, 0], pos: [x * U, 0, 0] });
  }
  place(group, cylinderX(0.13 * U, 0.25 * U, 0.42 * U, 24, dark), { pos: [-1.13 * U, 0, 0] });
  addEngineGlow(group, -1.36 * U, 0, 0, 0.13 * U, engineGlow);

  // Orion's four three-panel solar-array wings form the characteristic cross.
  for (const axis of ['y', 'z'] as const) {
    for (const sign of [-1, 1]) {
      const strutEnd = new THREE.Vector3(-0.35 * U, 0, 0);
      strutEnd[axis] = sign * 0.86 * U;
      place(group, createRodBetween(new THREE.Vector3(-0.35 * U, 0, 0), strutEnd, 0.035 * U, service, 8),
        { name: `orion-solar-boom-${axis}-${sign}` });
      for (let panelIndex = 0; panelIndex < 3; panelIndex++) {
        const along = sign * (0.88 + panelIndex * 0.46) * U;
        part(group, new THREE.BoxGeometry(
          0.05 * U,
          axis === 'y' ? 0.43 * U : 0.34 * U,
          axis === 'z' ? 0.43 * U : 0.34 * U,
        ), solar, {
          name: `orion-solar-panel-${axis}-${sign}-${panelIndex + 1}`,
          pos: axis === 'y' ? [-0.35 * U, along, 0] : [-0.35 * U, 0, along],
        });
      }
    }
  }
  return group;
}

function createStarliner(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const white = standard(0xe1e2dd, 0.68, 0.16, 0x242726, 0.08);
  const gray = standard(0x777e7d, 0.58, 0.5);
  const black = standard(0x25292a, 0.8, 0.24);
  const blue = standard(0x1a5f8c, 0.48, 0.28, 0x092033, 0.16);
  const solar = standard(0x163954, 0.4, 0.42, 0x071725, 0.18);
  const glass = standard(0x07171e, 0.14, 0.26, 0x164052, 0.3);
  const engineGlow = glow(0x83caff, 0.72);

  place(group, cylinderX(0.42 * U, 0.82 * U, 1.02 * U, 48, white), { name: 'starliner-crew-capsule', pos: [0.62 * U, 0, 0] });
  part(group, new THREE.SphereGeometry(0.43 * U, 36, 18), white, { scale: [0.38, 1, 1], pos: [1.2 * U, 0, 0] });
  place(group, cylinderX(0.25 * U, 0.25 * U, 0.22 * U, 28, gray), { pos: [1.42 * U, 0, 0] });
  part(group, new THREE.TorusGeometry(0.27 * U, 0.035 * U, 8, 28), white, { rot: [0, Math.PI / 2, 0], pos: [1.54 * U, 0, 0] });
  for (const [y, z] of [[0.34, -0.32], [0.34, 0.32], [0.13, -0.58], [0.13, 0.58]]) {
    part(group, new THREE.BoxGeometry(0.12 * U, 0.14 * U, 0.14 * U), glass, { pos: [0.93 * U, y * U, z * U] });
  }
  for (const zSign of [-1, 1]) {
    part(group, new THREE.BoxGeometry(0.6 * U, 0.045 * U, 0.08 * U), blue, { pos: [0.55 * U, 0.65 * U, zSign * 0.28 * U] });
  }

  place(group, cylinderX(0.84 * U, 0.84 * U, 0.66 * U, 40, gray), { name: 'starliner-service-module', pos: [-0.22 * U, 0, 0] });
  place(group, discX(0.85 * U, 0.08 * U, black, 40), { pos: [-0.59 * U, 0, 0] });
  // Starliner's cells sit on the service module's aft face rather than wings.
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    part(group, new THREE.BoxGeometry(0.035 * U, 0.28 * U, 0.18 * U), solar, {
      name: `starliner-aft-solar-cell-${i + 1}`,
      pos: [-0.64 * U, Math.cos(angle) * 0.57 * U, Math.sin(angle) * 0.57 * U],
      rot: [angle, 0, 0],
    });
  }
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    place(group, cylinderX(0.045 * U, 0.07 * U, 0.18 * U, 12, black), { pos: [-0.69 * U, Math.cos(angle) * 0.7 * U, Math.sin(angle) * 0.7 * U] });
    addEngineGlow(group, -0.79 * U, Math.cos(angle) * 0.7 * U, Math.sin(angle) * 0.7 * U, 0.04 * U, engineGlow);
  }
  // Starliner is physically compact; a uniform display-scale adjustment keeps
  // its researched proportions while matching the fleet's chase-view envelope.
  group.scale.setScalar(1.12);
  return group;
}

function createDreamChaser(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const white = standard(0xd9dcda, 0.66, 0.18, 0x242827, 0.08);
  const tile = standard(0x242829, 0.84, 0.18);
  const dark = standard(0x465052, 0.58, 0.52);
  const orange = standard(0xc25f20, 0.66, 0.24, 0x2d1205, 0.14);
  const glass = standard(0x071820, 0.13, 0.28, 0x164357, 0.34);
  const engineGlow = glow(0x86cfff, 0.78);

  const planform: Array<[number, number]> = [
    [2.05 * U, 0], [1.1 * U, -0.54 * U], [-0.55 * U, -1.25 * U],
    [-1.36 * U, -1.08 * U], [-1.12 * U, -0.38 * U], [-1.52 * U, -0.28 * U],
    [-1.52 * U, 0.28 * U], [-1.12 * U, 0.38 * U], [-1.36 * U, 1.08 * U],
    [-0.55 * U, 1.25 * U], [1.1 * U, 0.54 * U],
  ];
  place(group, plateXZ(planform, 0.22 * U, tile, 0.025 * U), { name: 'dream-chaser-lifting-body', pos: [0, -0.12 * U, 0] });
  place(group, plateXZ(planform.map(([x, z]) => [x * 0.92, z * 0.86]), 0.24 * U, white, 0.035 * U), { pos: [0, 0.04 * U, 0] });
  part(group, new THREE.SphereGeometry(0.48 * U, 28, 16), glass, { name: 'dream-chaser-cockpit', scale: [1.45, 0.42, 0.7], pos: [1.02 * U, 0.33 * U, 0] });
  part(group, new THREE.SphereGeometry(0.35 * U, 24, 14), tile, { scale: [1.4, 0.35, 0.62], pos: [1.72 * U, -0.08 * U, 0] });

  for (const zSign of [-1, 1]) {
    place(group, plateXZ([
      [-1.24 * U, -0.04 * U], [-0.5 * U, -0.04 * U],
      [-0.9 * U, 0.78 * U], [-1.38 * U, 0.48 * U],
    ], 0.08 * U, white, 0.012 * U), {
      name: `dream-chaser-tail-${zSign < 0 ? 'port' : 'starboard'}`,
      rot: [zSign * Math.PI / 2, 0, 0], pos: [0, 0.16 * U, zSign * 0.58 * U],
    });
    group.add(createRodBetween(
      new THREE.Vector3(1.0 * U, 0.2 * U, zSign * 0.48 * U),
      new THREE.Vector3(-1.18 * U, 0.18 * U, zSign * 1.02 * U),
      0.035 * U,
      orange,
      8,
    ));
    place(group, cylinderX(0.12 * U, 0.16 * U, 0.34 * U, 18, dark), { pos: [-1.42 * U, 0.02 * U, zSign * 0.36 * U] });
    addEngineGlow(group, -1.61 * U, 0.02 * U, zSign * 0.36 * U, 0.1 * U, engineGlow);
    for (let i = 0; i < 6; i++) {
      part(group, new THREE.BoxGeometry(0.24 * U, 0.035 * U, 0.2 * U), i % 2 ? dark : tile,
        { pos: [(0.65 - i * 0.31) * U, 0.2 * U, zSign * (0.3 + i * 0.1) * U], rot: [0, zSign * 0.16, 0] });
    }
  }
  part(group, new THREE.BoxGeometry(1.3 * U, 0.04 * U, 0.32 * U), orange, { pos: [-0.1 * U, 0.28 * U, 0] });
  return group;
}

function createXWing(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const ivory = standard(0xc7c6b8, 0.72, 0.18);
  const panel = standard(0xddd9c8, 0.66, 0.14);
  const dark = standard(0x303536, 0.58, 0.5);
  const red = standard(0x9c3128, 0.68, 0.18);
  const glass = standard(0x10191c, 0.16, 0.35, 0x173a43, 0.25);
  const pinkGlow = glow(0xff6670, 0.88);
  const blueGlow = glow(0x8bd1ff, 0.78);

  place(group, cylinderX(0.3 * U, 0.42 * U, 2.05 * U, 24, ivory), { name: 'x-wing-fuselage', pos: [0.2 * U, 0, 0] });
  part(group, new THREE.ConeGeometry(0.3 * U, 1.15 * U, 28), ivory, { rot: [0, 0, -Math.PI / 2], pos: [1.8 * U, 0, 0] });
  part(group, new THREE.ConeGeometry(0.305 * U, 0.35 * U, 28, 1, true), red, { rot: [0, 0, -Math.PI / 2], pos: [1.4 * U, 0, 0] });
  part(group, new THREE.SphereGeometry(0.35 * U, 24, 14), glass, { scale: [1.25, 0.55, 0.78], pos: [0.48 * U, 0.33 * U, 0] });
  part(group, new THREE.SphereGeometry(0.17 * U, 20, 12), panel, { scale: [1, 0.72, 1], pos: [-0.28 * U, 0.39 * U, 0] });

  for (const ySign of [-1, 1]) {
    for (const zSign of [-1, 1]) {
      const wx = ySign * zSign * 0.19;
      part(group, new THREE.BoxGeometry(1.48 * U, 0.07 * U, 1.12 * U), panel, {
        name: `x-wing-s-foil-${ySign < 0 ? 'lower' : 'upper'}-${zSign < 0 ? 'port' : 'starboard'}`,
        pos: [-0.25 * U, ySign * 0.38 * U, zSign * 0.63 * U], rot: [wx, 0, 0],
      });
      part(group, new THREE.BoxGeometry(0.62 * U, 0.075 * U, 0.25 * U), red, { pos: [0.12 * U, ySign * 0.42 * U, zSign * 0.73 * U], rot: [wx, 0, 0] });

      place(group, cylinderX(0.17 * U, 0.2 * U, 0.78 * U, 20, dark), { pos: [-0.5 * U, ySign * 0.44 * U, zSign * 0.64 * U] });
      addEngineGlow(group, -0.91 * U, ySign * 0.44 * U, zSign * 0.64 * U, 0.12 * U, blueGlow);

      const cannonEnd = new THREE.Vector3(1.65 * U, ySign * 0.48 * U, zSign * 1.17 * U);
      group.add(createRodBetween(new THREE.Vector3(0.05 * U, ySign * 0.44 * U, zSign * 1.17 * U), cannonEnd, 0.028 * U, dark, 8));
      part(group, new THREE.SphereGeometry(0.055 * U, 12, 8), pinkGlow, { pos: [cannonEnd.x, cannonEnd.y, cannonEnd.z] });
    }
  }
  return group;
}

function createTieFighter(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const frame = standard(0x87949a, 0.5, 0.56);
  const darkFrame = standard(0x2f393d, 0.52, 0.62);
  const solar = standard(0x18242a, 0.52, 0.38, 0x0b151a, 0.15);
  const glass = standard(0x071317, 0.14, 0.3, 0x163740, 0.3);
  const green = glow(0x62ff8b, 0.82);
  const red = glow(0xff5e54, 0.74);

  part(group, new THREE.SphereGeometry(0.64 * U, 32, 22), frame, { name: 'tie-spherical-cockpit', scale: [1.08, 1, 1] });
  place(group, cylinderX(0.36 * U, 0.42 * U, 0.08 * U, 12, glass), { pos: [0.66 * U, 0, 0] });
  part(group, new THREE.TorusGeometry(0.41 * U, 0.04 * U, 8, 12), darkFrame, { rot: [0, Math.PI / 2, 0], pos: [0.71 * U, 0, 0] });
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    group.add(createRodBetween(
      new THREE.Vector3(0.72 * U, Math.cos(angle) * 0.08 * U, Math.sin(angle) * 0.08 * U),
      new THREE.Vector3(0.72 * U, Math.cos(angle) * 0.38 * U, Math.sin(angle) * 0.38 * U),
      0.018 * U,
      darkFrame,
      6,
    ));
  }

  for (const zSign of [-1, 1]) {
    group.add(createRodBetween(
      new THREE.Vector3(0, 0, zSign * 0.48 * U),
      new THREE.Vector3(0, 0, zSign * 1.18 * U),
      0.12 * U,
      frame,
      10,
    ));
    part(group, new THREE.SphereGeometry(0.19 * U, 16, 12), darkFrame, { pos: [0, 0, zSign * 1.18 * U] });

    // Six-sided solar wing, vertical in X/Y with a metallic perimeter.
    part(group, new THREE.CylinderGeometry(1.22 * U, 1.22 * U, 0.1 * U, 6), solar, {
      name: `tie-hexagonal-solar-wing-${zSign < 0 ? 'port' : 'starboard'}`,
      rot: [Math.PI / 2, 0, 0], pos: [0, 0, zSign * 1.42 * U],
    });
    part(group, new THREE.TorusGeometry(1.08 * U, 0.055 * U, 8, 6), frame, { pos: [0, 0, zSign * 1.48 * U] });
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      group.add(createRodBetween(
        new THREE.Vector3(0, 0, zSign * 1.49 * U),
        new THREE.Vector3(Math.cos(angle) * 1.02 * U, Math.sin(angle) * 1.02 * U, zSign * 1.49 * U),
        0.025 * U,
        frame,
        6,
      ));
    }
  }
  for (const z of [-0.22, 0.22]) {
    addEngineGlow(group, -0.64 * U, 0, z * U, 0.08 * U, red);
    place(group, cylinderX(0.045 * U, 0.055 * U, 0.5 * U, 12, darkFrame), { pos: [0.55 * U, -0.32 * U, z * U] });
    part(group, new THREE.SphereGeometry(0.045 * U, 10, 8), green, { pos: [0.82 * U, -0.32 * U, z * U] });
  }
  return group;
}

function createStarDestroyer(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const hull = standard(0xb8b8ae, 0.78, 0.2);
  const lightHull = standard(0xd0d0c4, 0.72, 0.16);
  const trench = standard(0x424643, 0.62, 0.5);
  const window = glow(0xcbe8ff, 0.68);
  const engineGlow = glow(0x88c9ff, 0.9);

  place(group, plateXZ([
    [2.35 * U, 0], [-1.5 * U, -1.42 * U], [-1.5 * U, 1.42 * U],
  ], 0.24 * U, hull, 0.02 * U), { name: 'star-destroyer-dagger-wedge', pos: [0, 0.12 * U, 0] });
  place(group, plateXZ([
    [2.15 * U, 0], [-1.48 * U, -1.24 * U], [-1.48 * U, 1.24 * U],
  ], 0.32 * U, trench, 0.015 * U), { pos: [0, -0.19 * U, 0] });

  // Layered dorsal city, command tower, shield domes, and bridge slit.
  const cityBlocks: Array<[number, number, number, number, number]> = [
    [-0.35, 0.34, 0, 1.3, 0.72], [-0.58, 0.5, 0, 0.86, 0.5],
    [-0.84, 0.67, 0, 0.5, 0.38], [0.16, 0.28, 0, 0.75, 0.46],
  ];
  for (const [x, y, z, length, width] of cityBlocks) {
    part(group, new THREE.BoxGeometry(length * U, 0.2 * U, width * U), lightHull, { pos: [x * U, y * U, z * U] });
  }
  part(group, new THREE.BoxGeometry(0.38 * U, 0.72 * U, 0.48 * U), hull, { name: 'star-destroyer-command-tower', pos: [-0.83 * U, 0.9 * U, 0] });
  part(group, new THREE.BoxGeometry(0.28 * U, 0.18 * U, 1.05 * U), lightHull, { pos: [-0.78 * U, 1.22 * U, 0] });
  part(group, new THREE.BoxGeometry(0.03 * U, 0.055 * U, 0.82 * U), window, { pos: [-0.63 * U, 1.22 * U, 0] });
  for (const z of [-0.34, 0.34]) {
    part(group, new THREE.SphereGeometry(0.16 * U, 20, 12), lightHull, { pos: [-0.78 * U, 1.42 * U, z * U] });
  }

  // Surface trenches and turbolaser batteries carry detail to chase distance.
  for (const zSign of [-1, 1]) {
    for (const x of [-0.9, -0.45, 0, 0.45, 0.9]) {
      part(group, new THREE.BoxGeometry(0.32 * U, 0.035 * U, 0.055 * U), trench,
        { pos: [x * U, 0.28 * U, zSign * (0.38 + (0.9 - x) * 0.15) * U], rot: [0, zSign * -0.22, 0] });
      part(group, new THREE.BoxGeometry(0.12 * U, 0.1 * U, 0.16 * U), lightHull, { pos: [x * U, 0.36 * U, zSign * (0.32 + (0.9 - x) * 0.12) * U] });
    }
  }

  // The ventral launch bay is the most important underside landmark.
  part(group, new THREE.BoxGeometry(0.82 * U, 0.055 * U, 0.34 * U), trench, { name: 'star-destroyer-ventral-hangar', pos: [-0.18 * U, -0.42 * U, 0] });

  // Three large primary thrusters flanked by four smaller auxiliaries.
  for (const [index, z] of [-0.36, 0, 0.36].entries()) {
    place(group, cylinderX(0.14 * U, 0.205 * U, 0.28 * U, 20, trench), { name: `star-destroyer-main-engine-${index + 1}`, pos: [-1.58 * U, -0.02 * U, z * U] });
    addEngineGlow(group, -1.73 * U, -0.02 * U, z * U, 0.135 * U, engineGlow);
  }
  const auxiliaryEngines: Array<[number, number]> = [[0.22, -0.2], [0.22, 0.2], [-0.22, -0.2], [-0.22, 0.2]];
  for (const [index, [y, z]] of auxiliaryEngines.entries()) {
    place(group, cylinderX(0.065 * U, 0.1 * U, 0.18 * U, 16, trench), { name: `star-destroyer-aux-engine-${index + 1}`, pos: [-1.54 * U, y * U, z * U] });
    addEngineGlow(group, -1.64 * U, y * U, z * U, 0.06 * U, engineGlow);
  }
  return group;
}

function createApollo(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const capsuleMetal = new THREE.MeshPhysicalMaterial({
    color: 0xb7b2a6, roughness: 0.5, metalness: 0.72, clearcoat: 0.12, clearcoatRoughness: 0.5,
  });
  const serviceWhite = standard(0xd5d5ce, 0.7, 0.16);
  const dark = standard(0x343737, 0.58, 0.5);
  const foil = standard(0xb8913d, 0.5, 0.72, 0x241a07, 0.16);
  const glass = standard(0x08171e, 0.16, 0.26, 0x133848, 0.28);
  const antenna = standard(0xdeddd3, 0.36, 0.48);
  const engineGlow = glow(0x9fd6ff, 0.78);

  part(group, new THREE.ConeGeometry(0.68 * U, 1.25 * U, 40), capsuleMetal, { name: 'apollo-command-module', rot: [0, 0, -Math.PI / 2], pos: [0.68 * U, 0, 0] });
  place(group, discX(0.69 * U, 0.1 * U, dark, 40), { pos: [0.03 * U, 0, 0] });
  place(group, cylinderX(0.15 * U, 0.15 * U, 0.32 * U, 20, dark), { pos: [1.46 * U, 0, 0] });
  part(group, new THREE.TorusGeometry(0.17 * U, 0.025 * U, 8, 24), antenna, { rot: [0, Math.PI / 2, 0], pos: [1.63 * U, 0, 0] });

  for (const zSign of [-1, 1]) {
    part(group, new THREE.BoxGeometry(0.18 * U, 0.15 * U, 0.12 * U), glass, { pos: [0.75 * U, 0.3 * U, zSign * 0.34 * U], rot: [0, zSign * 0.28, 0] });
  }
  part(group, new THREE.BoxGeometry(0.3 * U, 0.03 * U, 0.34 * U), dark, { pos: [0.5 * U, 0.53 * U, 0] });

  place(group, cylinderX(0.67 * U, 0.67 * U, 1.5 * U, 32, serviceWhite), { name: 'apollo-service-module', pos: [-0.75 * U, 0, 0] });
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    part(group, new THREE.BoxGeometry(0.9 * U, 0.38 * U, 0.035 * U), i % 2 ? foil : dark,
      { pos: [-0.73 * U, Math.cos(angle) * 0.65 * U, Math.sin(angle) * 0.65 * U], rot: [angle, 0, 0] });
  }
  for (const x of [-1.38, -0.75, -0.12]) {
    part(group, new THREE.TorusGeometry(0.68 * U, 0.025 * U, 7, 32), dark, { rot: [0, Math.PI / 2, 0], pos: [x * U, 0, 0] });
  }

  // Four RCS quads and the large SPS engine bell.
  for (const ySign of [-1, 1]) {
    for (const zSign of [-1, 1]) {
      part(group, new THREE.BoxGeometry(0.18 * U, 0.14 * U, 0.14 * U), dark, { pos: [-0.2 * U, ySign * 0.6 * U, zSign * 0.28 * U] });
      for (const xOffset of [-0.04, 0.04]) {
        place(group, cylinderX(0.025 * U, 0.04 * U, 0.11 * U, 10, antenna), { pos: [(-0.22 + xOffset) * U, ySign * 0.67 * U, zSign * 0.28 * U] });
      }
    }
  }
  part(group, createEngineBell(0.38 * U, 0.82 * U), dark, { name: 'apollo-service-propulsion-engine', rot: [0, 0, -Math.PI / 2], pos: [-1.56 * U, 0, 0] });
  addEngineGlow(group, -1.9 * U, 0, 0, 0.25 * U, engineGlow);

  part(group, createParabolicDishGeometry(0.32 * U, 0.11 * U), antenna, { rot: [0, 0, -Math.PI / 2], pos: [-0.95 * U, 0.72 * U, 0.22 * U] });
  group.add(createRodBetween(
    new THREE.Vector3(-0.95 * U, 0.56 * U, 0.22 * U),
    new THREE.Vector3(-0.95 * U, 0.84 * U, 0.22 * U),
    0.018 * U,
    antenna,
    8,
  ));
  return group;
}

function createNabooStarfighter(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const chrome = new THREE.MeshPhysicalMaterial({
    color: 0xd9dfd9, roughness: 0.25, metalness: 0.82, clearcoat: 0.34, clearcoatRoughness: 0.25,
  });
  const gold = standard(0xd39a27, 0.42, 0.52, 0x332006, 0.18);
  const darkGold = standard(0x76501b, 0.55, 0.48);
  const glass = standard(0x07151d, 0.12, 0.3, 0x12384c, 0.32);
  const dark = standard(0x33393a, 0.46, 0.58);
  const blue = glow(0x74c9ff, 0.85);

  place(group, cylinderX(0.28 * U, 0.4 * U, 1.75 * U, 32, chrome), { pos: [0.35 * U, 0, 0] });
  part(group, new THREE.ConeGeometry(0.28 * U, 1.62 * U, 32), gold, { rot: [0, 0, -Math.PI / 2], pos: [2.02 * U, 0, 0] });
  part(group, new THREE.SphereGeometry(0.36 * U, 28, 16), glass, { name: 'naboo-pilot-canopy', scale: [1.25, 0.54, 0.85], pos: [0.28 * U, 0.34 * U, 0] });
  place(group, plateXZ([
    [-0.15 * U, 0], [-1.15 * U, 0], [-1.05 * U, 0.78 * U], [-0.72 * U, 0.73 * U],
  ], 0.09 * U, gold, 0.012 * U), { rot: [Math.PI / 2, 0, 0], pos: [0, 0.02 * U, 0] });

  part(group, new THREE.SphereGeometry(0.17 * U, 20, 12), chrome, { name: 'naboo-astromech-dome', scale: [1, 0.72, 1], pos: [-0.32 * U, 0.37 * U, 0] });
  place(group, cylinderX(0.035 * U, 0.065 * U, 1.3 * U, 14, darkGold), { name: 'naboo-center-tail-finial', pos: [-1.38 * U, 0, 0] });

  for (const zSign of [-1, 1]) {
    const side = zSign < 0 ? 'port' : 'starboard';
    group.add(plateXZ([
      [0.62 * U, zSign * 0.25 * U], [-0.62 * U, zSign * 0.88 * U],
      [-1.02 * U, zSign * 0.78 * U], [-0.42 * U, zSign * 0.23 * U],
    ], 0.07 * U, gold, 0.012 * U));
    place(group, cylinderX(0.25 * U, 0.31 * U, 1.75 * U, 28, chrome), { name: `naboo-j-type-engine-${side}`, pos: [-0.25 * U, 0, zSign * 1.03 * U] });
    part(group, new THREE.ConeGeometry(0.25 * U, 0.6 * U, 28), gold, { rot: [0, 0, -Math.PI / 2], pos: [0.92 * U, 0, zSign * 1.03 * U] });
    addEngineGlow(group, -1.14 * U, 0, zSign * 1.03 * U, 0.19 * U, blue);
    place(group, cylinderX(0.045 * U, 0.065 * U, 1.2 * U, 14, darkGold), { name: `naboo-engine-finial-${side}`, pos: [-1.65 * U, 0, zSign * 1.03 * U] });
    for (const x of [-0.72, -0.3, 0.12]) {
      part(group, new THREE.TorusGeometry(0.27 * U, 0.018 * U, 6, 28), dark, { rot: [0, Math.PI / 2, 0], pos: [x * U, 0, zSign * 1.03 * U] });
    }
  }
  for (const x of [-0.75, -0.4, -0.05, 0.3, 0.65]) {
    part(group, new THREE.TorusGeometry(0.405 * U, 0.012 * U, 6, 32), darkGold, { rot: [0, Math.PI / 2, 0], pos: [x * U, 0, 0] });
  }
  return group;
}

function createYWing(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const ivory = standard(0xc8c7b7, 0.72, 0.18);
  const yellow = standard(0xc59627, 0.62, 0.28, 0x261a05, 0.12);
  const dark = standard(0x343a3b, 0.54, 0.52);
  const pipe = standard(0x7e8887, 0.44, 0.62);
  const glass = standard(0x08171e, 0.15, 0.3, 0x143a4a, 0.28);
  const blue = glow(0x78cfff, 0.84);

  part(group, new THREE.SphereGeometry(0.63 * U, 30, 20), ivory, { scale: [1.25, 0.58, 1], pos: [1.08 * U, 0, 0] });
  part(group, new THREE.SphereGeometry(0.4 * U, 24, 14), glass, { name: 'y-wing-cockpit', scale: [1.05, 0.45, 0.72], pos: [0.72 * U, 0.38 * U, 0] });
  part(group, new THREE.BoxGeometry(1.35 * U, 0.28 * U, 0.46 * U), dark, { pos: [-0.08 * U, 0, 0] });
  part(group, new THREE.BoxGeometry(0.55 * U, 0.08 * U, 0.72 * U), yellow, { pos: [1.05 * U, 0.38 * U, 0] });

  part(group, new THREE.SphereGeometry(0.17 * U, 18, 10), ivory, { name: 'y-wing-astromech-dome', scale: [1, 0.72, 1], pos: [0.05 * U, 0.34 * U, 0] });

  for (const zSign of [-1, 1]) {
    part(group, new THREE.BoxGeometry(1.55 * U, 0.18 * U, 0.22 * U), ivory, { pos: [-0.22 * U, 0, zSign * 0.72 * U] });
    place(group, cylinderX(0.29 * U, 0.34 * U, 2.25 * U, 24, dark), { name: `y-wing-engine-nacelle-${zSign < 0 ? 'port' : 'starboard'}`, pos: [-0.42 * U, 0, zSign * 0.95 * U] });
    place(group, cylinderX(0.3 * U, 0.3 * U, 0.42 * U, 24, yellow), { pos: [0.73 * U, 0, zSign * 0.95 * U] });
    addEngineGlow(group, -1.58 * U, 0, zSign * 0.95 * U, 0.22 * U, blue);
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const start = new THREE.Vector3(0.45 * U, Math.cos(angle) * 0.31 * U, zSign * 0.95 * U + Math.sin(angle) * 0.31 * U);
      const end = new THREE.Vector3(-1.4 * U, Math.cos(angle) * 0.31 * U, zSign * 0.95 * U + Math.sin(angle) * 0.31 * U);
      group.add(createRodBetween(start, end, 0.018 * U, pipe, 6));
    }
    place(group, cylinderX(0.035 * U, 0.05 * U, 1.15 * U, 12, pipe), { pos: [1.18 * U, -0.12 * U, zSign * 0.75 * U] });
  }
  part(group, new THREE.CylinderGeometry(0.15 * U, 0.18 * U, 0.16 * U, 16), dark, { pos: [0.85 * U, 0.56 * U, 0] });
  for (const z of [-0.09, 0.09]) {
    place(group, cylinderX(0.025 * U, 0.035 * U, 0.72 * U, 10, pipe), { pos: [1.23 * U, 0.6 * U, z * U] });
  }
  return group;
}

/** Intrepid-class USS Voyager NCC-74656. The low, arrow-lens primary hull,
 * integrated secondary hull, and compact variable-geometry nacelles avoid the
 * separated saucer/neck silhouette of the Constitution-class Enterprise. */
function createUssVoyager(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const pearl = new THREE.MeshPhysicalMaterial({
    color: 0xbfc9cb, roughness: 0.5, metalness: 0.32, clearcoat: 0.28, clearcoatRoughness: 0.48,
  });
  const pale = standard(0xd4d9d8, 0.62, 0.2);
  const dark = standard(0x46525a, 0.52, 0.5);
  const charcoal = standard(0x222b31, 0.46, 0.58);
  const window = glow(0xd9f4ff, 0.76);
  const blue = glow(0x63c8ff, 0.9);
  const red = glow(0xff6658, 0.76);

  place(group, plateXZ([
    [1.86 * U, 0], [1.4 * U, -0.58 * U], [0.55 * U, -0.9 * U],
    [-0.28 * U, -0.76 * U], [-0.86 * U, -0.35 * U], [-0.96 * U, 0],
    [-0.86 * U, 0.35 * U], [-0.28 * U, 0.76 * U], [0.55 * U, 0.9 * U],
    [1.4 * U, 0.58 * U],
  ], 0.18 * U, pearl, 0.035 * U), { name: 'voyager-primary-hull', pos: [0, 0.1 * U, 0] });

  part(group, new THREE.SphereGeometry(0.83 * U, 40, 18), pale, { scale: [1.5, 0.2, 0.82], pos: [0.65 * U, 0.27 * U, 0] });
  part(group, new THREE.SphereGeometry(0.17 * U, 20, 12), pale, { scale: [1.15, 0.32, 0.8], pos: [0.83 * U, 0.44 * U, 0] });

  part(group, new THREE.SphereGeometry(0.66 * U, 36, 20), pearl, { name: 'voyager-secondary-hull', scale: [1.85, 0.6, 0.68], pos: [-0.65 * U, -0.23 * U, 0] });
  place(group, cylinderX(0.28 * U, 0.4 * U, 0.92 * U, 28, dark), { pos: [-1.42 * U, -0.18 * U, 0] });

  place(group, discX(0.3 * U, 0.055 * U, blue, 32), { name: 'voyager-navigational-deflector', pos: [0.13 * U, -0.35 * U, 0] });
  part(group, new THREE.TorusGeometry(0.33 * U, 0.035 * U, 8, 32), dark, { rot: [0, Math.PI / 2, 0], pos: [0.13 * U, -0.35 * U, 0] });

  for (const zSign of [-1, 1]) {
    place(group, plateXZ([
      [-0.65 * U, zSign * 0.24 * U], [-0.95 * U, zSign * 0.92 * U],
      [-1.35 * U, zSign * 1.02 * U], [-1.12 * U, zSign * 0.25 * U],
    ], 0.11 * U, pearl, 0.015 * U), { pos: [0, -0.05 * U, 0] });

    place(group, cylinderX(0.17 * U, 0.23 * U, 1.62 * U, 28, pearl), { name: `voyager-variable-nacelle-${zSign < 0 ? 'port' : 'starboard'}`, pos: [-1.1 * U, 0.16 * U, zSign * 1.08 * U] });
    part(group, new THREE.SphereGeometry(0.23 * U, 22, 14), red, { scale: [0.5, 1, 1], pos: [-0.27 * U, 0.16 * U, zSign * 1.08 * U] });
    part(group, new THREE.BoxGeometry(1.08 * U, 0.06 * U, 0.11 * U), blue, { pos: [-1.12 * U, 0.34 * U, zSign * 1.08 * U] });
    for (const x of [-1.72, -1.37, -1.02, -0.67]) {
      part(group, new THREE.TorusGeometry(0.225 * U, 0.014 * U, 6, 24), dark, { rot: [0, Math.PI / 2, 0], pos: [x * U, 0.16 * U, zSign * 1.08 * U] });
    }
    addEngineGlow(group, -1.93 * U, 0.16 * U, zSign * 1.08 * U, 0.13 * U, blue);
    addEngineGlow(group, -1.73 * U, 0.03 * U, zSign * 0.3 * U, 0.1 * U, red);
  }

  for (const zSign of [-1, 1]) {
    for (const x of [-0.1, 0.24, 0.58, 0.92, 1.25]) {
      part(group, new THREE.SphereGeometry(0.035 * U, 8, 6), window, { scale: [1.55, 0.35, 0.7], pos: [x * U, 0.18 * U, zSign * (0.55 + (1.25 - x) * 0.17) * U] });
    }
  }
  part(group, new THREE.BoxGeometry(0.48 * U, 0.04 * U, 0.38 * U), charcoal, { pos: [-1.52 * U, -0.4 * U, 0] });
  return group;
}

/** TNG-era D'deridex-class Romulan Warbird: command head on an extended neck,
 * huge feathered wing halves, edge nacelles, and a genuinely open central
 * volume between separated dorsal and ventral hulls. */
function createRomulanWarbird(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const green = standard(0x506f58, 0.62, 0.42, 0x102419, 0.16);
  const paleGreen = standard(0x789178, 0.6, 0.34);
  const darkGreen = standard(0x253d31, 0.68, 0.46);
  const bronze = standard(0x766342, 0.58, 0.52, 0x211707, 0.12);
  const emerald = glow(0x70ffc1, 0.86);
  const amber = glow(0xffbd64, 0.7);

  part(group, new THREE.SphereGeometry(0.45 * U, 30, 18), green, { name: 'romulan-command-head', scale: [1.5, 0.42, 0.82], pos: [1.67 * U, 0.02 * U, 0] });
  part(group, new THREE.ConeGeometry(0.23 * U, 0.7 * U, 20), bronze, { rot: [0, 0, -Math.PI / 2], pos: [2.28 * U, -0.02 * U, 0] });
  part(group, new THREE.SphereGeometry(0.16 * U, 18, 10), paleGreen, { scale: [1.2, 0.4, 0.72], pos: [1.58 * U, 0.28 * U, 0] });

  place(group, cylinderX(0.17 * U, 0.28 * U, 1.72 * U, 18, darkGreen), { name: 'romulan-outstretched-neck', pos: [0.56 * U, -0.04 * U, 0] });
  part(group, new THREE.BoxGeometry(1.45 * U, 0.11 * U, 0.12 * U), bronze, { pos: [0.5 * U, 0.16 * U, 0] });

  const hollow = new THREE.Group();
  hollow.name = 'romulan-open-hollow-core';
  group.add(hollow);

  for (const zSign of [-1, 1]) {
    const side = zSign < 0 ? 'port' : 'starboard';
    place(group, plateXZ([
      [0.18 * U, zSign * 0.2 * U], [-0.18 * U, zSign * 1.2 * U],
      [-1.28 * U, zSign * 1.95 * U], [-1.78 * U, zSign * 1.7 * U],
      [-1.42 * U, zSign * 0.52 * U], [-0.55 * U, zSign * 0.24 * U],
    ], 0.16 * U, green, 0.025 * U), { name: `romulan-dorsal-wing-${side}`, pos: [0, 0.27 * U, 0] });

    place(group, plateXZ([
      [-0.02 * U, zSign * 0.24 * U], [-0.48 * U, zSign * 1.02 * U],
      [-1.42 * U, zSign * 1.68 * U], [-1.65 * U, zSign * 1.42 * U],
      [-1.27 * U, zSign * 0.58 * U], [-0.52 * U, zSign * 0.28 * U],
    ], 0.15 * U, darkGreen, 0.022 * U), { name: `romulan-ventral-wing-${side}`, pos: [0, -0.42 * U, 0] });

    place(group, cylinderX(0.16 * U, 0.22 * U, 1.5 * U, 24, paleGreen), { name: `romulan-warp-nacelle-${side}`, pos: [-0.85 * U, 0.08 * U, zSign * 1.82 * U] });
    part(group, new THREE.BoxGeometry(0.95 * U, 0.07 * U, 0.1 * U), emerald, { pos: [-0.8 * U, 0.25 * U, zSign * 1.82 * U] });
    addEngineGlow(group, -1.62 * U, 0.08 * U, zSign * 1.82 * U, 0.12 * U, emerald);

    for (let i = 0; i < 6; i++) {
      part(group, new THREE.BoxGeometry(0.5 * U, 0.045 * U, 0.12 * U), i % 2 ? bronze : paleGreen,
        { pos: [(-0.28 - i * 0.23) * U, 0.46 * U, zSign * (0.62 + i * 0.2) * U], rot: [0, zSign * -0.42, 0] });
    }
    for (let i = 0; i < 4; i++) {
      part(group, new THREE.BoxGeometry(0.42 * U, 0.04 * U, 0.1 * U), bronze,
        { pos: [(-0.55 - i * 0.24) * U, -0.54 * U, zSign * (0.62 + i * 0.21) * U], rot: [0, zSign * -0.38, 0] });
    }
  }

  part(group, new THREE.BoxGeometry(0.48 * U, 0.18 * U, 2.15 * U), green, { pos: [-1.5 * U, 0.31 * U, 0] });
  part(group, new THREE.BoxGeometry(0.4 * U, 0.15 * U, 1.72 * U), darkGreen, { pos: [-1.4 * U, -0.43 * U, 0] });
  for (const z of [-0.62, -0.3, 0, 0.3, 0.62]) {
    addEngineGlow(group, -1.76 * U, 0.3 * U, z * U, 0.075 * U, amber);
  }
  return group;
}

export function createPlayerFleetModel(profile: Exclude<PlayerShipProfile, 'default'>, referenceRadiusAU: number): THREE.Group {
  const finish = (model: THREE.Group): THREE.Group => {
    const readable = boostDeepSpaceReadability(addFleetSurfaceDetail(profile, model, referenceRadiusAU));
    readable.name = `player-ship-${profile}`;
    readable.userData.playerShipProfile = profile;
    return readable;
  };
  switch (profile) {
    case 'shuttle': return finish(createSpaceShuttle(referenceRadiusAU));
    case 'soyuz': return finish(createSoyuz(referenceRadiusAU));
    case 'falcon': return finish(createFalcon(referenceRadiusAU));
    case 'enterprise': return finish(createEnterprise(referenceRadiusAU));
    case 'ussVoyager': return finish(createUssVoyager(referenceRadiusAU));
    case 'klingon': return finish(createKlingonBirdOfPrey(referenceRadiusAU));
    case 'romulan': return finish(createRomulanWarbird(referenceRadiusAU));
    case 'saucer': return finish(createFlyingSaucer(referenceRadiusAU));
    case 'starship': return finish(createStarship(referenceRadiusAU));
    case 'dragon': return finish(createDragon(referenceRadiusAU));
    case 'orion': return finish(createOrion(referenceRadiusAU));
    case 'starliner': return finish(createStarliner(referenceRadiusAU));
    case 'dreamChaser': return finish(createDreamChaser(referenceRadiusAU));
    case 'xwing': return finish(createXWing(referenceRadiusAU));
    case 'tie': return finish(createTieFighter(referenceRadiusAU));
    case 'starDestroyer': return finish(createStarDestroyer(referenceRadiusAU));
    case 'apollo': return finish(createApollo(referenceRadiusAU));
    case 'naboo': return finish(createNabooStarfighter(referenceRadiusAU));
    case 'ywing': return finish(createYWing(referenceRadiusAU));
  }
}
