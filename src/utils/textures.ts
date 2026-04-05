import * as THREE from 'three';
import { TEXTURES } from './constants';

const loader = new THREE.TextureLoader();
loader.crossOrigin = 'anonymous';

function load(url: string, timeoutMs = 8000): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`Texture load timeout: ${url}`)); }
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
        reject(err);
      },
    );
  });
}

export interface LoadedTextures {
  earthDay: THREE.Texture;
  earthNight: THREE.Texture;
  earthClouds: THREE.Texture;
  earthBump: THREE.Texture;
  moon: THREE.Texture;
}

export async function loadAllTextures(
  onProgress?: (loaded: number, total: number) => void,
): Promise<LoadedTextures> {
  const entries = [
    ['earthDay', TEXTURES.EARTH_DAY],
    ['earthNight', TEXTURES.EARTH_NIGHT],
    ['earthClouds', TEXTURES.EARTH_CLOUDS],
    ['earthBump', TEXTURES.EARTH_BUMP],
    ['moon', TEXTURES.MOON],
  ] as const;

  const total = entries.length;
  let loaded = 0;
  const results: Record<string, THREE.Texture> = {};

  await Promise.all(
    entries.map(async ([key, url]) => {
      try {
        results[key] = await load(url);
      } catch {
        // Fallback: generate a solid color texture
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = key.includes('earth') ? '#2244aa' : '#888888';
        ctx.fillRect(0, 0, 2, 2);
        results[key] = new THREE.CanvasTexture(canvas);
      }
      loaded++;
      onProgress?.(loaded, total);
    }),
  );

  return results as unknown as LoadedTextures;
}
