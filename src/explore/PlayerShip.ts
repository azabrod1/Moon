import * as THREE from 'three';
import { LIGHT_SPEED_AU_PER_S } from './planets/planetData';

// Default cruise speed: 1c
const DEFAULT_SPEED_AU_S = LIGHT_SPEED_AU_PER_S;
const FORWARD_VECTOR = new THREE.Vector3(1, 0, 0);

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

export class PlayerShip {
  group: THREE.Group;
  mesh: THREE.Mesh;
  private exhaustCone: THREE.Mesh;
  private exhaustCore: THREE.Mesh;
  private exhaustLight: THREE.PointLight;
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
    const R = moonRadiusAU * 0.7;   // hull radius
    const L = moonRadiusAU * 3;     // overall length reference

    // ── Hull ──
    const hullGeo = createHullGeometry(R, L);
    const hullMat = new THREE.MeshStandardMaterial({
      color: 0xb0c0d8,
      emissive: 0x1a2540,
      emissiveIntensity: 0.2,
      roughness: 0.45,
      metalness: 0.4,
    });
    const hull = new THREE.Mesh(hullGeo, hullMat);
    this.mesh = hull;

    // ── Accent stripe (ring around the hull) ──
    const stripeGeo = new THREE.TorusGeometry(R * 1.005, R * 0.04, 8, 24);
    const stripeMat = new THREE.MeshStandardMaterial({
      color: 0x2266cc,
      emissive: 0x0a1133,
      emissiveIntensity: 0.15,
      roughness: 0.2,
      metalness: 0.8,
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
      emissiveIntensity: 0.2,
      roughness: 0.05,
      metalness: 0.1,
      transparent: true,
      opacity: 0.75,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
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
      emissiveIntensity: 0.25,
      roughness: 0.4,
      metalness: 0.9,
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

    // Engine light (subtle)
    this.exhaustLight = new THREE.PointLight(0x334466, 0.15, L * 4, 0);
    this.exhaustLight.position.y = -L * 0.7;

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

    // ── Assemble ──
    const shipModel = new THREE.Group();
    shipModel.add(hull, this.exhaustCone, this.exhaustCore, this.exhaustLight);
    // Orient: ship's +Y (forward) aligns with world +X
    shipModel.rotation.z = -Math.PI / 2;
    this.group.add(shipModel);
    this.group.userData.shipModel = shipModel;
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

    this.exhaustCone.visible = exhaustOn;
    this.exhaustCore.visible = exhaustOn;
    this.exhaustLight.visible = exhaustOn;

    if (exhaustOn) {
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

      this.exhaustLight.intensity = intensity * 0.3 * pulse;
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
}
