/**
 * Deterministic tertiary surface finishes for the selectable fleet.
 *
 * Geometry supplies the recognizable silhouette and secondary structures;
 * these generated maps supply the fine material scale between them. Keeping
 * the maps procedural avoids asset downloads and lets unit tests construct
 * every model without a DOM or canvas implementation.
 */
import * as THREE from 'three';
import type { PlayerShipProfile } from '../shipProfiles';

type FleetProfile = Exclude<PlayerShipProfile, 'default'>;
type SurfaceFamily =
  | 'thermal'
  | 'capsule'
  | 'ufo'
  | 'rebel'
  | 'imperial'
  | 'polished'
  | 'federation'
  | 'alien';

interface SurfaceTextures {
  albedo: THREE.DataTexture;
  height: THREE.DataTexture;
  roughness: THREE.DataTexture;
  bumpScale: number;
}

const TEXTURE_SIZE = 256;
const surfaceCache = new Map<SurfaceFamily, SurfaceTextures>();

function surfaceFamilyFor(profile: FleetProfile): SurfaceFamily {
  switch (profile) {
    case 'shuttle':
    case 'starship':
    case 'dreamChaser':
      return 'thermal';
    case 'soyuz':
    case 'dragon':
    case 'orion':
    case 'starliner':
    case 'apollo':
      return 'capsule';
    case 'saucer':
      return 'ufo';
    case 'falcon':
    case 'xwing':
    case 'ywing':
      return 'rebel';
    case 'tie':
    case 'starDestroyer':
      return 'imperial';
    case 'naboo':
      return 'polished';
    case 'enterprise':
    case 'ussVoyager':
      return 'federation';
    case 'klingon':
    case 'romulan':
      return 'alien';
  }
}

function hash2d(x: number, y: number, salt: number): number {
  let value = Math.imul(x + salt * 1013, 0x45d9f3b) ^ Math.imul(y + salt * 7919, 0x119de1f3);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967295;
}

function rgbaTexture(name: string, data: Uint8Array, color = false): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, TEXTURE_SIZE, TEXTURE_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = name;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 3);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function writePixel(
  target: Uint8Array,
  index: number,
  red: number,
  green: number,
  blue: number,
): void {
  const offset = index * 4;
  target[offset] = THREE.MathUtils.clamp(Math.round(red), 0, 255);
  target[offset + 1] = THREE.MathUtils.clamp(Math.round(green), 0, 255);
  target[offset + 2] = THREE.MathUtils.clamp(Math.round(blue), 0, 255);
  target[offset + 3] = 255;
}

interface PatternSample {
  albedo: [number, number, number];
  height: number;
  roughness: number;
}

function thermalSample(x: number, y: number): PatternSample {
  const row = Math.floor(y / 12);
  const staggeredX = (x + (row % 2) * 9) % 18;
  const localY = y % 12;
  const seam = staggeredX < 1.3 || localY < 1.3;
  const fastener = (staggeredX < 2.4 || staggeredX > 16.2) && (localY < 2.4 || localY > 9.6);
  const panelTone = 246 - Math.floor(hash2d(Math.floor(x / 18), row, 1) * 14);
  if (fastener) return { albedo: [112, 118, 121], height: 76, roughness: 220 };
  if (seam) return { albedo: [150, 156, 158], height: 88, roughness: 242 };
  const brushed = ((x + y * 3) % 11 === 0) ? -7 : 0;
  return { albedo: [panelTone + brushed, panelTone + brushed, panelTone + brushed], height: 176 + brushed, roughness: 224 + Math.abs(brushed) };
}

function capsuleSample(x: number, y: number): PatternSample {
  const cellX = x % 32;
  const cellY = y % 24;
  const seam = cellX < 1.5 || cellY < 1.5;
  const quilt = Math.abs((cellX % 12) - (cellY % 12)) < 0.75 || Math.abs((cellX % 12) + (cellY % 12) - 12) < 0.75;
  const fastener = ((cellX - 4) ** 2 + (cellY - 4) ** 2 < 2.2) || ((cellX - 28) ** 2 + (cellY - 20) ** 2 < 2.2);
  const tone = 245 - Math.floor(hash2d(Math.floor(x / 32), Math.floor(y / 24), 2) * 11);
  if (fastener) return { albedo: [105, 112, 116], height: 210, roughness: 170 };
  if (seam) return { albedo: [164, 170, 172], height: 86, roughness: 238 };
  if (quilt) return { albedo: [tone - 10, tone - 9, tone - 7], height: 144, roughness: 226 };
  return { albedo: [tone, tone, tone - 1], height: 170, roughness: 215 };
}

function ufoSample(x: number, y: number): PatternSample {
  const cx = (x % 64) - 32;
  const cy = (y % 64) - 32;
  const radius = Math.sqrt(cx * cx + cy * cy);
  const ring = Math.abs((radius % 10) - 5) > 4.1;
  const spoke = Math.abs(cx) < 1 || Math.abs(cy) < 1 || Math.abs(Math.abs(cx) - Math.abs(cy)) < 0.8;
  const node = ((cx - 14) ** 2 + (cy - 14) ** 2 < 5) || ((cx + 14) ** 2 + (cy + 14) ** 2 < 5);
  if (node) return { albedo: [142, 245, 250], height: 220, roughness: 126 };
  if (ring || spoke) return { albedo: [174, 194, 198], height: 104, roughness: 170 };
  const tone = 238 + Math.floor(hash2d(x, y, 3) * 10);
  return { albedo: [tone - 4, tone, tone + 2], height: 172, roughness: 160 };
}

function rebelSample(x: number, y: number): PatternSample {
  const row = Math.floor(y / 20);
  const width = 19 + Math.floor(hash2d(row, 0, 4) * 17);
  const offset = Math.floor(hash2d(row, 1, 4) * width);
  const cellX = (x + offset) % width;
  const cellY = y % 20;
  const seam = cellX < 1.6 || cellY < 1.4;
  const scratch = ((x * 3 + y * 11 + row * 7) % 97) < 1.2;
  const grime = hash2d(x, y, 5) > 0.975;
  const plate = 238 - Math.floor(hash2d(Math.floor((x + offset) / width), row, 6) * 24);
  if (seam) return { albedo: [109, 112, 108], height: 74, roughness: 246 };
  if (scratch) return { albedo: [194, 187, 171], height: 118, roughness: 202 };
  if (grime) return { albedo: [120, 116, 105], height: 130, roughness: 250 };
  return { albedo: [plate, plate - 1, plate - 5], height: 166, roughness: 228 };
}

function imperialSample(x: number, y: number): PatternSample {
  const cellX = x % 24;
  const cellY = y % 16;
  const trench = cellY < 1.4 || (Math.floor(y / 16) % 4 === 0 && cellY < 3);
  const seam = cellX < 1.1;
  const inset = cellX > 6 && cellX < 18 && cellY > 5 && cellY < 9;
  const node = ((cellX - 5) ** 2 + (cellY - 12) ** 2) < 2;
  if (node) return { albedo: [177, 194, 198], height: 210, roughness: 174 };
  if (trench) return { albedo: [86, 91, 91], height: 62, roughness: 244 };
  if (seam || inset) return { albedo: [151, 157, 157], height: 104, roughness: 230 };
  const tone = 235 - Math.floor(hash2d(Math.floor(x / 24), Math.floor(y / 16), 7) * 12);
  return { albedo: [tone, tone, tone - 2], height: 170, roughness: 214 };
}

function polishedSample(x: number, y: number): PatternSample {
  const cellX = x % 40;
  const cellY = y % 32;
  const inlay = cellX < 1 || cellY < 1 || Math.abs(cellX - cellY) < 0.65;
  const servicePort = cellX > 17 && cellX < 23 && cellY > 12 && cellY < 18;
  const brush = (x + y * 5) % 13 === 0;
  if (servicePort) return { albedo: [168, 173, 169], height: 102, roughness: 178 };
  if (inlay) return { albedo: [198, 202, 197], height: 126, roughness: 152 };
  const tone = brush ? 244 : 252;
  return { albedo: [tone - 2, tone, tone - 1], height: brush ? 158 : 170, roughness: brush ? 150 : 124 };
}

function federationSample(x: number, y: number): PatternSample {
  const tileX = x % 32;
  const tileY = y % 32;
  const quadrant = (Math.floor(x / 32) + Math.floor(y / 32) * 3) % 4;
  const grid = tileX < 1.2 || tileY < 1.2;
  const aztecA = quadrant % 2 === 0 && (tileX < 4 || (tileX > 12 && tileX < 15) || tileY > 27);
  const aztecB = quadrant % 2 === 1 && (tileY < 4 || (tileY > 12 && tileY < 15) || tileX > 27);
  const escapeMark = ((tileX - 8) ** 2 + (tileY - 22) ** 2) < 3;
  if (escapeMark) return { albedo: [190, 167, 144], height: 200, roughness: 190 };
  if (grid) return { albedo: [143, 153, 157], height: 86, roughness: 230 };
  const base = 242 - quadrant * 4;
  if (aztecA || aztecB) return { albedo: [base - 12, base - 9, base - 7], height: 154, roughness: 208 };
  return { albedo: [base, base + 1, base + 1], height: 174, roughness: 198 };
}

function alienSample(x: number, y: number): PatternSample {
  const row = Math.floor(y / 18);
  const localY = y % 18;
  const localX = (x + (row % 2) * 14) % 28;
  const edge = Math.abs(localX - 14) < 1.2 || Math.abs(localY - Math.abs(localX - 14) * 0.75) < 1.1;
  const ridge = Math.abs(localX - 14) < 2.8 && localY > 5;
  const scaleTone = 231 - Math.floor(hash2d(Math.floor(x / 28), row, 8) * 20);
  if (edge) return { albedo: [116, 137, 119], height: 78, roughness: 240 };
  if (ridge) return { albedo: [193, 174, 127], height: 208, roughness: 184 };
  return { albedo: [scaleTone - 9, scaleTone, scaleTone - 10], height: 166, roughness: 222 };
}

function samplePattern(family: SurfaceFamily, x: number, y: number): PatternSample {
  switch (family) {
    case 'thermal': return thermalSample(x, y);
    case 'capsule': return capsuleSample(x, y);
    case 'ufo': return ufoSample(x, y);
    case 'rebel': return rebelSample(x, y);
    case 'imperial': return imperialSample(x, y);
    case 'polished': return polishedSample(x, y);
    case 'federation': return federationSample(x, y);
    case 'alien': return alienSample(x, y);
  }
}

function createSurfaceTextures(family: SurfaceFamily): SurfaceTextures {
  const pixelCount = TEXTURE_SIZE * TEXTURE_SIZE;
  const albedoData = new Uint8Array(pixelCount * 4);
  const heightData = new Uint8Array(pixelCount * 4);
  const roughnessData = new Uint8Array(pixelCount * 4);

  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      const index = y * TEXTURE_SIZE + x;
      const sample = samplePattern(family, x, y);
      writePixel(albedoData, index, ...sample.albedo);
      writePixel(heightData, index, sample.height, sample.height, sample.height);
      writePixel(roughnessData, index, sample.roughness, sample.roughness, sample.roughness);
    }
  }

  const bumpScale = family === 'polished'
    ? 0.008
    : family === 'federation'
      ? 0.014
      : family === 'ufo'
        ? 0.018
        : family === 'thermal'
          ? 0.026
          : family === 'alien'
            ? 0.035
            : 0.03;
  return {
    albedo: rgbaTexture(`fleet-${family}-micro-albedo`, albedoData, true),
    height: rgbaTexture(`fleet-${family}-micro-height`, heightData),
    roughness: rgbaTexture(`fleet-${family}-micro-roughness`, roughnessData),
    bumpScale,
  };
}

function texturesFor(family: SurfaceFamily): SurfaceTextures {
  const cached = surfaceCache.get(family);
  if (cached) return cached;
  const created = createSurfaceTextures(family);
  surfaceCache.set(family, created);
  return created;
}

function acceptsMicroSurface(material: THREE.MeshStandardMaterial): boolean {
  if (material.transparent || material.opacity < 0.98) return false;
  const brightest = Math.max(material.color.r, material.color.g, material.color.b);
  const glassLike = brightest < 0.16 && material.roughness < 0.32;
  return !glassLike;
}

/** Apply fine albedo, relief, and gloss variation to every eligible face of a
 * non-Default craft. Existing authored maps always win. */
export function applyFleetMicroSurface(profile: FleetProfile, model: THREE.Group): THREE.Group {
  const family = surfaceFamilyFor(profile);
  const textures = texturesFor(family);
  const adjusted = new Set<THREE.MeshStandardMaterial>();
  let texturedMaterialCount = 0;

  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial) || adjusted.has(material)) continue;
      adjusted.add(material);
      if (!acceptsMicroSurface(material)) continue;

      if (!material.map) material.map = textures.albedo;
      if (!material.bumpMap) {
        material.bumpMap = textures.height;
        material.bumpScale = textures.bumpScale;
      }
      if (!material.roughnessMap) material.roughnessMap = textures.roughness;
      // The scene has no ambient light. Modulating the restrained emissive
      // readability floor preserves the panel pattern on a ship's night side.
      if (!material.emissiveMap) material.emissiveMap = textures.albedo;
      material.userData.microSurfaceFamily = family;
      material.needsUpdate = true;
      texturedMaterialCount++;
    }
  });

  model.userData.microSurface = 'procedural-tertiary-v1';
  model.userData.microSurfaceFamily = family;
  model.userData.texturedMaterialCount = texturedMaterialCount;
  return model;
}
