import * as THREE from 'three';
import { type PlanetData, SUN_DATA } from './planets/planetData';
import { createSaturnRings } from './planets/rings';
import {
  atmosphereVertexShader,
  atmosphereFragmentShader,
  earthNightVertexShader,
  earthNightFragmentShader,
} from '../shaders/atmosphere';

const loader = new THREE.TextureLoader();
loader.crossOrigin = 'anonymous';

// Texture URLs — Wikipedia (Wikimedia Commons), three-globe, high quality
const PLANET_TEXTURE_URLS: Record<string, string> = {
  mercury: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/30/Mercury_in_color_-_Prockter07_centered.jpg/1024px-Mercury_in_color_-_Prockter07_centered.jpg',
  venus: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/19/Cylindrical_Map_of_Venus.jpg/1024px-Cylindrical_Map_of_Venus.jpg',
  earthDay: 'https://unpkg.com/three-globe@2.41.12/example/img/earth-blue-marble.jpg',
  earthNight: 'https://unpkg.com/three-globe@2.41.12/example/img/earth-night.jpg',
  earthClouds: 'https://unpkg.com/three-globe@2.41.12/example/img/earth-clouds.png',
  earthBump: 'https://unpkg.com/three-globe@2.41.12/example/img/earth-topology.png',
  mars: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f8/Mars_cylindrical_map.jpg/1024px-Mars_cylindrical_map.jpg',
  jupiter: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a3/Cylindrical_Map_of_Jupiter.jpg/1024px-Cylindrical_Map_of_Jupiter.jpg',
  saturn: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1e/Solarsystemscope_texture_8k_saturn.jpg/1024px-Solarsystemscope_texture_8k_saturn.jpg',
  uranus: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/95/Solarsystemscope_texture_2k_uranus.jpg/1024px-Solarsystemscope_texture_2k_uranus.jpg',
  neptune: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/06/Solarsystemscope_texture_2k_neptune.jpg/1024px-Solarsystemscope_texture_2k_neptune.jpg',
  pluto: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/78/Pluto_color_global_map.jpg/1024px-Pluto_color_global_map.jpg',
};

// Fallback colors if textures fail
const FALLBACK_COLORS: Record<string, string> = {
  mercury: '#8c7e6d',
  venus: '#e8cda0',
  earthDay: '#2244aa',
  earthNight: '#050510',
  earthClouds: '#ffffff',
  earthBump: '#444444',
  mars: '#c1440e',
  jupiter: '#c8a55a',
  saturn: '#e8d5a3',
  uranus: '#7ec8e3',
  neptune: '#3355ff',
  pluto: '#bba88f',
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
    color1: [1.0, 0.9, 0.6],
    color2: [0.9, 0.7, 0.3],
    power: 3.0,
    intensity: 1.2,
    scale: 1.08,
    alpha: 0.5,
  },
  Earth: {
    color1: [0.35, 0.6, 1.0],
    color2: [0.15, 0.35, 0.9],
    power: 5.0,
    intensity: 0.8,
    scale: 1.06,
    alpha: 0.35,
  },
  Mars: {
    color1: [1.0, 0.6, 0.3],
    color2: [0.8, 0.4, 0.2],
    power: 6.0,
    intensity: 0.4,
    scale: 1.04,
    alpha: 0.2,
  },
  Jupiter: {
    color1: [0.9, 0.8, 0.5],
    color2: [0.7, 0.5, 0.3],
    power: 4.0,
    intensity: 0.6,
    scale: 1.03,
    alpha: 0.25,
  },
  Saturn: {
    color1: [0.9, 0.85, 0.6],
    color2: [0.7, 0.6, 0.4],
    power: 4.0,
    intensity: 0.5,
    scale: 1.03,
    alpha: 0.2,
  },
  Uranus: {
    color1: [0.5, 0.8, 0.9],
    color2: [0.3, 0.6, 0.8],
    power: 3.5,
    intensity: 0.7,
    scale: 1.05,
    alpha: 0.3,
  },
  Neptune: {
    color1: [0.2, 0.4, 1.0],
    color2: [0.1, 0.2, 0.8],
    power: 3.5,
    intensity: 0.8,
    scale: 1.05,
    alpha: 0.35,
  },
};

function loadTexture(key: string): Promise<THREE.Texture> {
  const url = PLANET_TEXTURE_URLS[key];
  if (!url) return Promise.resolve(createFallbackTexture(key));

  return new Promise((resolve) => {
    loader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        resolve(tex);
      },
      undefined,
      () => resolve(createFallbackTexture(key)),
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
  nightMaterial?: THREE.ShaderMaterial; // For Earth night lights
  cloudsMesh?: THREE.Mesh;
}

export async function createPlanetMesh(planet: PlanetData): Promise<PlanetMesh> {
  const group = new THREE.Group();
  group.name = planet.name;

  const texture = await loadTexture(planet.textureKey);

  // High segment counts for quality
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
  mesh.rotation.z = (planet.axialTiltDeg * Math.PI) / 180;
  group.add(mesh);

  // Atmosphere glow for planets with atmospheres
  let atmosphere: THREE.Mesh | undefined;
  const atmosConfig = ATMOSPHERES[planet.name];
  if (atmosConfig) {
    atmosphere = createAtmosphereGlow(planet.radiusAU, atmosConfig);
    atmosphere.rotation.z = (planet.axialTiltDeg * Math.PI) / 180;
    group.add(atmosphere);
  }

  // Earth-specific enhancements: night lights + clouds
  let nightMaterial: THREE.ShaderMaterial | undefined;
  let cloudsMesh: THREE.Mesh | undefined;

  if (planet.name === 'Earth') {
    // Night lights layer
    const nightTex = await loadTexture('earthNight');
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
    const nightMesh = new THREE.Mesh(nightGeo, nightMaterial);
    nightMesh.rotation.z = (planet.axialTiltDeg * Math.PI) / 180;
    group.add(nightMesh);

    // Cloud layer
    const cloudTex = await loadTexture('earthClouds');
    const cloudGeo = new THREE.SphereGeometry(planet.radiusAU * 1.01, segments, segments / 2);
    const cloudMat = new THREE.MeshStandardMaterial({
      map: cloudTex,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      roughness: 1.0,
    });
    cloudsMesh = new THREE.Mesh(cloudGeo, cloudMat);
    cloudsMesh.rotation.z = (planet.axialTiltDeg * Math.PI) / 180;
    group.add(cloudsMesh);

    // Use bump map too
    const bumpTex = await loadTexture('earthBump');
    (mesh.material as THREE.MeshStandardMaterial).bumpMap = bumpTex;
    (mesh.material as THREE.MeshStandardMaterial).bumpScale = planet.radiusAU * 0.02;
  }

  // Saturn rings
  let rings: THREE.Mesh | undefined;
  if (planet.hasRings) {
    rings = createSaturnRings(planet.radiusAU);
    rings.rotation.z = (planet.axialTiltDeg * Math.PI) / 180;
    group.add(rings);
  }

  return { group, mesh, data: planet, rings, atmosphere, nightMaterial, cloudsMesh };
}

export function createExploreSun(): THREE.Group {
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
        float intensity = 2.5 - rimDot * 1.2 + n * 0.3;
        gl_FragColor = vec4(surfaceColor * intensity, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, sunMat);
  group.add(mesh);

  // Glow shell
  const glowGeo = new THREE.SphereGeometry(SUN_DATA.radiusAU * 2.0, 32, 16);
  const glowMat = new THREE.ShaderMaterial({
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
      varying vec3 vNormal;
      varying vec3 vPosition;
      void main() {
        vec3 viewDir = normalize(-vPosition);
        float rimDot = 1.0 - max(dot(viewDir, vNormal), 0.0);
        float intensity = pow(rimDot, 2.0) * 2.0;
        vec3 glowColor = mix(vec3(1.0, 0.6, 0.1), vec3(1.0, 0.2, 0.0), rimDot);
        gl_FragColor = vec4(glowColor * intensity, intensity * 0.3);
      }
    `,
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  group.add(new THREE.Mesh(glowGeo, glowMat));

  // Point light
  const light = new THREE.PointLight(0xfff5e0, 3.0, 0, 2);
  group.add(light);

  group.userData.sunMaterial = sunMat;
  return group;
}
