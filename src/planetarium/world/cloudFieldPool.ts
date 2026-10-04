/**
 * The cloud field's pages on the GPU: one RG8 texture array that holds every
 * resident page, and the 16 × 8 page table the deck's shader reads to find
 * them (world/cloudFieldSlots), with the three things a page's way into a
 * layer is made of — its load (both files fetched, decoded off the main
 * thread), its upload, and its table entry. Which page takes which layer, and
 * when, is the residency's (world/cloudFieldResidency), which calls these
 * three; the session (world/cloudFieldSession) wires the two together.
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
 * THE LOAD fetches a page's two files on the main thread, as every sector
 * tile is fetched — under the caller's AbortSignal, so a page given up on
 * stops costing bandwidth at once — and hands the two Blobs to the page
 * worker (world/cloudFieldWorker), which is started by the first load and
 * never at boot. A signal that aborts after the fetch cancels the decode in
 * the worker too. The pages are the two sets gen-tiles cuts from the cloud
 * master, `earth-clouds.v2/32k-a` (opacity) and `32k-p` (premultiplied
 * brightness), addressed like every sector tile (world/texturePolicy
 * `resolveTileUrl`) at the hashes the generated table names.
 *
 * THE UPLOAD writes a page in two steps — level 0, the 8 MiB one, then levels
 * 1 to 11 together — through `renderer.copyTextureToTexture(levelTex, pool,
 * null, (0, 0, layer), 0, level)`, where `levelTex` is a CPU `DataTexture`
 * three has never seen: that takes the renderer's CPU branch, one
 * `texSubImage3D` into the layer at the destination level, through three's
 * own binding state, with the unpack alignment, flip and premultiply taken
 * from the pool (1, false, false) and no mip generation for a level above
 * zero. (Three never uploads custom mips for an array texture, and
 * `generateMipmap` would rebuild every layer.)
 *
 * CONTEXT LOSS (PlanetariumMode's handlers, through the session). A loss
 * clears the table; a restore allocates the twelve levels again, still with
 * no data, and checks the allocation as at boot.
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
} from './cloudField';
import { cloudFieldUniforms } from './cloudFieldSlots';
import { textureGpuBytes } from './textureBytes';
import { resolveTileUrl, sectorSetHash } from './texturePolicy';

/** A decoded page: which it is, and its twelve levels, 2048² down to 1², RG8
 *  in GL order. */
export interface CloudPage {
  page: number;
  levels: Uint8Array[];
}

/** What the last load and upload of a page cost, for the development bridge. */
export interface CloudPageTimings {
  fetchMs: number;
  decodeMs: number;
  mipMs: number;
  fileBytes: number;
  /** The two upload steps, ms; −1 until a step has run. */
  uploadMs: [number, number];
}

/** Where one plane of one page is served from: the opacity or the
 *  premultiplied brightness, at the hash the generated table names. */
function pageUrl(col: number, row: number, plane: 'opacity' | 'brightness'): string {
  const { key } = CLOUD_FIELD_SETS;
  const tier = CLOUD_FIELD_SETS[plane];
  return resolveTileUrl(key, tier, sectorSetHash(key, tier), col, row);
}

/** One file's bytes, under the load's signal. */
async function fetchPlane(url: string, signal: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.blob();
}

function abortError(): DOMException {
  return new DOMException('the page was given up', 'AbortError');
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

type WorkerReply =
  | { id: number; ok: true; levels: ArrayBuffer[]; decodeMs: number; mipMs: number }
  | { id: number; ok: false; error: string };

export class CloudFieldPool {
  readonly pool: THREE.DataArrayTexture;
  readonly table: THREE.DataTexture;
  readonly layerCount: number;
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (reply: WorkerReply) => void>();
  // One CPU source per level, its data swapped in for each copy, and the
  // copy's destination: an upload allocates nothing.
  private readonly levelSources: THREE.DataTexture[];
  private readonly destination = new THREE.Vector3();
  private readonly timings = new Map<number, CloudPageTimings>();
  contextLosses = 0;
  contextRestores = 0;
  private lost = false;

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
    this.layerCount = layerCount;
    this.levelSources = Array.from({ length: CLOUD_PAGE_LEVELS }, (_, level) => {
      const size = CLOUD_PAGE_SIZE >> level;
      return new THREE.DataTexture(null, size, size, THREE.RGFormat, THREE.UnsignedByteType);
    });
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

  /** The GPU bytes the pool holds: its allocation, whatever is resident. */
  bytes(): number {
    return textureGpuBytes(this.pool);
  }

  /**
   * Fetch and decode one page (`row * 16 + col`, row 0 the northernmost).
   * Rejects on a failed fetch or decode, and at once with an AbortError when
   * `signal` aborts, cancelling whatever is still in flight: the other file's
   * fetch when one fails, the worker's decode once both are in.
   */
  async load(page: number, signal: AbortSignal): Promise<CloudPage> {
    const col = page % CLOUD_FIELD_GRID[0];
    const row = (page - col) / CLOUD_FIELD_GRID[0];
    // Both files under one controller, so a failure of either stops the other.
    const files = new AbortController();
    const relay = () => files.abort();
    signal.addEventListener('abort', relay, { once: true });
    const t0 = performance.now();
    let a: Blob;
    let p: Blob;
    try {
      [a, p] = await Promise.all([
        fetchPlane(pageUrl(col, row, 'opacity'), files.signal),
        fetchPlane(pageUrl(col, row, 'brightness'), files.signal),
      ]);
    } catch (err) {
      files.abort();
      throw err;
    } finally {
      signal.removeEventListener('abort', relay);
    }
    const fetchMs = performance.now() - t0;
    return this.decode(page, a, p, signal, fetchMs);
  }

  private decode(page: number, a: Blob, p: Blob, signal: AbortSignal, fetchMs: number): Promise<CloudPage> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const worker = this.workerFor();
      const id = this.nextId++;
      const onAbort = () => {
        this.pending.delete(id);
        worker.postMessage({ cancel: id });
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, (reply) => {
        signal.removeEventListener('abort', onAbort);
        if (!reply.ok) {
          reject(new Error(reply.error));
          return;
        }
        this.timings.set(page, {
          fetchMs, decodeMs: reply.decodeMs, mipMs: reply.mipMs, fileBytes: a.size + p.size, uploadMs: [-1, -1],
        });
        resolve({ page, levels: reply.levels.map((b) => new Uint8Array(b)) });
      });
      worker.postMessage({ id, a, p });
    });
  }

  private workerFor(): Worker {
    if (!this.worker) {
      const worker = new Worker(new URL('./cloudFieldWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        const cb = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        cb?.(e.data);
      };
      // A worker that failed to start, or died, answers nothing: every page
      // waiting on it fails now rather than at the load deadline, and the
      // next load starts a fresh one.
      worker.onerror = (e: ErrorEvent) => {
        e.preventDefault();
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        const waiting = [...this.pending.entries()];
        this.pending.clear();
        for (const [id, cb] of waiting) cb({ id, ok: false, error: `the page worker failed: ${e.message || 'no message'}` });
      };
      this.worker = worker;
    }
    return this.worker;
  }

  /** One upload step of a decoded page into `layer`: step 0 level 0, step 1
   *  levels 1 to 11. Never throws; does nothing while the context is lost. */
  upload(decoded: CloudPage, layer: number, step: 0 | 1): void {
    if (this.lost) return;
    const t0 = performance.now();
    this.destination.set(0, 0, layer);
    const last = step === 0 ? 0 : CLOUD_PAGE_LEVELS - 1;
    for (let level = step === 0 ? 0 : 1; level <= last; level++) {
      const source = this.levelSources[level];
      source.image.data = decoded.levels[level];
      this.renderer.copyTextureToTexture(source, this.pool, null, this.destination, 0, level);
      // The page's bytes are the caller's to let go of.
      source.image.data = null;
    }
    const timing = this.timings.get(decoded.page);
    if (timing) timing.uploadMs[step] = performance.now() - t0;
  }

  /** A page's table entry: R (0 absent, `layer + 1` resident, the reserved
   *  codes above) and G (its fade, 0 to 255). */
  writeEntry(page: number, r: number, g: number): void {
    const data = this.table.image.data as Uint8Array;
    data[page * 2] = r;
    data[page * 2 + 1] = g;
    this.table.needsUpdate = true;
  }

  /** The context is gone, and every layer with it: the table cleared, and no
   *  upload until the pool is allocated again. */
  contextLost(): void {
    this.lost = true;
    this.contextLosses++;
    (this.table.image.data as Uint8Array).fill(0);
    this.table.needsUpdate = true;
  }

  /**
   * three has re-created its texture state: allocate the twelve levels again,
   * still with no data, and check it as at boot. On a GL error the pool is
   * deleted, the worker stopped and the report says so, for the caller to
   * turn the field off.
   */
  contextRestored(): CloudFieldAllocation {
    this.contextRestores++;
    const checked = allocateChecked(this.renderer.getContext() as WebGL2RenderingContext, () => this.renderer.initTexture(this.pool));
    const report: CloudFieldAllocation = {
      layers: this.layerCount, bytes: cloudFieldPoolBytes(this.layerCount), ms: checked.ms, glError: checked.glError,
    };
    if (checked.glError !== 0) {
      this.pool.dispose();
      this.worker?.terminate();
      this.worker = null;
      this.pending.clear();
      return report;
    }
    this.lost = false;
    this.table.needsUpdate = true;
    return report;
  }

  /** Everything the bridge reports: the allocation, the table as the shader
   *  reads it, and each page's last load and upload. */
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
    for (const [page, t] of this.timings) {
      const col = page % CLOUD_FIELD_GRID[0];
      pages[cloudPageKey(col, (page - col) / CLOUD_FIELD_GRID[0])] = {
        fetchMs: +t.fetchMs.toFixed(1), decodeMs: +t.decodeMs.toFixed(1), mipMs: +t.mipMs.toFixed(1),
        fileBytes: t.fileBytes, uploadMs: t.uploadMs.map((ms) => +ms.toFixed(3)),
      };
    }
    const bytes = this.bytes();
    return {
      layers: this.layerCount,
      size: CLOUD_PAGE_SIZE,
      levels: CLOUD_PAGE_LEVELS,
      format: 'RG8',
      anisotropy: this.pool.anisotropy,
      poolBytes: bytes,
      poolMiB: +(bytes / 1048576).toFixed(2),
      poolBytesExact: cloudFieldPoolBytes(this.layerCount),
      perLayerMiB: +(cloudFieldPoolBytes(1) / 1048576).toFixed(3),
      table,
      pages,
      workerStarted: this.worker !== null,
      contextLosses: this.contextLosses,
      contextRestores: this.contextRestores,
      lost: this.lost,
    };
  }
}
