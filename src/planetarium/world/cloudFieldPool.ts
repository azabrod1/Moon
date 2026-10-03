/**
 * The cloud field's pages on the GPU: one RG8 texture array that holds every
 * resident page, and the 16 × 8 page table the deck's shader reads to find
 * them (world/cloudFieldSlots), with the path a page takes into a layer — its
 * two files fetched and decoded off the main thread, its levels uploaded, its
 * table entry written last. No residency yet: pages are requested, faded and
 * evicted by hand, through the development bridge (world/cloudFieldDev).
 * Imported only by a session that asked for the field (`?cloudtiles=1`), so
 * nothing here is loaded, allocated or fetched otherwise.
 *
 * THE POOL is a `DataArrayTexture` with no data, allocated once with all
 * twelve levels: `source.dataReady = false` and `mipmaps.length = 12` make
 * three's upload call `texStorage3D(levels = 12, RG8, 2048, 2048, N)` and
 * transfer nothing (WebGLTextures: the allocation precedes the dataReady test,
 * and `getMipLevels` reads the count off `mipmaps.length`). N is the device
 * profile's `cloudFieldLayers`. The allocation is checked with `getError`: an
 * array that failed to allocate is incomplete and samples as zero, so every
 * page the table called resident would draw as CLEAR sky. A failed allocation
 * therefore turns the field off for the session instead (PlanetariumMode),
 * and so does a failed re-allocation after a context restore.
 *
 * Three never uploads custom mips for an array texture and `generateMipmap`
 * would rebuild every layer, so each level of each page is written by hand
 * through `renderer.copyTextureToTexture(levelTex, pool, null, (0, 0, layer),
 * 0, level)`, where `levelTex` is a CPU `DataTexture` three has never seen:
 * that takes the renderer's CPU branch, one `texSubImage3D` into the layer at
 * the destination level, through three's own binding state, with the unpack
 * alignment, flip and premultiply taken from the pool (1, false, false) and
 * no mip generation for a level above zero.
 *
 * PUBLISHING. A page's table entry is written only after every level of its
 * layer is in, so a draw never samples a layer half written; an eviction
 * clears the entry before the layer can take another page. Levels go up one
 * per animation frame by default, or a whole page at once with `perFrame: 12`.
 *
 * THE PAGES are the two sets gen-tiles cuts from the cloud master,
 * `earth-clouds.v2/32k-a` (opacity) and `32k-p` (premultiplied brightness),
 * addressed like every sector tile (world/texturePolicy `resolveTileUrl`) at
 * the hashes the generated table names. A page that fails to arrive leaves
 * its entry absent, so the deck draws the base sheet there; the first failure
 * is said once through `debugWarn`, since a field that quietly never arrives
 * looks like nothing at all.
 *
 * CONTEXT LOSS (PlanetariumMode's handlers). A loss clears the table; a
 * restore re-allocates the pool empty (dataReady is still false), checks the
 * allocation again, and fetches every page that was resident back into the
 * layer it had. A decode that completes for a generation that has since been
 * evicted or lost is dropped.
 *
 * BYTES are the pool's ALLOCATION — every layer, empty or not, all twelve
 * levels — read through `textureGpuBytes`, the accounting the memory envelope
 * uses; the mode reserves them in the envelope as its fixed bytes.
 */
import * as THREE from 'three';
import {
  CLOUD_FIELD_ANISOTROPY,
  CLOUD_FIELD_GRID,
  CLOUD_FIELD_SETS,
  CLOUD_PAGE_LEVELS,
  CLOUD_PAGE_SIZE,
  cloudFieldPoolBytes,
  cloudPageKey,
  parseCloudPageKey,
} from './cloudField';
import { cloudFieldUniforms } from './cloudFieldSlots';
import { textureGpuBytes } from './textureBytes';
import { resolveTileUrl, sectorSetHash } from './texturePolicy';
import { debugWarn } from '../../shared/debug';

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

/** Where one plane of one page is served from: the opacity or the
 *  premultiplied brightness, at the hash the generated table names. */
function pageUrl(col: number, row: number, plane: 'opacity' | 'brightness'): string {
  const { key } = CLOUD_FIELD_SETS;
  const tier = CLOUD_FIELD_SETS[plane];
  return resolveTileUrl(key, tier, sectorSetHash(key, tier), col, row);
}

/** What an allocation reports: the time it took and the GL error after it. */
export interface CloudFieldAllocation {
  layers: number;
  bytes: number;
  /** The upload call and the `getError` round trip together. */
  ms: number;
  /** `gl.getError()` right after the allocation; NO_ERROR (0) is success. */
  glError: number;
}

/** Check a GL allocation: drain whatever error an earlier call left, run it,
 *  and read the one it raised. */
function allocateChecked(gl: WebGL2RenderingContext, allocate: () => void): { ms: number; glError: number } {
  for (let n = 0; n < 16 && gl.getError() !== gl.NO_ERROR; n++) { /* drain */ }
  const t0 = performance.now();
  allocate();
  const glError = gl.getError();
  return { ms: performance.now() - t0, glError };
}

export class CloudFieldPool {
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
  private warnedFailure = false;
  contextLosses = 0;
  contextRestores = 0;
  private settleWaiters: Array<() => void> = [];

  private constructor(private readonly renderer: THREE.WebGLRenderer, layerCount: number) {
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
    this.table = cloudFieldUniforms().uCloudPageTable.value;
    this.layers = Array.from({ length: layerCount }, () => null);
  }

  /**
   * Allocate a pool of `layers` pages and check the allocation. On success the
   * pool is bound into the shader's slot; on a GL error it is deleted again
   * and only the report comes back, so the caller can turn the field off.
   */
  static allocate(renderer: THREE.WebGLRenderer, layers: number): { pool: CloudFieldPool | null; report: CloudFieldAllocation } {
    const field = new CloudFieldPool(renderer, layers);
    const checked = allocateChecked(renderer.getContext() as WebGL2RenderingContext, () => renderer.initTexture(field.pool));
    const report: CloudFieldAllocation = {
      layers, bytes: cloudFieldPoolBytes(layers), ms: checked.ms, glError: checked.glError,
    };
    if (checked.glError !== 0) {
      field.pool.dispose();
      return { pool: null, report };
    }
    cloudFieldUniforms().uCloudPages.value = field.pool;
    return { pool: field, report };
  }

  get layerCount(): number { return this.layers.length; }

  /** Layers holding a page, in any state. */
  layersUsed(): number {
    let n = 0;
    for (const l of this.layers) if (l !== null) n++;
    return n;
  }

  /** The GPU bytes the pool holds: its allocation, whatever is resident. */
  bytes(): number {
    return textureGpuBytes(this.pool);
  }

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
        // Fail open, loudly once: the entry stays absent and the deck draws
        // the base sheet there.
        if (!this.warnedFailure) {
          this.warnedFailure = true;
          debugWarn(`Cloud field page ${rec.key} did not load, the deck stays on its base map there: ${rec.error}`);
        }
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
    this.workerFor().postMessage({
      id, urlA: pageUrl(rec.col, rec.row, 'opacity'), urlP: pageUrl(rec.col, rec.row, 'brightness'),
    });
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

  /** Write a raw R code into a resident page's table entry (the bridge's
   *  check that the reserved codes draw the base). */
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

  /** The context is gone, and every layer with it. */
  onContextLost(): void {
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

  /**
   * three has re-created its texture state: allocate the twelve levels again,
   * still with no data, and check it as at boot. On success every page that
   * was resident is fetched back into the layer it had; on a GL error the
   * pool is deleted and the report says so, for the caller to turn the field
   * off.
   */
  onContextRestored(): CloudFieldAllocation {
    this.lost = false;
    this.contextRestores++;
    const checked = allocateChecked(this.renderer.getContext() as WebGL2RenderingContext, () => this.renderer.initTexture(this.pool));
    const report: CloudFieldAllocation = {
      layers: this.layers.length, bytes: cloudFieldPoolBytes(this.layers.length), ms: checked.ms, glError: checked.glError,
    };
    if (checked.glError !== 0) {
      this.pages.clear();
      this.layers.fill(null);
      this.pool.dispose();
      this.worker?.terminate();
      this.worker = null;
      return report;
    }
    this.table.needsUpdate = true;
    for (const rec of this.pages.values()) {
      rec.uploadMs = [];
      rec.requestedAt = performance.now();
      rec.residentAt = undefined;
      this.decode(rec);
    }
    return report;
  }

  /** Everything the bridge reports: the layers, the allocation, the table as
   *  the shader reads it, and each page's timings. */
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
    const bytes = this.bytes();
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
      occupied: this.layersUsed(),
      perFrame: this.perFrame,
      table,
      pages,
      contextLosses: this.contextLosses,
      contextRestores: this.contextRestores,
      lost: this.lost,
    };
  }
}
