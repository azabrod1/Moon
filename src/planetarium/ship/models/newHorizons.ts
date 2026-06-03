/**
 * New Horizons spacecraft model — procedural THREE.Group geometry.
 */
import * as THREE from 'three';
import { createVoyagerDishGeometry, createRodBetween } from './shipPrimitives';

export function createNewHorizonsModel(referenceRadiusAU: number): THREE.Group {
  const model = new THREE.Group();

  const whiteMetal = new THREE.MeshStandardMaterial({
    color: 0xeaedf2,
    emissive: 0x121925,
    emissiveIntensity: 0.05,
    roughness: 0.35,
    metalness: 0.38,
  });
  const goldFoil = new THREE.MeshPhysicalMaterial({
    color: 0xb79a5e,
    emissive: 0x1c1408,
    emissiveIntensity: 0.16,
    roughness: 0.48,
    metalness: 0.78,
    clearcoat: 0.12,
    clearcoatRoughness: 0.32,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: 0x515965,
    emissive: 0x111824,
    emissiveIntensity: 0.08,
    roughness: 0.58,
    metalness: 0.34,
  });

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(referenceRadiusAU * 0.68, referenceRadiusAU * 0.5, referenceRadiusAU * 0.34),
    goldFoil,
  );
  body.position.y = referenceRadiusAU * 0.02;
  model.add(body);

  const topPlate = new THREE.Mesh(
    new THREE.BoxGeometry(referenceRadiusAU * 0.74, referenceRadiusAU * 0.06, referenceRadiusAU * 0.4),
    whiteMetal,
  );
  topPlate.position.y = referenceRadiusAU * 0.28;
  model.add(topPlate);

  const dishRadius = referenceRadiusAU * 0.95;
  const dish = new THREE.Mesh(
    createVoyagerDishGeometry(dishRadius, referenceRadiusAU * 0.22),
    new THREE.MeshStandardMaterial({
      color: 0xf0f4f8,
      roughness: 0.28,
      metalness: 0.2,
      side: THREE.DoubleSide,
    }),
  );
  dish.position.y = referenceRadiusAU * 0.82;
  model.add(dish);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(dishRadius, referenceRadiusAU * 0.018, 10, 48),
    whiteMetal,
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = referenceRadiusAU * 0.82;
  model.add(rim);

  const feedHorn = new THREE.Mesh(
    new THREE.ConeGeometry(referenceRadiusAU * 0.052, referenceRadiusAU * 0.18, 18),
    whiteMetal,
  );
  feedHorn.rotation.x = Math.PI;
  feedHorn.position.y = referenceRadiusAU * 0.98;
  model.add(feedHorn);

  const feedAnchor = new THREE.Vector3(0, referenceRadiusAU * 0.93, 0);
  for (const anchor of [
    new THREE.Vector3(dishRadius * 0.42, referenceRadiusAU * 0.77, 0),
    new THREE.Vector3(-dishRadius * 0.42, referenceRadiusAU * 0.77, 0),
    new THREE.Vector3(0, referenceRadiusAU * 0.77, dishRadius * 0.34),
  ]) {
    model.add(createRodBetween(anchor, feedAnchor, referenceRadiusAU * 0.01, whiteMetal, 6));
  }

  const rtgBoom = createRodBetween(
    new THREE.Vector3(-referenceRadiusAU * 0.1, -referenceRadiusAU * 0.04, 0),
    new THREE.Vector3(-referenceRadiusAU * 1.18, -referenceRadiusAU * 0.86, 0),
    referenceRadiusAU * 0.017,
    whiteMetal,
    8,
  );
  model.add(rtgBoom);

  const rtg = new THREE.Mesh(
    new THREE.CylinderGeometry(referenceRadiusAU * 0.12, referenceRadiusAU * 0.12, referenceRadiusAU * 0.52, 18),
    darkMetal,
  );
  rtg.rotation.z = Math.PI / 2;
  rtg.position.set(-referenceRadiusAU * 0.92, -referenceRadiusAU * 0.67, 0);
  model.add(rtg);

  const instrumentDeck = new THREE.Group();
  instrumentDeck.position.set(referenceRadiusAU * 0.43, -referenceRadiusAU * 0.1, 0);
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(referenceRadiusAU * 0.24, referenceRadiusAU * 0.18, referenceRadiusAU * 0.16),
    whiteMetal,
  );
  instrumentDeck.add(box);
  const tube = new THREE.Mesh(
    new THREE.CylinderGeometry(referenceRadiusAU * 0.045, referenceRadiusAU * 0.045, referenceRadiusAU * 0.3, 16),
    darkMetal,
  );
  tube.rotation.z = Math.PI / 2;
  tube.position.x = referenceRadiusAU * 0.2;
  instrumentDeck.add(tube);
  model.add(instrumentDeck);

  const tracker = new THREE.Mesh(
    new THREE.BoxGeometry(referenceRadiusAU * 0.12, referenceRadiusAU * 0.12, referenceRadiusAU * 0.12),
    whiteMetal,
  );
  tracker.position.set(referenceRadiusAU * 0.12, referenceRadiusAU * 0.22, referenceRadiusAU * 0.2);
  model.add(tracker);

  const boom = createRodBetween(
    new THREE.Vector3(referenceRadiusAU * 0.1, referenceRadiusAU * 0.08, 0),
    new THREE.Vector3(referenceRadiusAU * 1.08, referenceRadiusAU * 0.06, 0),
    referenceRadiusAU * 0.012,
    whiteMetal,
    8,
  );
  model.add(boom);

  const sensor = new THREE.Mesh(
    new THREE.BoxGeometry(referenceRadiusAU * 0.12, referenceRadiusAU * 0.08, referenceRadiusAU * 0.08),
    darkMetal,
  );
  sensor.position.set(referenceRadiusAU * 1.14, referenceRadiusAU * 0.06, 0);
  model.add(sensor);

  model.rotation.z = -Math.PI / 2;
  model.scale.setScalar(1.28);
  return model;
}
