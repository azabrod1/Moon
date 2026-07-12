/**
 * Cassini (procedural fallback) spacecraft model — procedural THREE.Group geometry.
 */
import * as THREE from 'three';
import { createEngineBell, createParabolicDishGeometry, createRodBetween } from './shipPrimitives';

export function createCassiniModel(referenceRadiusAU: number): THREE.Group {
  const model = new THREE.Group();
  const dishRadius = referenceRadiusAU * 1.52;
  const dishDepth = referenceRadiusAU * 0.34;
  const busRadius = referenceRadiusAU * 0.34;
  const busHeight = referenceRadiusAU * 1.02;

  const whiteMetal = new THREE.MeshStandardMaterial({
    color: 0xe7ebf1,
    emissive: 0x111824,
    emissiveIntensity: 0.06,
    roughness: 0.34,
    metalness: 0.4,
  });
  const goldFoil = new THREE.MeshPhysicalMaterial({
    color: 0xb89955,
    emissive: 0x201507,
    emissiveIntensity: 0.18,
    roughness: 0.46,
    metalness: 0.8,
    clearcoat: 0.12,
    clearcoatRoughness: 0.34,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: 0x4f5863,
    emissive: 0x121824,
    emissiveIntensity: 0.08,
    roughness: 0.6,
    metalness: 0.35,
  });

  const dish = new THREE.Mesh(
    createParabolicDishGeometry(dishRadius, dishDepth),
    new THREE.MeshStandardMaterial({
      color: 0xf2f5f8,
      roughness: 0.28,
      metalness: 0.22,
      side: THREE.DoubleSide,
    }),
  );
  dish.position.y = referenceRadiusAU * 1.08;
  model.add(dish);

  const dishRim = new THREE.Mesh(
    new THREE.TorusGeometry(dishRadius, referenceRadiusAU * 0.02, 12, 64),
    whiteMetal,
  );
  dishRim.rotation.x = Math.PI / 2;
  dishRim.position.y = referenceRadiusAU * 1.08;
  model.add(dishRim);

  const bus = new THREE.Mesh(
    new THREE.CylinderGeometry(busRadius, busRadius, busHeight, 12),
    goldFoil,
  );
  bus.position.y = referenceRadiusAU * 0.02;
  bus.rotation.y = Math.PI / 12;
  model.add(bus);

  const engineBell = new THREE.Mesh(
    createEngineBell(referenceRadiusAU * 0.22, referenceRadiusAU * 0.92),
    darkMetal,
  );
  engineBell.rotation.z = Math.PI;
  engineBell.position.y = -referenceRadiusAU * 0.88;
  model.add(engineBell);

  const upperDeck = new THREE.Mesh(
    new THREE.CylinderGeometry(busRadius * 1.04, busRadius * 1.04, referenceRadiusAU * 0.09, 12),
    whiteMetal,
  );
  upperDeck.position.y = referenceRadiusAU * 0.55;
  model.add(upperDeck);

  const lowerDeck = upperDeck.clone();
  lowerDeck.position.y = -referenceRadiusAU * 0.46;
  model.add(lowerDeck);

  for (let i = 0; i < 12; i++) {
    const blanket = new THREE.Mesh(
      new THREE.BoxGeometry(referenceRadiusAU * 0.18, referenceRadiusAU * 0.54, referenceRadiusAU * 0.014),
      goldFoil,
    );
    const angle = (i / 12) * Math.PI * 2;
    blanket.position.set(
      Math.cos(angle) * busRadius * 1.04,
      referenceRadiusAU * 0.04,
      Math.sin(angle) * busRadius * 1.04,
    );
    blanket.rotation.y = angle;
    model.add(blanket);
  }

  const feedBase = new THREE.Mesh(
    new THREE.CylinderGeometry(referenceRadiusAU * 0.04, referenceRadiusAU * 0.04, referenceRadiusAU * 0.18, 16),
    darkMetal,
  );
  feedBase.position.y = referenceRadiusAU * 1.25;
  model.add(feedBase);

  const feedHorn = new THREE.Mesh(
    new THREE.ConeGeometry(referenceRadiusAU * 0.07, referenceRadiusAU * 0.28, 18),
    whiteMetal,
  );
  feedHorn.rotation.x = Math.PI;
  feedHorn.position.y = referenceRadiusAU * 1.43;
  model.add(feedHorn);

  const feedAnchor = new THREE.Vector3(0, referenceRadiusAU * 1.22, 0);
  const spread = dishRadius * 0.46;
  for (const anchor of [
    new THREE.Vector3(spread, referenceRadiusAU * 1.03, 0),
    new THREE.Vector3(-spread, referenceRadiusAU * 1.03, 0),
    new THREE.Vector3(0, referenceRadiusAU * 1.03, spread),
    new THREE.Vector3(0, referenceRadiusAU * 1.03, -spread),
  ]) {
    model.add(createRodBetween(anchor, feedAnchor, referenceRadiusAU * 0.011, whiteMetal, 6));
  }

  const huygens = new THREE.Mesh(
    new THREE.CylinderGeometry(referenceRadiusAU * 0.24, referenceRadiusAU * 0.21, referenceRadiusAU * 0.2, 20),
    new THREE.MeshStandardMaterial({
      color: 0xc68e35,
      emissive: 0x281606,
      emissiveIntensity: 0.18,
      roughness: 0.44,
      metalness: 0.58,
    }),
  );
  huygens.position.set(0, -referenceRadiusAU * 0.18, 0);
  model.add(huygens);

  const magnetometerBoom = createRodBetween(
    new THREE.Vector3(0, referenceRadiusAU * 0.54, 0),
    new THREE.Vector3(0, referenceRadiusAU * 3.1, 0),
    referenceRadiusAU * 0.012,
    whiteMetal,
    8,
  );
  model.add(magnetometerBoom);

  const magnetometer = new THREE.Mesh(
    new THREE.SphereGeometry(referenceRadiusAU * 0.05, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0x8ec2ff }),
  );
  magnetometer.position.y = referenceRadiusAU * 3.22;
  model.add(magnetometer);

  const rtgBoomEnd = new THREE.Vector3(-referenceRadiusAU * 2.1, -referenceRadiusAU * 0.92, 0);
  model.add(createRodBetween(
    new THREE.Vector3(0, -referenceRadiusAU * 0.26, 0),
    rtgBoomEnd,
    referenceRadiusAU * 0.018,
    whiteMetal,
    8,
  ));
  for (const pos of [
    new THREE.Vector3(-referenceRadiusAU * 0.95, -referenceRadiusAU * 0.55, 0),
    new THREE.Vector3(-referenceRadiusAU * 1.42, -referenceRadiusAU * 0.74, 0),
    new THREE.Vector3(-referenceRadiusAU * 1.89, -referenceRadiusAU * 0.94, 0),
  ]) {
    const rtg = new THREE.Mesh(
      new THREE.CylinderGeometry(referenceRadiusAU * 0.11, referenceRadiusAU * 0.11, referenceRadiusAU * 0.42, 18),
      darkMetal,
    );
    rtg.rotation.z = Math.PI / 2;
    rtg.position.copy(pos);
    model.add(rtg);
  }

  const cameraPlatform = new THREE.Group();
  cameraPlatform.position.set(referenceRadiusAU * 0.55, -referenceRadiusAU * 0.16, 0);
  const platformBase = new THREE.Mesh(
    new THREE.CylinderGeometry(referenceRadiusAU * 0.13, referenceRadiusAU * 0.13, referenceRadiusAU * 0.09, 14),
    darkMetal,
  );
  platformBase.rotation.z = Math.PI / 2;
  cameraPlatform.add(platformBase);
  for (const offset of [-0.12, 0.12]) {
    const cameraTube = new THREE.Mesh(
      new THREE.CylinderGeometry(referenceRadiusAU * 0.045, referenceRadiusAU * 0.045, referenceRadiusAU * 0.28, 18),
      whiteMetal,
    );
    cameraTube.rotation.z = Math.PI / 2;
    cameraTube.position.set(referenceRadiusAU * 0.18, offset * referenceRadiusAU, 0);
    cameraPlatform.add(cameraTube);
  }
  model.add(cameraPlatform);

  model.rotation.z = -Math.PI / 2;
  model.scale.setScalar(1.22);
  return model;
}
