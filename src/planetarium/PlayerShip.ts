/**
 * Player ship for the Planetarium: position (AU), heading + pitch, speed as a
 * multiple of c, autopilot target, and per-mission ship profiles. Also owns
 * the visible GLB ship mesh. Pure state + kinematics — mode-specific physics
 * tuning and autopilot policy live here until Phase 2 splits out
 * ship/PlayerShipState, ship/ShipPhysics, ship/ShipAutopilot, etc.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { LIGHT_SPEED_AU_PER_S } from './planets/planetData';
import { createHullGeometry, createEngineBell, createFin } from './ship/models/shipPrimitives';
import { createVoyagerModel } from './ship/models/voyager';
import { createCassiniModel } from './ship/models/cassini';
import { createNewHorizonsModel } from './ship/models/newHorizons';
import { createJunoModel } from './ship/models/juno';

// Default cruise speed: 1c
const DEFAULT_SPEED_AU_S = LIGHT_SPEED_AU_PER_S;
const FORWARD_VECTOR = new THREE.Vector3(1, 0, 0);

export type ShipProfile = 'default' | 'voyager' | 'cassini' | 'newHorizons' | 'juno';

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
  systemSpeedMultiplier = 0.083; // ~25k km/s default system speed
  systemSpeedFactor = 1.0;      // 1 = open space, 0 = deep in system (set by PlanetariumMode)
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
      const fin = createFin(R, L);
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
      ? createVoyagerModel(referenceRadiusAU)
      : profile === 'cassini'
        ? createCassiniModel(referenceRadiusAU)
        : profile === 'newHorizons'
          ? createNewHorizonsModel(referenceRadiusAU)
          : createJunoModel(referenceRadiusAU);
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
      const fallback = createCassiniModel(this.spacecraftReferenceRadiusAU);
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

  get speedAUPerS(): number {
    if (!this.moving) return 0;
    const cruise = DEFAULT_SPEED_AU_S * this.speedMultiplier;
    const system = DEFAULT_SPEED_AU_S * Math.min(this.systemSpeedMultiplier, this.speedMultiplier);
    return system + (cruise - system) * this.systemSpeedFactor;
  }

  get speedC(): number {
    return this.speedAUPerS / LIGHT_SPEED_AU_PER_S;
  }

  update(dt: number) {
    const direction = this.getForwardDirection();
    this.group.quaternion.setFromUnitVectors(FORWARD_VECTOR, direction);

    // Animate exhaust
    this.exhaustTime += dt;
    const effectiveMultiplier = this.speedAUPerS / DEFAULT_SPEED_AU_S;
    const speedFrac = effectiveMultiplier / PlayerShip.SPEED_MAX;
    const exhaustOn = this.moving && effectiveMultiplier > 0.01;

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
  static readonly SPEED_MAX = 20;
  static readonly SPEED_DEFAULT = 1.0;
  static readonly SYSTEM_SPEED_MAX = 0.4;     // 0.4c ≈ 120k km/s
  static readonly SYSTEM_SPEED_DEFAULT = 0.083; // ~25k km/s
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
