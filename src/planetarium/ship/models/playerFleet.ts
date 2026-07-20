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

  const fuselage = cylinderX(0.47 * U, 0.51 * U, 2.8 * U, 40, white);
  fuselage.name = 'shuttle-orbiter-fuselage';
  fuselage.position.x = -0.15 * U;
  group.add(fuselage);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.51 * U, 40, 24), white);
  nose.scale.set(1.65, 1, 1);
  nose.position.x = 1.35 * U;
  group.add(nose);
  const noseCap = new THREE.Mesh(new THREE.SphereGeometry(0.505 * U, 32, 18), black);
  noseCap.scale.set(0.35, 0.96, 0.96);
  noseCap.position.x = 1.72 * U;
  group.add(noseCap);

  // The delta wing and black belly establish the orbiter silhouette from the
  // everyday elevated chase view; the white inset leaves a visible tile edge.
  const wing = plateXZ([
    [0.72 * U, -0.42 * U], [-0.78 * U, -1.72 * U], [-1.48 * U, -1.62 * U],
    [-0.98 * U, -0.42 * U], [-1.35 * U, 0.42 * U], [-0.78 * U, 1.72 * U],
    [0.72 * U, 0.42 * U],
  ], 0.12 * U, black, 0.015 * U);
  wing.name = 'shuttle-delta-wing';
  wing.position.y = -0.05 * U;
  group.add(wing);
  const wingTop = plateXZ([
    [0.58 * U, -0.39 * U], [-0.76 * U, -1.56 * U], [-1.25 * U, -1.48 * U],
    [-0.86 * U, -0.4 * U], [-1.17 * U, 0.4 * U], [-0.76 * U, 1.56 * U],
    [0.58 * U, 0.39 * U],
  ], 0.045 * U, warmWhite, 0.01 * U);
  wingTop.position.y = 0.09 * U;
  group.add(wingTop);

  // Split payload doors, hinges, and bay seam.
  for (const z of [-0.27, 0.27]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.45 * U, 0.08 * U, 0.42 * U), warmWhite);
    door.position.set(-0.15 * U, 0.45 * U, z * U);
    door.rotation.x = z < 0 ? -0.08 : 0.08;
    group.add(door);
    for (const x of [-0.72, -0.32, 0.08, 0.48]) {
      const hinge = new THREE.Mesh(new THREE.BoxGeometry(0.07 * U, 0.035 * U, 0.07 * U), darkSteel);
      hinge.position.set(x * U, 0.505 * U, z * U);
      group.add(hinge);
    }
  }

  // Cockpit panes are separate, recessed pieces rather than one painted band.
  for (const [x, y, z, rz] of [
    [1.47, 0.36, -0.22, -0.32], [1.47, 0.36, 0.22, 0.32],
    [1.22, 0.43, -0.31, -0.18], [1.22, 0.43, 0.31, 0.18],
  ] as Array<[number, number, number, number]>) {
    const pane = new THREE.Mesh(new THREE.BoxGeometry(0.29 * U, 0.035 * U, 0.22 * U), windowMat);
    pane.position.set(x * U, y * U, z * U);
    pane.rotation.y = rz;
    group.add(pane);
  }

  const tail = plateXZ([
    [-0.6 * U, 0], [-1.52 * U, 0], [-1.32 * U, 0.93 * U], [-0.96 * U, 0.88 * U],
  ], 0.12 * U, white, 0.012 * U);
  tail.rotation.x = Math.PI / 2;
  tail.position.set(0, 0.03 * U, -0.06 * U);
  group.add(tail);
  const rudderStripe = new THREE.Mesh(new THREE.BoxGeometry(0.48 * U, 0.055 * U, 0.08 * U), red);
  rudderStripe.position.set(-1.08 * U, 0.66 * U, 0);
  rudderStripe.rotation.z = -0.3;
  group.add(rudderStripe);

  for (const z of [-0.29, 0, 0.29]) {
    const bell = new THREE.Mesh(createEngineBell(0.14 * U, 0.5 * U), darkSteel);
    bell.name = `shuttle-main-engine-${z}`;
    bell.rotation.z = -Math.PI / 2;
    bell.position.set(-1.7 * U, -0.08 * U, z * U);
    group.add(bell);
    addEngineGlow(group, -1.91 * U, -0.08 * U, z * U, 0.105 * U, engineGlow);
  }
  for (const z of [-0.46, 0.46]) {
    const pod = cylinderX(0.16 * U, 0.2 * U, 0.63 * U, 24, white);
    pod.position.set(-1.18 * U, 0.29 * U, z * U);
    group.add(pod);
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

  const service = cylinderX(0.48 * U, 0.48 * U, 1.18 * U, 28, foil);
  service.name = 'soyuz-instrumentation-propulsion-module';
  service.position.x = -0.77 * U;
  group.add(service);
  for (const x of [-1.28, -0.93, -0.58, -0.23]) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(0.49 * U, 0.025 * U, 8, 32), charcoal);
    rib.rotation.y = Math.PI / 2;
    rib.position.x = x * U;
    group.add(rib);
  }

  const descent = cylinderX(0.34 * U, 0.59 * U, 0.76 * U, 32, pale);
  descent.name = 'soyuz-descent-module';
  descent.position.x = 0.2 * U;
  group.add(descent);
  const heatShield = discX(0.59 * U, 0.08 * U, charcoal, 32);
  heatShield.position.x = -0.19 * U;
  group.add(heatShield);

  const orbital = new THREE.Mesh(new THREE.SphereGeometry(0.56 * U, 36, 24), foil);
  orbital.name = 'soyuz-orbital-module';
  orbital.scale.x = 1.14;
  orbital.position.x = 0.96 * U;
  group.add(orbital);
  const docking = cylinderX(0.13 * U, 0.13 * U, 0.45 * U, 20, charcoal);
  docking.position.x = 1.6 * U;
  group.add(docking);
  const dockingRing = new THREE.Mesh(new THREE.TorusGeometry(0.15 * U, 0.025 * U, 8, 24), pale);
  dockingRing.rotation.y = Math.PI / 2;
  dockingRing.position.x = 1.83 * U;
  group.add(dockingRing);
  for (const z of [-0.34, 0.34]) {
    const port = cylinderX(0.095 * U, 0.095 * U, 0.035 * U, 16, windowMat);
    port.position.set(0.98 * U, 0.25 * U, z * U);
    port.rotation.z = 0;
    port.rotation.x = Math.PI / 2;
    group.add(port);
  }

  // Four-section solar wings, with raised silver cell borders and hinges.
  for (const zSign of [-1, 1]) {
    const wing = new THREE.Group();
    wing.name = `soyuz-solar-wing-${zSign < 0 ? 'port' : 'starboard'}`;
    wing.position.set(-0.72 * U, 0, zSign * 0.5 * U);
    for (let i = 0; i < 4; i++) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.63 * U, 0.055 * U, 0.48 * U), solar);
      panel.position.z = zSign * (0.25 + i * 0.5) * U;
      wing.add(panel);
      const border = new THREE.Mesh(new THREE.BoxGeometry(0.65 * U, 0.018 * U, 0.025 * U), solarGrid);
      border.position.set(0, 0.04 * U, zSign * (0.25 + i * 0.5) * U);
      wing.add(border);
      for (const dx of [-0.2, 0, 0.2]) {
        const cellLine = new THREE.Mesh(new THREE.BoxGeometry(0.012 * U, 0.061 * U, 0.45 * U), solarGrid);
        cellLine.position.set(dx * U, 0.005 * U, zSign * (0.25 + i * 0.5) * U);
        wing.add(cellLine);
      }
    }
    group.add(wing);
  }

  const dish = new THREE.Mesh(createParabolicDishGeometry(0.22 * U, 0.08 * U), antenna);
  dish.rotation.z = -Math.PI / 2;
  dish.position.set(-1.05 * U, 0.5 * U, 0);
  group.add(dish);
  const mastStart = new THREE.Vector3(-1.05 * U, 0.4 * U, 0);
  const mastEnd = new THREE.Vector3(-1.05 * U, 0.78 * U, 0);
  group.add(createRodBetween(mastStart, mastEnd, 0.018 * U, antenna, 8));
  for (const z of [-0.25, 0, 0.25]) {
    const nozzle = cylinderX(0.055 * U, 0.075 * U, 0.16 * U, 14, charcoal);
    nozzle.position.set(-1.45 * U, -0.18 * U, z * U);
    group.add(nozzle);
  }
  return group;
}

function createFalcon(referenceRadiusAU: number): THREE.Group {
  const U = referenceRadiusAU;
  const group = new THREE.Group();
  const hull = standard(0x8c8b83, 0.82, 0.22, 0x0c0d0d, 0.08);
  const lightHull = standard(0xa9a69b, 0.76, 0.18);
  const dark = standard(0x262827, 0.6, 0.44);
  const rust = standard(0x6f3a29, 0.75, 0.2);
  const glass = standard(0x08151c, 0.16, 0.32, 0x0c3345, 0.28);
  const blue = glow(0x78c8ff, 0.92);

  const saucer = discY(1.48 * U, 1.48 * U, 0.34 * U, hull, 64);
  saucer.position.x = -0.12 * U;
  group.add(saucer);
  const upperDisc = discY(1.17 * U, 0.84 * U, 0.18 * U, lightHull, 64);
  upperDisc.position.set(-0.18 * U, 0.2 * U, 0);
  group.add(upperDisc);
  const lowerDisc = discY(0.85 * U, 1.18 * U, 0.16 * U, dark, 64);
  lowerDisc.position.set(-0.18 * U, -0.2 * U, 0);
  group.add(lowerDisc);

  // Forward mandibles and the recessed central notch create the unmistakable
  // forked freighter planform even when the hull is only a few dozen pixels.
  for (const zSign of [-1, 1]) {
    const mandible = new THREE.Mesh(new THREE.BoxGeometry(1.7 * U, 0.36 * U, 0.52 * U), hull);
    mandible.position.set(1.17 * U, 0, zSign * 0.73 * U);
    mandible.rotation.y = zSign * -0.055;
    group.add(mandible);
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(1.08 * U, 0.17 * U, 0.29 * U), dark);
    jaw.position.set(1.38 * U, 0.24 * U, zSign * 0.73 * U);
    group.add(jaw);
    for (const x of [0.75, 1.12, 1.49, 1.86]) {
      const greeble = new THREE.Mesh(new THREE.BoxGeometry(0.17 * U, 0.1 * U, 0.23 * U), x === 1.49 ? rust : dark);
      greeble.position.set(x * U, 0.3 * U, zSign * 0.73 * U);
      group.add(greeble);
    }
  }
  const notch = new THREE.Mesh(new THREE.BoxGeometry(1.02 * U, 0.2 * U, 0.57 * U), dark);
  notch.position.set(1.4 * U, 0.03 * U, 0);
  group.add(notch);

  // Offset cockpit tube and multi-pane canopy.
  const cockpitBoom = cylinderX(0.18 * U, 0.24 * U, 1.03 * U, 18, hull);
  cockpitBoom.name = 'falcon-offset-cockpit-boom';
  cockpitBoom.position.set(0.45 * U, 0.06 * U, -1.42 * U);
  cockpitBoom.rotation.y = -0.12;
  group.add(cockpitBoom);
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.31 * U, 24, 16), hull);
  cockpit.name = 'falcon-offset-cockpit';
  cockpit.scale.x = 1.25;
  cockpit.position.set(1.0 * U, 0.06 * U, -1.54 * U);
  group.add(cockpit);
  for (const y of [-0.11, 0.08]) {
    for (const z of [-1.72, -1.55, -1.38]) {
      const pane = new THREE.Mesh(new THREE.BoxGeometry(0.035 * U, 0.13 * U, 0.12 * U), glass);
      pane.position.set(1.27 * U, y * U, z * U);
      group.add(pane);
    }
  }

  const radar = new THREE.Mesh(createParabolicDishGeometry(0.31 * U, 0.11 * U), lightHull);
  radar.position.set(-0.45 * U, 0.48 * U, 0.38 * U);
  radar.rotation.z = -0.32;
  group.add(radar);
  group.add(createRodBetween(
    new THREE.Vector3(-0.45 * U, 0.23 * U, 0.38 * U),
    new THREE.Vector3(-0.45 * U, 0.51 * U, 0.38 * U),
    0.025 * U,
    dark,
    8,
  ));

  // Concentric hull trenches and dense radial service boxes.
  for (const radius of [0.48, 0.92, 1.27]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * U, 0.035 * U, 8, 64), dark);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(-0.32 * U, 0.37 * U, 0);
    group.add(ring);
  }
  for (let i = 0; i < 20; i++) {
    const angle = (i / 20) * Math.PI * 2;
    const radius = (0.55 + (i % 3) * 0.25) * U;
    const detail = new THREE.Mesh(
      new THREE.BoxGeometry(0.2 * U, 0.08 * U, 0.11 * U),
      i % 7 === 0 ? rust : dark,
    );
    detail.position.set(-0.32 * U, 0.42 * U, 0);
    detail.position.x += Math.cos(angle) * radius;
    detail.position.z += Math.sin(angle) * radius;
    detail.rotation.y = -angle;
    group.add(detail);
  }

  // The drive is a recessed ARC, not a straight bar with floating bulbs. Each
  // path point lies on the saucer's real aft circle, so even the outer ends
  // remain seated inside the hull silhouette.
  const engineArcPoints: THREE.Vector3[] = [];
  for (let i = 0; i <= 16; i++) {
    const z = THREE.MathUtils.lerp(-1.18, 1.18, i / 16);
    const aftX = -0.12 - Math.sqrt(1.48 * 1.48 - z * z);
    engineArcPoints.push(new THREE.Vector3(aftX * U, 0, z * U));
  }
  const engineArc = new THREE.CatmullRomCurve3(engineArcPoints);
  const engineHousing = new THREE.Mesh(
    new THREE.TubeGeometry(engineArc, 64, 0.14 * U, 10, false),
    dark,
  );
  engineHousing.name = 'falcon-engine-housing';
  engineHousing.scale.y = 0.66;
  group.add(engineHousing);
  const engineLight = new THREE.Mesh(
    new THREE.TubeGeometry(engineArc, 64, 0.085 * U, 10, false),
    blue,
  );
  engineLight.name = 'falcon-engine-light';
  engineLight.position.y = -0.015 * U;
  engineLight.scale.y = 0.64;
  engineLight.renderOrder = 1;
  group.add(engineLight);
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

  const saucer = discY(1.3 * U, 1.3 * U, 0.19 * U, pearl, 72);
  saucer.name = 'enterprise-primary-saucer';
  saucer.position.x = 0.87 * U;
  group.add(saucer);
  const saucerCrown = new THREE.Mesh(new THREE.SphereGeometry(0.64 * U, 40, 18), pearl);
  saucerCrown.scale.set(1, 0.19, 1);
  saucerCrown.position.set(0.87 * U, 0.09 * U, 0);
  group.add(saucerCrown);
  const bridge = new THREE.Mesh(new THREE.SphereGeometry(0.17 * U, 24, 12), pearl);
  bridge.scale.y = 0.34;
  bridge.position.set(0.98 * U, 0.24 * U, 0);
  group.add(bridge);
  const saucerRim = new THREE.Mesh(new THREE.TorusGeometry(1.29 * U, 0.045 * U, 10, 72), hullDark);
  saucerRim.rotation.x = Math.PI / 2;
  saucerRim.position.x = 0.87 * U;
  group.add(saucerRim);

  // Neck and secondary hull.
  const neck = plateXZ([
    [0.42 * U, -0.14 * U], [-0.45 * U, -0.22 * U], [-0.62 * U, 0.22 * U], [0.18 * U, 0.18 * U],
  ], 0.16 * U, pearl, 0.015 * U);
  neck.rotation.x = Math.PI / 2;
  neck.position.y = -0.18 * U;
  group.add(neck);
  const engineering = cylinderX(0.45 * U, 0.63 * U, 1.72 * U, 36, pearl);
  engineering.name = 'enterprise-secondary-hull';
  engineering.position.set(-0.52 * U, -0.48 * U, 0);
  group.add(engineering);
  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.52 * U, 30, 18), pearl);
  tail.scale.set(1.35, 0.75, 0.8);
  tail.position.set(-1.29 * U, -0.48 * U, 0);
  group.add(tail);
  const deflector = discX(0.36 * U, 0.055 * U, blue, 36);
  deflector.position.set(0.37 * U, -0.48 * U, 0);
  group.add(deflector);
  const deflectorRim = new THREE.Mesh(new THREE.TorusGeometry(0.39 * U, 0.045 * U, 10, 36), hullDark);
  deflectorRim.rotation.y = Math.PI / 2;
  deflectorRim.position.copy(deflector.position);
  group.add(deflectorRim);

  // Swept pylons and twin warp nacelles.
  for (const zSign of [-1, 1]) {
    const pylon = plateXZ([
      [-1.05 * U, 0.2 * U], [-0.63 * U, zSign * 1.18 * U], [-0.27 * U, zSign * 1.22 * U],
      [-0.57 * U, 0.19 * U],
    ], 0.13 * U, pearl, 0.012 * U);
    pylon.position.y = 0.03 * U;
    group.add(pylon);
    const nacelle = cylinderX(0.19 * U, 0.24 * U, 2.18 * U, 28, pearl);
    nacelle.name = `enterprise-warp-nacelle-${zSign < 0 ? 'port' : 'starboard'}`;
    nacelle.position.set(-0.68 * U, 0.36 * U, zSign * 1.28 * U);
    group.add(nacelle);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.245 * U, 24, 16), red);
    cap.scale.x = 0.42;
    cap.position.set(0.43 * U, 0.36 * U, zSign * 1.28 * U);
    group.add(cap);
    const grille = new THREE.Mesh(new THREE.BoxGeometry(1.3 * U, 0.08 * U, 0.12 * U), blue);
    grille.position.set(-0.72 * U, 0.51 * U, zSign * 1.28 * U);
    group.add(grille);
    for (const x of [-1.48, -1.1, -0.72, -0.34, 0.04]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.247 * U, 0.016 * U, 6, 24), hullDark);
      band.rotation.y = Math.PI / 2;
      band.position.set(x * U, 0.36 * U, zSign * 1.28 * U);
      group.add(band);
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

  const command = new THREE.Mesh(new THREE.SphereGeometry(0.48 * U, 30, 18), green);
  command.name = 'klingon-command-head';
  command.scale.set(1.35, 0.42, 0.78);
  command.position.set(1.48 * U, 0.08 * U, 0);
  group.add(command);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.28 * U, 0.72 * U, 20), bronze);
  beak.name = 'klingon-forward-beak';
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(2.12 * U, 0.02 * U, 0);
  group.add(beak);
  const bridge = new THREE.Mesh(new THREE.SphereGeometry(0.19 * U, 20, 12), darkGreen);
  bridge.scale.set(1.1, 0.48, 0.72);
  bridge.position.set(1.38 * U, 0.38 * U, 0);
  group.add(bridge);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(1.25 * U, 0.22 * U, 0.34 * U), darkGreen);
  neck.name = 'klingon-long-neck';
  neck.position.set(0.48 * U, -0.03 * U, 0);
  group.add(neck);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.78 * U, 32, 18), green);
  body.scale.set(1.15, 0.5, 0.9);
  body.position.set(-0.52 * U, 0.02 * U, 0);
  group.add(body);
  const aftDeck = plateXZ([
    [-0.1 * U, -0.62 * U], [-1.6 * U, -0.88 * U], [-1.92 * U, 0],
    [-1.6 * U, 0.88 * U], [-0.1 * U, 0.62 * U],
  ], 0.2 * U, darkGreen, 0.025 * U);
  aftDeck.position.y = -0.1 * U;
  group.add(aftDeck);

  for (const zSign of [-1, 1]) {
    const wingAssembly = new THREE.Group();
    wingAssembly.name = `klingon-swept-wing-${zSign < 0 ? 'port' : 'starboard'}`;
    // The K'vort/B'rel family can articulate its wings. A shallow attack-mode
    // droop makes the bird silhouette unmistakable without hiding the dorsal
    // feather plating from the chase camera.
    wingAssembly.rotation.x = zSign * 0.14;
    group.add(wingAssembly);
    const wing = plateXZ([
      [-0.2 * U, zSign * 0.36 * U], [-0.72 * U, zSign * 1.72 * U],
      [-1.58 * U, zSign * 1.95 * U], [-1.32 * U, zSign * 0.58 * U],
    ], 0.16 * U, green, 0.025 * U);
    wing.position.y = -0.05 * U;
    wingAssembly.add(wing);
    const leadingEdge = createRodBetween(
      new THREE.Vector3(-0.2 * U, 0.05 * U, zSign * 0.36 * U),
      new THREE.Vector3(-0.72 * U, 0.05 * U, zSign * 1.72 * U),
      0.055 * U,
      bronze,
      8,
    );
    wingAssembly.add(leadingEdge);
    const wingtip = cylinderX(0.14 * U, 0.19 * U, 0.72 * U, 18, dark);
    wingtip.position.set(-1.3 * U, 0, zSign * 1.86 * U);
    wingAssembly.add(wingtip);
    const disruptor = cylinderX(0.045 * U, 0.075 * U, 1.05 * U, 12, bronze);
    disruptor.name = `klingon-wingtip-cannon-${zSign < 0 ? 'port' : 'starboard'}`;
    disruptor.position.set(-0.5 * U, -0.04 * U, zSign * 1.84 * U);
    wingAssembly.add(disruptor);
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.075 * U, 12, 8), red);
    muzzle.position.set(0.04 * U, -0.04 * U, zSign * 1.84 * U);
    wingAssembly.add(muzzle);
    for (let i = 0; i < 6; i++) {
      const feather = new THREE.Mesh(new THREE.BoxGeometry(0.46 * U, 0.035 * U, 0.2 * U), i % 2 ? darkGreen : bronze);
      feather.position.set((-0.5 - i * 0.14) * U, 0.07 * U, zSign * (0.62 + i * 0.19) * U);
      feather.rotation.y = zSign * -0.38;
      wingAssembly.add(feather);
    }
    addEngineGlow(wingAssembly, -1.92 * U, 0, zSign * 0.54 * U, 0.16 * U, amber);
  }
  for (const z of [-0.28, 0, 0.28]) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.36 * U, 0.07 * U, 0.12 * U), dark);
    vent.position.set(-1.28 * U, 0.3 * U, z * U);
    group.add(vent);
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

  const body = discY(1.7 * U, 1.7 * U, 0.21 * U, alloy, 72);
  group.add(body);
  const upper = new THREE.Mesh(new THREE.SphereGeometry(1.48 * U, 56, 22), alloy);
  upper.scale.set(1, 0.19, 1);
  upper.position.y = 0.12 * U;
  group.add(upper);
  const lower = new THREE.Mesh(new THREE.SphereGeometry(1.28 * U, 48, 20), dark);
  lower.scale.set(1, 0.16, 1);
  lower.position.y = -0.14 * U;
  group.add(lower);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.67 * U, 40, 22, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  dome.scale.set(1.18, 0.76, 1);
  dome.position.y = 0.18 * U;
  group.add(dome);
  const domeRim = new THREE.Mesh(new THREE.TorusGeometry(0.73 * U, 0.055 * U, 10, 48), dark);
  domeRim.rotation.x = Math.PI / 2;
  domeRim.position.y = 0.18 * U;
  group.add(domeRim);

  for (const radius of [0.92, 1.28, 1.62]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * U, 0.025 * U, 8, 64), dark);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = radius === 1.62 ? 0 : 0.24 * U;
    group.add(ring);
  }
  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * Math.PI * 2;
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.055 * U, 12, 8), i % 3 === 0 ? amber : cyan);
    light.scale.y = 0.4;
    light.position.set(Math.cos(angle) * 1.38 * U, -0.23 * U, Math.sin(angle) * 1.38 * U);
    group.add(light);
  }
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.28 * U, 0.055 * U, 0.09 * U), dark);
    vent.position.set(Math.cos(angle) * 1.08 * U, 0.28 * U, Math.sin(angle) * 1.08 * U);
    vent.rotation.y = -angle;
    group.add(vent);
  }
  const tractor = new THREE.Mesh(new THREE.CylinderGeometry(0.42 * U, 0.15 * U, 0.35 * U, 32, 1, true), cyan);
  tractor.position.y = -0.31 * U;
  group.add(tractor);
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

  const hull = cylinderX(0.48 * U, 0.48 * U, 2.72 * U, 48, steel);
  hull.name = 'starship-stainless-hull';
  hull.position.x = -0.28 * U;
  group.add(hull);
  const hullShield = new THREE.Mesh(
    new THREE.CylinderGeometry(0.492 * U, 0.492 * U, 2.72 * U, 48, 1, true, 0, Math.PI),
    heatShield,
  );
  hullShield.rotation.z = -Math.PI / 2;
  hullShield.position.x = -0.28 * U;
  group.add(hullShield);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.48 * U, 1.3 * U, 48), steel);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 1.73 * U;
  group.add(nose);
  const noseShield = new THREE.Mesh(
    new THREE.ConeGeometry(0.492 * U, 1.3 * U, 48, 1, true, 0, Math.PI),
    heatShield,
  );
  noseShield.rotation.z = -Math.PI / 2;
  noseShield.position.x = 1.73 * U;
  group.add(noseShield);
  const aft = cylinderX(0.53 * U, 0.48 * U, 0.46 * U, 48, steel);
  aft.position.x = -1.85 * U;
  group.add(aft);
  const aftShield = new THREE.Mesh(
    new THREE.CylinderGeometry(0.542 * U, 0.492 * U, 0.46 * U, 48, 1, true, 0, Math.PI),
    heatShield,
  );
  aftShield.rotation.z = -Math.PI / 2;
  aftShield.position.x = -1.85 * U;
  group.add(aftShield);

  // Belly heat-shield shell plus overlapping faceted strips: the shell keeps
  // the windward half continuous through the nose while the strips break up
  // the surface into readable tile bands at chase-camera scale.
  for (let i = 0; i < 13; i++) {
    const x = (-1.5 + i * 0.25) * U;
    const tile = new THREE.Mesh(new THREE.BoxGeometry(0.21 * U, 0.035 * U, 0.58 * U), heatShield);
    tile.position.set(x, -0.465 * U, 0);
    tile.rotation.y = (i % 2 ? 0.018 : -0.018);
    group.add(tile);
  }
  for (const x of [-1.45, -0.9, -0.35, 0.2, 0.75]) {
    const seam = new THREE.Mesh(new THREE.TorusGeometry(0.485 * U, 0.012 * U, 6, 40), darkSteel);
    seam.rotation.y = Math.PI / 2;
    seam.position.x = x * U;
    group.add(seam);
  }

  for (const zSign of [-1, 1]) {
    const forwardFlap = plateXZ([
      [1.35 * U, zSign * 0.34 * U], [0.78 * U, zSign * 0.93 * U],
      [0.36 * U, zSign * 0.82 * U], [0.62 * U, zSign * 0.36 * U],
    ], 0.09 * U, heatShield, 0.012 * U);
    forwardFlap.name = `starship-forward-flap-${zSign < 0 ? 'port' : 'starboard'}`;
    forwardFlap.position.y = -0.03 * U;
    group.add(forwardFlap);
    const aftFlap = plateXZ([
      [-1.35 * U, zSign * 0.36 * U], [-1.92 * U, zSign * 1.0 * U],
      [-2.13 * U, zSign * 0.83 * U], [-1.75 * U, zSign * 0.34 * U],
    ], 0.11 * U, heatShield, 0.015 * U);
    aftFlap.name = `starship-aft-flap-${zSign < 0 ? 'port' : 'starboard'}`;
    aftFlap.position.y = -0.02 * U;
    group.add(aftFlap);
  }

  // Six Raptors: three compact sea-level engines in the center and three
  // larger vacuum bells around them. Keeping the two rings distinct is the
  // characteristic Starship aft view (and avoids the old seven-engine cluster).
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2 + Math.PI / 2;
    const y = Math.cos(angle) * 0.16 * U;
    const z = Math.sin(angle) * 0.16 * U;
    const bell = cylinderX(0.07 * U, 0.105 * U, 0.25 * U, 18, darkSteel);
    bell.name = `starship-sea-level-engine-${i + 1}`;
    bell.position.set(-2.18 * U, y, z);
    group.add(bell);
    addEngineGlow(group, -2.315 * U, y, z, 0.066 * U, engineGlow);
  }
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2 - Math.PI / 2;
    const y = Math.cos(angle) * 0.34 * U;
    const z = Math.sin(angle) * 0.34 * U;
    const bell = cylinderX(0.105 * U, 0.17 * U, 0.31 * U, 22, darkSteel);
    bell.name = `starship-vacuum-engine-${i + 1}`;
    bell.position.set(-2.2 * U, y, z);
    group.add(bell);
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

  const capsule = cylinderX(0.47 * U, 0.69 * U, 1.32 * U, 48, ceramic);
  capsule.name = 'dragon-crew-capsule';
  capsule.position.x = 0.4 * U;
  group.add(capsule);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.48 * U, 36, 20), ceramic);
  nose.scale.set(0.52, 1, 1);
  nose.position.x = 1.08 * U;
  group.add(nose);
  const heatShield = discX(0.69 * U, 0.1 * U, black, 48);
  heatShield.position.x = -0.3 * U;
  group.add(heatShield);
  const dockingCollar = cylinderX(0.22 * U, 0.22 * U, 0.2 * U, 28, trunkMetal);
  dockingCollar.position.x = 1.35 * U;
  group.add(dockingCollar);
  const dockingRing = new THREE.Mesh(new THREE.TorusGeometry(0.235 * U, 0.035 * U, 8, 28), ceramic);
  dockingRing.rotation.y = Math.PI / 2;
  dockingRing.position.x = 1.46 * U;
  group.add(dockingRing);

  // Four inset cabin windows and the characteristic blue waist markings.
  for (const [y, z] of [[0.34, -0.28], [0.34, 0.28], [0.16, -0.48], [0.16, 0.48]]) {
    const pane = new THREE.Mesh(new THREE.BoxGeometry(0.18 * U, 0.14 * U, 0.13 * U), glass);
    pane.position.set(0.83 * U, y * U, z * U);
    group.add(pane);
  }
  for (const zSign of [-1, 1]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.65 * U, 0.035 * U, 0.08 * U), blue);
    stripe.position.set(0.35 * U, 0.57 * U, zSign * 0.27 * U);
    group.add(stripe);
  }

  // Trunk with dark-blue solar-cell facets and a silver structural grid.
  const trunk = cylinderX(0.7 * U, 0.7 * U, 1.22 * U, 32, trunkMetal);
  trunk.name = 'dragon-unpressurized-trunk';
  trunk.position.x = -0.96 * U;
  group.add(trunk);
  // The flight vehicle does not have deployable solar wings: cells cover one
  // half of Dragon's trunk. Six flush facets keep that exact half-and-half
  // treatment readable while leaving the opposite metallic side exposed.
  for (let i = 0; i < 6; i++) {
    const angle = -Math.PI / 2 + ((i + 0.5) / 6) * Math.PI;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.8 * U, 0.38 * U, 0.025 * U), solar);
    panel.name = `dragon-trunk-solar-facet-${i + 1}`;
    panel.position.set(-0.96 * U, Math.cos(angle) * 0.67 * U, Math.sin(angle) * 0.67 * U);
    panel.rotation.x = angle - Math.PI / 2;
    group.add(panel);
  }
  for (const x of [-1.45, -1.0, -0.51]) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(0.705 * U, 0.025 * U, 7, 32), trunkMetal);
    rib.rotation.y = Math.PI / 2;
    rib.position.x = x * U;
    group.add(rib);
  }

  // SuperDraco pairs sit flush in black pods around the capsule shoulder.
  for (const ySign of [-1, 1]) {
    for (const zSign of [-1, 1]) {
      const pod = new THREE.Mesh(new THREE.SphereGeometry(0.14 * U, 18, 12), black);
      pod.scale.set(1.35, 0.7, 0.7);
      pod.position.set(0.18 * U, ySign * 0.5 * U, zSign * 0.35 * U);
      group.add(pod);
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

  const crew = cylinderX(0.35 * U, 0.72 * U, 1.0 * U, 48, capsule);
  crew.name = 'orion-crew-module';
  crew.position.x = 0.85 * U;
  group.add(crew);
  const heatShield = discX(0.73 * U, 0.1 * U, dark, 48);
  heatShield.position.x = 0.32 * U;
  group.add(heatShield);
  const dockingCollar = cylinderX(0.23 * U, 0.23 * U, 0.22 * U, 28, service);
  dockingCollar.position.x = 1.46 * U;
  group.add(dockingCollar);
  const dockingRing = new THREE.Mesh(new THREE.TorusGeometry(0.24 * U, 0.035 * U, 8, 28), white);
  dockingRing.rotation.y = Math.PI / 2;
  dockingRing.position.x = 1.58 * U;
  group.add(dockingRing);

  for (const z of [-0.34, 0, 0.34]) {
    const pane = new THREE.Mesh(new THREE.BoxGeometry(0.08 * U, 0.15 * U, 0.16 * U), glass);
    pane.position.set(1.08 * U, 0.31 * U, z * U);
    group.add(pane);
  }

  const serviceModule = cylinderX(0.68 * U, 0.68 * U, 1.18 * U, 36, service);
  serviceModule.name = 'orion-european-service-module';
  serviceModule.position.x = -0.34 * U;
  group.add(serviceModule);
  for (const x of [-0.7, -0.25, 0.12]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.69 * U, 0.02 * U, 6, 36), dark);
    band.rotation.y = Math.PI / 2;
    band.position.x = x * U;
    group.add(band);
  }
  const mainNozzle = cylinderX(0.13 * U, 0.25 * U, 0.42 * U, 24, dark);
  mainNozzle.position.x = -1.13 * U;
  group.add(mainNozzle);
  addEngineGlow(group, -1.36 * U, 0, 0, 0.13 * U, engineGlow);

  // Orion's four three-panel solar-array wings form the characteristic cross.
  for (const axis of ['y', 'z'] as const) {
    for (const sign of [-1, 1]) {
      const strutEnd = new THREE.Vector3(-0.35 * U, 0, 0);
      strutEnd[axis] = sign * 0.86 * U;
      const boom = createRodBetween(new THREE.Vector3(-0.35 * U, 0, 0), strutEnd, 0.035 * U, service, 8);
      boom.name = `orion-solar-boom-${axis}-${sign}`;
      group.add(boom);
      for (let panelIndex = 0; panelIndex < 3; panelIndex++) {
        const panel = new THREE.Mesh(
          new THREE.BoxGeometry(
            0.05 * U,
            axis === 'y' ? 0.43 * U : 0.34 * U,
            axis === 'z' ? 0.43 * U : 0.34 * U,
          ),
          solar,
        );
        panel.name = `orion-solar-panel-${axis}-${sign}-${panelIndex + 1}`;
        panel.position.x = -0.35 * U;
        panel.position[axis] = sign * (0.88 + panelIndex * 0.46) * U;
        group.add(panel);
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

  const crew = cylinderX(0.42 * U, 0.82 * U, 1.02 * U, 48, white);
  crew.name = 'starliner-crew-capsule';
  crew.position.x = 0.62 * U;
  group.add(crew);
  const forwardCap = new THREE.Mesh(new THREE.SphereGeometry(0.43 * U, 36, 18), white);
  forwardCap.scale.set(0.38, 1, 1);
  forwardCap.position.x = 1.2 * U;
  group.add(forwardCap);
  const dockingCollar = cylinderX(0.25 * U, 0.25 * U, 0.22 * U, 28, gray);
  dockingCollar.position.x = 1.42 * U;
  group.add(dockingCollar);
  const dockingRing = new THREE.Mesh(new THREE.TorusGeometry(0.27 * U, 0.035 * U, 8, 28), white);
  dockingRing.rotation.y = Math.PI / 2;
  dockingRing.position.x = 1.54 * U;
  group.add(dockingRing);
  for (const [y, z] of [[0.34, -0.32], [0.34, 0.32], [0.13, -0.58], [0.13, 0.58]]) {
    const pane = new THREE.Mesh(new THREE.BoxGeometry(0.12 * U, 0.14 * U, 0.14 * U), glass);
    pane.position.set(0.93 * U, y * U, z * U);
    group.add(pane);
  }
  for (const zSign of [-1, 1]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.6 * U, 0.045 * U, 0.08 * U), blue);
    stripe.position.set(0.55 * U, 0.65 * U, zSign * 0.28 * U);
    group.add(stripe);
  }

  const serviceModule = cylinderX(0.84 * U, 0.84 * U, 0.66 * U, 40, gray);
  serviceModule.name = 'starliner-service-module';
  serviceModule.position.x = -0.22 * U;
  group.add(serviceModule);
  const solarDeck = discX(0.85 * U, 0.08 * U, black, 40);
  solarDeck.position.x = -0.59 * U;
  group.add(solarDeck);
  // Starliner's cells sit on the service module's aft face rather than wings.
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.035 * U, 0.28 * U, 0.18 * U), solar);
    panel.name = `starliner-aft-solar-cell-${i + 1}`;
    panel.position.set(-0.64 * U, Math.cos(angle) * 0.57 * U, Math.sin(angle) * 0.57 * U);
    panel.rotation.x = angle;
    group.add(panel);
  }
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const thruster = cylinderX(0.045 * U, 0.07 * U, 0.18 * U, 12, black);
    thruster.position.set(-0.69 * U, Math.cos(angle) * 0.7 * U, Math.sin(angle) * 0.7 * U);
    group.add(thruster);
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
  const lower = plateXZ(planform, 0.22 * U, tile, 0.025 * U);
  lower.name = 'dream-chaser-lifting-body';
  lower.position.y = -0.12 * U;
  group.add(lower);
  const upper = plateXZ(planform.map(([x, z]) => [x * 0.92, z * 0.86]), 0.24 * U, white, 0.035 * U);
  upper.position.y = 0.04 * U;
  group.add(upper);
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.48 * U, 28, 16), glass);
  cockpit.name = 'dream-chaser-cockpit';
  cockpit.scale.set(1.45, 0.42, 0.7);
  cockpit.position.set(1.02 * U, 0.33 * U, 0);
  group.add(cockpit);
  const noseCap = new THREE.Mesh(new THREE.SphereGeometry(0.35 * U, 24, 14), tile);
  noseCap.scale.set(1.4, 0.35, 0.62);
  noseCap.position.set(1.72 * U, -0.08 * U, 0);
  group.add(noseCap);

  for (const zSign of [-1, 1]) {
    const tail = plateXZ([
      [-1.24 * U, -0.04 * U], [-0.5 * U, -0.04 * U],
      [-0.9 * U, 0.78 * U], [-1.38 * U, 0.48 * U],
    ], 0.08 * U, white, 0.012 * U);
    tail.name = `dream-chaser-tail-${zSign < 0 ? 'port' : 'starboard'}`;
    tail.rotation.x = zSign * Math.PI / 2;
    tail.position.set(0, 0.16 * U, zSign * 0.58 * U);
    group.add(tail);
    const edge = createRodBetween(
      new THREE.Vector3(1.0 * U, 0.2 * U, zSign * 0.48 * U),
      new THREE.Vector3(-1.18 * U, 0.18 * U, zSign * 1.02 * U),
      0.035 * U,
      orange,
      8,
    );
    group.add(edge);
    const engine = cylinderX(0.12 * U, 0.16 * U, 0.34 * U, 18, dark);
    engine.position.set(-1.42 * U, 0.02 * U, zSign * 0.36 * U);
    group.add(engine);
    addEngineGlow(group, -1.61 * U, 0.02 * U, zSign * 0.36 * U, 0.1 * U, engineGlow);
    for (let i = 0; i < 6; i++) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.24 * U, 0.035 * U, 0.2 * U), i % 2 ? dark : tile);
      panel.position.set((0.65 - i * 0.31) * U, 0.2 * U, zSign * (0.3 + i * 0.1) * U);
      panel.rotation.y = zSign * 0.16;
      group.add(panel);
    }
  }
  const dorsalPanel = new THREE.Mesh(new THREE.BoxGeometry(1.3 * U, 0.04 * U, 0.32 * U), orange);
  dorsalPanel.position.set(-0.1 * U, 0.28 * U, 0);
  group.add(dorsalPanel);
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

  const fuselage = cylinderX(0.3 * U, 0.42 * U, 2.05 * U, 24, ivory);
  fuselage.name = 'x-wing-fuselage';
  fuselage.position.x = 0.2 * U;
  group.add(fuselage);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.3 * U, 1.15 * U, 28), ivory);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 1.8 * U;
  group.add(nose);
  const noseStripe = new THREE.Mesh(new THREE.ConeGeometry(0.305 * U, 0.35 * U, 28, 1, true), red);
  noseStripe.rotation.z = -Math.PI / 2;
  noseStripe.position.x = 1.4 * U;
  group.add(noseStripe);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.35 * U, 24, 14), glass);
  canopy.scale.set(1.25, 0.55, 0.78);
  canopy.position.set(0.48 * U, 0.33 * U, 0);
  group.add(canopy);
  const astromech = new THREE.Mesh(new THREE.SphereGeometry(0.17 * U, 20, 12), panel);
  astromech.scale.y = 0.72;
  astromech.position.set(-0.28 * U, 0.39 * U, 0);
  group.add(astromech);

  for (const ySign of [-1, 1]) {
    for (const zSign of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.48 * U, 0.07 * U, 1.12 * U), panel);
      wing.name = `x-wing-s-foil-${ySign < 0 ? 'lower' : 'upper'}-${zSign < 0 ? 'port' : 'starboard'}`;
      wing.position.set(-0.25 * U, ySign * 0.38 * U, zSign * 0.63 * U);
      wing.rotation.x = ySign * zSign * 0.19;
      group.add(wing);
      const marking = new THREE.Mesh(new THREE.BoxGeometry(0.62 * U, 0.075 * U, 0.25 * U), red);
      marking.position.set(0.12 * U, ySign * 0.42 * U, zSign * 0.73 * U);
      marking.rotation.x = wing.rotation.x;
      group.add(marking);

      const engine = cylinderX(0.17 * U, 0.2 * U, 0.78 * U, 20, dark);
      engine.position.set(-0.5 * U, ySign * 0.44 * U, zSign * 0.64 * U);
      group.add(engine);
      addEngineGlow(group, -0.91 * U, ySign * 0.44 * U, zSign * 0.64 * U, 0.12 * U, blueGlow);

      const cannonStart = new THREE.Vector3(0.05 * U, ySign * 0.44 * U, zSign * 1.17 * U);
      const cannonEnd = new THREE.Vector3(1.65 * U, ySign * 0.48 * U, zSign * 1.17 * U);
      group.add(createRodBetween(cannonStart, cannonEnd, 0.028 * U, dark, 8));
      const cannonTip = new THREE.Mesh(new THREE.SphereGeometry(0.055 * U, 12, 8), pinkGlow);
      cannonTip.position.copy(cannonEnd);
      group.add(cannonTip);
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

  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.64 * U, 32, 22), frame);
  cockpit.name = 'tie-spherical-cockpit';
  cockpit.scale.x = 1.08;
  group.add(cockpit);
  const frontWindow = cylinderX(0.36 * U, 0.42 * U, 0.08 * U, 12, glass);
  frontWindow.position.x = 0.66 * U;
  group.add(frontWindow);
  const windowRim = new THREE.Mesh(new THREE.TorusGeometry(0.41 * U, 0.04 * U, 8, 12), darkFrame);
  windowRim.rotation.y = Math.PI / 2;
  windowRim.position.x = 0.71 * U;
  group.add(windowRim);
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const spoke = createRodBetween(
      new THREE.Vector3(0.72 * U, Math.cos(angle) * 0.08 * U, Math.sin(angle) * 0.08 * U),
      new THREE.Vector3(0.72 * U, Math.cos(angle) * 0.38 * U, Math.sin(angle) * 0.38 * U),
      0.018 * U,
      darkFrame,
      6,
    );
    group.add(spoke);
  }

  for (const zSign of [-1, 1]) {
    const pylon = createRodBetween(
      new THREE.Vector3(0, 0, zSign * 0.48 * U),
      new THREE.Vector3(0, 0, zSign * 1.18 * U),
      0.12 * U,
      frame,
      10,
    );
    group.add(pylon);
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.19 * U, 16, 12), darkFrame);
    hub.position.z = zSign * 1.18 * U;
    group.add(hub);

    // Six-sided solar wing, vertical in X/Y with a metallic perimeter.
    const wing = new THREE.Mesh(new THREE.CylinderGeometry(1.22 * U, 1.22 * U, 0.1 * U, 6), solar);
    wing.name = `tie-hexagonal-solar-wing-${zSign < 0 ? 'port' : 'starboard'}`;
    wing.rotation.x = Math.PI / 2;
    wing.position.z = zSign * 1.42 * U;
    group.add(wing);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.08 * U, 0.055 * U, 8, 6), frame);
    rim.position.z = zSign * 1.48 * U;
    group.add(rim);
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const spoke = createRodBetween(
        new THREE.Vector3(0, 0, zSign * 1.49 * U),
        new THREE.Vector3(Math.cos(angle) * 1.02 * U, Math.sin(angle) * 1.02 * U, zSign * 1.49 * U),
        0.025 * U,
        frame,
        6,
      );
      group.add(spoke);
    }
  }
  for (const z of [-0.22, 0.22]) {
    addEngineGlow(group, -0.64 * U, 0, z * U, 0.08 * U, red);
    const cannon = cylinderX(0.045 * U, 0.055 * U, 0.5 * U, 12, darkFrame);
    cannon.position.set(0.55 * U, -0.32 * U, z * U);
    group.add(cannon);
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.045 * U, 10, 8), green);
    muzzle.position.set(0.82 * U, -0.32 * U, z * U);
    group.add(muzzle);
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

  const upperWedge = plateXZ([
    [2.35 * U, 0], [-1.5 * U, -1.42 * U], [-1.5 * U, 1.42 * U],
  ], 0.24 * U, hull, 0.02 * U);
  upperWedge.name = 'star-destroyer-dagger-wedge';
  upperWedge.position.y = 0.12 * U;
  group.add(upperWedge);
  const lowerWedge = plateXZ([
    [2.15 * U, 0], [-1.48 * U, -1.24 * U], [-1.48 * U, 1.24 * U],
  ], 0.32 * U, trench, 0.015 * U);
  lowerWedge.position.y = -0.19 * U;
  group.add(lowerWedge);

  // Layered dorsal city, command tower, shield domes, and bridge slit.
  const cityBlocks: Array<[number, number, number, number, number]> = [
    [-0.35, 0.34, 0, 1.3, 0.72], [-0.58, 0.5, 0, 0.86, 0.5],
    [-0.84, 0.67, 0, 0.5, 0.38], [0.16, 0.28, 0, 0.75, 0.46],
  ];
  for (const [x, y, z, length, width] of cityBlocks) {
    const block = new THREE.Mesh(new THREE.BoxGeometry(length * U, 0.2 * U, width * U), lightHull);
    block.position.set(x * U, y * U, z * U);
    group.add(block);
  }
  const tower = new THREE.Mesh(new THREE.BoxGeometry(0.38 * U, 0.72 * U, 0.48 * U), hull);
  tower.name = 'star-destroyer-command-tower';
  tower.position.set(-0.83 * U, 0.9 * U, 0);
  group.add(tower);
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.28 * U, 0.18 * U, 1.05 * U), lightHull);
  bridge.position.set(-0.78 * U, 1.22 * U, 0);
  group.add(bridge);
  const bridgeLight = new THREE.Mesh(new THREE.BoxGeometry(0.03 * U, 0.055 * U, 0.82 * U), window);
  bridgeLight.position.set(-0.63 * U, 1.22 * U, 0);
  group.add(bridgeLight);
  for (const z of [-0.34, 0.34]) {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.16 * U, 20, 12), lightHull);
    dome.position.set(-0.78 * U, 1.42 * U, z * U);
    group.add(dome);
  }

  // Surface trenches and turbolaser batteries carry detail to chase distance.
  for (const zSign of [-1, 1]) {
    for (const x of [-0.9, -0.45, 0, 0.45, 0.9]) {
      const trenchLine = new THREE.Mesh(new THREE.BoxGeometry(0.32 * U, 0.035 * U, 0.055 * U), trench);
      trenchLine.position.set(x * U, 0.28 * U, zSign * (0.38 + (0.9 - x) * 0.15) * U);
      trenchLine.rotation.y = zSign * -0.22;
      group.add(trenchLine);
      const turret = new THREE.Mesh(new THREE.BoxGeometry(0.12 * U, 0.1 * U, 0.16 * U), lightHull);
      turret.position.set(x * U, 0.36 * U, zSign * (0.32 + (0.9 - x) * 0.12) * U);
      group.add(turret);
    }
  }

  // The ventral launch bay is the most important underside landmark.
  const hangar = new THREE.Mesh(new THREE.BoxGeometry(0.82 * U, 0.055 * U, 0.34 * U), trench);
  hangar.name = 'star-destroyer-ventral-hangar';
  hangar.position.set(-0.18 * U, -0.42 * U, 0);
  group.add(hangar);

  // Three large primary thrusters flanked by four smaller auxiliaries.
  for (const [index, z] of [-0.36, 0, 0.36].entries()) {
    const bell = cylinderX(0.14 * U, 0.205 * U, 0.28 * U, 20, trench);
    bell.name = `star-destroyer-main-engine-${index + 1}`;
    bell.position.set(-1.58 * U, -0.02 * U, z * U);
    group.add(bell);
    addEngineGlow(group, -1.73 * U, -0.02 * U, z * U, 0.135 * U, engineGlow);
  }
  const auxiliaryEngines: Array<[number, number]> = [[0.22, -0.2], [0.22, 0.2], [-0.22, -0.2], [-0.22, 0.2]];
  for (const [index, [y, z]] of auxiliaryEngines.entries()) {
    const bell = cylinderX(0.065 * U, 0.1 * U, 0.18 * U, 16, trench);
    bell.name = `star-destroyer-aux-engine-${index + 1}`;
    bell.position.set(-1.54 * U, y * U, z * U);
    group.add(bell);
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

  const commandModule = new THREE.Mesh(new THREE.ConeGeometry(0.68 * U, 1.25 * U, 40), capsuleMetal);
  commandModule.name = 'apollo-command-module';
  commandModule.rotation.z = -Math.PI / 2;
  commandModule.position.x = 0.68 * U;
  group.add(commandModule);
  const heatShield = discX(0.69 * U, 0.1 * U, dark, 40);
  heatShield.position.x = 0.03 * U;
  group.add(heatShield);
  const dockingTunnel = cylinderX(0.15 * U, 0.15 * U, 0.32 * U, 20, dark);
  dockingTunnel.position.x = 1.46 * U;
  group.add(dockingTunnel);
  const dockingRing = new THREE.Mesh(new THREE.TorusGeometry(0.17 * U, 0.025 * U, 8, 24), antenna);
  dockingRing.rotation.y = Math.PI / 2;
  dockingRing.position.x = 1.63 * U;
  group.add(dockingRing);

  for (const zSign of [-1, 1]) {
    const pane = new THREE.Mesh(new THREE.BoxGeometry(0.18 * U, 0.15 * U, 0.12 * U), glass);
    pane.position.set(0.75 * U, 0.3 * U, zSign * 0.34 * U);
    pane.rotation.y = zSign * 0.28;
    group.add(pane);
  }
  const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.3 * U, 0.03 * U, 0.34 * U), dark);
  hatch.position.set(0.5 * U, 0.53 * U, 0);
  group.add(hatch);

  const serviceModule = cylinderX(0.67 * U, 0.67 * U, 1.5 * U, 32, serviceWhite);
  serviceModule.name = 'apollo-service-module';
  serviceModule.position.x = -0.75 * U;
  group.add(serviceModule);
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const bay = new THREE.Mesh(new THREE.BoxGeometry(0.9 * U, 0.38 * U, 0.035 * U), i % 2 ? foil : dark);
    bay.position.set(-0.73 * U, Math.cos(angle) * 0.65 * U, Math.sin(angle) * 0.65 * U);
    bay.rotation.x = angle;
    group.add(bay);
  }
  for (const x of [-1.38, -0.75, -0.12]) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(0.68 * U, 0.025 * U, 7, 32), dark);
    rib.rotation.y = Math.PI / 2;
    rib.position.x = x * U;
    group.add(rib);
  }

  // Four RCS quads and the large SPS engine bell.
  for (const ySign of [-1, 1]) {
    for (const zSign of [-1, 1]) {
      const quad = new THREE.Mesh(new THREE.BoxGeometry(0.18 * U, 0.14 * U, 0.14 * U), dark);
      quad.position.set(-0.2 * U, ySign * 0.6 * U, zSign * 0.28 * U);
      group.add(quad);
      for (const xOffset of [-0.04, 0.04]) {
        const nozzle = cylinderX(0.025 * U, 0.04 * U, 0.11 * U, 10, antenna);
        nozzle.position.set((-0.22 + xOffset) * U, ySign * 0.67 * U, zSign * 0.28 * U);
        group.add(nozzle);
      }
    }
  }
  const bell = new THREE.Mesh(createEngineBell(0.38 * U, 0.82 * U), dark);
  bell.name = 'apollo-service-propulsion-engine';
  bell.rotation.z = -Math.PI / 2;
  bell.position.x = -1.56 * U;
  group.add(bell);
  addEngineGlow(group, -1.9 * U, 0, 0, 0.25 * U, engineGlow);

  const dish = new THREE.Mesh(createParabolicDishGeometry(0.32 * U, 0.11 * U), antenna);
  dish.rotation.z = -Math.PI / 2;
  dish.position.set(-0.95 * U, 0.72 * U, 0.22 * U);
  group.add(dish);
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

  const fuselage = cylinderX(0.28 * U, 0.4 * U, 1.75 * U, 32, chrome);
  fuselage.position.x = 0.35 * U;
  group.add(fuselage);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.28 * U, 1.62 * U, 32), gold);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 2.02 * U;
  group.add(nose);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.36 * U, 28, 16), glass);
  canopy.name = 'naboo-pilot-canopy';
  canopy.scale.set(1.25, 0.54, 0.85);
  canopy.position.set(0.28 * U, 0.34 * U, 0);
  group.add(canopy);
  const tailFin = plateXZ([
    [-0.15 * U, 0], [-1.15 * U, 0], [-1.05 * U, 0.78 * U], [-0.72 * U, 0.73 * U],
  ], 0.09 * U, gold, 0.012 * U);
  tailFin.rotation.x = Math.PI / 2;
  tailFin.position.y = 0.02 * U;
  group.add(tailFin);

  const astromech = new THREE.Mesh(new THREE.SphereGeometry(0.17 * U, 20, 12), chrome);
  astromech.name = 'naboo-astromech-dome';
  astromech.scale.y = 0.72;
  astromech.position.set(-0.32 * U, 0.37 * U, 0);
  group.add(astromech);
  const centerFinial = cylinderX(0.035 * U, 0.065 * U, 1.3 * U, 14, darkGold);
  centerFinial.name = 'naboo-center-tail-finial';
  centerFinial.position.set(-1.38 * U, 0, 0);
  group.add(centerFinial);

  for (const zSign of [-1, 1]) {
    const wing = plateXZ([
      [0.62 * U, zSign * 0.25 * U], [-0.62 * U, zSign * 0.88 * U],
      [-1.02 * U, zSign * 0.78 * U], [-0.42 * U, zSign * 0.23 * U],
    ], 0.07 * U, gold, 0.012 * U);
    group.add(wing);
    const engine = cylinderX(0.25 * U, 0.31 * U, 1.75 * U, 28, chrome);
    engine.name = `naboo-j-type-engine-${zSign < 0 ? 'port' : 'starboard'}`;
    engine.position.set(-0.25 * U, 0, zSign * 1.03 * U);
    group.add(engine);
    const engineNose = new THREE.Mesh(new THREE.ConeGeometry(0.25 * U, 0.6 * U, 28), gold);
    engineNose.rotation.z = -Math.PI / 2;
    engineNose.position.set(0.92 * U, 0, zSign * 1.03 * U);
    group.add(engineNose);
    addEngineGlow(group, -1.14 * U, 0, zSign * 1.03 * U, 0.19 * U, blue);
    const tailNeedle = cylinderX(0.045 * U, 0.065 * U, 1.2 * U, 14, darkGold);
    tailNeedle.name = `naboo-engine-finial-${zSign < 0 ? 'port' : 'starboard'}`;
    tailNeedle.position.set(-1.65 * U, 0, zSign * 1.03 * U);
    group.add(tailNeedle);
    for (const x of [-0.72, -0.3, 0.12]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.27 * U, 0.018 * U, 6, 28), dark);
      band.rotation.y = Math.PI / 2;
      band.position.set(x * U, 0, zSign * 1.03 * U);
      group.add(band);
    }
  }
  for (const x of [-0.75, -0.4, -0.05, 0.3, 0.65]) {
    const seam = new THREE.Mesh(new THREE.TorusGeometry(0.405 * U, 0.012 * U, 6, 32), darkGold);
    seam.rotation.y = Math.PI / 2;
    seam.position.x = x * U;
    group.add(seam);
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

  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.63 * U, 30, 20), ivory);
  nose.scale.set(1.25, 0.58, 1);
  nose.position.x = 1.08 * U;
  group.add(nose);
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.4 * U, 24, 14), glass);
  cockpit.name = 'y-wing-cockpit';
  cockpit.scale.set(1.05, 0.45, 0.72);
  cockpit.position.set(0.72 * U, 0.38 * U, 0);
  group.add(cockpit);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(1.35 * U, 0.28 * U, 0.46 * U), dark);
  neck.position.x = -0.08 * U;
  group.add(neck);
  const noseStripe = new THREE.Mesh(new THREE.BoxGeometry(0.55 * U, 0.08 * U, 0.72 * U), yellow);
  noseStripe.position.set(1.05 * U, 0.38 * U, 0);
  group.add(noseStripe);

  const astromech = new THREE.Mesh(new THREE.SphereGeometry(0.17 * U, 18, 10), ivory);
  astromech.name = 'y-wing-astromech-dome';
  astromech.scale.y = 0.72;
  astromech.position.set(0.05 * U, 0.34 * U, 0);
  group.add(astromech);

  for (const zSign of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.55 * U, 0.18 * U, 0.22 * U), ivory);
    arm.position.set(-0.22 * U, 0, zSign * 0.72 * U);
    group.add(arm);
    const nacelle = cylinderX(0.29 * U, 0.34 * U, 2.25 * U, 24, dark);
    nacelle.name = `y-wing-engine-nacelle-${zSign < 0 ? 'port' : 'starboard'}`;
    nacelle.position.set(-0.42 * U, 0, zSign * 0.95 * U);
    group.add(nacelle);
    const nacelleCap = cylinderX(0.3 * U, 0.3 * U, 0.42 * U, 24, yellow);
    nacelleCap.position.set(0.73 * U, 0, zSign * 0.95 * U);
    group.add(nacelleCap);
    addEngineGlow(group, -1.58 * U, 0, zSign * 0.95 * U, 0.22 * U, blue);
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const start = new THREE.Vector3(0.45 * U, Math.cos(angle) * 0.31 * U, zSign * 0.95 * U + Math.sin(angle) * 0.31 * U);
      const end = new THREE.Vector3(-1.4 * U, Math.cos(angle) * 0.31 * U, zSign * 0.95 * U + Math.sin(angle) * 0.31 * U);
      group.add(createRodBetween(start, end, 0.018 * U, pipe, 6));
    }
    const cannon = cylinderX(0.035 * U, 0.05 * U, 1.15 * U, 12, pipe);
    cannon.position.set(1.18 * U, -0.12 * U, zSign * 0.75 * U);
    group.add(cannon);
  }
  const ionTurret = new THREE.Mesh(new THREE.CylinderGeometry(0.15 * U, 0.18 * U, 0.16 * U, 16), dark);
  ionTurret.position.set(0.85 * U, 0.56 * U, 0);
  group.add(ionTurret);
  for (const z of [-0.09, 0.09]) {
    const gun = cylinderX(0.025 * U, 0.035 * U, 0.72 * U, 10, pipe);
    gun.position.set(1.23 * U, 0.6 * U, z * U);
    group.add(gun);
  }
  return group;
}

export function createPlayerFleetModel(profile: Exclude<PlayerShipProfile, 'default'>, referenceRadiusAU: number): THREE.Group {
  const finish = (model: THREE.Group): THREE.Group => {
    const readable = boostDeepSpaceReadability(model);
    readable.name = `player-ship-${profile}`;
    readable.userData.playerShipProfile = profile;
    return readable;
  };
  switch (profile) {
    case 'shuttle': return finish(createSpaceShuttle(referenceRadiusAU));
    case 'soyuz': return finish(createSoyuz(referenceRadiusAU));
    case 'falcon': return finish(createFalcon(referenceRadiusAU));
    case 'enterprise': return finish(createEnterprise(referenceRadiusAU));
    case 'klingon': return finish(createKlingonBirdOfPrey(referenceRadiusAU));
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
