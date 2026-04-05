import * as THREE from 'three';
import { LIGHT_SPEED_AU_PER_S } from './planets/planetData';

// Default speed: traverse solar system (~30 AU) in ~30 minutes
// 30 AU / 1800s = 0.0167 AU/s ≈ 2.8× light speed
const DEFAULT_SPEED_AU_S = 30 / 1800;

export class PlayerShip {
  group: THREE.Group;
  mesh: THREE.Mesh;

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

    // The player is a small moon-like sphere
    const moonRadiusAU = 1737.4 / 149_597_870.7; // Moon radius in AU
    const geo = new THREE.SphereGeometry(moonRadiusAU * 50, 16, 8); // 50x larger for visibility
    const mat = new THREE.MeshStandardMaterial({
      color: 0xaaaaaa,
      roughness: 0.9,
      metalness: 0.0,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.group.add(this.mesh);

    // Add a subtle glow around the player for visibility
    const glowGeo = new THREE.SphereGeometry(moonRadiusAU * 100, 16, 8);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x6688ff,
      transparent: true,
      opacity: 0.15,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.group.add(new THREE.Mesh(glowGeo, glowMat));
  }

  get speedAUPerS(): number {
    return this.moving ? DEFAULT_SPEED_AU_S * this.speedMultiplier : 0;
  }

  get speedC(): number {
    return this.speedAUPerS / LIGHT_SPEED_AU_PER_S;
  }

  update(dt: number) {
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
  static readonly SPEED_MIN = 0.05;
  static readonly SPEED_MAX = 50;
  static readonly SPEED_DEFAULT = 1.0;
  static readonly DEFAULT_SPEED_AU_S = DEFAULT_SPEED_AU_S;
}
