/**
 * Player ship for the Planetarium: position (AU), heading + pitch, speed as a
 * multiple of c, selectable player craft, and per-mission ship profiles. Owns
 * the ship state, per-frame kinematics + exhaust animation, and the lifecycle of the visible
 * ship/probe models (built lazily; the Cassini profile loads a GLB with a
 * procedural fallback). All procedural geometry lives in ship/models/.
 */
import * as THREE from 'three';
import { SHIP_REFERENCE_RADIUS_AU } from './cruiseView';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { LIGHT_SPEED_AU_PER_S } from './planets/planetData';
import { createDefaultShip } from './ship/models/defaultShip';
import { createVoyagerModel } from './ship/models/voyager';
import { createCassiniModel } from './ship/models/cassini';
import { createNewHorizonsModel } from './ship/models/newHorizons';
import { createJunoModel } from './ship/models/juno';
import { createPlayerFleetModel } from './ship/models/playerFleet';
import {
  isPlayerShipProfile,
  type HistoricShipProfile,
  type PlayerShipProfile,
  type ShipProfile,
} from './ship/shipProfiles';

export type { HistoricShipProfile, PlayerShipProfile, ShipProfile } from './ship/shipProfiles';

// Default cruise speed: 1c
const DEFAULT_SPEED_AU_S = LIGHT_SPEED_AU_PER_S;
const FORWARD_VECTOR = new THREE.Vector3(1, 0, 0);

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
  private playerFleetModels = new Map<Exclude<PlayerShipProfile, 'default'>, THREE.Group>();
  private spacecraftReferenceRadiusAU: number;
  private profile: ShipProfile = 'default';
  private exhaustCone: THREE.Mesh;
  private exhaustCore: THREE.Mesh;

  posX = 0.05;
  posY = 0;
  posZ = 0;
  heading = 0;
  pitch = 0;
  speedMultiplier = 1.0;
  systemSpeedMultiplier = 0.083; // ~25k km/s default system speed
  systemSpeedFactor = 1.0;      // 1 = open space, 0 = deep in system (set by PlanetariumMode)
  speedCapAUPerS = Infinity;    // per-frame moon-proximity cap (set by PlanetariumMode)
  moving = true;
  yawInput = 0;
  pitchInput = 0;
  distanceTraveled = 0;
  timeElapsed = 0;
  visitedPlanets: Set<string> = new Set();

  constructor() {
    this.group = new THREE.Group();

    // The rig-scaled reference radius: the hull and every chase-view pad
    // derive from the same base (see cruiseView.ts), so the ship's on-screen
    // size survives any rig rescale.
    this.spacecraftReferenceRadiusAU = SHIP_REFERENCE_RADIUS_AU;

    const ship = createDefaultShip(SHIP_REFERENCE_RADIUS_AU);
    this.defaultModel = ship.model;
    this.mesh = ship.mesh;
    this.exhaustCone = ship.exhaustCone;
    this.exhaustCore = ship.exhaustCore;
    this.group.add(this.defaultModel);
    this.group.userData.shipModel = this.defaultModel;
  }

  private getOrCreateProbeModel(profile: HistoricShipProfile): THREE.Group {
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

  private getOrCreatePlayerModel(profile: Exclude<PlayerShipProfile, 'default'>): THREE.Group {
    const existing = this.playerFleetModels.get(profile);
    if (existing) return existing;
    const model = createPlayerFleetModel(profile, this.spacecraftReferenceRadiusAU);
    model.visible = false;
    this.group.add(model);
    this.playerFleetModels.set(profile, model);
    return model;
  }

  async ensureProfileLoaded(profile: HistoricShipProfile): Promise<void> {
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

  private setPlayerFleetModelsVisible(visible: boolean) {
    for (const model of this.playerFleetModels.values()) model.visible = visible;
  }

  /** The speed the dialed throttle WOULD fly this frame: the cruise/system
   *  blend with no proximity cap and no parked gate. The governor's engaged
   *  latch compares its cap against this — the applied speed is circular
   *  (it already contains the cap) and reads 0 parked, which would clear
   *  the latch the moment the ship stops beside a body. */
  get commandedSpeedAUPerS(): number {
    const cruise = DEFAULT_SPEED_AU_S * this.speedMultiplier;
    const system = DEFAULT_SPEED_AU_S * Math.min(this.systemSpeedMultiplier, this.speedMultiplier);
    return system + (cruise - system) * this.systemSpeedFactor;
  }

  get speedAUPerS(): number {
    if (!this.moving) return 0;
    return Math.min(this.commandedSpeedAUPerS, this.speedCapAUPerS);
  }

  get speedC(): number {
    return this.speedAUPerS / LIGHT_SPEED_AU_PER_S;
  }

  /**
   * Sync the visible model to the current heading/pitch without integrating
   * motion. Scripted mission transfers drive the pose fields directly and
   * skip update(), the only other writer of the model quaternion.
   */
  syncModelOrientation() {
    this.group.quaternion.setFromUnitVectors(FORWARD_VECTOR, this.getForwardDirection());
  }

  update(dt: number) {
    this.syncModelOrientation();

    // Animate exhaust
    const effectiveMultiplier = this.speedAUPerS / DEFAULT_SPEED_AU_S;
    const speedFrac = effectiveMultiplier / PlayerShip.SPEED_MAX;
    const exhaustOn = this.moving && effectiveMultiplier > 0.01;

    const showExhaust = this.profile === 'default' && exhaustOn;
    this.exhaustCone.visible = showExhaust;
    this.exhaustCore.visible = showExhaust;

    if (showExhaust) {
      // Steady torch, no flicker: the additive HDR plume sits near the
      // composer's bloom threshold, so even a small opacity pulse gates the
      // glow on and off and reads as throbbing. The top of the ramp is kept
      // modest for the same reason — full burn should read as a bright
      // lance, not flood the frame.
      const intensity = 0.2 + speedFrac * 0.28;

      // Outer plume — subtle haze
      (this.exhaustCone.material as THREE.MeshBasicMaterial).opacity = intensity * 0.1;
      this.exhaustCone.scale.set(
        0.5 + speedFrac * 0.35,
        0.4 + speedFrac * 0.65,
        0.5 + speedFrac * 0.35,
      );

      // Inner core — moderate glow
      (this.exhaustCore.material as THREE.MeshBasicMaterial).opacity = intensity * 0.35;
      this.exhaustCore.scale.set(
        0.6 + speedFrac * 0.25,
        0.3 + speedFrac * 0.85,
        0.6 + speedFrac * 0.25,
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
    this.setProbeModelsVisible(false);
    this.setPlayerFleetModelsVisible(false);
    if (profile !== 'default' && isPlayerShipProfile(profile)) {
      const playerModel = this.getOrCreatePlayerModel(profile);
      this.defaultModel.visible = false;
      playerModel.visible = true;
      this.group.userData.shipModel = playerModel;
      return;
    }
    if (profile !== 'default') {
      // Cassini's model loads asynchronously (GLB), so `cassiniModel` is null
      // until it resolves. Resolve the probe model BEFORE hiding the default
      // ship: a not-yet-loaded profile then falls back to the visible default
      // rather than blanking the player out entirely.
      const probeModel = profile === 'cassini'
        ? this.cassiniModel
        : this.getOrCreateProbeModel(profile);
      if (probeModel) {
        this.defaultModel.visible = false;
        probeModel.visible = true;
        this.group.userData.shipModel = probeModel;
        return;
      }
    }
    this.defaultModel.visible = true;
    this.group.userData.shipModel = this.defaultModel;
  }
}
