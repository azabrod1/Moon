/**
 * Voyager spacecraft model — procedural THREE.Group geometry.
 */
import * as THREE from 'three';
import { createVoyagerDishGeometry, createRodBetween } from './shipPrimitives';

export function createVoyagerModel(referenceRadiusAU: number): THREE.Group {
  const model = new THREE.Group();
  const coreRadius = referenceRadiusAU * 0.44;
  const coreHeight = referenceRadiusAU * 0.72;
  const dishRadius = referenceRadiusAU * 1.22;
  const dishDepth = referenceRadiusAU * 0.28;

  const foilMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xb59a55,
    emissive: 0x1c1407,
    emissiveIntensity: 0.18,
    roughness: 0.48,
    metalness: 0.82,
    clearcoat: 0.18,
    clearcoatRoughness: 0.38,
  });
  const whiteMetalMaterial = new THREE.MeshStandardMaterial({
    color: 0xe7ebf1,
    emissive: 0x101722,
    emissiveIntensity: 0.06,
    roughness: 0.38,
    metalness: 0.42,
  });
  const trussMaterial = new THREE.MeshStandardMaterial({
    color: 0xcbd3df,
    roughness: 0.4,
    metalness: 0.56,
  });
  const darkMetalMaterial = new THREE.MeshStandardMaterial({
    color: 0x4f5864,
    emissive: 0x131820,
    emissiveIntensity: 0.08,
    roughness: 0.58,
    metalness: 0.38,
  });

  const bus = new THREE.Mesh(
    new THREE.CylinderGeometry(coreRadius, coreRadius, coreHeight, 8),
    foilMaterial,
  );
  bus.rotation.y = Math.PI / 8;
  model.add(bus);

  const topDeck = new THREE.Mesh(
    new THREE.CylinderGeometry(coreRadius * 0.92, coreRadius * 0.92, referenceRadiusAU * 0.11, 8),
    whiteMetalMaterial,
  );
  topDeck.position.y = coreHeight * 0.42;
  topDeck.rotation.y = Math.PI / 8;
  model.add(topDeck);

  const bottomDeck = topDeck.clone();
  bottomDeck.position.y = -coreHeight * 0.42;
  model.add(bottomDeck);

  for (let i = 0; i < 8; i++) {
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(referenceRadiusAU * 0.22, referenceRadiusAU * 0.42, referenceRadiusAU * 0.018),
      foilMaterial,
    );
    const angle = (i / 8) * Math.PI * 2 + Math.PI / 8;
    panel.position.set(
      Math.cos(angle) * coreRadius * 0.94,
      0,
      Math.sin(angle) * coreRadius * 0.94,
    );
    panel.rotation.y = angle;
    model.add(panel);
  }

  const propellantTank = new THREE.Mesh(
    new THREE.SphereGeometry(referenceRadiusAU * 0.16, 20, 20),
    new THREE.MeshStandardMaterial({
      color: 0xd7dde8,
      roughness: 0.32,
      metalness: 0.48,
    }),
  );
  propellantTank.position.y = referenceRadiusAU * 0.07;
  model.add(propellantTank);

  const scanPlatform = new THREE.Group();
  scanPlatform.position.set(referenceRadiusAU * 0.28, -referenceRadiusAU * 0.2, 0);
  const scanBase = new THREE.Mesh(
    new THREE.CylinderGeometry(referenceRadiusAU * 0.17, referenceRadiusAU * 0.17, referenceRadiusAU * 0.08, 12),
    darkMetalMaterial,
  );
  scanBase.rotation.z = Math.PI / 2;
  scanPlatform.add(scanBase);
  for (const offset of [-0.14, 0.14]) {
    const cameraTube = new THREE.Mesh(
      new THREE.CylinderGeometry(referenceRadiusAU * 0.05, referenceRadiusAU * 0.05, referenceRadiusAU * 0.25, 14),
      whiteMetalMaterial,
    );
    cameraTube.rotation.z = Math.PI / 2;
    cameraTube.position.set(referenceRadiusAU * 0.14, offset * referenceRadiusAU, 0);
    scanPlatform.add(cameraTube);

    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(referenceRadiusAU * 0.033, referenceRadiusAU * 0.045, referenceRadiusAU * 0.05, 14),
      new THREE.MeshStandardMaterial({
        color: 0x1e2633,
        emissive: 0x0b1422,
        emissiveIntensity: 0.2,
        roughness: 0.25,
        metalness: 0.18,
      }),
    );
    lens.rotation.z = Math.PI / 2;
    lens.position.set(referenceRadiusAU * 0.28, offset * referenceRadiusAU, 0);
    scanPlatform.add(lens);
  }
  model.add(scanPlatform);

  const dish = new THREE.Mesh(
    createVoyagerDishGeometry(dishRadius, dishDepth),
    new THREE.MeshStandardMaterial({
      color: 0xf0f3f7,
      emissive: 0x0f1420,
      emissiveIntensity: 0.05,
      roughness: 0.34,
      metalness: 0.28,
      side: THREE.DoubleSide,
    }),
  );
  dish.position.y = referenceRadiusAU * 0.88;
  model.add(dish);

  const dishRim = new THREE.Mesh(
    new THREE.TorusGeometry(dishRadius, referenceRadiusAU * 0.022, 10, 48),
    whiteMetalMaterial,
  );
  dishRim.rotation.x = Math.PI / 2;
  dishRim.position.y = referenceRadiusAU * 0.88;
  model.add(dishRim);

  const feedHorn = new THREE.Mesh(
    new THREE.ConeGeometry(referenceRadiusAU * 0.085, referenceRadiusAU * 0.24, 20),
    whiteMetalMaterial,
  );
  feedHorn.rotation.x = Math.PI;
  feedHorn.position.y = referenceRadiusAU * 1.18;
  model.add(feedHorn);

  const feedBase = new THREE.Mesh(
    new THREE.CylinderGeometry(referenceRadiusAU * 0.045, referenceRadiusAU * 0.045, referenceRadiusAU * 0.14, 14),
    darkMetalMaterial,
  );
  feedBase.position.y = referenceRadiusAU * 1.03;
  model.add(feedBase);

  const feedAnchor = new THREE.Vector3(0, referenceRadiusAU * 1.03, 0);
  const strutRadius = referenceRadiusAU * 0.012;
  const strutY = referenceRadiusAU * 0.85;
  const strutSpread = dishRadius * 0.42;
  const dishAnchors = [
    new THREE.Vector3(strutSpread, strutY, 0),
    new THREE.Vector3(-strutSpread, strutY, 0),
    new THREE.Vector3(0, strutY, strutSpread),
    new THREE.Vector3(0, strutY, -strutSpread),
  ];
  for (const anchor of dishAnchors) {
    model.add(createRodBetween(anchor, feedAnchor, strutRadius, trussMaterial, 6));
  }

  const forwardBoom = createRodBetween(
    new THREE.Vector3(0, coreHeight * 0.18, 0),
    new THREE.Vector3(0, referenceRadiusAU * 2.55, 0),
    referenceRadiusAU * 0.018,
    trussMaterial,
    8,
  );
  model.add(forwardBoom);

  const magnetometer = new THREE.Mesh(
    new THREE.SphereGeometry(referenceRadiusAU * 0.05, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0x86baff }),
  );
  magnetometer.position.y = referenceRadiusAU * 2.65;
  model.add(magnetometer);

  const aftBoomStart = new THREE.Vector3(0, -coreHeight * 0.05, 0);
  const aftBoomEnd = new THREE.Vector3(-referenceRadiusAU * 1.55, -referenceRadiusAU * 0.95, 0);
  model.add(createRodBetween(aftBoomStart, aftBoomEnd, referenceRadiusAU * 0.022, trussMaterial, 8));

  const rtgPositions = [
    new THREE.Vector3(-referenceRadiusAU * 0.76, -referenceRadiusAU * 0.62, 0),
    new THREE.Vector3(-referenceRadiusAU * 1.03, -referenceRadiusAU * 0.8, 0),
    new THREE.Vector3(-referenceRadiusAU * 1.31, -referenceRadiusAU * 0.98, 0),
  ];
  for (const rtgPosition of rtgPositions) {
    const rtg = new THREE.Mesh(
      new THREE.CylinderGeometry(referenceRadiusAU * 0.105, referenceRadiusAU * 0.105, referenceRadiusAU * 0.38, 16),
      darkMetalMaterial,
    );
    rtg.rotation.z = Math.PI / 2;
    rtg.position.copy(rtgPosition);
    model.add(rtg);

    const finRing = new THREE.Mesh(
      new THREE.TorusGeometry(referenceRadiusAU * 0.1, referenceRadiusAU * 0.01, 6, 18),
      new THREE.MeshStandardMaterial({
        color: 0x6f7783,
        roughness: 0.5,
        metalness: 0.34,
      }),
    );
    finRing.rotation.y = Math.PI / 2;
    finRing.position.copy(rtgPosition);
    model.add(finRing);
  }

  const scienceMast = createRodBetween(
    new THREE.Vector3(coreRadius * 0.4, -referenceRadiusAU * 0.04, 0),
    new THREE.Vector3(referenceRadiusAU * 0.98, -referenceRadiusAU * 0.54, 0),
    referenceRadiusAU * 0.014,
    trussMaterial,
    6,
  );
  model.add(scienceMast);

  const instrument = new THREE.Mesh(
    new THREE.BoxGeometry(referenceRadiusAU * 0.18, referenceRadiusAU * 0.11, referenceRadiusAU * 0.11),
    whiteMetalMaterial,
  );
  instrument.position.set(referenceRadiusAU * 1.02, -referenceRadiusAU * 0.56, 0);
  model.add(instrument);

  const plasmaAntenna = createRodBetween(
    new THREE.Vector3(0, referenceRadiusAU * 0.16, coreRadius * 0.25),
    new THREE.Vector3(0, referenceRadiusAU * 0.62, referenceRadiusAU * 0.94),
    referenceRadiusAU * 0.008,
    trussMaterial,
    5,
  );
  model.add(plasmaAntenna);

  model.rotation.z = -Math.PI / 2;
  model.scale.setScalar(1.25);
  return model;
}
