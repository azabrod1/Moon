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
  const count = 6000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Concentrate more asteroids in the middle of the belt
    const t = Math.random();
    const radius = ASTEROID_BELT.innerAU + t * (ASTEROID_BELT.outerAU - ASTEROID_BELT.innerAU);
    const angle = Math.random() * Math.PI * 2;
    const y = (Math.random() - 0.5) * 0.06;

    positions[i * 3] = radius * Math.cos(angle);
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = radius * Math.sin(angle);

    // More color variety: gray-brown with occasional lighter/darker rocks
    const brightness = 0.3 + Math.random() * 0.45;
    const warmth = 0.7 + Math.random() * 0.3; // some more gray, some more brown
    colors[i * 3] = brightness;
    colors[i * 3 + 1] = brightness * (0.85 + Math.random() * 0.1);
    colors[i * 3 + 2] = brightness * warmth * 0.75;

    // Per-particle size variation: most tiny, a few slightly larger
    const sizeRng = Math.random();
    sizes[i] = sizeRng < 0.92
      ? 0.4 + Math.random() * 0.6   // 92%: tiny (0.4-1.0)
      : 1.0 + Math.random() * 1.5;  // 8%: slightly larger (1.0-2.5)
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  // Custom shader for per-particle sizes (like star shader)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      pixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      uniform float pixelRatio;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        // Size attenuation: scale by distance
        gl_PointSize = size * pixelRatio * (30.0 / -mvPosition.z);
        gl_PointSize = clamp(gl_PointSize, 0.5, 6.0);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float alpha = 0.7 * (1.0 - smoothstep(0.3, 0.5, d));
        gl_FragColor = vec4(vColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
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
  const ambientLight = new THREE.AmbientLight(0x334466, 0.35);
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
