/**
 * The cloud field's pages on the GPU, for the vertical slice: one RG8 texture
 * array that holds every resident page, a 16 × 8 page table the deck's shader
 * reads to find them, and the DEV bridge that loads, fades and evicts named
 * pages by hand (`__moon.cloudField`). No streamer: the slice exists to prove
 * the upload path, the addressing and the look before one is built.
 * DEVELOPMENT ONLY; nothing in a production build reaches this module.
 *
 * THE POOL is a `DataArrayTexture` with no data, allocated once with all
 * twelve levels: `source.dataReady = false` and `mipmaps.length = 12` make
 * three's upload call `texStorage3D(levels = 12, RG8, 2048, 2048, N)` and
 * transfer nothing (WebGLTextures: the allocation precedes the dataReady test,
 * and `getMipLevels` reads the count off `mipmaps.length`). three never
 * uploads custom mips for an array texture and `generateMipmap` would rebuild
 * every layer, so each level of each page is written by hand through
 * `renderer.copyTextureToTexture(levelTex, pool, null, (0, 0, layer), 0,
 * level)`, where `levelTex` is a CPU `DataTexture` three has never seen: that
 * takes the renderer's CPU branch, one `texSubImage3D` into the layer at the
 * destination level, through three's own binding state, with the unpack
 * alignment, flip and premultiply taken from the pool (1, false, false) and
 * no mip generation for a level above zero.
 *
 * PUBLISHING. A page's table entry is written only after every level of its
 * layer is in, so a draw never samples a layer half written; an eviction
 * clears the entry before the layer can take another page. Levels go up one
 * per animation frame by default (the warm queue uploads whole textures
 * through `initTexture`, which is not this shape of work), or a whole page at
 * once with `perFrame: 12`.
 *
 * CONTEXT LOSS. three re-creates its texture state on a restore and
 * re-allocates the pool empty (dataReady is still false), so a loss clears
 * the table and a restore re-allocates the pool under the cover of the next
 * frame and fetches every page that was resident again into the layer it had.
 * A decode that completes for a generation that has since been evicted or
 * lost is dropped.
 *
 * BYTES are the pool's ALLOCATION — every layer, empty or not, all twelve
 * levels — read through `textureGpuBytes`, the accounting the memory envelope
 * uses. The envelope itself is not told in this slice.
 */
import * as THREE from 'three';
import {
  CLOUD_FIELD_ANISOTROPY,
  CLOUD_FIELD_GRID,
  CLOUD_PAGE_LEVELS,
  CLOUD_PAGE_SIZE,
  cloudFieldPoolBytes,
  cloudPageKey,
  parseCloudPageKey,
} from './cloudField';
import { cloudFieldMaterials, cloudFieldUniforms } from './cloudFieldSlots';
import { fieldTexelMajorAt, fieldUnproject, type FieldCamera } from './cloudFieldMeasure';
import { textureGpuBytes } from './textureBytes';
import { lensUnwarpNdc } from '../../shared/math/lensProjection';

type PageState = 'decoding' | 'uploading' | 'resident' | 'failed';

interface PageRecord {
  key: string;
  col: number;
  row: number;
  layer: number;
  fade: number;
  state: PageState;
  gen: number;
  levels: Uint8Array[] | null;
  nextLevel: number;
  fetchMs?: number;
  decodeMs?: number;
  mipMs?: number;
  fileBytes?: number;
  uploadMs: number[];
  requestedAt: number;
  residentAt?: number;
  error?: string;
}

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
  /** Write a raw R code into a resident page's table entry (DEV): 254 and 255
   *  are the reserved codes, which must draw the base. */
  code?: Record<string, number>;
  /** Levels uploaded per animation frame (1..12). */
  perFrame?: number;
  /** Resolve once every requested page is resident or failed. */
  wait?: boolean;
  /** Return the state (always returned; kept for the brief's spelling). */
  state?: boolean;
}

const PAGE_URL = (key: string, ch: 'a' | 'p') =>
  `${import.meta.env.BASE_URL}textures/tiles/earth-clouds.v2/field32k/${key}.${ch}.webp`;

class CloudFieldPool {
  readonly pool: THREE.DataArrayTexture;
  readonly table: THREE.DataTexture;
  private readonly layers: (string | null)[];
  private readonly pages = new Map<string, PageRecord>();
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (reply: unknown) => void>();
  private gen = 0;
  private pumping = false;
  private perFrame = 1;
  private lost = false;
  contextLosses = 0;
  contextRestores = 0;
  private settleWaiters: Array<() => void> = [];

  constructor(private readonly renderer: THREE.WebGLRenderer, layerCount: number) {
    const u = cloudFieldUniforms();
    const pool = new THREE.DataArrayTexture(null, CLOUD_PAGE_SIZE, CLOUD_PAGE_SIZE, layerCount);
    pool.format = THREE.RGFormat;
    pool.type = THREE.UnsignedByteType;
    pool.colorSpace = THREE.NoColorSpace;
    pool.generateMipmaps = false;
    pool.minFilter = THREE.LinearMipmapLinearFilter;
    pool.magFilter = THREE.LinearFilter;
    pool.wrapS = THREE.ClampToEdgeWrapping;
    pool.wrapT = THREE.ClampToEdgeWrapping;
    pool.anisotropy = CLOUD_FIELD_ANISOTROPY;
    pool.unpackAlignment = 1;
    pool.flipY = false;
    // Only the count is read: it is what makes three allocate twelve levels.
    pool.mipmaps = Array.from({ length: CLOUD_PAGE_LEVELS }, () => ({})) as unknown as typeof pool.mipmaps;
    pool.source.dataReady = false;
    pool.needsUpdate = true;
    this.pool = pool;
    this.table = u.uCloudPageTable.value;
    this.layers = Array.from({ length: layerCount }, () => null);
    u.uCloudPages.value = pool;
    renderer.initTexture(pool);
    const canvas = renderer.domElement;
    canvas.addEventListener('webglcontextlost', () => this.onLost());
    canvas.addEventListener('webglcontextrestored', () => this.onRestored());
  }

  get layerCount(): number { return this.layers.length; }

  private workerFor(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./cloudFieldWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ id: number }>) => {
        const cb = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        cb?.(e.data);
      };
    }
    return this.worker;
  }

  private writeEntry(rec: PageRecord | null, col: number, row: number): void {
    const o = (row * CLOUD_FIELD_GRID[0] + col) * 2;
    const data = this.table.image.data as Uint8Array;
    data[o] = rec ? rec.layer + 1 : 0;
    data[o + 1] = rec ? Math.round(Math.min(1, Math.max(0, rec.fade)) * 255) : 0;
    this.table.needsUpdate = true;
  }

  request(key: string): void {
    const cell = parseCloudPageKey(key);
    if (!cell) throw new Error(`cloudField: no page ${key}`);
    const k = cloudPageKey(cell[0], cell[1]);
    const existing = this.pages.get(k);
    if (existing && existing.state !== 'failed') return;
    const layer = existing ? existing.layer : this.layers.indexOf(null);
    if (layer < 0) throw new Error(`cloudField: the pool's ${this.layers.length} layers are full; evict one first`);
    this.layers[layer] = k;
    const rec: PageRecord = {
      key: k, col: cell[0], row: cell[1], layer, fade: existing?.fade ?? 1, state: 'decoding',
      gen: ++this.gen, levels: null, nextLevel: 0, uploadMs: [], requestedAt: performance.now(),
    };
    this.pages.set(k, rec);
    this.decode(rec);
  }

  private decode(rec: PageRecord): void {
    const id = this.nextId++;
    const gen = rec.gen;
    this.pending.set(id, (raw) => {
      const reply = raw as { ok: boolean; levels?: ArrayBuffer[]; error?: string; fetchMs?: number; decodeMs?: number; mipMs?: number; fileBytes?: number };
      const live = this.pages.get(rec.key);
      // Evicted, or the context was lost, while this decode was in flight.
      if (live !== rec || rec.gen !== gen) return;
      if (!reply.ok || !reply.levels) {
        rec.state = 'failed';
        rec.error = reply.error ?? 'decode failed';
        this.settle();
        return;
      }
      rec.levels = reply.levels.map((b) => new Uint8Array(b));
      rec.fetchMs = reply.fetchMs;
      rec.decodeMs = reply.decodeMs;
      rec.mipMs = reply.mipMs;
      rec.fileBytes = reply.fileBytes;
      rec.state = 'uploading';
      rec.nextLevel = 0;
      this.pump();
    });
    this.workerFor().postMessage({ id, urlA: PAGE_URL(rec.key, 'a'), urlP: PAGE_URL(rec.key, 'p') });
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    const step = () => {
      const job = [...this.pages.values()].find((p) => p.state === 'uploading');
      if (!job || this.lost) { this.pumping = false; return; }
      for (let n = 0; n < this.perFrame && job.nextLevel < CLOUD_PAGE_LEVELS; n++) this.uploadLevel(job);
      if (job.nextLevel >= CLOUD_PAGE_LEVELS) {
        job.levels = null;
        job.state = 'resident';
        job.residentAt = performance.now();
        this.writeEntry(job, job.col, job.row);
        this.settle();
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private uploadLevel(job: PageRecord): void {
    const level = job.nextLevel;
    const size = CLOUD_PAGE_SIZE >> level;
    const bytes = job.levels![level];
    const src = new THREE.DataTexture(bytes, size, size, THREE.RGFormat, THREE.UnsignedByteType);
    const t0 = performance.now();
    this.renderer.copyTextureToTexture(src, this.pool, null, new THREE.Vector3(0, 0, job.layer), 0, level);
    job.uploadMs.push(+(performance.now() - t0).toFixed(3));
    job.nextLevel = level + 1;
  }

  evict(key: string): void {
    const rec = this.pages.get(key);
    if (!rec) return;
    // The entry first: no draw after this may sample the layer.
    this.writeEntry(null, rec.col, rec.row);
    this.pages.delete(key);
    rec.gen = -1;
    this.layers[rec.layer] = null;
    this.settle();
  }

  setCode(key: string, code: number): void {
    const rec = this.pages.get(key);
    if (!rec || rec.state !== 'resident') return;
    const o = (rec.row * CLOUD_FIELD_GRID[0] + rec.col) * 2;
    (this.table.image.data as Uint8Array)[o] = Math.max(0, Math.min(255, Math.round(code)));
    this.table.needsUpdate = true;
  }

  setFade(key: string, fade: number): void {
    const rec = this.pages.get(key);
    if (!rec) return;
    rec.fade = fade;
    if (rec.state === 'resident') this.writeEntry(rec, rec.col, rec.row);
  }

  setPerFrame(n: number): void {
    this.perFrame = Math.max(1, Math.min(CLOUD_PAGE_LEVELS, Math.round(n)));
  }

  private settle(): void {
    if ([...this.pages.values()].some((p) => p.state === 'decoding' || p.state === 'uploading')) return;
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) w();
  }

  whenSettled(): Promise<void> {
    if (![...this.pages.values()].some((p) => p.state === 'decoding' || p.state === 'uploading')) return Promise.resolve();
    return new Promise((resolve) => this.settleWaiters.push(resolve));
  }

  private onLost(): void {
    this.lost = true;
    this.contextLosses++;
    const data = this.table.image.data as Uint8Array;
    data.fill(0);
    this.table.needsUpdate = true;
    // Every page in flight or resident is gone with the layer it was in; the
    // generation bump drops any decode that lands before the restore.
    for (const rec of this.pages.values()) {
      rec.gen = ++this.gen;
      rec.levels = null;
      rec.nextLevel = 0;
      rec.state = 'decoding';
    }
  }

  private onRestored(): void {
    this.lost = false;
    this.contextRestores++;
    // three's texture state was re-created: this allocates the twelve levels
    // again, still with no data, and re-binds nothing else.
    this.renderer.initTexture(this.pool);
    this.table.needsUpdate = true;
    for (const rec of this.pages.values()) {
      rec.uploadMs = [];
      rec.requestedAt = performance.now();
      rec.residentAt = undefined;
      this.decode(rec);
    }
  }

  state(): Record<string, unknown> {
    const data = this.table.image.data as Uint8Array;
    const table: Array<{ page: string; layer: number; fade: number }> = [];
    for (let r = 0; r < CLOUD_FIELD_GRID[1]; r++) {
      for (let c = 0; c < CLOUD_FIELD_GRID[0]; c++) {
        const o = (r * CLOUD_FIELD_GRID[0] + c) * 2;
        if (data[o] > 0) table.push({ page: cloudPageKey(c, r), layer: data[o] - 1, fade: +(data[o + 1] / 255).toFixed(3) });
      }
    }
    const pages: Record<string, unknown> = {};
    for (const rec of this.pages.values()) {
      pages[rec.key] = {
        layer: rec.layer, fade: rec.fade, state: rec.state, error: rec.error,
        fetchMs: rec.fetchMs != null ? +rec.fetchMs.toFixed(1) : undefined,
        decodeMs: rec.decodeMs != null ? +rec.decodeMs.toFixed(1) : undefined,
        mipMs: rec.mipMs != null ? +rec.mipMs.toFixed(1) : undefined,
        fileBytes: rec.fileBytes,
        uploadMs: rec.uploadMs,
        uploadMsTotal: +rec.uploadMs.reduce((a, b) => a + b, 0).toFixed(3),
        msToResident: rec.residentAt != null ? +(rec.residentAt - rec.requestedAt).toFixed(1) : undefined,
      };
    }
    const bytes = textureGpuBytes(this.pool);
    return {
      layers: this.layers.length,
      layerOf: [...this.layers],
      size: CLOUD_PAGE_SIZE,
      levels: CLOUD_PAGE_LEVELS,
      format: 'RG8',
      anisotropy: this.pool.anisotropy,
      poolBytes: bytes,
      poolMiB: +(bytes / 1048576).toFixed(2),
      poolBytesExact: cloudFieldPoolBytes(this.layers.length),
      perLayerMiB: +(cloudFieldPoolBytes(1) / 1048576).toFixed(3),
      occupied: this.layers.filter((l) => l !== null).length,
      perFrame: this.perFrame,
      table,
      pages,
      contextLosses: this.contextLosses,
      contextRestores: this.contextRestores,
      lost: this.lost,
    };
  }
}

let instance: CloudFieldPool | null = null;

/** Allocate the pool (under the boot cover, on `?cloudtiles=1`). */
export function installCloudFieldPool(renderer: THREE.WebGLRenderer, layers = 6): void {
  if (!instance) instance = new CloudFieldPool(renderer, layers);
}

/** Active samplers of a material's LINKED program, read from GL: the count the
 *  driver holds the program to, not one counted from the source. */
function linkedSamplers(renderer: THREE.WebGLRenderer, mat: THREE.Material): { count: number; names: string[] } | null {
  const props = renderer.properties.get(mat) as { currentProgram?: { program: WebGLProgram } };
  const prog = props.currentProgram?.program;
  if (!prog) return null;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const samplerTypes = new Set<number>([
    gl.SAMPLER_2D, gl.SAMPLER_3D, gl.SAMPLER_CUBE, gl.SAMPLER_2D_SHADOW, gl.SAMPLER_2D_ARRAY,
    gl.SAMPLER_2D_ARRAY_SHADOW, gl.SAMPLER_CUBE_SHADOW, gl.INT_SAMPLER_2D, gl.INT_SAMPLER_3D,
    gl.INT_SAMPLER_CUBE, gl.INT_SAMPLER_2D_ARRAY, gl.UNSIGNED_INT_SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_3D,
    gl.UNSIGNED_INT_SAMPLER_CUBE, gl.UNSIGNED_INT_SAMPLER_2D_ARRAY,
  ]);
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    if (info && samplerTypes.has(info.type)) names.push(info.name);
  }
  return { count: names.length, names };
}

/** The deck's material, found by its mesh's name (PlanetFactory names it). */
function deckMaterial(scene: THREE.Object3D | null): THREE.Material | null {
  const fieldMaterials = cloudFieldMaterials();
  if (fieldMaterials.size > 0) return [...fieldMaterials][0];
  let found: THREE.Material | null = null;
  scene?.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh && o.name === 'Earth clouds') found = (o as THREE.Mesh).material as THREE.Material;
  });
  return found;
}

/** `__moon.cloudField(request)`: load, fade and evict pages by hand, and the
 *  state of the pool, its table and the deck's linked program. */
export async function devCloudField(
  renderer: THREE.WebGLRenderer, scene: THREE.Object3D | null, req: CloudFieldRequest = {},
): Promise<Record<string, unknown>> {
  const list = (v: string | string[] | undefined): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
  if (instance) {
    if (req.perFrame != null) instance.setPerFrame(req.perFrame);
    if (req.evict === 'all') for (const k of instance.state().layerOf as (string | null)[]) { if (k) instance.evict(k); }
    else for (const k of list(req.evict as string | string[] | undefined)) instance.evict(k);
    for (const k of list(req.pages)) instance.request(k);
    for (const [k, f] of Object.entries(req.fade ?? {})) instance.setFade(k, f);
    for (const [k, c] of Object.entries(req.code ?? {})) instance.setCode(k, c);
    if (req.wait) await instance.whenSettled();
  } else if (req.pages || req.evict || req.fade) {
    throw new Error('cloudField: no pool — boot the dev server with ?cloudtiles=1');
  }
  if (req.diag != null) cloudFieldUniforms().uCloudFieldDiag.value = req.diag;
  const mat = deckMaterial(scene);
  const defines = (mat as (THREE.Material & { defines?: Record<string, string> }) | null)?.defines ?? {};
  return {
    defineOn: defines.CLOUD_FIELD !== undefined,
    diag: cloudFieldUniforms().uCloudFieldDiag.value,
    deckProgram: mat ? linkedSamplers(renderer, mat) : null,
    pool: instance ? instance.state() : null,
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
 * `__moon.cloudFieldProbe(points)` (DEV), with `diag: 3` set: at each point —
 * given in DISPLAYED output NDC, or `'limb'` for a point a little inside the
 * deck's limb above the frame's centre — the guard's input as the shader wrote
 * it into the scene target (R the major in tile-ratio pixels, G in scene
 * pixels, B the guard), beside the residency's number for the same deck point
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
