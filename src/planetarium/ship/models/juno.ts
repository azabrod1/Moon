/**
 * Juno spacecraft model — procedural THREE.Group geometry.
 */
import * as THREE from 'three';
import { createParabolicDishGeometry, createRodBetween } from './shipPrimitives';

export function createJunoModel(referenceRadiusAU: number): THREE.Group {
  const model = new THREE.Group();

  const whiteMetal = new THREE.MeshStandardMaterial({
    color: 0xe8ecf2,
    emissive: 0x111924,
    emissiveIntensity: 0.05,
    roughness: 0.34,
    metalness: 0.4,
  });
  const goldFoil = new THREE.MeshPhysicalMaterial({
    color: 0xb49758,
    emissive: 0x1d1407,
    emissiveIntensity: 0.14,
    roughness: 0.48,
    metalness: 0.8,
    clearcoat: 0.1,
    clearcoatRoughness: 0.35,
  });
  const solarBlue = new THREE.MeshStandardMaterial({
    color: 0x1e3557,
    emissive: 0x091427,
    emissiveIntensity: 0.18,
    roughness: 0.62,
    metalness: 0.18,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: 0x515967,
    emissive: 0x121823,
    emissiveIntensity: 0.08,
    roughness: 0.58,
    metalness: 0.34,
  });

  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(referenceRadiusAU * 0.34, referenceRadiusAU * 0.34, referenceRadiusAU * 0.7, 12),
    goldFoil,
  );
  core.rotation.y = Math.PI / 12;
  model.add(core);

  const deck = new THREE.Mesh(
    new THREE.CylinderGeometry(referenceRadiusAU * 0.42, referenceRadiusAU * 0.42, referenceRadiusAU * 0.08, 12),
    whiteMetal,
  );
  deck.position.y = referenceRadiusAU * 0.18;
  model.add(deck);

  const dishRadius = referenceRadiusAU * 0.78;
  const dish = new THREE.Mesh(
    createParabolicDishGeometry(dishRadius, referenceRadiusAU * 0.18),
    new THREE.MeshStandardMaterial({
      color: 0xf2f5f8,
      roughness: 0.28,
      metalness: 0.18,
      side: THREE.DoubleSide,
    }),
  );
  dish.position.y = referenceRadiusAU * 0.64;
  model.add(dish);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(dishRadius, referenceRadiusAU * 0.016, 10, 48),
    whiteMetal,
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = referenceRadiusAU * 0.64;
  model.add(rim);

  const feed = new THREE.Mesh(
    new THREE.ConeGeometry(referenceRadiusAU * 0.045, referenceRadiusAU * 0.14, 18),
    whiteMetal,
  );
  feed.rotation.x = Math.PI;
  feed.position.y = referenceRadiusAU * 0.76;
  model.add(feed);

  const panelGroup = new THREE.Group();
  const panelLength = referenceRadiusAU * 2.9;
  const panelWidth = referenceRadiusAU * 0.34;
  const panelThickness = referenceRadiusAU * 0.03;
  for (let i = 0; i < 3; i++) {
    const arm = new THREE.Group();
    arm.rotation.y = (i / 3) * Math.PI * 2;

    const truss = createRodBetween(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(panelLength * 0.22, 0, 0),
      referenceRadiusAU * 0.013,
      whiteMetal,
      8,
    );
    arm.add(truss);

    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(panelLength, panelThickness, panelWidth),
      solarBlue,
    );
    panel.position.x = panelLength * 0.72;
    arm.add(panel);

    for (const x of [-0.28, 0, 0.28]) {
      const seam = new THREE.Mesh(
        new THREE.BoxGeometry(referenceRadiusAU * 0.018, panelThickness * 1.15, panelWidth * 0.96),
        new THREE.MeshStandardMaterial({
          color: 0x60728d,
          roughness: 0.5,
          metalness: 0.24,
        }),
      );
      seam.position.set(panel.position.x + x * panelLength, 0, 0);
      arm.add(seam);
    }

    panelGroup.add(arm);
  }
  model.add(panelGroup);

  const magnetometerBoom = createRodBetween(
    new THREE.Vector3(panelLength * 1.43, 0, 0),
    new THREE.Vector3(panelLength * 1.82, 0, 0),
    referenceRadiusAU * 0.01,
    whiteMetal,
    6,
  );
  model.add(magnetometerBoom);

  const magSensor = new THREE.Mesh(
    new THREE.SphereGeometry(referenceRadiusAU * 0.04, 14, 14),
    new THREE.MeshBasicMaterial({ color: 0x8ab8ff }),
  );
  magSensor.position.x = panelLength * 1.9;
  model.add(magSensor);

  const lowerAssembly = new THREE.Mesh(
    new THREE.CylinderGeometry(referenceRadiusAU * 0.18, referenceRadiusAU * 0.24, referenceRadiusAU * 0.24, 18),
    darkMetal,
  );
  lowerAssembly.position.y = -referenceRadiusAU * 0.42;
  model.add(lowerAssembly);

  model.rotation.z = -Math.PI / 2;
  model.scale.setScalar(1.32);
  return model;
}
