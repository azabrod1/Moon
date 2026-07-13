/**
 * Spike S1 throwaway code (docs/descent/ROADMAP.md) — replaced by the production
 * DescentMode in P1. The surviving artifact is the shell refactor this exercises
 * (src/app/renderPipeline.ts).
 *
 * World scene: meters, selenocentric, camera-relative on the GPU. A real-scale
 * gray datum sphere for the horizon/limb, a tile-local terrain patch at a fixed
 * site (jitter-free by construction), reference furniture, and a sun the exposure
 * control drives PRE-bloom (light intensity, not renderer exposure — TECH §6).
 * background stays null so the sky pass shows through (S1 checklist).
 */
import * as THREE from 'three';
import { MOON_RADIUS_M, toCameraRelative, type Vec3f64 } from './frames';

export const BODY_RADIUS_M = MOON_RADIUS_M;

// Site tangent frame at the datum sphere's north pole (any fixed surface point
// works; the pole keeps the frame trivial). Right-handed: east × north = up.
export const SITE_UP = new THREE.Vector3(0, 1, 0);
export const SITE_EAST = new THREE.Vector3(1, 0, 0);
export const SITE_NORTH = new THREE.Vector3(0, 0, -1);
export const SITE_ORIGIN_M: Vec3f64 = { x: 0, y: BODY_RADIUS_M, z: 0 };

/** Direction TO the sun in world space (elevation 20°, side azimuth) — shared
 *  with the sky pass so the glare sprite sits where the shading says it should. */
export const SUN_DIR_WORLD = new THREE.Vector3()
  .addScaledVector(SITE_EAST, Math.cos(20 * THREE.MathUtils.DEG2RAD) * Math.sin(135 * THREE.MathUtils.DEG2RAD))
  .addScaledVector(SITE_NORTH, Math.cos(20 * THREE.MathUtils.DEG2RAD) * Math.cos(135 * THREE.MathUtils.DEG2RAD))
  .addScaledVector(SITE_UP, Math.sin(20 * THREE.MathUtils.DEG2RAD))
  .normalize();

// Direction TO Earth. DESIGN App. A anchors Earth at 66° elevation; the spike
// lowers it to 28° (approximate is allowed) so it sits inside the near-horizon
// frame the descent shows at low altitude instead of far above it.
export const EARTH_DIR_WORLD = new THREE.Vector3()
  .addScaledVector(SITE_UP, Math.sin(28 * THREE.MathUtils.DEG2RAD))
  .addScaledVector(SITE_NORTH, Math.cos(28 * THREE.MathUtils.DEG2RAD))
  .normalize();

const PATCH_HALF_M = 4_000; // 8×8 km patch
const PATCH_SEGS = 256; // 257×257 vertices
const PEDESTAL_M = 30; // lift above the datum so the border can't z-fight the sphere
const BUMP_M = 60; // value-noise relief amplitude

// --- deterministic value noise (seeded hash — no Math.random) ---------------

function hash2(ix: number, iz: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296; // [0, 1)
}

function valueNoise(x: number, z: number, cell: number): number {
  const fx = x / cell, fz = z / cell;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const n00 = hash2(ix, iz), n10 = hash2(ix + 1, iz);
  const n01 = hash2(ix, iz + 1), n11 = hash2(ix + 1, iz + 1);
  return (n00 + (n10 - n00) * sx) * (1 - sz) + (n01 + (n11 - n01) * sx) * sz;
}

/** Terrain height (m) above the datum sphere at a tile-local east/north offset. */
function heightAt(u: number, v: number): number {
  const bumps = 0.6 * valueNoise(u, v, 420) + 0.3 * valueNoise(u, v, 130) + 0.1 * valueNoise(u, v, 43);
  return PEDESTAL_M + bumps * BUMP_M;
}

const _dir = new THREE.Vector3();

/**
 * Surface point for a tangent offset, projected onto the sphere and lifted by the
 * terrain height along the radial. `absolute` returns the selenocentric position
 * (baked into float32 downstream — the naive path that jitters); otherwise it is
 * tile-local (site origin subtracted in f64 — the steady path).
 */
function surfacePoint(u: number, v: number, absolute: boolean, out: THREE.Vector3): THREE.Vector3 {
  _dir.copy(SITE_UP).addScaledVector(SITE_EAST, u / BODY_RADIUS_M).addScaledVector(SITE_NORTH, v / BODY_RADIUS_M).normalize();
  const r = BODY_RADIUS_M + heightAt(u, v);
  out.copy(_dir).multiplyScalar(r);
  if (!absolute) out.y -= BODY_RADIUS_M; // subtract the site-origin Y in f64 (pole is on +Y)
  return out;
}

function buildPatchGeometry(absolute: boolean): THREE.BufferGeometry {
  const n = PATCH_SEGS + 1;
  const positions = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const scratch = new THREE.Vector3();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = -PATCH_HALF_M + (2 * PATCH_HALF_M * i) / PATCH_SEGS;
      const v = -PATCH_HALF_M + (2 * PATCH_HALF_M * j) / PATCH_SEGS;
      surfacePoint(u, v, absolute, scratch);
      const k = (j * n + i) * 3;
      positions[k] = scratch.x; positions[k + 1] = scratch.y; positions[k + 2] = scratch.z;
      // UVs centred on the site (0 at the patch centre) so near-field texture
      // coords stay small — a 1000× repeat samples fine at uv≈0 but averages to
      // grey at uv≈500 where a float32 varying loses the per-pixel increment.
      const t = (j * n + i) * 2;
      uvs[t] = i / PATCH_SEGS - 0.5; uvs[t + 1] = j / PATCH_SEGS - 0.5;
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < PATCH_SEGS; j++) {
    for (let i = 0; i < PATCH_SEGS; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      indices.push(a, b, c, b, d, c); // CCW seen from +Y (up) so the top face isn't back-culled
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** ~0.5 m two-gray checker — high-frequency detail that makes sub-pixel jitter
 *  visible. Mipmaps are OFF on purpose: at this repeat a mip chain averages the
 *  cells to flat gray, hiding both the detail and the naive-path displacement it
 *  is meant to reveal (crisp-with-aliasing is the honest jitter detector here). */
function makeCheckerTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 512, cells = 16, cell = size / cells;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#4a4a4a' : '#a8a8a8';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1000, 1000); // 8 km / 1000 = 8 m tile, /16 cells ⇒ ~0.5 m checker
  tex.anisotropy = maxAnisotropy;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// Reference furniture: gray boxes 0.5–10 m within 60 m, one 50 m obelisk ~290 m
// out for a silhouette. Deterministic tangent offsets (u east, v north).
const BOXES: { u: number; v: number; s: number }[] = [
  { u: 6, v: 12, s: 2.0 }, { u: -10, v: 20, s: 0.6 }, { u: 18, v: 34, s: 4.0 },
  { u: -22, v: 14, s: 1.2 }, { u: 4, v: 50, s: 8.0 }, { u: -38, v: 40, s: 0.5 },
];
const OBELISK = { u: 0, v: 290, w: 4, h: 50 };

export class SpikeWorld {
  readonly scene = new THREE.Scene();
  readonly siteOriginM = SITE_ORIGIN_M;

  private sphere: THREE.Mesh;
  private siteGroup = new THREE.Group(); // boxes + obelisk, always camera-relative-clean
  private patch: THREE.Mesh; // toggled between tile-local and naive-absolute
  private sun: THREE.DirectionalLight;
  private naive = false;
  private checker: THREE.CanvasTexture;
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  private _off = new THREE.Vector3();

  constructor(renderer: THREE.WebGLRenderer) {
    this.scene.background = null; // AC: the sky pass shows through

    const gray = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 1, metalness: 0 });
    this.disposables.push(gray);

    // Datum sphere (real radius) — the horizon/limb. Its center offset is huge, so
    // it carries the ~0.125 m float32 wobble; near the site the patch covers it and
    // at the limb the wobble is sub-pixel.
    const sphereGeo = new THREE.SphereGeometry(BODY_RADIUS_M, 512, 256);
    this.sphere = new THREE.Mesh(sphereGeo, gray);
    this.sphere.frustumCulled = false;
    this.scene.add(this.sphere);
    this.disposables.push(sphereGeo);

    this.checker = makeCheckerTexture(renderer.capabilities.getMaxAnisotropy());
    this.disposables.push(this.checker);
    const patchMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.checker, roughness: 1, metalness: 0 });
    this.disposables.push(patchMat);
    const patchGeo = buildPatchGeometry(false);
    this.disposables.push(patchGeo);
    this.patch = new THREE.Mesh(patchGeo, patchMat);
    this.patch.frustumCulled = false;
    this.scene.add(this.patch);

    // Furniture in the clean site frame.
    for (const b of BOXES) {
      const geo = new THREE.BoxGeometry(b.s, b.s, b.s);
      this.disposables.push(geo);
      const mesh = new THREE.Mesh(geo, gray);
      surfacePoint(b.u, b.v, false, this._off);
      mesh.position.set(this._off.x, this._off.y + b.s / 2, this._off.z);
      this.siteGroup.add(mesh);
    }
    const obGeo = new THREE.BoxGeometry(OBELISK.w, OBELISK.h, OBELISK.w);
    this.disposables.push(obGeo);
    const obelisk = new THREE.Mesh(obGeo, gray);
    surfacePoint(OBELISK.u, OBELISK.v, false, this._off);
    obelisk.position.set(this._off.x, this._off.y + OBELISK.h / 2, this._off.z);
    this.siteGroup.add(obelisk);
    this.scene.add(this.siteGroup);

    // Sun: the pre-bloom exposure control drives THIS light's intensity.
    this.sun = new THREE.DirectionalLight(0xfff4e6, 2.2);
    this.sun.position.copy(SUN_DIR_WORLD).multiplyScalar(1000);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Faint fixed blue-gray earthshine fill from the Earth direction.
    const earthshine = new THREE.DirectionalLight(0x9fb4d8, 0.16);
    earthshine.position.copy(EARTH_DIR_WORLD).multiplyScalar(1000);
    this.scene.add(earthshine);
    this.scene.add(earthshine.target);
  }

  /**
   * Naive-transform proof: rebuild the patch with ABSOLUTE selenocentric float32
   * vertices and park the group at −cameraPos computed in float32. Both the
   * ~1.7e6 m vertices and the huge model translation quantize to ~0.125 m, so the
   * GPU's model-view subtraction cancels catastrophically → visible jitter, where
   * the tile-local path stays rock steady.
   */
  setNaive(on: boolean): void {
    if (on === this.naive) return;
    this.naive = on;
    const old = this.patch.geometry;
    this.patch.geometry = buildPatchGeometry(on);
    old.dispose();
    this.disposables.push(this.patch.geometry);
  }

  isNaive(): boolean {
    return this.naive;
  }

  /** Terrain height (m above the datum) at the site centre — the camera rides the
   *  zenith line above THIS, not the bare datum, or it would sit inside the patch. */
  siteGroundHeightM(): number {
    return heightAt(0, 0);
  }

  update(camPosM: Vec3f64, exposureEV: number): void {
    // Everything offsets by −cameraPos in f64 so the camera sits at scene origin.
    toCameraRelative({ x: 0, y: 0, z: 0 }, camPosM, this._off);
    this.sphere.position.copy(this._off);

    toCameraRelative(this.siteOriginM, camPosM, this._off);
    this.siteGroup.position.copy(this._off);

    if (this.naive) {
      // Classic absolute path: float32 −cameraPos, absolute vertices already baked.
      this.patch.position.set(Math.fround(-camPosM.x), Math.fround(-camPosM.y), Math.fround(-camPosM.z));
    } else {
      this.patch.position.copy(this._off); // same clean site offset as the furniture
    }

    // Exposure applied PRE-bloom via the sun light (TECH §6 ordering trap).
    this.sun.intensity = 2.2 * Math.pow(2, exposureEV);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
