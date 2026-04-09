import * as THREE from 'three';
import { ALL_BODIES, ASTEROID_BELT, type PlanetData } from './planets/planetData';
import { createPlanetMesh, createExploreSun, type PlanetMesh } from './PlanetFactory';
import { computePlanetPositionEquatorial, sampleOrbitLinePoints, utcMsToJD } from './astronomy';

export type LayoutMode = 'aligned' | 'realistic';
export const CREATE_SOLAR_SYSTEM_TOTAL_UNITS = 1 + ALL_BODIES.length + ALL_BODIES.length + 1;

export interface SolarSystemLoadProgress {
  completedUnits: number;
  totalUnits: number;
}

export interface SolarSystemObjects {
  sun: THREE.Group;
  planets: PlanetMesh[];
  orbitLines: THREE.Line[];
  asteroidBelt: THREE.Points;
  sunLight: THREE.PointLight;
  ambientLight: THREE.AmbientLight;
}

function createAlignedPlanetPosition(planet: PlanetData, seed: number): { x: number; y: number; z: number } {
  const radius = planet.semiMajorAxisAU;
  const spread = ((seed * 7.13) % 1 - 0.5) * (Math.PI / 6);
  return { x: radius * Math.cos(spread), y: 0, z: radius * Math.sin(spread) };
}

export function getPlanetOrbitalPosition(
  planet: PlanetData,
  seed: number,
  layoutMode: LayoutMode,
  date?: Date,
): { x: number; y: number; z: number } {
  if (layoutMode === 'aligned') {
    return createAlignedPlanetPosition(planet, seed);
  }

  const position = computePlanetPositionEquatorial(planet, utcMsToJD((date ?? new Date()).getTime()));
  return { x: position.x, y: position.y, z: position.z };
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

function createAsteroidBelt(): THREE.Points {
  const count = 3000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const radius = ASTEROID_BELT.innerAU + Math.random() * (ASTEROID_BELT.outerAU - ASTEROID_BELT.innerAU);
    const angle = Math.random() * Math.PI * 2;
    const y = (Math.random() - 0.5) * 0.05;

    positions[i * 3] = radius * Math.cos(angle);
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = radius * Math.sin(angle);

    const brightness = 0.4 + Math.random() * 0.3;
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

  return new THREE.Points(geometry, material);
}

export async function createSolarSystem(
  onProgress?: (progress: SolarSystemLoadProgress) => void,
  useBloom = true,
  layoutMode: LayoutMode = 'realistic',
  date?: Date,
): Promise<SolarSystemObjects> {
  const totalUnits = CREATE_SOLAR_SYSTEM_TOTAL_UNITS;
  let completedUnits = 0;
  const reportProgress = () => onProgress?.({ completedUnits, totalUnits });

  reportProgress();
  const sun = createExploreSun(useBloom);
  const sunLight = sun.children.find(child => child instanceof THREE.PointLight) as THREE.PointLight;
  const ambientLight = new THREE.AmbientLight(0x334466, 0.4);
  completedUnits += 1;
  reportProgress();

  const planets = await Promise.all(ALL_BODIES.map(async (body, index) => {
    const planetMesh = await createPlanetMesh(body);
    const position = getPlanetOrbitalPosition(body, index + 1, layoutMode, date);
    planetMesh.group.position.set(position.x, position.y, position.z);
    completedUnits += 1;
    reportProgress();
    return planetMesh;
  }));

  const orbitLines: THREE.Line[] = [];
  for (let i = 0; i < ALL_BODIES.length; i++) {
    const body = ALL_BODIES[i];
    const orbitPoints =
      layoutMode === 'aligned'
        ? sampleOrbitLinePoints(
            {
              ...body,
              eccentricity: 0,
              inclinationDeg: 0,
              ascendingNodeDeg: 0,
              lonPerihelionDeg: 0,
            },
            256,
          )
        : sampleOrbitLinePoints(body, 256);
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
    asteroidBelt,
    sunLight,
    ambientLight,
  };
}

export function getPlanetWorldPositions(planets: PlanetMesh[]): Map<string, { x: number; y: number; z: number }> {
  const map = new Map<string, { x: number; y: number; z: number }>();
  for (const planet of planets) {
    const position = planet.group.userData.worldPosAU as { x: number; y: number; z: number } | undefined;
    if (position) {
      map.set(planet.data.name, position);
    }
  }
  return map;
}
