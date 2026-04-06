import * as THREE from 'three';
import { LIGHT_SPEED_AU_PER_S } from './planets/planetData';

// Default speed: traverse solar system (~30 AU) in ~30 minutes
// 30 AU / 1800s = 0.0167 AU/s ≈ 2.8× light speed
const DEFAULT_SPEED_AU_S = 30 / 1800;

export class PlayerShip {
  group: THREE.Group;
  mesh: THREE.Mesh;
  private exhaustLight: THREE.PointLight;
  private exhaustGlow: THREE.Mesh;

  // Position in AU (double precision)
  posX = 0.05;
  posY = 0;
  posZ = 0;

  // Heading in radians (0 = +X, PI/2 = +Z)
  heading = 0;

  // Speed multiplier (1.0 = default, adjustable)
  speedMultiplier = 1.0;

  // Is moving
  moving = true;

  // Steering input (-1 to 1)
  steerInput = 0;

  // Accumulated stats
  distanceTraveled = 0;
  timeElapsed = 0;
  visitedPlanets: Set<string> = new Set();

  constructor() {
    this.group = new THREE.Group();

    // Rocket ship roughly Moon-sized for scale comparison
    const moonRadiusAU = 1737.4 / 149_597_870.7;
    const shipLength = moonRadiusAU * 3;
    const shipRadius = moonRadiusAU * 0.8;

    // Fuselage (cylinder with slight taper)
    const bodyGeo = new THREE.CylinderGeometry(shipRadius * 0.9, shipRadius, shipLength, 16);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xd8d8d8,
      roughness: 0.3,
      metalness: 0.7,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);

    // Nose cone (sleeker)
    const noseGeo = new THREE.ConeGeometry(shipRadius * 0.9, shipLength * 0.6, 16);
    const noseMat = new THREE.MeshStandardMaterial({
      color: 0xdd3311,
      roughness: 0.25,
      metalness: 0.5,
      emissive: 0x330800,
      emissiveIntensity: 0.3,
    });
    const nose = new THREE.Mesh(noseGeo, noseMat);
    nose.position.y = shipLength * 0.8;

    // Engine bell (wider, darker)
    const engineGeo = new THREE.ConeGeometry(shipRadius * 1.3, shipLength * 0.35, 16);
    const engineMat = new THREE.MeshStandardMaterial({
      color: 0x444444,
      roughness: 0.5,
      metalness: 0.9,
    });
    const engine = new THREE.Mesh(engineGeo, engineMat);
    engine.position.y = -shipLength * 0.67;
    engine.rotation.x = Math.PI;

    // Fins (4 swept-back fins around the base)
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0);
    finShape.lineTo(shipRadius * 2.2, -shipLength * 0.4);
    finShape.lineTo(shipRadius * 1.5, -shipLength * 0.05);
    finShape.lineTo(0, shipLength * 0.15);
    finShape.closePath();

    const finGeo = new THREE.ExtrudeGeometry(finShape, {
      depth: shipRadius * 0.06,
      bevelEnabled: false,
    });
    const finMat = new THREE.MeshStandardMaterial({
      color: 0xcc2200,
      roughness: 0.3,
      metalness: 0.6,
      side: THREE.DoubleSide,
    });

    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(finGeo, finMat);
      fin.position.y = -shipLength * 0.35;
      fin.rotation.y = (i * Math.PI) / 2;
      body.add(fin);
    }

    // Window / cockpit stripe
    const windowGeo = new THREE.RingGeometry(shipRadius * 0.88, shipRadius * 0.95, 16);
    const windowMat = new THREE.MeshStandardMaterial({
      color: 0x88ccff,
      emissive: 0x4488cc,
      emissiveIntensity: 0.6,
      roughness: 0.1,
      metalness: 0.3,
      side: THREE.DoubleSide,
    });
    const window1 = new THREE.Mesh(windowGeo, windowMat);
    window1.position.y = shipLength * 0.3;
    window1.rotation.x = Math.PI / 2;
    body.add(window1);

    // Exhaust glow (visible when moving)
    const exhaustGlowGeo = new THREE.ConeGeometry(shipRadius * 0.8, shipLength * 0.6, 12);
    const exhaustGlowMat = new THREE.MeshBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.5,
    });
    this.exhaustGlow = new THREE.Mesh(exhaustGlowGeo, exhaustGlowMat);
    this.exhaustGlow.position.y = -shipLength * 1.05;
    this.exhaustGlow.rotation.x = Math.PI;

    // Exhaust point light
    this.exhaustLight = new THREE.PointLight(0x4488ff, 0.5, shipLength * 8);
    this.exhaustLight.position.y = -shipLength * 0.9;

    // Assemble into mesh group; orient so +Y = forward
    this.mesh = body; // reference for visibility toggle
    const shipModel = new THREE.Group();
    shipModel.add(body, nose, engine, this.exhaustGlow, this.exhaustLight);
    // Rotate so the ship's forward (+Y local) aligns with +X world initially
    shipModel.rotation.z = -Math.PI / 2;
    this.group.add(shipModel);
    this.group.userData.shipModel = shipModel;
  }

  get speedAUPerS(): number {
    return this.moving ? DEFAULT_SPEED_AU_S * this.speedMultiplier : 0;
  }

  get speedC(): number {
    return this.speedAUPerS / LIGHT_SPEED_AU_PER_S;
  }

  update(dt: number) {
    // Always rotate ship to face heading
    this.group.rotation.y = -this.heading;

    // Update exhaust based on speed
    const speedFraction = this.speedMultiplier / PlayerShip.SPEED_MAX;
    const exhaustOn = this.moving && this.speedMultiplier > 0.01;
    this.exhaustGlow.visible = exhaustOn;
    this.exhaustLight.visible = exhaustOn;
    if (exhaustOn) {
      const intensity = 0.3 + speedFraction * 0.7;
      (this.exhaustGlow.material as THREE.MeshBasicMaterial).opacity = intensity * 0.6;
      this.exhaustGlow.scale.setScalar(0.5 + speedFraction * 1.0);
      this.exhaustLight.intensity = intensity;
    }

    if (!this.moving) return;

    const speed = this.speedAUPerS;

    // Apply steering
    if (this.steerInput !== 0) {
      this.heading += this.steerInput * dt * 0.8; // turning rate
    }

    // Move along heading
    const dx = Math.cos(this.heading) * speed * dt;
    const dz = Math.sin(this.heading) * speed * dt;

    this.posX += dx;
    this.posZ += dz;

    // Track distance
    this.distanceTraveled += Math.sqrt(dx * dx + dz * dz);
    this.timeElapsed += dt;
  }

  setPosition(x: number, y: number, z: number) {
    this.posX = x;
    this.posY = y;
    this.posZ = z;
  }

  // Point heading toward a target position
  headToward(targetX: number, targetZ: number) {
    this.heading = Math.atan2(targetZ - this.posZ, targetX - this.posX);
  }

  getDistanceFromSun(): number {
    return Math.sqrt(this.posX * this.posX + this.posY * this.posY + this.posZ * this.posZ);
  }

  // Speed presets
  static readonly SPEED_MIN = 0;  // Allow full stop in manual mode
  static readonly SPEED_MAX = 3.6; // ~30c at max
  static readonly SPEED_DEFAULT = 1.0;
  static readonly DEFAULT_SPEED_AU_S = DEFAULT_SPEED_AU_S;
}
