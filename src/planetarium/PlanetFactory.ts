/**
 * Async mesh construction for all Planetarium bodies: planet spheres with
 * per-body texture + atmosphere glow, Earth-specific night-lights/clouds,
 * Saturn rings, major moons, and the Planetarium's Sun (bigger, animated
 * corona, optional bloom). Falls back to procedurally generated canvas
 * textures on load failure so the app never blocks on a missing file.
 */
import * as THREE from 'three';
import { type PlanetData, SUN_DATA } from './planets/planetData';
import { createSaturnRings } from './planets/rings';
import {
  earthNightVertexShader,
  earthNightFragmentShader,
} from '../shared/shaders/atmosphere';
import { debugWarn } from '../shared/debug';

const loader = new THREE.TextureLoader();
loader.crossOrigin = 'anonymous';

// Texture URLs — bundled locally in public/textures/ (Solar System Scope CC BY 4.0 + NASA)
const BASE = import.meta.env.BASE_URL + 'textures/';
const PLANET_TEXTURE_URLS: Record<string, string> = {
  mercury: BASE + 'mercury.jpg',
  venus: BASE + 'venus.jpg',
  earthDay: BASE + 'earth-day.jpg',
  earthNight: BASE + 'earth-night.jpg',
  earthClouds: BASE + 'earth-clouds.jpg',
  earthBump: BASE + 'earth-bump.png',
  mars: BASE + 'mars.jpg',
  jupiter: BASE + 'jupiter.jpg',
  saturn: BASE + 'saturn.jpg',
  uranus: BASE + 'uranus.jpg',
  neptune: BASE + 'neptune.jpg',
  pluto: BASE + 'pluto.jpg',
  moon: BASE + 'moon.jpg',
  io: BASE + 'io.jpg',
  europa: BASE + 'europa.jpg',
  ganymede: BASE + 'ganymede.jpg',
  callisto: BASE + 'callisto.jpg',
  triton: BASE + 'triton.jpg',
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

// Atmosphere configs per planet — color, intensity, scale
interface AtmosphereConfig {
  color1: [number, number, number];
  color2: [number, number, number];
  power: number;
  intensity: number;
  scale: number; // atmosphere shell size relative to planet
  alpha: number;
}

const ATMOSPHERES: Record<string, AtmosphereConfig> = {
  Venus: {
    color1: [0.85, 0.78, 0.55],
    color2: [0.7, 0.58, 0.3],
    power: 5.0,
    intensity: 0.3,
    scale: 1.04,
    alpha: 0.12,
  },
  Earth: {
    color1: [0.3, 0.5, 0.85],
    color2: [0.12, 0.3, 0.7],
    power: 5.0,
    intensity: 0.3,
    scale: 1.03,
    alpha: 0.12,
  },
  Mars: {
    color1: [0.6, 0.45, 0.38],
    color2: [0.5, 0.35, 0.25],
    power: 8.0,
    intensity: 0.15,
    scale: 1.02,
    alpha: 0.06,
  },
  Jupiter: {
    color1: [0.75, 0.65, 0.42],
    color2: [0.55, 0.42, 0.25],
    power: 5.0,
    intensity: 0.2,
    scale: 1.02,
    alpha: 0.08,
  },
  Saturn: {
    color1: [0.75, 0.7, 0.5],
    color2: [0.55, 0.48, 0.32],
    power: 5.0,
    intensity: 0.18,
    scale: 1.02,
    alpha: 0.07,
  },
  Uranus: {
    color1: [0.4, 0.65, 0.75],
    color2: [0.25, 0.5, 0.65],
    power: 4.5,
    intensity: 0.25,
    scale: 1.03,
    alpha: 0.1,
  },
  Neptune: {
    color1: [0.18, 0.32, 0.75],
    color2: [0.1, 0.18, 0.6],
    power: 4.5,
    intensity: 0.28,
    scale: 1.03,
    alpha: 0.12,
  },
};

function loadTexture(key: string, timeoutMs = 8000): Promise<THREE.Texture> {
  const url = PLANET_TEXTURE_URLS[key];
  if (!url) return Promise.resolve(createFallbackTexture(key));

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
        tex.colorSpace = THREE.SRGBColorSpace;
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
  tex.colorSpace = THREE.SRGBColorSpace;
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
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 color1;
      uniform vec3 color2;
      uniform float power;
      uniform float intensity;
      uniform float alpha;

      varying vec3 vNormal;
      varying vec3 vPosition;

      void main() {
        vec3 viewDir = normalize(-vPosition);
        float rimDot = 1.0 - max(dot(viewDir, vNormal), 0.0);
        float glow = pow(rimDot, power) * intensity;
        vec3 color = mix(color1, color2, rimDot);
        gl_FragColor = vec4(color, glow * alpha);
      }
    `,
    uniforms: {
      color1: { value: new THREE.Vector3(...config.color1) },
      color2: { value: new THREE.Vector3(...config.color2) },
      power: { value: config.power },
      intensity: { value: config.intensity },
      alpha: { value: config.alpha },
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
    bumpMap: texture,
    bumpScale: planet.radiusAU * 0.01, // subtle bump
    roughness: planet.name === 'Mercury' || planet.name === 'Mars' ? 0.95 : 0.8,
    metalness: 0.05,
  });

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
  if (planet.hasRings) {
    rings = createSaturnRings(planet.radiusAU);
    group.add(rings);
  }

  return { group, mesh, data: planet, rings, atmosphere, nightMesh, nightMaterial, cloudsMesh };
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
  colorTex.colorSpace = THREE.SRGBColorSpace;
  const bumpTex = new THREE.CanvasTexture(bumpCanvas);
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

    // Photo-textured moons (Moon, Io, …) stream their real image; on true
    // success it replaces the procedural colour. Load directly rather than via
    // loadTexture (which resolves a grey fallback on failure) so a failed JPG
    // keeps the procedural texture. photoLoaded tells the painter not to
    // clobber a photo that already won.
    const photoUrl = moonData.textureKey ? PLANET_TEXTURE_URLS[moonData.textureKey] : undefined;
    if (photoUrl) {
      loader.load(
        photoUrl,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
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

    result.push({ mesh, data: moonData, painted: false });
  }

  return result;
}
