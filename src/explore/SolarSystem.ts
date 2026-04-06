import * as THREE from 'three';
import { ALL_BODIES, ASTEROID_BELT, type PlanetData, SUN_DATA } from './planets/planetData';
import { createPlanetMesh, createExploreSun, type PlanetMesh } from './PlanetFactory';
import { computePlanetPosition, dateToJD } from './orbitalMechanics';

export type LayoutMode = 'aligned' | 'realistic';

export interface SolarSystemObjects {
  sun: THREE.Group;
  planets: PlanetMesh[];
  orbitLines: THREE.Line[];
  asteroidBelt: THREE.Points;
  sunLight: THREE.PointLight;
  ambientLight: THREE.AmbientLight;
}

// Place planets on their orbits
export function getPlanetOrbitalPosition(
  planet: PlanetData,
  seed: number,
  layoutMode: LayoutMode,
  date?: Date,
): { x: number; y: number; z: number } {
  if (layoutMode === 'realistic' && date) {
    return computePlanetPosition(planet, dateToJD(date));
  }
  // Aligned: roughly lined up within ±15° cone
  const r = planet.semiMajorAxisAU;
  const spread = ((seed * 7.13) % 1 - 0.5) * (Math.PI / 6);
  return { x: r * Math.cos(spread), y: 0, z: r * Math.sin(spread) };
}

function createOrbitLine(radiusAU: number, color: number, opacity: number): THREE.Line {
  const segments = 256;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(
      radiusAU * Math.cos(angle),
      0,
      radiusAU * Math.sin(angle),
    ));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  return new THREE.Line(geo, mat);
}

function createAsteroidBelt(): THREE.Points {
  const count = 3000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const r = ASTEROID_BELT.innerAU + Math.random() * (ASTEROID_BELT.outerAU - ASTEROID_BELT.innerAU);
    const angle = Math.random() * Math.PI * 2;
    const y = (Math.random() - 0.5) * 0.05; // slight vertical spread

    positions[i * 3] = r * Math.cos(angle);
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = r * Math.sin(angle);

    // Gray-brown color
    const brightness = 0.4 + Math.random() * 0.3;
    colors[i * 3] = brightness;
    colors[i * 3 + 1] = brightness * 0.9;
    colors[i * 3 + 2] = brightness * 0.7;

    sizes[i] = 0.001 + Math.random() * 0.003;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.003,
    vertexColors: true,
    transparent: true,
    opacity: 0.6,
    sizeAttenuation: true,
    depthWrite: false,
  });

  return new THREE.Points(geo, mat);
}

export async function createSolarSystem(
  onProgress?: (msg: string) => void,
  useBloom = true,
  layoutMode: LayoutMode = 'aligned',
  date?: Date,
): Promise<SolarSystemObjects> {
  onProgress?.('Creating the Sun...');
  const sun = createExploreSun(useBloom);

  // Sun already has a PointLight from createExploreSun()
  // Get reference to it for the return object
  const sunLight = sun.children.find(c => c instanceof THREE.PointLight) as THREE.PointLight;

  const ambientLight = new THREE.AmbientLight(0x334466, 0.4);

  onProgress?.('Creating planets...');
  const planets: PlanetMesh[] = [];
  for (let i = 0; i < ALL_BODIES.length; i++) {
    const body = ALL_BODIES[i];
    onProgress?.(`Loading ${body.name}...`);
    const planetMesh = await createPlanetMesh(body);

    // Position on orbit
    const pos = getPlanetOrbitalPosition(body, i + 1, layoutMode, date);
    planetMesh.group.position.set(pos.x, pos.y, pos.z);

    planets.push(planetMesh);
  }

  onProgress?.('Drawing orbits...');
  const orbitLines: THREE.Line[] = [];
  for (const body of ALL_BODIES) {
    const line = createOrbitLine(
      body.semiMajorAxisAU,
      body.color,
      0.2,
    );
    line.name = `orbit-${body.name}`;
    orbitLines.push(line);
  }

  onProgress?.('Generating asteroid belt...');
  const asteroidBelt = createAsteroidBelt();

  return {
    sun,
    planets,
    orbitLines,
    asteroidBelt,
    sunLight,
    ambientLight,
  };
}

// Get world positions of all planets (in AU, before floating origin offset)
export function getPlanetWorldPositions(planets: PlanetMesh[]): Map<string, { x: number; y: number; z: number }> {
  const map = new Map<string, { x: number; y: number; z: number }>();
  for (const p of planets) {
    // Store the "original" world position (before floating origin offset)
    // These are set once during creation and stored in userData
    const pos = p.group.userData.worldPosAU as { x: number; y: number; z: number } | undefined;
    if (pos) {
      map.set(p.data.name, pos);
    }
  }
  return map;
}
