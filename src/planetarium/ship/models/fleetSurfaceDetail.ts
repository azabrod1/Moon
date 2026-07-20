/**
 * Secondary-scale geometry for the selectable fleet.
 *
 * The primary builders in playerFleet.ts own each craft's silhouette. This
 * pass adds the layer that makes a model read as a vehicle rather than a toy:
 * access panels, thermal protection, vents, windows, plumbing, emitters,
 * engine internals, and franchise-specific hull treatment. Details are kept
 * slightly oversized so they remain legible from the chase camera.
 */
import * as THREE from 'three';
import type { PlayerShipProfile } from '../shipProfiles';
import { applyFleetMicroSurface } from './fleetMicroSurface';
import { createRodBetween } from './shipPrimitives';

type FleetProfile = Exclude<PlayerShipProfile, 'default'>;
type SurfaceMaterial = THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;

interface DetailPalette {
  panel: THREE.MeshStandardMaterial;
  pale: THREE.MeshStandardMaterial;
  seam: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  light: THREE.MeshBasicMaterial;
}

interface FleetPropulsionState {
  outerMaterial: THREE.MeshBasicMaterial;
  coreMaterial: THREE.MeshBasicMaterial;
  haloMaterial: THREE.MeshBasicMaterial;
  halos: THREE.Mesh[];
}

function standard(color: number, roughness: number, metalness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function lit(color: number): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color, toneMapped: false });
  return material;
}

function energyMaterial(color: number, opacity: number, additive = false): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    toneMapped: false,
  });
  return material;
}

function paletteFor(profile: FleetProfile): DetailPalette {
  if (['falcon', 'xwing', 'ywing', 'tie', 'starDestroyer', 'naboo'].includes(profile)) {
    return {
      panel: standard(0xaaa99f, 0.76, 0.22),
      pale: standard(0xd4d0c2, 0.7, 0.18),
      seam: standard(0x252b2d, 0.58, 0.52),
      accent: standard(0x8b3f2e, 0.68, 0.28),
      glass: standard(0x07171d, 0.16, 0.28),
      light: lit(0xbdeaff),
    };
  }
  if (['enterprise', 'ussVoyager'].includes(profile)) {
    return {
      panel: standard(0xb8c2c3, 0.56, 0.3),
      pale: standard(0xe1ded1, 0.62, 0.18),
      seam: standard(0x343e47, 0.5, 0.52),
      accent: standard(0x775049, 0.62, 0.3),
      glass: standard(0x162834, 0.18, 0.32),
      light: lit(0xd8f5ff),
    };
  }
  if (['klingon', 'romulan'].includes(profile)) {
    return {
      panel: standard(0x657a61, 0.64, 0.42),
      pale: standard(0x86947b, 0.6, 0.34),
      seam: standard(0x23362b, 0.64, 0.5),
      accent: standard(0x8a7042, 0.58, 0.5),
      glass: standard(0x1b201a, 0.2, 0.3),
      light: lit(0x8affca),
    };
  }
  return {
    panel: standard(0x9ca5a4, 0.65, 0.36),
    pale: standard(0xd6d8d2, 0.68, 0.18),
    seam: standard(0x292f31, 0.64, 0.48),
    accent: standard(0x9b6439, 0.62, 0.36),
    glass: standard(0x071a24, 0.16, 0.3),
    light: lit(0xa9e8ff),
  };
}

function addBox(
  root: THREE.Group,
  name: string,
  size: [number, number, number],
  position: [number, number, number],
  material: SurfaceMaterial,
  rotation: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  root.add(mesh);
  return mesh;
}

function addSphere(
  root: THREE.Group,
  name: string,
  radius: number,
  position: [number, number, number],
  scale: [number, number, number],
  material: SurfaceMaterial,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 10), material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  root.add(mesh);
  return mesh;
}

function addRod(
  root: THREE.Group,
  name: string,
  start: [number, number, number],
  end: [number, number, number],
  radius: number,
  material: SurfaceMaterial,
): THREE.Mesh {
  const rod = createRodBetween(
    new THREE.Vector3(...start),
    new THREE.Vector3(...end),
    radius,
    material,
    8,
  );
  rod.name = name;
  root.add(rod);
  return rod;
}

function addRingX(
  root: THREE.Group,
  name: string,
  x: number,
  y: number,
  z: number,
  radius: number,
  tube: number,
  material: SurfaceMaterial,
): THREE.Mesh {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 6, 32), material);
  ring.name = name;
  ring.rotation.y = Math.PI / 2;
  ring.position.set(x, y, z);
  root.add(ring);
  return ring;
}

function addTopPlate(
  root: THREE.Group,
  name: string,
  points: Array<[number, number]>,
  y: number,
  depth: number,
  material: SurfaceMaterial,
): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: Math.min(depth * 0.2, 0.01),
    bevelThickness: Math.min(depth * 0.2, 0.01),
    steps: 1,
  });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, depth / 2, 0);
  geometry.computeVertexNormals();
  const plate = new THREE.Mesh(geometry, material);
  plate.name = name;
  plate.position.y = y;
  root.add(plate);
  return plate;
}

function addWindowRow(
  root: THREE.Group,
  prefix: string,
  positions: Array<[number, number, number]>,
  size: [number, number, number],
  material: SurfaceMaterial,
): void {
  positions.forEach((position, index) => {
    addBox(root, `${prefix}-${index + 1}`, size, position, material);
  });
}

function addNavLights(root: THREE.Group, prefix: string, positions: Array<[number, number, number]>, material: SurfaceMaterial): void {
  positions.forEach((position, index) => {
    addSphere(root, `${prefix}-${index + 1}`, 0.035, position, [1, 0.5, 1], material);
  });
}

function addShuttleDetail(root: THREE.Group, p: DetailPalette): void {
  // Thermal-protection blankets, elevon seams, bay latches, and nose RCS.
  for (const zSign of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const x = 0.38 - i * 0.36;
      addBox(root, `shuttle-detail-wing-tile-${zSign}-${i}`, [0.25, 0.025, 0.32], [x, 0.135, zSign * (0.55 + i * 0.2)], p.panel, [0, zSign * 0.05, 0]);
    }
    addRod(root, `shuttle-detail-elevon-seam-${zSign}`, [-0.65, 0.16, zSign * 0.55], [-1.28, 0.16, zSign * 1.43], 0.016, p.seam);
    addWindowRow(root, `shuttle-detail-rcs-${zSign}`, [
      [1.52, 0.17, zSign * 0.44], [1.58, 0.07, zSign * 0.46], [1.48, -0.03, zSign * 0.45],
    ], [0.035, 0.035, 0.045], p.seam);
  }
  for (let i = 0; i < 7; i++) addBox(root, `shuttle-detail-payload-latch-${i}`, [0.055, 0.035, 0.08], [-0.82 + i * 0.25, 0.535, 0], p.seam);
  addBox(root, 'shuttle-detail-crew-hatch', [0.32, 0.025, 0.28], [0.88, 0.405, 0.35], p.seam, [0.05, 0, -0.1]);
  addBox(root, 'shuttle-detail-rudder-split', [0.62, 0.025, 0.035], [-1.05, 0.72, 0], p.seam, [0, 0, -0.28]);
}

function addSoyuzDetail(root: THREE.Group, p: DetailPalette): void {
  for (const x of [-1.18, -0.94, -0.7, -0.46]) {
    addBox(root, `soyuz-detail-service-blanket-${x}`, [0.18, 0.035, 0.42], [x, 0.49, 0], p.panel);
  }
  for (const zSign of [-1, 1]) {
    addRod(root, `soyuz-detail-propellant-line-${zSign}`, [-1.28, 0.36, zSign * 0.28], [-0.27, 0.36, zSign * 0.28], 0.018, p.accent);
    addBox(root, `soyuz-detail-descent-window-frame-${zSign}`, [0.08, 0.16, 0.16], [0.35, 0.27, zSign * 0.38], p.seam, [0, zSign * 0.25, 0]);
    for (let i = 0; i < 4; i++) {
      addBox(root, `soyuz-detail-solar-cell-${zSign}-${i}`, [0.44, 0.02, 0.015], [-0.72, 0.045, zSign * (0.76 + i * 0.5)], p.pale);
    }
  }
  addRingX(root, 'soyuz-detail-orbital-hatch-ring', 1.15, 0.31, 0, 0.18, 0.018, p.seam);
  addBox(root, 'soyuz-detail-periscope', [0.18, 0.12, 0.1], [0.5, 0.49, 0.05], p.seam, [0, 0, -0.18]);
  addNavLights(root, 'soyuz-detail-navigation-light', [[-0.35, 0.3, -0.42], [-0.35, 0.3, 0.42]], p.light);
}

function addFalconDetail(root: THREE.Group, p: DetailPalette): void {
  // Patchwork hull plates and irregular maintenance greebles are deliberate.
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 + ring * 0.12;
      const radius = 0.62 + ring * 0.46;
      addBox(root, `falcon-detail-hull-plate-${ring}-${i}`, [0.26, 0.025, 0.14], [
        -0.2 + Math.cos(angle) * radius, 0.505 + ring * 0.015, Math.sin(angle) * radius,
      ], i % 4 === 0 ? p.accent : p.panel, [0, -angle, 0]);
    }
  }
  for (const zSign of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      addBox(root, `falcon-detail-mandible-bay-${zSign}-${i}`, [0.2, 0.05, 0.26], [0.82 + i * 0.27, 0.37, zSign * 0.73], i % 3 === 0 ? p.accent : p.seam);
    }
    addRod(root, `falcon-detail-mandible-pipe-${zSign}`, [0.65, 0.43, zSign * 0.52], [1.92, 0.43, zSign * 0.52], 0.015, p.pale);
  }
  addRingX(root, 'falcon-detail-dorsal-turret-ring', -0.06, 0.52, 0, 0.2, 0.026, p.seam);
  addBox(root, 'falcon-detail-dorsal-turret', [0.24, 0.16, 0.24], [-0.06, 0.59, 0], p.pale);
  addWindowRow(root, 'falcon-detail-cockpit-frame', [[1.29, 0.12, -1.68], [1.29, 0.12, -1.54], [1.29, 0.12, -1.4]], [0.025, 0.17, 0.025], p.pale);
}

function addSaucerDetail(root: THREE.Group, p: DetailPalette): void {
  for (let i = 0; i < 20; i++) {
    const angle = (i / 20) * Math.PI * 2;
    addBox(root, `saucer-detail-radial-panel-${i}`, [0.38, 0.025, 0.065], [Math.cos(angle) * 1.12, 0.305, Math.sin(angle) * 1.12], i % 5 === 0 ? p.accent : p.panel, [0, -angle, 0]);
  }
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    addSphere(root, `saucer-detail-dome-port-${i}`, 0.04, [Math.cos(angle) * 0.58, 0.48, Math.sin(angle) * 0.58], [1.5, 0.45, 1], p.glass);
  }
  addSphere(root, 'saucer-detail-dorsal-sensor', 0.13, [0, 0.76, 0], [1, 0.35, 1], p.light);
  addRod(root, 'saucer-detail-forward-antenna', [1.5, 0.12, 0], [1.92, 0.12, 0], 0.025, p.seam);
}

function addStarshipDetail(root: THREE.Group, p: DetailPalette): void {
  // Stainless weld rings and offset heat-shield tiles follow the real vehicle.
  for (let i = 0; i < 10; i++) {
    const x = -1.45 + i * 0.29;
    addRingX(root, `starship-detail-weld-ring-${i}`, x, 0, 0, 0.492, 0.008, i % 3 === 0 ? p.accent : p.seam);
    for (const z of [-0.32, 0, 0.32]) {
      addBox(root, `starship-detail-heat-tile-${i}-${z}`, [0.2, 0.02, 0.19], [x + (i % 2) * 0.035, -0.505, z], p.seam, [0, 0.02 * i, 0]);
    }
  }
  for (const x of [-1.2, -0.55, 0.08, 0.72]) {
    addBox(root, `starship-detail-vent-${x}`, [0.18, 0.025, 0.08], [x, 0.505, 0.18], p.seam);
  }
  for (const zSign of [-1, 1]) {
    addSphere(root, `starship-detail-forward-flap-hinge-${zSign}`, 0.07, [0.62, 0.08, zSign * 0.42], [1.6, 0.55, 1], p.accent);
    addSphere(root, `starship-detail-aft-flap-hinge-${zSign}`, 0.08, [-1.67, 0.07, zSign * 0.43], [1.6, 0.55, 1], p.accent);
  }
}

function addDragonDetail(root: THREE.Group, p: DetailPalette): void {
  for (const zSign of [-1, 1]) {
    addTopPlate(root, `dragon-detail-window-bezel-${zSign}`, [[0.55, zSign * 0.21], [0.9, zSign * 0.18], [0.86, zSign * 0.43], [0.5, zSign * 0.48]], 0.46, 0.025, p.glass);
    for (let i = 0; i < 4; i++) {
      addBox(root, `dragon-detail-superdraco-port-${zSign}-${i}`, [0.06, 0.06, 0.08], [0.28 + i * 0.16, 0.48 - i * 0.035, zSign * 0.45], p.seam, [0, zSign * 0.18, 0]);
    }
    addRod(root, `dragon-detail-trunk-line-${zSign}`, [-1.43, 0.38, zSign * 0.35], [-0.38, 0.53, zSign * 0.44], 0.016, p.pale);
  }
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    addBox(root, `dragon-detail-trunk-radiator-${i}`, [0.55, 0.025, 0.16], [-0.98, Math.cos(angle) * 0.58, Math.sin(angle) * 0.58], i % 2 ? p.panel : p.seam, [angle, 0, 0]);
  }
  addRingX(root, 'dragon-detail-docking-petal-ring', 1.36, 0, 0, 0.24, 0.025, p.seam);
}

function addOrionDetail(root: THREE.Group, p: DetailPalette): void {
  for (const zSign of [-1, 1]) {
    addBox(root, `orion-detail-crew-window-${zSign}`, [0.16, 0.12, 0.12], [0.8, 0.34, zSign * 0.38], p.glass, [0, zSign * 0.28, 0]);
    addBox(root, `orion-detail-rcs-pod-${zSign}`, [0.2, 0.11, 0.16], [0.2, 0.54, zSign * 0.32], p.seam);
    for (let i = 0; i < 4; i++) {
      addBox(root, `orion-detail-solar-cell-${zSign}-${i}`, [0.015, 0.42, 0.42], [-0.73, zSign * (0.82 + i * 0.42), 0], p.pale);
      addBox(root, `orion-detail-cross-solar-cell-${zSign}-${i}`, [0.015, 0.42, 0.42], [-0.73, 0, zSign * (0.82 + i * 0.42)], p.pale);
    }
  }
  for (const x of [-1.2, -0.85, -0.5]) addRingX(root, `orion-detail-service-rib-${x}`, x, 0, 0, 0.55, 0.014, p.seam);
  addBox(root, 'orion-detail-side-hatch', [0.3, 0.025, 0.3], [0.58, 0.51, 0], p.seam);
  addRingX(root, 'orion-detail-docking-target', 1.5, 0, 0, 0.16, 0.02, p.pale);
}

function addStarlinerDetail(root: THREE.Group, p: DetailPalette): void {
  for (const zSign of [-1, 1]) {
    addWindowRow(root, `starliner-detail-window-${zSign}`, [
      [0.72, 0.35, zSign * 0.34], [0.42, 0.43, zSign * 0.42], [0.08, 0.44, zSign * 0.45],
    ], [0.16, 0.1, 0.08], p.glass);
    for (let i = 0; i < 4; i++) {
      addBox(root, `starliner-detail-service-bay-${zSign}-${i}`, [0.26, 0.025, 0.17], [-0.72 - i * 0.18, 0.55, zSign * 0.27], i % 2 ? p.panel : p.seam);
    }
    addRod(root, `starliner-detail-fluid-line-${zSign}`, [-1.42, 0.27, zSign * 0.48], [-0.22, 0.43, zSign * 0.52], 0.014, p.accent);
  }
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    addSphere(root, `starliner-detail-aft-thruster-${i}`, 0.045, [-1.55, Math.cos(angle) * 0.36, Math.sin(angle) * 0.36], [0.6, 1, 1], p.seam);
  }
  addRingX(root, 'starliner-detail-docking-seal', 1.42, 0, 0, 0.18, 0.022, p.seam);
}

function addDreamChaserDetail(root: THREE.Group, p: DetailPalette): void {
  for (const zSign of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      addBox(root, `dream-chaser-detail-wing-tile-${zSign}-${i}`, [0.28, 0.025, 0.22], [0.52 - i * 0.33, 0.18, zSign * (0.52 + i * 0.2)], i % 2 ? p.panel : p.pale, [0, zSign * -0.13, 0]);
    }
    addRod(root, `dream-chaser-detail-flap-seam-${zSign}`, [-0.58, 0.2, zSign * 0.68], [-1.42, 0.2, zSign * 1.28], 0.016, p.seam);
    addBox(root, `dream-chaser-detail-rcs-pod-${zSign}`, [0.24, 0.13, 0.16], [0.82, 0.34, zSign * 0.42], p.seam);
  }
  for (const x of [-0.75, -0.38, -0.01, 0.36]) addBox(root, `dream-chaser-detail-dorsal-hatch-${x}`, [0.28, 0.025, 0.34], [x, 0.39, 0], p.seam);
  addWindowRow(root, 'dream-chaser-detail-cockpit-divider', [[1.15, 0.38, -0.18], [1.15, 0.38, 0], [1.15, 0.38, 0.18]], [0.03, 0.18, 0.035], p.pale);
}

function addXWingDetail(root: THREE.Group, p: DetailPalette): void {
  for (const ySign of [-1, 1]) {
    for (const zSign of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        addBox(root, `xwing-detail-sfoil-panel-${ySign}-${zSign}-${i}`, [0.24, 0.025, 0.24], [-0.72 + i * 0.34, ySign * 0.46, zSign * (0.55 + i * 0.13)], i === 2 ? p.accent : p.panel, [ySign * zSign * 0.19, 0, 0]);
      }
      addRod(root, `xwing-detail-cannon-conduit-${ySign}-${zSign}`, [-0.75, ySign * 0.5, zSign * 1.08], [1.15, ySign * 0.5, zSign * 1.08], 0.014, p.seam);
    }
  }
  addWindowRow(root, 'xwing-detail-canopy-frame', [[0.58, 0.51, -0.18], [0.58, 0.51, 0], [0.58, 0.51, 0.18]], [0.035, 0.18, 0.035], p.pale);
  addBox(root, 'xwing-detail-astromech-band', [0.12, 0.025, 0.38], [-0.28, 0.49, 0], p.accent);
  addNavLights(root, 'xwing-detail-nav-light', [[-0.82, 0.48, -1.15], [-0.82, 0.48, 1.15]], p.light);
}

function addTieDetail(root: THREE.Group, p: DetailPalette): void {
  for (const zSign of [-1, 1]) {
    for (let ring = 0; ring < 2; ring++) {
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2 + Math.PI / 6;
        const radius = 0.48 + ring * 0.38;
        addRod(root, `tie-detail-solar-cell-${zSign}-${ring}-${i}`, [Math.cos(angle) * radius, Math.sin(angle) * radius, zSign * 1.485], [Math.cos(angle) * (radius + 0.26), Math.sin(angle) * (radius + 0.26), zSign * 1.485], 0.012, p.panel);
      }
    }
    addRingX(root, `tie-detail-pylon-collar-${zSign}`, 0, 0, zSign * 0.6, 0.18, 0.025, p.seam);
  }
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    addBox(root, `tie-detail-cockpit-panel-${i}`, [0.18, 0.045, 0.12], [-0.18, Math.cos(angle) * 0.57, Math.sin(angle) * 0.57], i % 2 ? p.seam : p.panel, [angle, 0, 0]);
  }
}

function addStarDestroyerDetail(root: THREE.Group, p: DetailPalette): void {
  for (const zSign of [-1, 1]) {
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 7; i++) {
        const x = -1.18 + i * 0.42;
        const z = zSign * (0.2 + row * 0.25 + (1.05 - x) * 0.12);
        addBox(root, `star-destroyer-detail-hull-panel-${zSign}-${row}-${i}`, [0.28, 0.025, 0.11], [x, 0.285 + row * 0.012, z], (i + row) % 5 === 0 ? p.pale : p.panel, [0, zSign * -0.24, 0]);
      }
    }
    for (let i = 0; i < 5; i++) addBox(root, `star-destroyer-detail-turret-${zSign}-${i}`, [0.1, 0.1, 0.1], [-0.72 + i * 0.38, 0.42, zSign * (0.42 + i * 0.07)], p.pale);
  }
  for (let i = 0; i < 6; i++) addBox(root, `star-destroyer-detail-bridge-window-${i}`, [0.025, 0.045, 0.1], [-0.62, 1.24, -0.31 + i * 0.125], p.light);
  addBox(root, 'star-destroyer-detail-hangar-interior', [0.68, 0.035, 0.25], [-0.18, -0.455, 0], p.glass);
}

function addApolloDetail(root: THREE.Group, p: DetailPalette): void {
  for (const x of [0.18, 0.42, 0.66, 0.9]) addRingX(root, `apollo-detail-command-panel-ring-${x}`, x, 0, 0, 0.63 - x * 0.28, 0.012, p.seam);
  for (const zSign of [-1, 1]) {
    addBox(root, `apollo-detail-window-bezel-${zSign}`, [0.18, 0.17, 0.04], [0.76, 0.32, zSign * 0.42], p.glass, [0, zSign * 0.3, 0]);
    addRod(root, `apollo-detail-umbilical-${zSign}`, [-1.35, 0.45, zSign * 0.3], [-0.12, 0.5, zSign * 0.3], 0.016, p.accent);
  }
  for (let bay = 0; bay < 6; bay++) {
    addBox(root, `apollo-detail-service-louver-${bay}`, [0.24, 0.025, 0.11], [-1.2 + bay * 0.2, 0.69, 0], bay % 2 ? p.panel : p.seam);
  }
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    addSphere(root, `apollo-detail-sps-rib-${i}`, 0.035, [-1.88, Math.cos(angle) * 0.25, Math.sin(angle) * 0.25], [1.6, 0.5, 0.5], p.pale);
  }
}

function addNabooDetail(root: THREE.Group, p: DetailPalette): void {
  for (const zSign of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      addRingX(root, `naboo-detail-engine-segment-${zSign}-${i}`, -0.82 + i * 0.23, 0, zSign * 1.03, 0.27, 0.01, i % 3 === 0 ? p.accent : p.seam);
    }
    addRod(root, `naboo-detail-wing-inlay-${zSign}`, [-0.82, 0.1, zSign * 0.78], [0.5, 0.1, zSign * 0.3], 0.018, p.pale);
    addNavLights(root, `naboo-detail-finial-light-${zSign}`, [[-2.22, 0, zSign * 1.03]], p.light);
  }
  for (const x of [-0.55, -0.2, 0.15, 0.5]) addBox(root, `naboo-detail-fuselage-inlay-${x}`, [0.24, 0.025, 0.15], [x, 0.405, 0], x === 0.15 ? p.accent : p.panel);
  addWindowRow(root, 'naboo-detail-canopy-frame', [[0.42, 0.5, -0.18], [0.42, 0.5, 0], [0.42, 0.5, 0.18]], [0.03, 0.14, 0.035], p.pale);
}

function addYWingDetail(root: THREE.Group, p: DetailPalette): void {
  for (const zSign of [-1, 1]) {
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      addRod(root, `ywing-detail-exposed-pipe-${zSign}-${i}`, [0.35, Math.cos(angle) * 0.35, zSign * 0.95 + Math.sin(angle) * 0.35], [-1.42, Math.cos(angle) * 0.35, zSign * 0.95 + Math.sin(angle) * 0.35], 0.012, i % 3 === 0 ? p.accent : p.pale);
    }
    for (const x of [-1.08, -0.68, -0.28, 0.12, 0.52]) addRingX(root, `ywing-detail-nacelle-rib-${zSign}-${x}`, x, 0, zSign * 0.95, 0.34, 0.012, p.seam);
  }
  for (let i = 0; i < 6; i++) addBox(root, `ywing-detail-neck-greeble-${i}`, [0.18, 0.08, 0.16], [-0.55 + i * 0.22, 0.2, i % 2 ? -0.18 : 0.18], i % 3 === 0 ? p.accent : p.panel);
  addWindowRow(root, 'ywing-detail-canopy-frame', [[0.88, 0.55, -0.18], [0.88, 0.55, 0], [0.88, 0.55, 0.18]], [0.03, 0.15, 0.035], p.pale);
}

function addEnterpriseDetail(root: THREE.Group, p: DetailPalette): void {
  // Concentric aztec-like panel bands and radial seams break up the saucer.
  for (const radius of [0.42, 0.72, 1.02]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.014, 6, 64), radius === 0.72 ? p.accent : p.seam);
    ring.name = `enterprise-detail-saucer-panel-ring-${radius}`;
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0.87, 0.225, 0);
    root.add(ring);
  }
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2;
    addRod(root, `enterprise-detail-saucer-seam-${i}`, [0.87 + Math.cos(angle) * 0.45, 0.228, Math.sin(angle) * 0.45], [0.87 + Math.cos(angle) * 1.2, 0.228, Math.sin(angle) * 1.2], 0.009, i % 4 === 0 ? p.accent : p.seam);
  }
  for (const zSign of [-1, 1]) {
    addWindowRow(root, `enterprise-detail-rim-window-${zSign}`, [-0.05, 0.25, 0.55, 0.85, 1.15, 1.45].map((x) => [x, 0.11, zSign * Math.sqrt(Math.max(0.1, 1.55 - (x - 0.87) ** 2))] as [number, number, number]), [0.07, 0.035, 0.025], p.light);
    for (const x of [-1.38, -1.03, -0.68, -0.33, 0.02]) addBox(root, `enterprise-detail-nacelle-grille-${zSign}-${x}`, [0.23, 0.035, 0.13], [x, 0.515, zSign * 1.28], p.light);
    addRod(root, `enterprise-detail-pylon-conduit-${zSign}`, [-1.03, 0.12, zSign * 0.22], [-0.48, 0.25, zSign * 1.15], 0.015, p.seam);
  }
  addRingX(root, 'enterprise-detail-deflector-rib-outer', 0.39, -0.48, 0, 0.27, 0.018, p.pale);
  addRingX(root, 'enterprise-detail-deflector-rib-inner', 0.4, -0.48, 0, 0.14, 0.014, p.seam);
  addSphere(root, 'enterprise-detail-bridge-sensor', 0.07, [1.01, 0.32, 0], [1.3, 0.4, 1], p.light);
}

function addVoyagerDetail(root: THREE.Group, p: DetailPalette): void {
  // Broad dark dorsal insets and warm hull plates match the supplied studio
  // model reference and are the largest visual improvement over the old toy.
  addTopPlate(root, 'voyager-detail-dorsal-spine', [[-0.72, -0.16], [1.48, -0.12], [1.7, 0], [1.48, 0.12], [-0.72, 0.16]], 0.335, 0.035, p.seam);
  for (const zSign of [-1, 1]) {
    addTopPlate(root, `voyager-detail-dark-dorsal-field-${zSign}`, [
      [-0.48, zSign * 0.18], [0.35, zSign * 0.3], [1.42, zSign * 0.18],
      [1.2, zSign * 0.52], [0.4, zSign * 0.7], [-0.34, zSign * 0.58],
    ], 0.31, 0.03, p.glass);
    addTopPlate(root, `voyager-detail-shoulder-panel-${zSign}`, [
      [-0.38, zSign * 0.6], [0.32, zSign * 0.72], [1.18, zSign * 0.52],
      [0.82, zSign * 0.79], [0.14, zSign * 0.84],
    ], 0.32, 0.028, p.pale);
    addRod(root, `voyager-detail-phaser-strip-${zSign}`, [-0.38, 0.37, zSign * 0.66], [0.82, 0.37, zSign * 0.78], 0.025, p.accent);
    addRod(root, `voyager-detail-forward-array-${zSign}`, [0.82, 0.37, zSign * 0.76], [1.48, 0.31, zSign * 0.38], 0.018, p.seam);

    // Escape pods and windows provide a human scale cue around the hull rim.
    for (let i = 0; i < 9; i++) {
      const x = -0.28 + i * 0.19;
      const z = zSign * (0.72 - Math.abs(x - 0.45) * 0.13);
      addBox(root, `voyager-detail-escape-pod-${zSign}-${i}`, [0.085, 0.026, 0.055], [x, 0.335, z], i % 4 === 0 ? p.accent : p.pale, [0, zSign * -0.12, 0]);
      addBox(root, `voyager-detail-rim-window-${zSign}-${i}`, [0.055, 0.035, 0.025], [x + 0.04, 0.205, zSign * (Math.abs(z) + 0.075)], p.light, [0, zSign * -0.12, 0]);
    }

    // Segmented plasma grilles, radiator ribs, and variable-pylon actuators.
    for (let i = 0; i < 7; i++) {
      const x = -1.72 + i * 0.22;
      addBox(root, `voyager-detail-nacelle-plasma-grille-${zSign}-${i}`, [0.15, 0.035, 0.12], [x, 0.365, zSign * 1.08], p.light);
      addRingX(root, `voyager-detail-nacelle-frame-${zSign}-${i}`, x, 0.16, zSign * 1.08, 0.225, 0.009, p.seam);
    }
    addSphere(root, `voyager-detail-pylon-actuator-${zSign}`, 0.08, [-1.05, 0.04, zSign * 0.65], [1.8, 0.55, 1], p.accent);
    addRod(root, `voyager-detail-pylon-conduit-${zSign}`, [-0.72, 0.04, zSign * 0.3], [-1.22, 0.04, zSign * 0.98], 0.018, p.seam);
    addNavLights(root, `voyager-detail-navigation-light-${zSign}`, [[0.1, 0.37, zSign * 0.86], [-1.78, 0.22, zSign * 1.08]], p.light);
  }
  addRingX(root, 'voyager-detail-deflector-vane-outer', 0.17, -0.35, 0, 0.24, 0.015, p.pale);
  addRingX(root, 'voyager-detail-deflector-vane-inner', 0.18, -0.35, 0, 0.12, 0.012, p.seam);
  addBox(root, 'voyager-detail-bridge-module', [0.32, 0.045, 0.24], [0.85, 0.49, 0], p.pale);
  addSphere(root, 'voyager-detail-bridge-sensor-dome', 0.065, [0.87, 0.53, 0], [1.4, 0.35, 1], p.light);
  for (const z of [-0.18, -0.06, 0.06, 0.18]) addBox(root, `voyager-detail-shuttle-bay-rib-${z}`, [0.36, 0.025, 0.025], [-1.52, -0.43, z], p.pale);
}

function addKlingonDetail(root: THREE.Group, p: DetailPalette): void {
  for (const zSign of [-1, 1]) {
    for (let i = 0; i < 8; i++) {
      addTopPlate(root, `klingon-detail-feather-plate-${zSign}-${i}`, [
        [-0.35 - i * 0.13, zSign * (0.48 + i * 0.17)],
        [-0.7 - i * 0.13, zSign * (0.58 + i * 0.17)],
        [-0.84 - i * 0.13, zSign * (0.73 + i * 0.17)],
        [-0.45 - i * 0.13, zSign * (0.65 + i * 0.17)],
      ], 0.16, 0.025, i % 3 === 0 ? p.accent : p.panel);
    }
    addRod(root, `klingon-detail-wing-spine-${zSign}`, [-0.3, 0.18, zSign * 0.42], [-1.48, 0.18, zSign * 1.8], 0.022, p.accent);
    addBox(root, `klingon-detail-disruptor-cooling-${zSign}`, [0.58, 0.06, 0.1], [-0.7, 0.08, zSign * 1.83], p.seam);
    addNavLights(root, `klingon-detail-disruptor-light-${zSign}`, [[0.02, 0, zSign * 1.84]], p.light);
  }
  for (let i = 0; i < 7; i++) addBox(root, `klingon-detail-neck-plate-${i}`, [0.13, 0.035, 0.28], [0.08 + i * 0.18, 0.105, 0], i % 2 ? p.seam : p.accent);
  addWindowRow(root, 'klingon-detail-command-window', [[1.62, 0.25, -0.22], [1.72, 0.25, 0], [1.62, 0.25, 0.22]], [0.08, 0.035, 0.08], p.light);
  addSphere(root, 'klingon-detail-cloaking-emitter', 0.11, [-0.52, 0.43, 0], [1.4, 0.38, 1], p.light);
}

function addRomulanDetail(root: THREE.Group, p: DetailPalette): void {
  for (const zSign of [-1, 1]) {
    for (let i = 0; i < 9; i++) {
      const x = -0.16 - i * 0.17;
      const z = zSign * (0.52 + i * 0.16);
      addBox(root, `romulan-detail-dorsal-feather-${zSign}-${i}`, [0.42, 0.032, 0.11], [x, 0.48, z], i % 3 === 0 ? p.accent : p.pale, [0, zSign * -0.42, 0]);
      if (i < 6) addBox(root, `romulan-detail-ventral-feather-${zSign}-${i}`, [0.34, 0.03, 0.1], [x - 0.3, -0.56, z - zSign * 0.06], p.accent, [0, zSign * -0.38, 0]);
    }
    addRod(root, `romulan-detail-nacelle-conduit-${zSign}`, [-1.45, 0.28, zSign * 1.82], [-0.2, 0.28, zSign * 1.82], 0.018, p.light);
    addNavLights(root, `romulan-detail-wingtip-emitter-${zSign}`, [[-1.62, 0.16, zSign * 1.84]], p.light);
  }
  for (let i = 0; i < 8; i++) addBox(root, `romulan-detail-neck-segment-${i}`, [0.15, 0.035, 0.25], [-0.02 + i * 0.19, 0.18, 0], i % 2 ? p.seam : p.accent);
  addWindowRow(root, 'romulan-detail-command-window', [[1.72, 0.22, -0.25], [1.83, 0.22, 0], [1.72, 0.22, 0.25]], [0.08, 0.035, 0.07], p.light);
  addSphere(root, 'romulan-detail-cloaking-core', 0.13, [-1.28, 0, 0], [1.8, 0.42, 1], p.light);
}

function addPanelGrid(
  root: THREE.Group,
  prefix: string,
  xs: number[],
  zs: number[],
  y: number,
  size: [number, number, number],
  primary: SurfaceMaterial,
  contrast: SurfaceMaterial,
): void {
  let index = 0;
  for (const x of xs) {
    for (const z of zs) {
      addBox(root, `${prefix}-${++index}`, size, [x, y, z], index % 4 === 0 ? contrast : primary);
    }
  }
}

/**
 * Underside treatment is intentionally separate and named. It prevents the
 * common procedural-model failure where a detailed dorsal view turns into a
 * blank plastic shell as soon as the player rolls or pitches past the craft.
 */
function addVentralDetail(profile: FleetProfile, root: THREE.Group, p: DetailPalette): void {
  switch (profile) {
    case 'shuttle': {
      addPanelGrid(root, 'shuttle-ventral-thermal-tile', [-1.1, -0.7, -0.3, 0.1, 0.5, 0.9], [-0.25, 0.25], -0.515, [0.3, 0.018, 0.2], p.seam, p.panel);
      for (const zSign of [-1, 1]) {
        for (let i = 0; i < 5; i++) addBox(root, `shuttle-ventral-wing-tile-${zSign}-${i}`, [0.24, 0.018, 0.28], [0.28 - i * 0.34, -0.125, zSign * (0.55 + i * 0.2)], p.seam, [0, zSign * 0.05, 0]);
        addRod(root, `shuttle-ventral-landing-gear-door-${zSign}`, [0.78, -0.52, zSign * 0.24], [1.2, -0.42, zSign * 0.32], 0.018, p.pale);
      }
      break;
    }
    case 'soyuz': {
      addPanelGrid(root, 'soyuz-ventral-blanket', [-1.18, -0.88, -0.58, -0.28], [-0.22, 0.22], -0.49, [0.2, 0.025, 0.18], p.panel, p.accent);
      for (const zSign of [-1, 1]) {
        addRod(root, `soyuz-ventral-service-line-${zSign}`, [-1.3, -0.38, zSign * 0.28], [-0.26, -0.38, zSign * 0.28], 0.016, p.pale);
        addSphere(root, `soyuz-ventral-thruster-cluster-${zSign}`, 0.065, [-1.33, -0.28, zSign * 0.3], [1.4, 0.7, 1], p.seam);
      }
      addBox(root, 'soyuz-ventral-descent-heat-shield-lock', [0.18, 0.025, 0.32], [-0.18, -0.46, 0], p.seam);
      break;
    }
    case 'falcon': {
      for (let ring = 0; ring < 2; ring++) {
        for (let i = 0; i < 12; i++) {
          const angle = (i / 12) * Math.PI * 2 + ring * 0.14;
          const radius = 0.55 + ring * 0.48;
          addBox(root, `falcon-ventral-maintenance-panel-${ring}-${i}`, [0.24, 0.022, 0.13], [-0.2 + Math.cos(angle) * radius, -0.305, Math.sin(angle) * radius], i % 5 === 0 ? p.accent : p.seam, [0, -angle, 0]);
        }
      }
      addRingX(root, 'falcon-ventral-cannon-turret-ring', -0.08, -0.33, 0, 0.22, 0.024, p.pale);
      addBox(root, 'falcon-ventral-cannon-turret', [0.25, 0.16, 0.25], [-0.08, -0.4, 0], p.panel);
      for (const zSign of [-1, 1]) addBox(root, `falcon-ventral-landing-gear-bay-${zSign}`, [0.42, 0.035, 0.25], [0.42, -0.32, zSign * 0.72], p.seam);
      break;
    }
    case 'saucer': {
      for (let i = 0; i < 20; i++) {
        const angle = (i / 20) * Math.PI * 2;
        addBox(root, `saucer-ventral-field-coil-${i}`, [0.32, 0.025, 0.07], [Math.cos(angle) * 0.96, -0.36, Math.sin(angle) * 0.96], i % 4 === 0 ? p.accent : p.panel, [0, -angle, 0]);
      }
      for (const radius of [0.48, 0.76, 1.12]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.018, 6, 48), radius === 0.76 ? p.light : p.seam);
        ring.name = `saucer-ventral-gravity-ring-${radius}`;
        ring.rotation.x = Math.PI / 2;
        ring.position.y = -0.37;
        root.add(ring);
      }
      break;
    }
    case 'starship': {
      addPanelGrid(root, 'starship-ventral-heat-tile', [-1.48, -1.2, -0.92, -0.64, -0.36, -0.08, 0.2, 0.48, 0.76], [-0.32, 0, 0.32], -0.522, [0.2, 0.018, 0.18], p.seam, p.panel);
      for (const zSign of [-1, 1]) {
        addRod(root, `starship-ventral-flap-hinge-line-${zSign}`, [-1.88, -0.1, zSign * 0.48], [-1.35, -0.1, zSign * 0.37], 0.018, p.accent);
        addBox(root, `starship-ventral-aft-service-port-${zSign}`, [0.18, 0.04, 0.12], [-1.73, -0.46, zSign * 0.25], p.pale);
      }
      break;
    }
    case 'dragon': {
      addPanelGrid(root, 'dragon-ventral-trunk-radiator', [-1.38, -1.05, -0.72, -0.39], [-0.28, 0.28], -0.67, [0.24, 0.022, 0.24], p.panel, p.seam);
      for (const zSign of [-1, 1]) {
        addRod(root, `dragon-ventral-trunk-pipe-${zSign}`, [-1.48, -0.52, zSign * 0.4], [-0.36, -0.63, zSign * 0.46], 0.016, p.pale);
        for (let i = 0; i < 3; i++) addSphere(root, `dragon-ventral-draco-port-${zSign}-${i}`, 0.04, [0.2 + i * 0.18, -0.56, zSign * 0.35], [1.2, 0.6, 1], p.seam);
      }
      addRingX(root, 'dragon-ventral-heat-shield-seal', -0.31, 0, 0, 0.62, 0.016, p.accent);
      break;
    }
    case 'orion': {
      addPanelGrid(root, 'orion-ventral-service-panel', [-0.82, -0.54, -0.26, 0.02], [-0.28, 0.28], -0.685, [0.22, 0.022, 0.22], p.panel, p.seam);
      for (const zSign of [-1, 1]) {
        addRod(root, `orion-ventral-service-line-${zSign}`, [-0.86, -0.56, zSign * 0.36], [0.14, -0.56, zSign * 0.36], 0.016, p.accent);
        addBox(root, `orion-ventral-rcs-cluster-${zSign}`, [0.18, 0.1, 0.15], [0.2, -0.58, zSign * 0.32], p.seam);
      }
      addBox(root, 'orion-ventral-crew-hatch', [0.28, 0.024, 0.28], [0.72, -0.56, 0], p.seam);
      break;
    }
    case 'starliner': {
      addPanelGrid(root, 'starliner-ventral-service-panel', [-0.48, -0.22, 0.04], [-0.45, 0, 0.45], -0.82, [0.2, 0.022, 0.22], p.panel, p.seam);
      for (const zSign of [-1, 1]) {
        addRod(root, `starliner-ventral-fluid-line-${zSign}`, [-0.58, -0.66, zSign * 0.46], [0.72, -0.52, zSign * 0.38], 0.015, p.accent);
        addBox(root, `starliner-ventral-airbag-cover-${zSign}`, [0.28, 0.025, 0.24], [0.46, -0.63, zSign * 0.28], p.seam);
      }
      addRingX(root, 'starliner-ventral-heat-shield-seal', -0.58, 0, 0, 0.75, 0.018, p.pale);
      break;
    }
    case 'dreamChaser': {
      addPanelGrid(root, 'dream-chaser-ventral-thermal-tile', [-1.12, -0.8, -0.48, -0.16, 0.16, 0.48, 0.8, 1.12], [-0.36, 0, 0.36], -0.25, [0.24, 0.018, 0.2], p.seam, p.panel);
      for (const zSign of [-1, 1]) {
        addRod(root, `dream-chaser-ventral-elevon-seam-${zSign}`, [-1.25, -0.24, zSign * 0.62], [-0.45, -0.24, zSign * 1.08], 0.016, p.pale);
        addBox(root, `dream-chaser-ventral-gear-door-${zSign}`, [0.42, 0.022, 0.2], [0.38, -0.27, zSign * 0.32], p.accent);
      }
      break;
    }
    case 'xwing': {
      for (const ySign of [-1, 1]) {
        for (const zSign of [-1, 1]) {
          for (let i = 0; i < 4; i++) addBox(root, `xwing-ventral-sfoil-panel-${ySign}-${zSign}-${i}`, [0.24, 0.02, 0.22], [-0.72 + i * 0.34, ySign * 0.39, zSign * (0.56 + i * 0.13)], i === 1 ? p.accent : p.seam, [ySign * zSign * 0.19, 0, 0]);
        }
      }
      for (const zSign of [-1, 1]) addRod(root, `xwing-ventral-fuselage-conduit-${zSign}`, [-0.78, -0.3, zSign * 0.28], [0.85, -0.3, zSign * 0.28], 0.015, p.pale);
      addBox(root, 'xwing-ventral-torpedo-bay', [0.58, 0.035, 0.32], [0.45, -0.37, 0], p.seam);
      break;
    }
    case 'tie': {
      for (const zSign of [-1, 1]) {
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2;
          addBox(root, `tie-ventral-solar-cell-${zSign}-${i}`, [0.2, 0.025, 0.12], [Math.cos(angle) * 0.72, Math.sin(angle) * 0.72, zSign * 1.49], i % 2 ? p.panel : p.seam, [0, 0, angle]);
        }
      }
      for (const z of [-0.28, 0, 0.28]) addBox(root, `tie-ventral-cockpit-hatch-${z}`, [0.3, 0.025, 0.18], [-0.1, -0.64, z], p.seam);
      addSphere(root, 'tie-ventral-sensor-blister', 0.09, [0.22, -0.63, 0], [1.4, 0.45, 1], p.light);
      break;
    }
    case 'starDestroyer': {
      for (const zSign of [-1, 1]) {
        for (let row = 0; row < 3; row++) {
          for (let i = 0; i < 7; i++) {
            const x = -1.15 + i * 0.4;
            addBox(root, `star-destroyer-ventral-trench-${zSign}-${row}-${i}`, [0.27, 0.022, 0.08], [x, -0.405 - row * 0.01, zSign * (0.22 + row * 0.2 + (1 - x) * 0.1)], (i + row) % 4 === 0 ? p.pale : p.seam, [0, zSign * -0.22, 0]);
          }
        }
      }
      for (const z of [-0.22, -0.11, 0, 0.11, 0.22]) addBox(root, `star-destroyer-ventral-hangar-light-${z}`, [0.5, 0.02, 0.025], [-0.18, -0.47, z], p.light);
      addSphere(root, 'star-destroyer-ventral-reactor-dome', 0.18, [-0.62, -0.43, 0], [1.35, 0.38, 1], p.panel);
      break;
    }
    case 'apollo': {
      addPanelGrid(root, 'apollo-ventral-service-bay', [-1.28, -1, -0.72, -0.44, -0.16], [-0.28, 0.28], -0.68, [0.22, 0.022, 0.21], p.panel, p.accent);
      for (const zSign of [-1, 1]) {
        addRod(root, `apollo-ventral-umbilical-${zSign}`, [-1.3, -0.52, zSign * 0.34], [-0.12, -0.52, zSign * 0.34], 0.016, p.pale);
        addBox(root, `apollo-ventral-rcs-quad-${zSign}`, [0.18, 0.1, 0.15], [-0.22, -0.63, zSign * 0.28], p.seam);
      }
      addRingX(root, 'apollo-ventral-command-heat-shield-seal', 0.03, 0, 0, 0.65, 0.016, p.seam);
      break;
    }
    case 'naboo': {
      addPanelGrid(root, 'naboo-ventral-fuselage-panel', [-0.62, -0.3, 0.02, 0.34, 0.66], [-0.18, 0.18], -0.405, [0.24, 0.018, 0.14], p.panel, p.accent);
      for (const zSign of [-1, 1]) {
        for (const x of [-0.68, -0.28, 0.12, 0.52]) addBox(root, `naboo-ventral-engine-panel-${zSign}-${x}`, [0.24, 0.02, 0.12], [x, -0.3, zSign * 1.03], x === 0.12 ? p.accent : p.seam);
        addRod(root, `naboo-ventral-wing-inlay-${zSign}`, [-0.78, -0.08, zSign * 0.77], [0.48, -0.08, zSign * 0.3], 0.016, p.pale);
      }
      break;
    }
    case 'ywing': {
      for (const zSign of [-1, 1]) {
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2 + Math.PI / 8;
          addRod(root, `ywing-ventral-engine-pipe-${zSign}-${i}`, [0.38, Math.cos(angle) * 0.34, zSign * 0.95 + Math.sin(angle) * 0.34], [-1.42, Math.cos(angle) * 0.34, zSign * 0.95 + Math.sin(angle) * 0.34], 0.012, i % 3 === 0 ? p.accent : p.pale);
        }
        for (const x of [-0.48, -0.16, 0.16, 0.48]) addBox(root, `ywing-ventral-arm-greeble-${zSign}-${x}`, [0.19, 0.07, 0.14], [x, -0.21, zSign * 0.72], p.seam);
      }
      addBox(root, 'ywing-ventral-bomb-bay', [0.72, 0.035, 0.38], [0.38, -0.39, 0], p.seam);
      break;
    }
    case 'enterprise': {
      for (const radius of [0.45, 0.76, 1.08]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.013, 6, 64), radius === 0.76 ? p.accent : p.seam);
        ring.name = `enterprise-ventral-saucer-panel-ring-${radius}`;
        ring.rotation.x = Math.PI / 2;
        ring.position.set(0.87, -0.115, 0);
        root.add(ring);
      }
      for (let i = 0; i < 16; i++) {
        const angle = (i / 16) * Math.PI * 2;
        addRod(root, `enterprise-ventral-saucer-seam-${i}`, [0.87 + Math.cos(angle) * 0.48, -0.118, Math.sin(angle) * 0.48], [0.87 + Math.cos(angle) * 1.2, -0.118, Math.sin(angle) * 1.2], 0.009, i % 4 === 0 ? p.accent : p.seam);
      }
      for (const zSign of [-1, 1]) addWindowRow(root, `enterprise-ventral-window-${zSign}`, [-1.15, -0.82, -0.49, -0.16].map((x) => [x, -0.86, zSign * 0.34] as [number, number, number]), [0.065, 0.035, 0.025], p.light);
      addBox(root, 'enterprise-ventral-photon-launcher', [0.22, 0.06, 0.18], [0.08, -0.78, 0], p.accent);
      break;
    }
    case 'ussVoyager': {
      for (const zSign of [-1, 1]) {
        addTopPlate(root, `voyager-ventral-primary-field-${zSign}`, [
          [-0.52, zSign * 0.17], [0.35, zSign * 0.27], [1.48, zSign * 0.15],
          [1.2, zSign * 0.48], [0.34, zSign * 0.67], [-0.4, zSign * 0.54],
        ], -0.015, 0.026, p.glass);
        addRod(root, `voyager-ventral-phaser-strip-${zSign}`, [-0.35, -0.05, zSign * 0.62], [0.82, -0.05, zSign * 0.73], 0.023, p.accent);
        for (let i = 0; i < 8; i++) {
          const x = -0.28 + i * 0.21;
          addBox(root, `voyager-ventral-escape-pod-${zSign}-${i}`, [0.08, 0.024, 0.05], [x, -0.045, zSign * (0.7 - Math.abs(x - 0.42) * 0.12)], i % 4 === 0 ? p.accent : p.pale);
          addBox(root, `voyager-ventral-window-${zSign}-${i}`, [0.052, 0.03, 0.024], [x, -0.13, zSign * (0.76 - Math.abs(x - 0.42) * 0.1)], p.light);
        }
        for (let i = 0; i < 6; i++) addBox(root, `voyager-ventral-nacelle-radiator-${zSign}-${i}`, [0.16, 0.03, 0.11], [-1.68 + i * 0.24, -0.04, zSign * 1.08], i % 2 ? p.panel : p.seam);
      }
      addPanelGrid(root, 'voyager-ventral-secondary-hull-panel', [-1.42, -1.08, -0.74, -0.4, -0.06], [-0.24, 0.24], -0.63, [0.24, 0.022, 0.16], p.panel, p.seam);
      for (const z of [-0.2, -0.1, 0, 0.1, 0.2]) addBox(root, `voyager-ventral-shuttle-bay-light-${z}`, [0.38, 0.022, 0.024], [-1.52, -0.45, z], p.light);
      break;
    }
    case 'klingon': {
      for (const zSign of [-1, 1]) {
        for (let i = 0; i < 8; i++) {
          addTopPlate(root, `klingon-ventral-feather-plate-${zSign}-${i}`, [
            [-0.36 - i * 0.13, zSign * (0.48 + i * 0.17)],
            [-0.7 - i * 0.13, zSign * (0.58 + i * 0.17)],
            [-0.84 - i * 0.13, zSign * (0.73 + i * 0.17)],
            [-0.45 - i * 0.13, zSign * (0.65 + i * 0.17)],
          ], -0.15, 0.023, i % 3 === 0 ? p.accent : p.seam);
        }
        addRod(root, `klingon-ventral-wing-spar-${zSign}`, [-0.3, -0.18, zSign * 0.42], [-1.48, -0.18, zSign * 1.8], 0.021, p.pale);
      }
      addPanelGrid(root, 'klingon-ventral-body-plate', [-1.22, -0.9, -0.58, -0.26], [-0.3, 0.3], -0.4, [0.22, 0.024, 0.18], p.panel, p.seam);
      addSphere(root, 'klingon-ventral-cloaking-emitter', 0.1, [-0.52, -0.43, 0], [1.4, 0.4, 1], p.light);
      break;
    }
    case 'romulan': {
      for (const zSign of [-1, 1]) {
        for (let i = 0; i < 9; i++) {
          const x = -0.16 - i * 0.17;
          const z = zSign * (0.52 + i * 0.16);
          addBox(root, `romulan-ventral-feather-panel-${zSign}-${i}`, [0.38, 0.03, 0.1], [x - 0.22, -0.515, z], i % 3 === 0 ? p.accent : p.panel, [0, zSign * -0.4, 0]);
        }
        addRod(root, `romulan-ventral-nacelle-conduit-${zSign}`, [-1.45, -0.1, zSign * 1.82], [-0.2, -0.1, zSign * 1.82], 0.017, p.light);
      }
      for (const z of [-0.5, -0.25, 0, 0.25, 0.5]) addBox(root, `romulan-ventral-aft-emitter-${z}`, [0.28, 0.028, 0.1], [-1.5, -0.53, z], p.accent);
      addSphere(root, 'romulan-ventral-cloaking-core', 0.12, [-1.25, -0.55, 0], [1.7, 0.4, 1], p.light);
      break;
    }
  }
}

type AftPort = [x: number, y: number, z: number, radius: number];

function aftPortsFor(profile: FleetProfile): AftPort[] {
  switch (profile) {
    case 'shuttle': return [[-1.925, -0.08, -0.29, 0.105], [-1.925, -0.08, 0, 0.105], [-1.925, -0.08, 0.29, 0.105], [-1.55, 0.28, -0.46, 0.075], [-1.55, 0.28, 0.46, 0.075]];
    case 'soyuz': return [[-1.54, -0.18, -0.25, 0.06], [-1.54, -0.18, 0, 0.07], [-1.54, -0.18, 0.25, 0.06]];
    case 'falcon': {
      return [-1.08, -0.72, -0.36, 0, 0.36, 0.72, 1.08].map((z) => [
        -0.12 - Math.sqrt(1.48 * 1.48 - z * z) - 0.03, 0, z, 0.075,
      ] as AftPort);
    }
    case 'saucer': return [-1.2, -0.8, -0.4, 0, 0.4, 0.8, 1.2].map((z) => [-Math.sqrt(1.65 * 1.65 - z * z), -0.08, z, 0.07]);
    case 'starship': return [[-2.39, 0.16, 0, 0.07], [-2.39, -0.08, -0.14, 0.07], [-2.39, -0.08, 0.14, 0.07], [-2.44, 0.34, 0, 0.105], [-2.44, -0.17, -0.29, 0.105], [-2.44, -0.17, 0.29, 0.105]];
    case 'dragon': return [[-1.58, -0.34, -0.38, 0.065], [-1.58, -0.34, 0.38, 0.065], [-1.58, 0.34, -0.38, 0.065], [-1.58, 0.34, 0.38, 0.065]];
    case 'orion': return [[-1.38, 0, 0, 0.14], [-0.98, -0.42, -0.32, 0.045], [-0.98, -0.42, 0.32, 0.045]];
    case 'starliner': return [-0.52, -0.26, 0, 0.26, 0.52].map((z) => [-0.83, -0.42, z, 0.055]);
    case 'dreamChaser': return [[-1.63, 0.02, -0.36, 0.1], [-1.63, 0.02, 0.36, 0.1], [-1.5, -0.16, 0, 0.065]];
    case 'xwing': return [[-0.94, -0.44, -0.64, 0.12], [-0.94, -0.44, 0.64, 0.12], [-0.94, 0.44, -0.64, 0.12], [-0.94, 0.44, 0.64, 0.12]];
    case 'tie': return [[-0.68, 0, -0.22, 0.08], [-0.68, 0, 0.22, 0.08]];
    case 'starDestroyer': return [[-1.75, 0, -0.36, 0.135], [-1.75, 0, 0, 0.135], [-1.75, 0, 0.36, 0.135], [-1.65, -0.22, -0.2, 0.06], [-1.65, -0.22, 0.2, 0.06], [-1.65, 0.22, -0.2, 0.06], [-1.65, 0.22, 0.2, 0.06]];
    case 'apollo': return [[-1.92, 0, 0, 0.25], [-1.48, -0.38, -0.34, 0.045], [-1.48, -0.38, 0.34, 0.045]];
    case 'naboo': return [[-1.16, 0, -1.03, 0.19], [-1.16, 0, 1.03, 0.19], [-2.04, 0, 0, 0.055]];
    case 'ywing': return [[-1.6, 0, -0.95, 0.22], [-1.6, 0, 0.95, 0.22]];
    case 'enterprise': return [[-1.79, 0.36, -1.28, 0.15], [-1.79, 0.36, 1.28, 0.15], [-1.72, -0.48, 0, 0.08]];
    case 'ussVoyager': return [[-1.95, 0.16, -1.08, 0.13], [-1.95, 0.16, 1.08, 0.13], [-1.88, -0.2, -0.28, 0.08], [-1.88, -0.2, 0.28, 0.08]];
    case 'klingon': return [[-1.95, 0, -0.54, 0.16], [-1.95, 0, 0.54, 0.16], [-1.72, 0.2, 0, 0.09]];
    case 'romulan': return [[-1.64, 0.08, -1.82, 0.12], [-1.64, 0.08, 1.82, 0.12], [-1.78, 0.3, -0.3, 0.075], [-1.78, 0.3, 0, 0.075], [-1.78, 0.3, 0.3, 0.075]];
  }
}

function aftEnergyColors(profile: FleetProfile): [outer: number, core: number] {
  if (profile === 'tie') return [0xff4f45, 0xffd7b8];
  if (profile === 'klingon') return [0xff9b38, 0xffe4a3];
  if (profile === 'romulan') return [0x58f5a7, 0xd8ffe9];
  if (profile === 'saucer') return [0x5deaff, 0xe4feff];
  return [0x63bfff, 0xe7f8ff];
}

function addAftPropulsionDetail(profile: FleetProfile, root: THREE.Group, p: DetailPalette): FleetPropulsionState {
  const [outerColor, coreColor] = aftEnergyColors(profile);
  const outerMaterial = energyMaterial(outerColor, 0.82);
  const coreMaterial = energyMaterial(coreColor, 0.96);
  const haloMaterial = energyMaterial(outerColor, 0.16, true);
  const halos: THREE.Mesh[] = [];
  for (const [index, [x, y, z, radius]] of aftPortsFor(profile).entries()) {
    addRingX(root, `${profile}-aft-engine-housing-${index + 1}`, x + 0.012, y, z, radius * 1.22, Math.max(0.01, radius * 0.16), p.seam);

    const halo = new THREE.Mesh(new THREE.RingGeometry(radius * 0.92, radius * 1.72, 32), haloMaterial);
    halo.name = `${profile}-aft-engine-halo-${index + 1}`;
    halo.rotation.y = -Math.PI / 2;
    halo.position.set(x + 0.006, y, z);
    halo.renderOrder = 1;
    root.add(halo);
    halos.push(halo);

    const outer = new THREE.Mesh(new THREE.CircleGeometry(radius, 24), outerMaterial);
    outer.name = `${profile}-aft-engine-light-${index + 1}`;
    outer.rotation.y = -Math.PI / 2;
    outer.position.set(x, y, z);
    outer.renderOrder = 2;
    root.add(outer);

    const baffle = new THREE.Mesh(new THREE.RingGeometry(radius * 0.5, radius * 0.72, 24), p.seam);
    baffle.name = `${profile}-aft-engine-baffle-${index + 1}`;
    baffle.rotation.y = -Math.PI / 2;
    baffle.position.set(x - 0.003, y, z);
    baffle.renderOrder = 3;
    root.add(baffle);

    if (radius >= 0.085) {
      for (let vane = 0; vane < 3; vane++) {
        addBox(
          root,
          `${profile}-aft-engine-vane-${index + 1}-${vane + 1}`,
          [0.012, radius * 1.55, Math.max(0.012, radius * 0.09)],
          [x - 0.004, y, z],
          p.pale,
          [(vane / 3) * Math.PI, 0, 0],
        ).renderOrder = 4;
      }
    }

    const core = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.46, 20), coreMaterial);
    core.name = `${profile}-aft-engine-hot-core-${index + 1}`;
    core.rotation.y = -Math.PI / 2;
    core.position.set(x - 0.004, y, z);
    core.renderOrder = 5;
    root.add(core);
  }
  return { outerMaterial, coreMaterial, haloMaterial, halos };
}

/** Drive the non-Default engine internals without moving or rescaling the
 * ship. Powered flight brightens the nested cores and gives the additive halo
 * a restrained high-frequency shimmer; parked craft retain a low pilot glow. */
export function updateFleetPropulsion(
  model: THREE.Group,
  elapsedSeconds: number,
  powered: boolean,
  throttleFraction: number,
): void {
  const state = model.userData.fleetPropulsion as FleetPropulsionState | undefined;
  if (!state) return;
  const throttle = THREE.MathUtils.clamp(throttleFraction, 0, 1);
  const shimmer = powered ? Math.sin(elapsedSeconds * 17) * 0.025 : 0;
  state.outerMaterial.opacity = powered ? 0.72 + throttle * 0.2 + shimmer : 0.24;
  state.coreMaterial.opacity = powered ? 0.88 + throttle * 0.1 : 0.36;
  state.haloMaterial.opacity = powered ? 0.09 + throttle * 0.13 + shimmer * 0.6 : 0.025;
  const haloScale = powered ? 1 + throttle * 0.08 + shimmer : 0.96;
  for (const halo of state.halos) halo.scale.setScalar(haloScale);
}

/** Add researched, profile-specific secondary geometry without changing the
 * primary model's scale, orientation, or the Default ship implementation. */
export function addFleetSurfaceDetail(profile: FleetProfile, model: THREE.Group, referenceRadiusAU: number): THREE.Group {
  const root = new THREE.Group();
  root.name = `${profile}-high-detail`;
  root.scale.setScalar(referenceRadiusAU);
  root.userData.detailPass = 'secondary-geometry-v1';
  model.add(root);
  const palette = paletteFor(profile);

  switch (profile) {
    case 'shuttle': addShuttleDetail(root, palette); break;
    case 'soyuz': addSoyuzDetail(root, palette); break;
    case 'falcon': addFalconDetail(root, palette); break;
    case 'saucer': addSaucerDetail(root, palette); break;
    case 'starship': addStarshipDetail(root, palette); break;
    case 'dragon': addDragonDetail(root, palette); break;
    case 'orion': addOrionDetail(root, palette); break;
    case 'starliner': addStarlinerDetail(root, palette); break;
    case 'dreamChaser': addDreamChaserDetail(root, palette); break;
    case 'xwing': addXWingDetail(root, palette); break;
    case 'tie': addTieDetail(root, palette); break;
    case 'starDestroyer': addStarDestroyerDetail(root, palette); break;
    case 'apollo': addApolloDetail(root, palette); break;
    case 'naboo': addNabooDetail(root, palette); break;
    case 'ywing': addYWingDetail(root, palette); break;
    case 'enterprise': addEnterpriseDetail(root, palette); break;
    case 'ussVoyager': addVoyagerDetail(root, palette); break;
    case 'klingon': addKlingonDetail(root, palette); break;
    case 'romulan': addRomulanDetail(root, palette); break;
  }
  const ventralRoot = new THREE.Group();
  ventralRoot.name = `${profile}-ventral-detail`;
  ventralRoot.userData.coverage = 'underside';
  root.add(ventralRoot);
  addVentralDetail(profile, ventralRoot, palette);
  const aftRoot = new THREE.Group();
  aftRoot.name = `${profile}-aft-detail`;
  aftRoot.userData.coverage = 'rear-propulsion';
  root.add(aftRoot);
  model.userData.fleetPropulsion = addAftPropulsionDetail(profile, aftRoot, palette);
  model.userData.surfaceDetail = 'enhanced';
  model.userData.surfaceCoverage = 'all-sides';
  return applyFleetMicroSurface(profile, model);
}
