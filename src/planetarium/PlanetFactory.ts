/**
 * Async mesh construction for all Planetarium bodies: planet spheres with
 * per-body texture + atmosphere glow, Earth-specific night-lights/clouds,
 * Saturn rings, major moons, and the Planetarium's Sun (bigger, animated
 * corona, optional bloom). Falls back to procedurally generated canvas
 * textures on load failure so the app never blocks on a missing file.
 */
import * as THREE from 'three';
import { type PlanetData, SUN_DATA } from './planets/planetData';
import { createPlanetRings, RING_CONFIGS } from './planets/rings';
import {
  atmosphereVertexShader,
  atmosphereFragmentShader,
  earthNightVertexShader,
  earthNightFragmentShader,
} from '../shared/shaders/atmosphere';
import { debugWarn } from '../shared/debug';
import { applyTextureDefaults, resolveTextureUrl, type TextureTier } from './world/texturePolicy';
import { augmentSurfaceMaterial, type SurfaceArchetype, type SurfaceShadingFx } from './world/surfaceShading';

const loader = new THREE.TextureLoader();
loader.crossOrigin = 'anonymous';

// Texture filenames — bundled locally in public/textures/ (Solar System Scope
// CC BY 4.0 + NASA). The filename stays resolution-agnostic; world/texturePolicy
// maps it through the active tier to a URL.
const PLANET_TEXTURE_FILES: Record<string, string> = {
  mercury: 'mercury.jpg',
  venus: 'venus.jpg',
  earthDay: 'earth-day.jpg',
  earthNight: 'earth-night.jpg',
  earthClouds: 'earth-clouds.jpg',
  earthBump: 'earth-bump.png',
  mars: 'mars.jpg',
  jupiter: 'jupiter.jpg',
  saturn: 'saturn.jpg',
  uranus: 'uranus.jpg',
  neptune: 'neptune.jpg',
  pluto: 'pluto.jpg',
  moon: 'moon.jpg',
  io: 'io.jpg',
  europa: 'europa.jpg',
  ganymede: 'ganymede.jpg',
  callisto: 'callisto.jpg',
  triton: 'triton.jpg',
};

// Fallback colors if textures fail
const FALLBACK_COLORS: Record<string, string> = {
  mercury: '#7a7168',
  venus: '#c4b08a',
  earthDay: '#2a4a88',
  earthNight: '#050510',
  earthClouds: '#ffffff',
  earthBump: '#444444',
  mars: '#9a4a2a',
  jupiter: '#a89060',
  saturn: '#bfb08a',
  uranus: '#6aa0b8',
  neptune: '#2a4ab8',
  pluto: '#9a8e7a',
};

// Atmosphere configs per planet. Drives the single-scatter shell: a Rayleigh
// day-limb tint that warms toward `sunsetColor` at the terminator, plus a Mie
// forward-scatter halo (`mieColor`, asymmetry `mieG`). `intensity` is overall
// brightness, `scale` the shell radius relative to the planet. `haloStrength`
// scales the glow that spills past the limb into space: ~1 for a thin atmosphere
// over a surface (Earth/Venus/Mars), low for all-atmosphere giants whose limb
// would otherwise ring against black.
interface AtmosphereConfig {
  dayColor: [number, number, number];
  sunsetColor: [number, number, number];
  mieColor: [number, number, number];
  rayleighStrength: number;
  mieStrength: number;
  mieG: number;
  power: number;
  intensity: number;
  haloStrength: number;
  scale: number;
}

const ATMOSPHERES: Record<string, AtmosphereConfig> = {
  Venus: {
    dayColor: [0.95, 0.85, 0.55], sunsetColor: [1.0, 0.7, 0.4], mieColor: [1.0, 0.93, 0.78],
    rayleighStrength: 0.9, mieStrength: 1.1, mieG: 0.7, power: 2.5, intensity: 1.5, haloStrength: 1.0, scale: 1.045,
  },
  Earth: {
    dayColor: [0.25, 0.5, 1.0], sunsetColor: [1.0, 0.45, 0.22], mieColor: [1.0, 0.96, 0.9],
    rayleighStrength: 1.1, mieStrength: 0.5, mieG: 0.76, power: 3.0, intensity: 1.3, haloStrength: 1.0, scale: 1.03,
  },
  Mars: {
    dayColor: [0.78, 0.6, 0.5], sunsetColor: [0.6, 0.55, 0.65], mieColor: [0.85, 0.72, 0.6],
    rayleighStrength: 0.35, mieStrength: 0.4, mieG: 0.6, power: 4.0, intensity: 0.55, haloStrength: 1.0, scale: 1.02,
  },
  Jupiter: {
    dayColor: [0.8, 0.7, 0.52], sunsetColor: [0.85, 0.6, 0.4], mieColor: [0.9, 0.83, 0.68],
    rayleighStrength: 0.55, mieStrength: 0.5, mieG: 0.65, power: 3.5, intensity: 0.7, haloStrength: 0.4, scale: 1.015,
  },
  Saturn: {
    dayColor: [0.82, 0.74, 0.54], sunsetColor: [0.85, 0.62, 0.42], mieColor: [0.92, 0.85, 0.68],
    rayleighStrength: 0.5, mieStrength: 0.45, mieG: 0.65, power: 3.5, intensity: 0.6, haloStrength: 0.4, scale: 1.015,
  },
  Uranus: {
    dayColor: [0.45, 0.72, 0.8], sunsetColor: [0.55, 0.72, 0.75], mieColor: [0.75, 0.88, 0.88],
    rayleighStrength: 0.8, mieStrength: 0.4, mieG: 0.6, power: 3.2, intensity: 0.5, haloStrength: 0.12, scale: 1.02,
  },
  Neptune: {
    dayColor: [0.2, 0.4, 0.9], sunsetColor: [0.35, 0.42, 0.72], mieColor: [0.6, 0.72, 0.92],
    rayleighStrength: 0.95, mieStrength: 0.4, mieG: 0.6, power: 3.2, intensity: 0.55, haloStrength: 0.12, scale: 1.02,
  },
};

function loadTexture(key: string, tier: TextureTier = '2k', timeoutMs = 8000): Promise<THREE.Texture> {
  const file = PLANET_TEXTURE_FILES[key];
  if (!file) return Promise.resolve(createFallbackTexture(key));
  const url = resolveTextureUrl(file, tier);

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        debugWarn('Planet texture timeout', { key, url });
        resolve(createFallbackTexture(key));
      }
    }, timeoutMs);
    loader.load(
      url,
      (tex) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        applyTextureDefaults(tex, 'color');
        resolve(tex);
      },
      undefined,
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        debugWarn('Planet texture fallback activated', {
          key,
          url,
          reason: err instanceof Error ? err.message : String(err),
        });
        resolve(createFallbackTexture(key));
      },
    );
  });
}

function createFallbackTexture(key: string): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  const baseColor = FALLBACK_COLORS[key] || '#888888';
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, 256, 128);

  const imageData = ctx.getImageData(0, 0, 256, 128);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 30;
    data[i] = Math.max(0, Math.min(255, data[i] + noise));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
  }

  // For gas giants, add horizontal bands
  if (key === 'jupiter' || key === 'saturn') {
    for (let y = 0; y < 128; y++) {
      const bandIntensity = Math.sin(y * 0.35) * 25 + Math.sin(y * 0.8) * 10;
      for (let x = 0; x < 256; x++) {
        const idx = (y * 256 + x) * 4;
        data[idx] = Math.max(0, Math.min(255, data[idx] + bandIntensity));
        data[idx + 1] = Math.max(0, Math.min(255, data[idx + 1] + bandIntensity * 0.8));
        data[idx + 2] = Math.max(0, Math.min(255, data[idx + 2] + bandIntensity * 0.5));
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  applyTextureDefaults(tex, 'color');
  return tex;
}

function createRadialGlowTexture(stops: Array<{ stop: number; color: string }>, size = 256): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const center = size / 2;

  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center);
  for (const { stop, color } of stops) {
    gradient.addColorStop(stop, color);
  }

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createSunGlowSprite(radiusAU: number, scale: number, texture: THREE.Texture, opacity: number): THREE.Sprite {
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });

  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(radiusAU * scale * 2);
  sprite.renderOrder = 8;
  return sprite;
}

function createAtmosphereGlow(radiusAU: number, config: AtmosphereConfig): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radiusAU * config.scale, 64, 32);
  const mat = new THREE.ShaderMaterial({
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereFragmentShader,
    uniforms: {
      // Fed per frame from the body's sun direction and approach distance.
      uSunDirWorld: { value: new THREE.Vector3(0, 0, 1) },
      alphaScale: { value: 1.0 },
      uDayColor: { value: new THREE.Vector3(...config.dayColor) },
      uSunsetColor: { value: new THREE.Vector3(...config.sunsetColor) },
      uMieColor: { value: new THREE.Vector3(...config.mieColor) },
      uRayleighStrength: { value: config.rayleighStrength },
      uMieStrength: { value: config.mieStrength },
      uMieG: { value: config.mieG },
      uPower: { value: config.power },
      uIntensity: { value: config.intensity },
      uHaloStrength: { value: config.haloStrength },
      uPlanetRadius: { value: radiusAU },
    },
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return new THREE.Mesh(geo, mat);
}

export interface PlanetMesh {
  group: THREE.Group;
  mesh: THREE.Mesh;
  data: PlanetData;
  rings?: THREE.Mesh;
  atmosphere?: THREE.Mesh;
  nightMesh?: THREE.Mesh;
  nightMaterial?: THREE.ShaderMaterial; // For Earth night lights
  cloudsMesh?: THREE.Mesh;
  fx?: SurfaceShadingFx;
}

// Icy / high-albedo moons get the icy night-fill (and, later, a specular ice
// response); dark or rocky bodies (our Moon, Io, Phobos, Deimos, Hyperion,
// Phoebe) fall through to the airless floor.
const ICY_MOONS = new Set([
  'Europa', 'Ganymede', 'Callisto', 'Titan', 'Mimas', 'Enceladus', 'Tethys',
  'Dione', 'Rhea', 'Iapetus', 'Miranda', 'Ariel', 'Umbriel', 'Titania',
  'Oberon', 'Triton', 'Charon',
]);

function planetArchetype(planet: PlanetData): SurfaceArchetype {
  if (planet.name === 'Earth') return 'earth';
  if (planet.isGasGiant) return 'gas';
  if (planet.name === 'Mercury' || planet.name === 'Pluto') return 'airless';
  return 'rocky'; // Venus, Mars
}

function moonArchetype(moon: MoonData): SurfaceArchetype {
  return ICY_MOONS.has(moon.name) ? 'icy' : 'airless';
}

export async function createPlanetMesh(planet: PlanetData): Promise<PlanetMesh> {
  const group = new THREE.Group();
  group.name = planet.name;

  const surfaceTexturePromise = loadTexture(planet.textureKey);
  const earthDetailTexturePromise = planet.name === 'Earth'
    ? Promise.all([
        loadTexture('earthNight'),
        loadTexture('earthClouds'),
        loadTexture('earthBump'),
      ])
    : null;
  const texture = await surfaceTexturePromise;

  const segments = planet.radiusKm > 50000 ? 128 : planet.radiusKm > 5000 ? 96 : 64;

  const geo = new THREE.SphereGeometry(planet.radiusAU, segments, segments / 2);

  // Use texture as both color map and bump map for surface detail
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    // Gas giants drop the colour-as-bump hack — embossing cloud bands as relief
    // just reads as fake crinkle; their banding lives entirely in the albedo.
    bumpMap: planet.isGasGiant ? null : texture,
    bumpScale: planet.radiusAU * 0.01, // subtle bump
    roughness: planet.name === 'Mercury' || planet.name === 'Mars' ? 0.95 : 0.8,
    metalness: 0.05,
  });
  // Saturn's dense rings shadow its globe; hand the surface shader the annulus
  // so it can trace the cast shadow. Other giants' rings are too faint to bother.
  const ringCfg = RING_CONFIGS[planet.name];
  const ringShadow = ringCfg?.style === 'saturn'
    ? { inner: planet.radiusAU * ringCfg.innerFactor, outer: planet.radiusAU * ringCfg.outerFactor }
    : undefined;
  const fx = augmentSurfaceMaterial(mat, planetArchetype(planet), ringShadow);

  const mesh = new THREE.Mesh(geo, mat);
  group.add(mesh);

  // Atmosphere glow for planets with atmospheres
  let atmosphere: THREE.Mesh | undefined;
  const atmosConfig = ATMOSPHERES[planet.name];
  if (atmosConfig) {
    atmosphere = createAtmosphereGlow(planet.radiusAU, atmosConfig);
    group.add(atmosphere);
  }

  // Earth-specific enhancements: night lights + clouds
  let nightMaterial: THREE.ShaderMaterial | undefined;
  let nightMesh: THREE.Mesh | undefined;
  let cloudsMesh: THREE.Mesh | undefined;

  if (planet.name === 'Earth' && earthDetailTexturePromise) {
    const [nightTex, cloudTex, bumpTex] = await earthDetailTexturePromise;

    const nightGeo = new THREE.SphereGeometry(planet.radiusAU * 1.001, segments, segments / 2);
    nightMaterial = new THREE.ShaderMaterial({
      uniforms: {
        nightTexture: { value: nightTex },
        sunDirection: { value: new THREE.Vector3(1, 0, 0) },
      },
      vertexShader: earthNightVertexShader,
      fragmentShader: earthNightFragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    nightMesh = new THREE.Mesh(nightGeo, nightMaterial);
    group.add(nightMesh);

    const cloudGeo = new THREE.SphereGeometry(planet.radiusAU * 1.01, segments, segments / 2);
    const cloudMat = new THREE.MeshStandardMaterial({
      map: cloudTex,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      roughness: 1.0,
    });
    cloudsMesh = new THREE.Mesh(cloudGeo, cloudMat);
    group.add(cloudsMesh);

    (mesh.material as THREE.MeshStandardMaterial).bumpMap = bumpTex;
    (mesh.material as THREE.MeshStandardMaterial).bumpScale = planet.radiusAU * 0.02;
  }

  let rings: THREE.Mesh | undefined;
  if (planet.hasRings && ringCfg) {
    const SUN_RADIUS_AU = 695_700 / 149_597_870.7;
    const sunTan = SUN_RADIUS_AU / planet.semiMajorAxisAU; // solar angular radius at the planet
    rings = createPlanetRings(planet.radiusAU, ringCfg, sunTan);
    group.add(rings);
  }

  return { group, mesh, data: planet, rings, atmosphere, nightMesh, nightMaterial, cloudsMesh, fx };
}

export function createPlanetariumSun(useBloom = true): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Sun';

  // Sun sphere with animated corona shader
  const geo = new THREE.SphereGeometry(SUN_DATA.radiusAU, 64, 32);
  const sunMat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float time;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }
      float fbm(vec2 p) {
        float v = 0.0; float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * noise(p); p *= 2.0; a *= 0.5;
        }
        return v;
      }
      void main() {
        vec3 viewDir = normalize(-vPosition);
        float rimDot = 1.0 - max(dot(viewDir, vNormal), 0.0);
        vec2 uv = vUv * 6.0;
        float n = fbm(uv + time * 0.15);
        vec3 coreColor = vec3(1.0, 0.95, 0.8);
        vec3 midColor = vec3(1.0, 0.7, 0.2);
        vec3 edgeColor = vec3(1.0, 0.3, 0.05);
        vec3 surfaceColor = mix(coreColor, midColor, rimDot * 0.7 + n * 0.3);
        surfaceColor = mix(surfaceColor, edgeColor, pow(rimDot, 2.0));
        float intensity = 3.1 - rimDot * 1.2 + n * 0.3;
        gl_FragColor = vec4(surfaceColor * intensity, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, sunMat);
  group.add(mesh);

  // Use billboarded radial glow sprites so the solar halo stays circular on screen.
  const innerGlowTexture = createRadialGlowTexture([
    { stop: 0.0, color: 'rgba(255,255,245,1.0)' },
    { stop: 0.18, color: 'rgba(255,244,220,0.95)' },
    { stop: 0.42, color: 'rgba(255,188,92,0.45)' },
    { stop: 0.72, color: 'rgba(255,120,26,0.12)' },
    { stop: 1.0, color: 'rgba(255,120,26,0.0)' },
  ]);
  const outerGlowTexture = createRadialGlowTexture([
    { stop: 0.0, color: 'rgba(255,235,190,0.26)' },
    { stop: 0.35, color: 'rgba(255,190,96,0.12)' },
    { stop: 0.7, color: 'rgba(255,130,36,0.04)' },
    { stop: 1.0, color: 'rgba(255,130,36,0.0)' },
  ]);

  const innerGlow = createSunGlowSprite(
    SUN_DATA.radiusAU,
    useBloom ? 4.6 : 5.4,
    innerGlowTexture,
    useBloom ? 1.0 : 1.0,
  );
  const outerGlow = createSunGlowSprite(
    SUN_DATA.radiusAU,
    useBloom ? 7.5 : 9.0,
    outerGlowTexture,
    useBloom ? 0.50 : 0.58,
  );
  group.add(outerGlow);
  group.add(innerGlow);

  const light = new THREE.PointLight(0xfff5e0, 3, 0, 0.3);
  group.add(light);

  group.userData.sunMaterial = sunMat;
  return group;
}

// ---- Moon meshes ----

import { type MoonData, getMoonsByPlanet } from './planets/moonData';

export interface MoonMesh {
  mesh: THREE.Mesh;
  data: MoonData;
  /** Procedural surface textures generated yet? Painted lazily (MoonPainter);
   *  a moon is never made visible before this is true. */
  painted: boolean;
  fx?: SurfaceShadingFx;
}

function seededRng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 16807 + 0) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// Layered sine-based value noise (no library needed)
function valueNoise(x: number, y: number, seed: number): number {
  const a = Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453;
  return a - Math.floor(a);
}

function fractalNoise(x: number, y: number, seed: number, octaves: number): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxAmp = 0;
  for (let i = 0; i < octaves; i++) {
    value += valueNoise(x * frequency, y * frequency, seed + i * 100) * amplitude;
    maxAmp += amplitude;
    amplitude *= 0.5;
    frequency *= 2.2;
  }
  return value / maxAmp;
}

// Tiny irregular moons (the outer-planet swarms, Phobos/Deimos, the small
// shepherd moons) render as a handful of pixels even up close, so they get
// half-dimension textures — a quarter of the per-moon pixel work — while round,
// inspectable moons keep full resolution.
const SMALL_MOON_RADIUS_KM = 150;

function createMoonTextures(
  color: number,
  name: string,
  radiusKm: number,
): { colorTex: THREE.Texture; bumpTex: THREE.Texture } {
  const textureWidth = radiusKm < SMALL_MOON_RADIUS_KM ? 256 : 512;
  const textureHeight = textureWidth / 2;
  const seed = hashString(name);
  const rng = seededRng(seed);

  // Determine moon "type" from color brightness/hue
  const baseColor = new THREE.Color(color);
  const brightness = baseColor.r * 0.299 + baseColor.g * 0.587 + baseColor.b * 0.114;
  const isIcy = brightness > 0.55;
  const isVolcanic = baseColor.r > 0.6 && baseColor.g > 0.4 && baseColor.b < 0.35;

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = textureWidth;
  colorCanvas.height = textureHeight;
  const ctx = colorCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = textureWidth;
  bumpCanvas.height = textureHeight;
  const bCtx = bumpCanvas.getContext('2d')!;

  // Generate per-pixel with fractal noise
  const colorData = ctx.createImageData(textureWidth, textureHeight);
  const bumpData = bCtx.createImageData(textureWidth, textureHeight);
  const colorPixels = colorData.data;
  const bumpPixels = bumpData.data;

  const baseR = baseColor.r * 255;
  const baseG = baseColor.g * 255;
  const baseB = baseColor.b * 255;

  // The image buffers are Uint8ClampedArray, so writes clamp to 0–255 and round
  // on assignment — the per-channel Math.max/min below are redundant. ny and the
  // row base depend only on y; hoist them out of the inner loop.
  for (let y = 0; y < textureHeight; y++) {
    const ny = y / textureHeight;
    const rowBase = y * textureWidth;
    for (let x = 0; x < textureWidth; x++) {
      const idx = (rowBase + x) * 4;
      const nx = x / textureWidth;

      // Large-scale terrain variation (3 octaves)
      const terrain = fractalNoise(nx * 6, ny * 6, seed, 3);
      // Medium detail
      const detail = fractalNoise(nx * 18, ny * 18, seed + 500, 2);
      // Fine grain
      const grain = valueNoise(nx * 50, ny * 50, seed + 1000);

      // Combine: terrain drives large color shifts, detail adds texture
      let variation: number;
      if (isIcy) {
        // Icy: smoother, subtle cracks
        variation = terrain * 0.15 + detail * 0.08 + grain * 0.03;
      } else if (isVolcanic) {
        // Volcanic: splotchy, high contrast
        variation = terrain * 0.3 + detail * 0.12 + grain * 0.04;
      } else {
        // Rocky: moderate cratering and noise
        variation = terrain * 0.22 + detail * 0.1 + grain * 0.04;
      }

      // Apply variation as brightness shift centered around 0
      const shift = (variation - 0.15) * 255;
      colorPixels[idx] = baseR + shift;
      colorPixels[idx + 1] = baseG + shift;
      colorPixels[idx + 2] = baseB + shift;
      colorPixels[idx + 3] = 255;

      // Bump map: terrain + detail as height
      const height = (terrain * 0.7 + detail * 0.3) * 255;
      bumpPixels[idx] = height;
      bumpPixels[idx + 1] = height;
      bumpPixels[idx + 2] = height;
      bumpPixels[idx + 3] = 255;
    }
  }

  // Add craters (seeded)
  const craterCount = isIcy ? 5 + Math.floor(rng() * 8) : 10 + Math.floor(rng() * 15);
  for (let i = 0; i < craterCount; i++) {
    const cx = Math.floor(rng() * textureWidth);
    const cy = Math.floor(rng() * textureHeight);
    const cr = isIcy ? 2 + rng() * 5 : 3 + rng() * 12;
    for (let dy = -Math.ceil(cr); dy <= Math.ceil(cr); dy++) {
      for (let dx = -Math.ceil(cr); dx <= Math.ceil(cr); dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > cr) continue;
        const px = ((cx + dx) % textureWidth + textureWidth) % textureWidth;
        const py = Math.max(0, Math.min(textureHeight - 1, cy + dy));
        const idx = (py * textureWidth + px) * 4;
        const t = dist / cr;
        if (t < 0.75) {
          // Dark crater floor
          const darken = (1 - t / 0.75) * 30;
          colorPixels[idx] = colorPixels[idx] - darken;
          colorPixels[idx + 1] = colorPixels[idx + 1] - darken;
          colorPixels[idx + 2] = colorPixels[idx + 2] - darken;
          bumpPixels[idx] = bumpPixels[idx] - darken * 2;
          bumpPixels[idx + 1] = bumpPixels[idx]; bumpPixels[idx + 2] = bumpPixels[idx];
        } else {
          // Bright rim
          const brighten = (1 - (t - 0.75) / 0.25) * 20;
          colorPixels[idx] = colorPixels[idx] + brighten;
          colorPixels[idx + 1] = colorPixels[idx + 1] + brighten;
          colorPixels[idx + 2] = colorPixels[idx + 2] + brighten;
          bumpPixels[idx] = bumpPixels[idx] + brighten * 2;
          bumpPixels[idx + 1] = bumpPixels[idx]; bumpPixels[idx + 2] = bumpPixels[idx];
        }
      }
    }
  }

  ctx.putImageData(colorData, 0, 0);
  bCtx.putImageData(bumpData, 0, 0);

  const colorTex = new THREE.CanvasTexture(colorCanvas);
  applyTextureDefaults(colorTex, 'color');
  const bumpTex = new THREE.CanvasTexture(bumpCanvas);
  applyTextureDefaults(bumpTex, 'data');
  return { colorTex, bumpTex };
}

/**
 * Generate and attach a moon's procedural surface textures. Idempotent — the
 * lazy painter and the visibility gate both call this and may reach the same
 * moon more than once. If the real photo already streamed in (photoLoaded),
 * only the bump is applied; the procedural colour is the floor that shows
 * until/unless a photo wins, so a moon whose JPG fails stays textured, not grey.
 */
export function paintMoonTextures(moon: MoonMesh): void {
  if (moon.painted) return;
  const mat = moon.mesh.material as THREE.MeshStandardMaterial;
  const { colorTex, bumpTex } = createMoonTextures(moon.data.color, moon.data.name, moon.data.radiusKm);
  mat.bumpMap = bumpTex;
  mat.bumpScale = Math.max(moon.data.radiusAU * 0.15, 0.0000005);
  if (mat.userData.photoLoaded) {
    colorTex.dispose();
  } else {
    mat.map = colorTex;
    mat.color.setRGB(1, 1, 1);
  }
  mat.needsUpdate = true;
  moon.painted = true;
}

/**
 * Create moon meshes for a planet. Moons orbit at their real orbital radius
 * (in AU). The surface texture is NOT generated here — it's painted lazily
 * (paintMoonTextures / MoonPainter) so first load isn't blocked on ~65 canvas
 * generations; meshes start with a flat placeholder material.
 */
export function createMoonMeshes(planetName: string): MoonMesh[] {
  const moons = getMoonsByPlanet(planetName);
  const result: MoonMesh[] = [];

  for (const moonData of moons) {
    const segments = moonData.radiusKm > 1000 ? 48 : moonData.radiusKm > 200 ? 24 : 16;
    const geo = new THREE.SphereGeometry(moonData.radiusAU, segments, segments / 2);

    // Flat placeholder. A moon is never made visible before it's painted (the
    // gate in updateMoonPositions), so this colour is a safety floor, not a
    // state the player normally sees.
    const mat = new THREE.MeshStandardMaterial({
      color: moonData.color,
      roughness: 0.85,
      metalness: 0.05,
      emissive: new THREE.Color(moonData.color),
      emissiveIntensity: 0.03,
    });
    const fx = augmentSurfaceMaterial(mat, moonArchetype(moonData));

    // Photo-textured moons (Moon, Io, …) stream their real image; on true
    // success it replaces the procedural colour. Load directly rather than via
    // loadTexture (which resolves a grey fallback on failure) so a failed JPG
    // keeps the procedural texture. photoLoaded tells the painter not to
    // clobber a photo that already won.
    const photoFile = moonData.textureKey ? PLANET_TEXTURE_FILES[moonData.textureKey] : undefined;
    const photoUrl = photoFile ? resolveTextureUrl(photoFile, '2k') : undefined;
    if (photoUrl) {
      loader.load(
        photoUrl,
        (tex) => {
          applyTextureDefaults(tex, 'color');
          mat.userData.photoLoaded = true;
          const prev = mat.map;
          mat.map = tex;
          mat.color.setRGB(1, 1, 1);
          mat.needsUpdate = true;
          if (prev) prev.dispose();
        },
        undefined,
        (err) =>
          debugWarn('Moon texture load failed', {
            name: moonData.name,
            reason: err instanceof Error ? err.message : String(err),
          }),
      );
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = moonData.name;
    mesh.visible = false; // hidden until painted and the player is close

    result.push({ mesh, data: moonData, painted: false, fx });
  }

  return result;
}
