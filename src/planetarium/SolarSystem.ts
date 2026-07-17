/**
 * Builds the Planetarium scene graph: Sun, all planets, orbit lines, asteroid belt.
 * `layoutMode` is 'aligned' (evenly spread for a compact overview) or 'realistic'
 * (ephemeris positions at a given date). Units are AU on the ecliptic.
 */
import * as THREE from 'three';
import { PLANETARIUM_BODIES, ASTEROID_BELT, type PlanetData } from './planets/planetData';
import { createPlanetMesh, createPlanetariumSun, type PlanetMesh } from './PlanetFactory';
import {
  computeBodyPositionAU,
  eclipticToEquatorial,
  sampleOrbitLinePoints,
  sampleTrajectoryLinePoints,
} from '../astronomy/planetary';
import { KM_PER_AU } from '../astronomy/constants';
import type { KeplerElements } from '../astronomy/standish';
import { augmentPointsMaterialWithSunGlareMask } from './world/sunGlareMask';

export type PlanetariumLayout = 'aligned' | 'realistic';
export const CREATE_SOLAR_SYSTEM_TOTAL_UNITS =
  1 + PLANETARIUM_BODIES.length + PLANETARIUM_BODIES.length + 1;

export interface SolarSystemLoadProgress {
  completedUnits: number;
  totalUnits: number;
}

export interface SolarSystemObjects {
  sun: THREE.Group;
  planets: PlanetMesh[];
  orbitLines: THREE.Line[];
  /** Sim epoch the orbit lines were last sampled at (lazy drift rebuild). */
  orbitLinesEpochUtcMs: number;
  asteroidBelt: THREE.Points;
  sunLight: THREE.PointLight;
}

// Decorative spread in the ecliptic plane, baked into the scene's J2000
// equatorial frame so aligned planets sit on their transformed orbit circles.
function createAlignedPlanetPosition(planet: PlanetData, seed: number): { x: number; y: number; z: number } {
  const radius = planet.semiMajorAxisAU;
  const spread = ((seed * 7.13) % 1 - 0.5) * (Math.PI / 6);
  const position = eclipticToEquatorial(
    new THREE.Vector3(radius * Math.cos(spread), 0, -radius * Math.sin(spread)),
  );
  return { x: position.x, y: position.y, z: position.z };
}

export function getPlanetOrbitalPosition(
  planet: PlanetData,
  seed: number,
  layoutMode: PlanetariumLayout,
  date?: Date,
): { x: number; y: number; z: number } {
  if (layoutMode === 'aligned') {
    return createAlignedPlanetPosition(planet, seed);
  }

  const position = computeBodyPositionAU(planet, (date ?? new Date()).getTime());
  return { x: position.x, y: position.y, z: position.z };
}

/** Aligned-mode ring: an epoch-free ecliptic circle at the catalog radius. */
function alignedCircleElements(planet: PlanetData): KeplerElements {
  return {
    semiMajorAxisAU: planet.semiMajorAxisAU,
    eccentricity: 0,
    inclinationDeg: 0,
    lonPerihelionDeg: 0,
    ascendingNodeDeg: 0,
    meanAnomalyDeg: 0,
  };
}

/** Aligned-mode circle segment count (planets sit exactly on the circles). */
export const ORBIT_LINE_SEGMENTS = 256;

/**
 * Realistic-mode segment count, sized so the polyline's chord sagitta stays
 * under ~a quarter of the body's own radius — the planet has to sit ON its
 * line even at landed zoom: N ≈ 2π·√(a / (8·R/4)), rounded up to a multiple
 * of 256. The old global 256 left every planet 1–13 body radii off its line
 * mid-chord (Pluto: ~200 — tiny body, enormous orbit; it clamps at 8192 for
 * ~0.37 R there).
 */
export function orbitLineSegmentCount(planet: PlanetData): number {
  const aKm = planet.semiMajorAxisAU * KM_PER_AU;
  const ideal = Math.ceil(2 * Math.PI * Math.sqrt(aKm / (2 * planet.radiusKm)));
  return Math.min(8192, Math.max(1024, Math.ceil(ideal / 256) * 256));
}

/**
 * One body's orbit-line vertices at a sim epoch. Realistic mode samples the
 * body's actual rendered trajectory (computeBodyPositionAU — see
 * sampleTrajectoryLinePoints for why elements aren't enough); aligned mode
 * draws epoch-free circles at the catalog radius.
 */
function sampleLinePoints(
  planet: PlanetData,
  layoutMode: PlanetariumLayout,
  utcMs: number,
): THREE.Vector3[] {
  if (layoutMode === 'aligned') {
    return sampleOrbitLinePoints(alignedCircleElements(planet), ORBIT_LINE_SEGMENTS);
  }
  return sampleTrajectoryLinePoints(planet, utcMs, orbitLineSegmentCount(planet));
}

/**
 * Re-sample every orbit line's geometry at the given sim epoch and re-stamp
 * orbitLinesEpochUtcMs. Mutates the existing geometry in place — replacing
 * the Line objects would break the orbitLines[i] ↔ PLANETARIUM_BODIES[i]
 * coupling and orphan GPU buffers — and recomputes each bounding sphere
 * (setFromPoints updates attributes but never invalidates the cached sphere,
 * which would leave frustum culling stale). The staleness *policy* (when to
 * call this) lives with the caller, PlanetariumMode.rebuildOrbitLinesIfStale.
 */
export function resampleOrbitLines(
  objects: Pick<SolarSystemObjects, 'orbitLines' | 'orbitLinesEpochUtcMs'>,
  layoutMode: PlanetariumLayout,
  utcMs: number,
): void {
  for (let i = 0; i < objects.orbitLines.length; i++) {
    const points = sampleLinePoints(PLANETARIUM_BODIES[i], layoutMode, utcMs);
    const geometry = objects.orbitLines[i].geometry;
    geometry.setFromPoints(points);
    geometry.computeBoundingSphere();
  }
  objects.orbitLinesEpochUtcMs = utcMs;
}

function createOrbitLine(points: THREE.Vector3[], color: number, opacity: number): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  return new THREE.Line(geometry, material);
}

const ASTEROID_BELT_SEED = 0x41535452;

/** Deterministic decorative scatter so captures and regression tests are stable. */
function asteroidBeltRng(): () => number {
  let state = ASTEROID_BELT_SEED;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function createAsteroidBelt(): THREE.Points {
  const count = 3000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const random = asteroidBeltRng();

  // Generate in the intermediate ecliptic frame, then bake into the scene's
  // J2000 equatorial frame. Height is ecliptic north, not scene-world +Y.
  for (let i = 0; i < count; i++) {
    const radius = ASTEROID_BELT.innerAU + random() * (ASTEROID_BELT.outerAU - ASTEROID_BELT.innerAU);
    const angle = random() * Math.PI * 2;
    const height = (random() - 0.5) * 0.05;
    const position = eclipticToEquatorial(
      new THREE.Vector3(radius * Math.cos(angle), height, -radius * Math.sin(angle)),
    );

    positions[i * 3] = position.x;
    positions[i * 3 + 1] = position.y;
    positions[i * 3 + 2] = position.z;

    const brightness = 0.4 + random() * 0.3;
    colors[i * 3] = brightness;
    colors[i * 3 + 1] = brightness * 0.9;
    colors[i * 3 + 2] = brightness * 0.7;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 0.003,
    vertexColors: true,
    transparent: true,
    opacity: 0.6,
    sizeAttenuation: true,
    depthWrite: false,
  });

  const belt = new THREE.Points(geometry, material);
  // Fade belt dots that sit behind the Sun's glare. The uniform refs are driven
  // per frame by the controller; inactive until then, so the belt is unchanged.
  belt.userData.sunGlareMaskUniforms = augmentPointsMaterialWithSunGlareMask(material);
  return belt;
}

export async function createSolarSystem(
  onProgress?: (progress: SolarSystemLoadProgress) => void,
  useBloom = true,
  layoutMode: PlanetariumLayout = 'realistic',
  date?: Date,
): Promise<SolarSystemObjects> {
  const totalUnits = CREATE_SOLAR_SYSTEM_TOTAL_UNITS;
  let completedUnits = 0;
  const reportProgress = () => onProgress?.({ completedUnits, totalUnits });

  reportProgress();
  const sun = createPlanetariumSun(useBloom);
  const sunLight = sun.children.find(child => child instanceof THREE.PointLight) as THREE.PointLight;
  completedUnits += 1;
  reportProgress();

  const planets = await Promise.all(PLANETARIUM_BODIES.map(async (body, index) => {
    const planetMesh = await createPlanetMesh(body);
    const position = getPlanetOrbitalPosition(body, index + 1, layoutMode, date);
    planetMesh.group.position.set(position.x, position.y, position.z);
    completedUnits += 1;
    reportProgress();
    return planetMesh;
  }));

  // Lines, planets, and the restored clock share one epoch at startup.
  const orbitLinesEpochUtcMs = (date ?? new Date()).getTime();
  const orbitLines: THREE.Line[] = [];
  for (let i = 0; i < PLANETARIUM_BODIES.length; i++) {
    const body = PLANETARIUM_BODIES[i];
    const orbitPoints = sampleLinePoints(body, layoutMode, orbitLinesEpochUtcMs);
    const line = createOrbitLine(orbitPoints, body.color, 0.2);
    line.name = `orbit-${body.name}`;
    orbitLines.push(line);
    completedUnits += 1;
    reportProgress();
  }

  const asteroidBelt = createAsteroidBelt();
  completedUnits += 1;
  reportProgress();

  return {
    sun,
    planets,
    orbitLines,
    orbitLinesEpochUtcMs,
    asteroidBelt,
    sunLight,
  };
}
