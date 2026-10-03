/**
 * The cloud field's development bridge (`__moon.cloudField`,
 * `__moon.cloudFieldProbe`): pages loaded, faded and evicted by hand, the
 * shader's diagnostics, and the guard's input read back against the
 * residency's number for the same deck point. DEVELOPMENT ONLY: imported by
 * main's DEV bridge and nothing else, so no production build carries it. The
 * pool it drives is the session's (world/cloudFieldPool), reached through the
 * planetarium mode that owns it.
 */
import * as THREE from 'three';
import type { CloudFieldPool } from './cloudFieldPool';
import { cloudFieldDiagUniform } from './cloudFieldSlots';
import { fieldTexelMajorAt, fieldUnproject, type FieldCamera } from './cloudFieldMeasure';
import { lensUnwarpNdc } from '../../shared/math/lensProjection';
import { linkedSamplers } from './samplerCensus';

export interface CloudFieldRequest {
  /** Pages to make resident, by key (`col_row`, row 0 the northernmost). */
  pages?: string | string[];
  /** Fades to set, 0..1, by key; a page not yet resident takes it on arrival. */
  fade?: Record<string, number>;
  /** Pages to evict. */
  evict?: string | string[] | 'all';
  /** The diagnostic: 0 off, 1 flat colour per layer, 2 tint by layer, 3 the
   *  guard's input written unlit to the scene target (read with `probe`). */
  diag?: number;
  /** Write a raw R code into a resident page's table entry: 254 and 255 are
   *  the reserved codes, which must draw the base. */
  code?: Record<string, number>;
  /** Levels uploaded per animation frame (1..12). */
  perFrame?: number;
  /** Resolve once every requested page is resident or failed. */
  wait?: boolean;
  /** Return the state (always returned; kept for the brief's spelling). */
  state?: boolean;
}

/** The planetarium deck's material, found by its mesh's name (PlanetFactory
 *  names it) — never the warm-up probe that shares its define. */
function deckMaterial(scene: THREE.Object3D | null): THREE.Material | null {
  const mesh = scene ? deckMesh(scene) : null;
  return mesh ? mesh.material as THREE.Material : null;
}

/** `__moon.cloudField(request)`: load, fade and evict pages by hand, and the
 *  state of the pool, its table and the deck's linked program. */
export async function devCloudField(
  renderer: THREE.WebGLRenderer, scene: THREE.Object3D | null, pool: CloudFieldPool | null,
  req: CloudFieldRequest = {},
): Promise<Record<string, unknown>> {
  const list = (v: string | string[] | undefined): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
  if (pool) {
    if (req.perFrame != null) pool.setPerFrame(req.perFrame);
    if (req.evict === 'all') for (const k of pool.state().layerOf as (string | null)[]) { if (k) pool.evict(k); }
    else for (const k of list(req.evict as string | string[] | undefined)) pool.evict(k);
    for (const k of list(req.pages)) pool.request(k);
    for (const [k, f] of Object.entries(req.fade ?? {})) pool.setFade(k, f);
    for (const [k, c] of Object.entries(req.code ?? {})) pool.setCode(k, c);
    if (req.wait) await pool.whenSettled();
  } else if (req.pages || req.evict || req.fade) {
    throw new Error('cloudField: no pool — boot with ?cloudtiles=1 on a device whose profile gives it layers');
  }
  if (req.diag != null) cloudFieldDiagUniform.value = req.diag;
  const mat = deckMaterial(scene);
  const defines = (mat as (THREE.Material & { defines?: Record<string, string> }) | null)?.defines ?? {};
  return {
    defineOn: defines.CLOUD_FIELD !== undefined,
    diag: cloudFieldDiagUniform.value,
    deckProgram: mat ? linkedSamplers(renderer, mat) : null,
    pool: pool ? pool.state() : null,
  };
}

/** One half-float from its bits. */
function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** Everything the probe needs from the entry point. */
export interface CloudFieldProbeContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Object3D;
  camera: THREE.PerspectiveCamera;
  sceneTarget: THREE.WebGLRenderTarget | null;
  /** The sub-rectangle the frame is drawn into, in device pixels. */
  drawSize: { width: number; height: number };
  sceneRatio: number;
  tileRatio: number;
}

/**
 * `__moon.cloudFieldProbe(points)`, with `diag: 3` set: at each point — given
 * in DISPLAYED output NDC, or `'limb'` for a point a little inside the deck's
 * limb above the frame's centre — the guard's input as the shader wrote it
 * into the scene target (R the major in tile-ratio pixels, G in scene pixels,
 * B the guard), beside the residency's number for the same deck point
 * (world/cloudFieldMeasure, on the scene target's grid at the tile ratio).
 */
export function devCloudFieldProbe(
  ctx: CloudFieldProbeContext, points: Array<[number, number] | 'limb'>,
): Array<Record<string, unknown>> {
  const deck = deckMesh(ctx.scene);
  if (!deck) return [];
  const cam = ctx.camera;
  const lens = cam.userData.lens as { designFovDeg: number; effectiveStrength?: number; strength: number } | undefined;
  const design = lens?.designFovDeg ?? cam.fov;
  const strength = lens ? lens.effectiveStrength ?? lens.strength : 0;
  const radius = (deck.geometry as THREE.SphereGeometry).parameters.radius;
  // The camera in the deck mesh's own frame, in deck radii.
  deck.updateMatrixWorld();
  cam.updateMatrixWorld();
  const inv = new THREE.Matrix4().copy(deck.matrixWorld).invert();
  const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld).applyMatrix4(inv).divideScalar(radius);
  const basis = (i: number) => new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, i)
    .transformDirection(inv);
  const cssH = ctx.renderer.domElement.clientHeight;
  const field: FieldCamera = {
    pos: [pos.x, pos.y, pos.z], right: basis(0).toArray() as [number, number, number],
    up: basis(1).toArray() as [number, number, number], back: basis(2).toArray() as [number, number, number],
    renderFovDeg: cam.fov, designFovDeg: design, lensStrength: strength, aspect: cam.aspect,
    heightPx: cssH * ctx.tileRatio,
  };
  const out: Array<Record<string, unknown>> = [];
  const resolveNdc = (pt: [number, number] | 'limb'): { x: number; y: number } | null => {
    if (pt !== 'limb') {
      return lensUnwarpNdc(pt[0], pt[1], design, cam.fov, cam.aspect, strength, { x: 0, y: 0 });
    }
    // Up the centre column of the scene target until the deck is missed, then
    // back down 12 scene pixels.
    let last: number | null = null;
    for (let y = 0; y <= 1; y += 0.0005) {
      const px = fieldUnproject(field, 0.5 * field.heightPx * field.aspect, (1 - y) * 0.5 * field.heightPx);
      if (px) last = y; else if (last !== null) break;
    }
    if (last === null) return null;
    return { x: 0, y: last - 24 / (ctx.drawSize.height) };
  };
  for (const pt of points) {
    const ndc = resolveNdc(pt);
    if (!ndc) { out.push({ point: pt, error: 'no deck there' }); continue; }
    // The scene target's pixel (GL rows from the bottom of the sub-rectangle).
    const sx = Math.min(ctx.drawSize.width - 1, Math.max(0, Math.floor((ndc.x + 1) * 0.5 * ctx.drawSize.width)));
    const sy = Math.min(ctx.drawSize.height - 1, Math.max(0, Math.floor((ndc.y + 1) * 0.5 * ctx.drawSize.height)));
    let shader: number[] | null = null;
    if (ctx.sceneTarget) {
      const buf = new Uint16Array(4);
      ctx.renderer.readRenderTargetPixels(ctx.sceneTarget, sx, sy, 1, 1, buf);
      shader = Array.from(buf, halfToFloat);
    }
    // The same pixel centre on the residency's grid.
    const tx = ((sx + 0.5) / ctx.drawSize.width) * field.heightPx * field.aspect;
    const ty = (1 - (sy + 0.5) / ctx.drawSize.height) * field.heightPx;
    const d = fieldUnproject(field, tx, ty);
    const cpu = d ? fieldTexelMajorAt(field, d) : null;
    out.push({
      point: pt, scenePx: [sx, sy], ndc: [+ndc.x.toFixed(4), +ndc.y.toFixed(4)],
      shaderMajor: shader ? +shader[0].toFixed(4) : null,
      shaderMajorScene: shader ? +shader[1].toFixed(4) : null,
      shaderGuard: shader ? +shader[2].toFixed(4) : null,
      residencyMajor: cpu !== null ? +cpu.toFixed(4) : null,
      ratio: shader && cpu ? +(shader[0] / cpu).toFixed(4) : null,
      sceneRatio: ctx.sceneRatio, tileRatio: ctx.tileRatio,
    });
  }
  return out;
}

function deckMesh(scene: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  scene.traverse((o) => { if (!found && (o as THREE.Mesh).isMesh && o.name === 'Earth clouds') found = o as THREE.Mesh; });
  return found;
}
