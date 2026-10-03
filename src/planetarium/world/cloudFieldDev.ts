/**
 * The cloud field's development bridge (`__moon.cloudField`,
 * `__moon.cloudFieldProbe`): the residency's state, the pool taken from it
 * so pages can be loaded, faded and evicted by hand, the shader's
 * diagnostics, and the guard's input read back against the residency's
 * number for the same deck point. DEVELOPMENT ONLY: imported by main's DEV
 * bridge and nothing else, so no production build carries it. The session it
 * drives (world/cloudFieldSession) is the one the planetarium mode owns.
 *
 * BY HAND. `auto: false` takes the pool from the residency (its entries and
 * layers cleared, its loads cancelled) and every hand request then goes
 * through the pool's own load, upload and table write: a requested page is
 * fetched and decoded as the residency's are, takes the first free layer,
 * goes up whole the moment it is decoded — both steps, outside the frame's
 * upload turn, which a hand-run capture has no use for — and is written to
 * the table at its fade. `auto: true` gives the pool back, the hand pages
 * dropped and the table cleared. A hand request while the residency owns the
 * pool is refused, loudly, rather than fought over.
 */
import * as THREE from 'three';
import type { CloudFieldSession } from './cloudFieldSession';
import type { CloudPage } from './cloudFieldPool';
import { cloudFieldDiagUniform } from './cloudFieldSlots';
import { fieldTexelMajorAt, fieldUnproject, type FieldCamera } from './cloudFieldMeasure';
import { CLOUD_FIELD_GRID, cloudPageKey, parseCloudPageKey } from './cloudField';
import { lensUnwarpNdc } from '../../shared/math/lensProjection';
import { linkedSamplers } from './samplerCensus';

export interface CloudFieldRequest {
  /** false takes the pool from the residency for the hand requests below;
   *  true gives it back. */
  auto?: boolean;
  /** Pages to make resident by hand, by key (`col_row`, row 0 the
   *  northernmost). */
  pages?: string | string[];
  /** Fades to set by hand, 0..1, by key; a page not yet resident takes it on
   *  arrival (1 otherwise). */
  fade?: Record<string, number>;
  /** Hand pages to evict. */
  evict?: string | string[] | 'all';
  /** The diagnostic: 0 off, 1 flat colour per layer, 2 tint by layer, 3 the
   *  guard's input written unlit to the scene target (read with `probe`). */
  diag?: number;
  /** Write a raw R code into a hand page's table entry: 254 and 255 are the
   *  reserved codes, which must draw the base. */
  code?: Record<string, number>;
  /** Resolve once every hand page is resident or failed. */
  wait?: boolean;
  /** Return the state (always returned; kept for the older spelling). */
  state?: boolean;
}

interface HandPage {
  layer: number;
  fade: number;
  state: 'loading' | 'resident' | 'failed';
  abort: AbortController;
  error?: string;
}

/** The pages loaded by hand while the residency is off, by page index. */
class HandPages {
  readonly pages = new Map<number, HandPage>();
  private readonly layers: Array<number | null>;
  private settleWaiters: Array<() => void> = [];
  private losses: number;

  constructor(private readonly session: CloudFieldSession) {
    this.layers = Array.from({ length: session.pool.layerCount }, () => null);
    this.losses = session.pool.contextLosses;
  }

  /** A lost context took every layer: forget what was in them. */
  private sync(): void {
    if (this.session.pool.contextLosses === this.losses) return;
    this.losses = this.session.pool.contextLosses;
    for (const rec of this.pages.values()) rec.abort.abort();
    this.pages.clear();
    this.layers.fill(null);
    this.settle();
  }

  request(page: number, fade: number | undefined): void {
    this.sync();
    const existing = this.pages.get(page);
    if (existing && existing.state !== 'failed') return;
    const layer = existing ? existing.layer : this.layers.indexOf(null);
    if (layer < 0) throw new Error(`cloudField: the pool's ${this.layers.length} layers are full; evict one first`);
    this.layers[layer] = page;
    const rec: HandPage = { layer, fade: fade ?? existing?.fade ?? 1, state: 'loading', abort: new AbortController() };
    this.pages.set(page, rec);
    const pool = this.session.pool;
    pool.load(page, rec.abort.signal).then(
      (decoded: CloudPage) => {
        if (this.pages.get(page) !== rec) return;
        pool.upload(decoded, layer, 0);
        pool.upload(decoded, layer, 1);
        rec.state = 'resident';
        this.write(page, rec);
        this.settle();
      },
      (err: unknown) => {
        if (this.pages.get(page) !== rec) return;
        rec.state = 'failed';
        rec.error = err instanceof Error ? err.message : String(err);
        this.settle();
      },
    );
  }

  evict(page: number): void {
    this.sync();
    const rec = this.pages.get(page);
    if (!rec) return;
    // The entry first: no draw after this may sample the layer.
    this.session.pool.writeEntry(page, 0, 0);
    rec.abort.abort();
    this.pages.delete(page);
    this.layers[rec.layer] = null;
    this.settle();
  }

  evictAll(): void {
    for (const page of [...this.pages.keys()]) this.evict(page);
  }

  setFade(page: number, fade: number): void {
    const rec = this.pages.get(page);
    if (!rec) return;
    rec.fade = fade;
    if (rec.state === 'resident') this.write(page, rec);
  }

  setCode(page: number, code: number): void {
    const rec = this.pages.get(page);
    if (!rec || rec.state !== 'resident') return;
    this.session.pool.writeEntry(page, Math.max(0, Math.min(255, Math.round(code))), Math.round(rec.fade * 255));
  }

  private write(page: number, rec: HandPage): void {
    this.session.pool.writeEntry(page, rec.layer + 1, Math.round(Math.min(1, Math.max(0, rec.fade)) * 255));
  }

  private busy(): boolean {
    for (const rec of this.pages.values()) if (rec.state === 'loading') return true;
    return false;
  }

  private settle(): void {
    if (this.busy()) return;
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) w();
  }

  whenSettled(): Promise<void> {
    if (!this.busy()) return Promise.resolve();
    return new Promise((resolve) => this.settleWaiters.push(resolve));
  }

  state(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [page, rec] of this.pages) {
      const col = page % CLOUD_FIELD_GRID[0];
      out[cloudPageKey(col, (page - col) / CLOUD_FIELD_GRID[0])] = {
        layer: rec.layer, fade: rec.fade, state: rec.state, error: rec.error,
      };
    }
    return out;
  }
}

let hand: HandPages | null = null;

function pageOf(key: string): number {
  const cell = parseCloudPageKey(key);
  if (!cell) throw new Error(`cloudField: no page ${key}`);
  return cell[1] * CLOUD_FIELD_GRID[0] + cell[0];
}

/** The planetarium deck's material, found by its mesh's name (PlanetFactory
 *  names it) — never the warm-up probe that shares its define. */
function deckMaterial(scene: THREE.Object3D | null): THREE.Material | null {
  const mesh = scene ? deckMesh(scene) : null;
  return mesh ? mesh.material as THREE.Material : null;
}

/** `__moon.cloudField(request)`: the residency's state, the pool by hand, and
 *  the deck's linked program. */
export async function devCloudField(
  renderer: THREE.WebGLRenderer, scene: THREE.Object3D | null, session: CloudFieldSession | null,
  req: CloudFieldRequest = {},
): Promise<Record<string, unknown>> {
  const list = (v: string | string[] | undefined): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const byHand = req.pages != null || req.evict != null || req.fade != null || req.code != null;
  if (session) {
    if (req.auto === false && session.isAuto) {
      session.setAuto(false);
      hand = new HandPages(session);
    }
    if (byHand && session.isAuto) {
      throw new Error('cloudField: the residency owns the pool; call cloudField({ auto: false }) first');
    }
    if (hand && !session.isAuto) {
      if (req.evict === 'all') hand.evictAll();
      else for (const k of list(req.evict as string | string[] | undefined)) hand.evict(pageOf(k));
      for (const k of list(req.pages)) hand.request(pageOf(k), req.fade?.[k]);
      for (const [k, f] of Object.entries(req.fade ?? {})) hand.setFade(pageOf(k), f);
      for (const [k, c] of Object.entries(req.code ?? {})) hand.setCode(pageOf(k), c);
      if (req.wait) await hand.whenSettled();
    }
    if (req.auto === true && !session.isAuto) {
      hand?.evictAll();
      hand = null;
      session.setAuto(true);
    }
  } else if (byHand || req.auto != null) {
    throw new Error('cloudField: no pool — boot with ?cloudtiles=1 on a device whose profile gives it layers');
  }
  if (req.diag != null) cloudFieldDiagUniform.value = req.diag;
  const mat = deckMaterial(scene);
  const defines = (mat as (THREE.Material & { defines?: Record<string, string> }) | null)?.defines ?? {};
  return {
    defineOn: defines.CLOUD_FIELD !== undefined,
    diag: cloudFieldDiagUniform.value,
    deckProgram: mat ? linkedSamplers(renderer, mat) : null,
    pool: session ? session.pool.state() : null,
    residency: session ? session.devState() : null,
    hand: hand ? hand.state() : null,
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
