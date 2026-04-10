import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { LIGHT_SPEED_AU_PER_S } from './planets/planetData';

// Default cruise speed: 1c
const DEFAULT_SPEED_AU_S = LIGHT_SPEED_AU_PER_S;
const FORWARD_VECTOR = new THREE.Vector3(1, 0, 0);

export type ShipProfile = 'default' | 'voyager' | 'cassini' | 'newHorizons' | 'juno';

/** Build a smooth hull profile via LatheGeometry */
function createHullGeometry(radius: number, length: number): THREE.LatheGeometry {
  // Profile points from nose tip (top) to engine base (bottom)
  // x = radius at that point, y = height
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0, length * 1.1),                    // nose tip
    new THREE.Vector2(radius * 0.12, length * 1.05),       // nose start
    new THREE.Vector2(radius * 0.4, length * 0.9),         // nose shoulder
    new THREE.Vector2(radius * 0.75, length * 0.7),        // upper taper
    new THREE.Vector2(radius * 0.92, length * 0.5),        // cockpit area
    new THREE.Vector2(radius, length * 0.3),               // max width
    new THREE.Vector2(radius, length * 0.0),               // mid body
    new THREE.Vector2(radius * 0.97, -length * 0.2),       // slight waist
    new THREE.Vector2(radius * 0.9, -length * 0.35),       // lower waist
    new THREE.Vector2(radius * 0.85, -length * 0.45),      // pre-engine taper
    new THREE.Vector2(radius * 0.75, -length * 0.5),       // engine mount
  ];
  return new THREE.LatheGeometry(pts, 24);
}

/** Engine bell with proper nozzle curve */
function createEngineBell(radius: number, length: number): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(radius * 0.3, 0),           // throat (top, narrow)
    new THREE.Vector2(radius * 0.25, -length * 0.05),
    new THREE.Vector2(radius * 0.3, -length * 0.12),
    new THREE.Vector2(radius * 0.5, -length * 0.22),
    new THREE.Vector2(radius * 0.75, -length * 0.32),
    new THREE.Vector2(radius * 1.05, -length * 0.4), // bell rim
    new THREE.Vector2(radius * 1.0, -length * 0.4),  // inner rim
    new THREE.Vector2(radius * 0.7, -length * 0.3),
    new THREE.Vector2(radius * 0.45, -length * 0.18),
    new THREE.Vector2(radius * 0.25, -length * 0.03),
    new THREE.Vector2(radius * 0.28, 0),           // inner throat
  ];
  return new THREE.LatheGeometry(pts, 20);
}

function createVoyagerDishGeometry(radius: number, depth: number): THREE.LatheGeometry {
  const points: THREE.Vector2[] = [];
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = radius * t;
    const y = -(t * t) * depth;
    points.push(new THREE.Vector2(r, y));
  }

  points.push(new THREE.Vector2(radius * 0.96, -depth * 0.92));
  points.push(new THREE.Vector2(radius * 0.88, -depth * 0.72));
  points.push(new THREE.Vector2(radius * 0.16, -depth * 0.08));

  return new THREE.LatheGeometry(points, 40);
}

function createRodBetween(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  radialSegments = 8,
): THREE.Mesh {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, radialSegments),
    material,
  );
  rod.position.copy(start).add(end).multiplyScalar(0.5);
  rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return rod;
}

export class PlayerShip {
  private static readonly gltfLoader = new GLTFLoader();

  group: THREE.Group;
  mesh: THREE.Mesh;
  private defaultModel: THREE.Group;
  private voyagerModel: THREE.Group | null = null;
  private cassiniModel: THREE.Group | null = null;
  private cassiniModelPromise: Promise<THREE.Group> | null = null;
  private newHorizonsModel: THREE.Group | null = null;
  private junoModel: THREE.Group | null = null;
  private spacecraftReferenceRadiusAU: number;
  private profile: ShipProfile = 'default';
  private exhaustCone: THREE.Mesh;
  private exhaustCore: THREE.Mesh;
  private exhaustTime = 0;

  posX = 0.05;
  posY = 0;
  posZ = 0;
  heading = 0;
  pitch = 0;
  speedMultiplier = 1.0;
  moving = true;
  yawInput = 0;
  pitchInput = 0;
  distanceTraveled = 0;
  timeElapsed = 0;
  visitedPlanets: Set<string> = new Set();

  constructor() {
    this.group = new THREE.Group();

    const moonRadiusAU = 1737.4 / 149_597_870.7;
    this.spacecraftReferenceRadiusAU = moonRadiusAU;
    const R = moonRadiusAU * 0.7;   // hull radius
    const L = moonRadiusAU * 3;     // overall length reference

    // ── Hull ──
    const hullGeo = createHullGeometry(R, L);
    const hullMat = new THREE.MeshStandardMaterial({
      color: 0xb0c0d8,
      emissive: 0x0a1220,
      emissiveIntensity: 0.08,
      roughness: 0.7,
      metalness: 0.15,
    });
    const hull = new THREE.Mesh(hullGeo, hullMat);
    this.mesh = hull;

    // ── Accent stripe (ring around the hull) ──
    const stripeGeo = new THREE.TorusGeometry(R * 1.005, R * 0.04, 8, 24);
    const stripeMat = new THREE.MeshStandardMaterial({
      color: 0x2266cc,
      emissive: 0x0a1133,
      emissiveIntensity: 0.08,
      roughness: 0.5,
      metalness: 0.3,
    });
    const stripe = new THREE.Mesh(stripeGeo, stripeMat);
    stripe.position.y = L * 0.3;
    stripe.rotation.x = Math.PI / 2;
    hull.add(stripe);

    // Second accent stripe lower
    const stripe2 = new THREE.Mesh(stripeGeo, stripeMat);
    stripe2.position.y = -L * 0.2;
    stripe2.rotation.x = Math.PI / 2;
    hull.add(stripe2);

    // ── Cockpit canopy ──
    const canopyGeo = new THREE.SphereGeometry(R * 0.38, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55);
    const canopyMat = new THREE.MeshPhysicalMaterial({
      color: 0x88ddff,
      emissive: 0x112233,
      emissiveIntensity: 0.08,
      roughness: 0.15,
      metalness: 0.05,
      transparent: true,
      opacity: 0.65,
      clearcoat: 0.5,
      clearcoatRoughness: 0.2,
    });
    const canopy = new THREE.Mesh(canopyGeo, canopyMat);
    canopy.position.set(0, L * 0.55, R * 0.65);
    canopy.rotation.x = -Math.PI * 0.15;
    hull.add(canopy);

    // ── Engine bell ──
    const bellGeo = createEngineBell(R, L);
    const bellMat = new THREE.MeshStandardMaterial({
      color: 0x4a5058,
      emissive: 0x0c1018,
      emissiveIntensity: 0.1,
      roughness: 0.6,
      metalness: 0.3,
    });
    const bell = new THREE.Mesh(bellGeo, bellMat);
    bell.position.y = -L * 0.5;
    hull.add(bell);

    // Inner engine glow ring
    const glowRingGeo = new THREE.TorusGeometry(R * 0.3, R * 0.04, 8, 16);
    const glowRingMat = new THREE.MeshBasicMaterial({
      color: 0x884422,
      transparent: true,
      opacity: 0.25,
    });
    const glowRing = new THREE.Mesh(glowRingGeo, glowRingMat);
    glowRing.position.y = -L * 0.52;
    glowRing.rotation.x = Math.PI / 2;
    hull.add(glowRing);

    // ── Fins (3 swept delta fins) ──
    for (let i = 0; i < 3; i++) {
      const fin = this.createFin(R, L);
      fin.rotation.y = (i * Math.PI * 2) / 3;
      hull.add(fin);
    }

    // ── Exhaust plume (layered) ──
    // Outer glow (wide, subtle)
    const outerGeo = new THREE.ConeGeometry(R * 0.6, L * 0.5, 12);
    const outerMat = new THREE.MeshBasicMaterial({
      color: 0x2a3d66,
      transparent: true,
      opacity: 0.08,
    });
    this.exhaustCone = new THREE.Mesh(outerGeo, outerMat);
    this.exhaustCone.position.y = -L * 1.3;
    this.exhaustCone.rotation.x = Math.PI;

    // Inner core (narrow, moderate)
    const coreGeo = new THREE.ConeGeometry(R * 0.18, L * 0.55, 8);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0x7799cc,
      transparent: true,
      opacity: 0.35,
    });
    this.exhaustCore = new THREE.Mesh(coreGeo, coreMat);
    this.exhaustCore.position.y = -L * 1.35;
    this.exhaustCore.rotation.x = Math.PI;

    // ── Nose tip accent ──
    const noseTipGeo = new THREE.SphereGeometry(R * 0.08, 8, 8);
    const noseTipMat = new THREE.MeshStandardMaterial({
      color: 0xcc2200,
      emissive: 0x551100,
      emissiveIntensity: 0.3,
      roughness: 0.3,
      metalness: 0.5,
    });
    const noseTip = new THREE.Mesh(noseTipGeo, noseTipMat);
    noseTip.position.y = L * 1.12;
    hull.add(noseTip);

    // ── Assemble default ship ──
    this.defaultModel = new THREE.Group();
    this.defaultModel.add(hull, this.exhaustCone, this.exhaustCore);
    this.defaultModel.rotation.z = -Math.PI / 2;
    this.group.add(this.defaultModel);

    this.group.userData.shipModel = this.defaultModel;
  }

  private getOrCreateProbeModel(profile: Exclude<ShipProfile, 'default'>): THREE.Group {
    const existing = profile === 'voyager'
      ? this.voyagerModel
      : profile === 'cassini'
        ? this.cassiniModel
        : profile === 'newHorizons'
          ? this.newHorizonsModel
          : this.junoModel;
    if (existing) return existing;

    const referenceRadiusAU = this.spacecraftReferenceRadiusAU;
    const model = profile === 'voyager'
      ? this.createVoyagerModel(referenceRadiusAU)
      : profile === 'cassini'
        ? this.createCassiniModel(referenceRadiusAU)
        : profile === 'newHorizons'
          ? this.createNewHorizonsModel(referenceRadiusAU)
          : this.createJunoModel(referenceRadiusAU);
    model.visible = false;
    this.group.add(model);

    if (profile === 'voyager') this.voyagerModel = model;
    else if (profile === 'cassini') this.cassiniModel = model;
    else if (profile === 'newHorizons') this.newHorizonsModel = model;
    else this.junoModel = model;

    return model;
  }

  async ensureProfileLoaded(profile: Exclude<ShipProfile, 'default'>): Promise<void> {
    if (profile === 'cassini') {
      await this.getOrCreateCassiniAssetModel();
      return;
    }
    this.getOrCreateProbeModel(profile);
  }

  private async getOrCreateCassiniAssetModel(): Promise<THREE.Group> {
    if (this.cassiniModel) return this.cassiniModel;
    if (this.cassiniModelPromise) return this.cassiniModelPromise;

    this.cassiniModelPromise = PlayerShip.gltfLoader.loadAsync(
      `${import.meta.env.BASE_URL}models/cassini-assembly.glb`,
    ).then((gltf) => {
      const root = new THREE.Group();
      const scene = gltf.scene;
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.castShadow = false;
          obj.receiveShadow = false;
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const material of materials) {
            if ('metalness' in material) material.metalness = Math.min(material.metalness ?? 0, 0.65);
            if ('roughness' in material) material.roughness = Math.max(material.roughness ?? 0.5, 0.38);
          }
        }
      });

      const bounds = new THREE.Box3().setFromObject(scene);
      const size = bounds.getSize(new THREE.Vector3());
      const maxDimension = Math.max(size.x, size.y, size.z, 1e-8);
      const targetDimension = this.spacecraftReferenceRadiusAU * 5.6;
      const scale = targetDimension / maxDimension;
      scene.scale.setScalar(scale);

      bounds.setFromObject(scene);
      const center = bounds.getCenter(new THREE.Vector3());
      scene.position.sub(center);

      root.add(scene);
      root.rotation.x = -Math.PI / 2;
      root.rotation.z = -Math.PI / 2;
      root.rotation.y = Math.PI;
      root.scale.setScalar(1.18);
      root.visible = false;
      this.group.add(root);
      this.cassiniModel = root;
      return root;
    }).catch(() => {
      const fallback = this.createCassiniModel(this.spacecraftReferenceRadiusAU);
      fallback.visible = false;
      this.group.add(fallback);
      this.cassiniModel = fallback;
      return fallback;
    }).finally(() => {
      this.cassiniModelPromise = null;
    });

    return this.cassiniModelPromise;
  }

  private setProbeModelsVisible(visible: boolean) {
    if (this.voyagerModel) this.voyagerModel.visible = visible;
    if (this.cassiniModel) this.cassiniModel.visible = visible;
    if (this.newHorizonsModel) this.newHorizonsModel.visible = visible;
    if (this.junoModel) this.junoModel.visible = visible;
  }

  private createVoyagerModel(referenceRadiusAU: number): THREE.Group {
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

  private createCassiniModel(referenceRadiusAU: number): THREE.Group {
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
      createVoyagerDishGeometry(dishRadius, dishDepth),
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

  private createNewHorizonsModel(referenceRadiusAU: number): THREE.Group {
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

  private createJunoModel(referenceRadiusAU: number): THREE.Group {
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
      createVoyagerDishGeometry(dishRadius, referenceRadiusAU * 0.18),
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

  private createFin(R: number, L: number): THREE.Mesh {
    const shape = new THREE.Shape();
    // Swept delta fin profile
    shape.moveTo(0, L * 0.05);                  // leading edge root
    shape.lineTo(R * 0.15, -L * 0.1);           // along hull
    shape.quadraticCurveTo(
      R * 1.6, -L * 0.35,                       // control point (sweep)
      R * 1.8, -L * 0.5,                        // tip trailing edge
    );
    shape.lineTo(R * 1.4, -L * 0.45);           // tip leading edge
    shape.quadraticCurveTo(
      R * 0.8, -L * 0.2,                        // control point back
      0, -L * 0.05,                              // root trailing edge
    );
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: R * 0.04,
      bevelEnabled: true,
      bevelThickness: R * 0.015,
      bevelSize: R * 0.015,
      bevelSegments: 2,
    });
    const mat = new THREE.MeshStandardMaterial({
      color: 0x8090a8,
      emissive: 0x141c28,
      emissiveIntensity: 0.25,
      roughness: 0.3,
      metalness: 0.7,
      side: THREE.DoubleSide,
    });
    const fin = new THREE.Mesh(geo, mat);
    fin.position.y = -L * 0.3;

    // Red fin tip accent
    const tipGeo = new THREE.SphereGeometry(R * 0.06, 6, 6);
    const tipMat = new THREE.MeshStandardMaterial({
      color: 0xdd2200,
      emissive: 0x661100,
      emissiveIntensity: 0.4,
      roughness: 0.3,
      metalness: 0.5,
    });
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.position.set(R * 1.7, -L * 0.18, R * 0.02);
    fin.add(tip);

    return fin;
  }

  get speedAUPerS(): number {
    return this.moving ? DEFAULT_SPEED_AU_S * this.speedMultiplier : 0;
  }

  get speedC(): number {
    return this.speedAUPerS / LIGHT_SPEED_AU_PER_S;
  }

  update(dt: number) {
    const direction = this.getForwardDirection();
    this.group.quaternion.setFromUnitVectors(FORWARD_VECTOR, direction);

    // Animate exhaust
    this.exhaustTime += dt;
    const speedFrac = this.speedMultiplier / PlayerShip.SPEED_MAX;
    const exhaustOn = this.moving && this.speedMultiplier > 0.01;

    const showExhaust = this.profile === 'default' && exhaustOn;
    this.exhaustCone.visible = showExhaust;
    this.exhaustCore.visible = showExhaust;

    if (showExhaust) {
      const pulse = 0.95 + 0.05 * Math.sin(this.exhaustTime * 10);
      const intensity = 0.2 + speedFrac * 0.4;

      // Outer plume — subtle haze
      (this.exhaustCone.material as THREE.MeshBasicMaterial).opacity = intensity * 0.1 * pulse;
      this.exhaustCone.scale.set(
        (0.5 + speedFrac * 0.4) * pulse,
        0.4 + speedFrac * 0.8,
        (0.5 + speedFrac * 0.4) * pulse,
      );

      // Inner core — moderate glow
      (this.exhaustCore.material as THREE.MeshBasicMaterial).opacity = intensity * 0.35;
      this.exhaustCore.scale.set(
        0.6 + speedFrac * 0.3,
        0.3 + speedFrac * 1.0,
        0.6 + speedFrac * 0.3,
      );

    }

    if (!this.moving) return;

    const speed = this.speedAUPerS;

    if (this.yawInput !== 0) {
      this.heading += this.yawInput * dt * 0.8;
    }
    if (this.pitchInput !== 0) {
      this.pitch = Math.max(-Math.PI * 0.49, Math.min(Math.PI * 0.49, this.pitch + this.pitchInput * dt * 0.65));
    }

    const updatedDirection = this.getForwardDirection();
    this.group.quaternion.setFromUnitVectors(FORWARD_VECTOR, updatedDirection);

    const dx = updatedDirection.x * speed * dt;
    const dy = updatedDirection.y * speed * dt;
    const dz = updatedDirection.z * speed * dt;

    this.posX += dx;
    this.posY += dy;
    this.posZ += dz;

    this.distanceTraveled += Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.timeElapsed += dt;
  }

  setPosition(x: number, y: number, z: number) {
    this.posX = x;
    this.posY = y;
    this.posZ = z;
  }

  headToward(targetX: number, targetZ: number, targetY = this.posY) {
    const dx = targetX - this.posX;
    const dy = targetY - this.posY;
    const dz = targetZ - this.posZ;
    const horizontal = Math.sqrt(dx * dx + dz * dz);
    this.heading = Math.atan2(dz, dx);
    this.pitch = Math.atan2(dy, Math.max(horizontal, 1e-8));
  }

  getDistanceFromSun(): number {
    return Math.sqrt(this.posX * this.posX + this.posY * this.posY + this.posZ * this.posZ);
  }

  getForwardDirection(): THREE.Vector3 {
    const cosPitch = Math.cos(this.pitch);
    return new THREE.Vector3(
      Math.cos(this.heading) * cosPitch,
      Math.sin(this.pitch),
      Math.sin(this.heading) * cosPitch,
    ).normalize();
  }

  static readonly SPEED_MIN = 0;
  static readonly SPEED_MAX = 3.6;
  static readonly SPEED_DEFAULT = 1.0;
  static readonly DEFAULT_SPEED_AU_S = DEFAULT_SPEED_AU_S;

  setProfile(profile: ShipProfile) {
    this.profile = profile;
    this.defaultModel.visible = profile === 'default';
    if (profile !== 'default') {
      this.setProbeModelsVisible(false);
      const probeModel = profile === 'cassini'
        ? this.cassiniModel
        : this.getOrCreateProbeModel(profile);
      if (!probeModel) {
        this.group.userData.shipModel = this.defaultModel;
        return;
      }
      probeModel.visible = true;
      this.group.userData.shipModel = probeModel;
    } else {
      this.setProbeModelsVisible(false);
      this.group.userData.shipModel = this.defaultModel;
    }
  }
}
