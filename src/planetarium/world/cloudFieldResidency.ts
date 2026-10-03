/**
 * Which of the cloud field's 128 pages sit in the pool's layers, decided every
 * frame from what the camera sees: the policy half of the field's residency,
 * with every side effect handed in — the page's load, its upload, the table
 * write, the sectors' business, the warning, the clock — so it runs and is
 * tested without a renderer, a worker or a network. The arithmetic of a page
 * on screen is `cloudFieldMeasure.ts`; the pool and its table are
 * `cloudFieldPool.ts`.
 *
 * DEMAND. The measure gives every page two numbers, page texels a tile-ratio
 * pixel on the footprint's major axis: the smallest among its points the
 * frame displays, and the smallest among its points in the frame widened by
 * the keep margin. A page is WANTED while the first is at most min(8, ratio /
 * wantTexelPx) — `ratio` the page level's width over the width the base sheet
 * is drawn at now, so a page is fetched only where the base has run out of
 * texels by the device row's own measure, and never past the guard's zero,
 * where it would draw nothing — and only by day: the day family's twilight
 * rule on the page's most lit point in frame. It is KEPT while the second is
 * at most 12 (the release line, half again the guard's zero, past which no
 * point of it in frame takes any weight) and its most lit point is short of
 * the night by the keep margin. A page's score is the sectors' form on the
 * first number, want / T × (0.5 + 0.5 × centrality): zero for a page not
 * kept, and for one the margin alone keeps. An extra demand of the same shape
 * (the pages a visible ground shadow reads) joins the deck's page by page:
 * the smaller numbers, the better centrality, the more lit point.
 *
 * RELEASED IS NOT EVICTED. The pool is allocated once and costs the same
 * empty or full, and a page whose guard is zero everywhere in frame costs the
 * deck's shader nothing past the table read it makes anyway, so a page that
 * stops being kept keeps its layer and its entry: it is simply the first to
 * go, without the margin and without the dwell, when a wanted page needs a
 * layer. A pan that turns back finds its pages still there, and a suspend
 * that releases everything (the deck hidden, the camera on the ground)
 * releases by scoring zero, never by clearing the pool.
 *
 * ONE PAGE IN THE PIPE, from its fetch to its table entry, so at most one
 * decoded page is ever held in memory and one load is in flight:
 * - Admission. The strongest wanted page not cooling down, when nothing is in
 *   the pipe, the frame admits and the sectors are not busy (no candidate
 *   waiting, fewer than their in-flight cap loading: they go first). It needs
 *   room: a free layer, or a resident it out-scores by the admit margin that
 *   is either released or has been drawn for the dwell. Its load gets an
 *   AbortSignal the residency owns and a generation; a completion for an
 *   older generation is dropped.
 * - Decoded. The page takes a free layer, or the weakest such resident starts
 *   to fade out — only now, so a load that fails evicts nothing. If no
 *   resident qualifies any more, the decoded page is dropped (no cooldown).
 *   While the victim fades, it turns back if it comes to out-score the page by
 *   the margin, or if the page is given up, and the page looks for another
 *   room.
 * - Upload. Two steps into the layer — level 0, then levels 1 to 11 — one a
 *   frame and only when the caller says the frame may carry one
 *   (`uploadStep`); the entry is written after the second, with a fade of
 *   zero, so no draw ever samples a layer half written.
 * - Failure. A load that rejects or outlives the deadline cools its page down
 *   (8 s, doubling up to four times) and is said once a session.
 *
 * FADES. A page fades in over 600 ms and out over 300 ms, ease-in-out, from
 * wherever it stands: one progress per page, run forward or back, so a
 * victim that turns back, or a page taken mid fade-in, reverses from its
 * current value. Eviction is always through a fade-out, the entry is cleared
 * when it reaches zero, and only then is the layer free. The table is written
 * only when a byte of it changes. The dwell runs from the first frame the
 * deck is drawn with the entry written (`deckDrawn`).
 *
 * SUSPENDS. The deck hidden or the camera grounded: everything released, the
 * pipe cancelled, no admissions. Spinning (Earth's day latch) or the chart
 * owning the frame: no admissions, the pipe runs on. The arrival veil: no
 * admissions and no uploads. An arrival, a tool visit or a mode switch:
 * `cancelInFlight` — the load aborted, the decoded page or its half-written
 * layer dropped, every resident kept. A lost context: `contextLost` drops
 * every entry and layer (the table written to zero) but not the demand, and
 * nothing is admitted or uploaded until `contextRestored`. A clock jump needs
 * nothing: the measure is whole every frame.
 *
 * Nothing is allocated per frame: every page's state is a typed array, the
 * frame and the demand are the caller's structs, the stats are one object
 * written in place. A load allocates its AbortController and its two
 * continuations.
 */
import {
  CLOUD_FIELD_GRID, CLOUD_FIELD_GUARD_TEXELS, CLOUD_FIELD_RELEASE_TEXELS, CLOUD_TABLE_SEE_PARENT,
} from './cloudField';
import type { CloudPageDemand } from './cloudFieldMeasure';

const PAGES = CLOUD_FIELD_GRID[0] * CLOUD_FIELD_GRID[1];

/** A page arriving fades in over this long, ease-in-out. */
export const CLOUD_PAGE_FADE_IN_MS = 600;
/** A page leaving fades out over this long before its layer is free. */
export const CLOUD_PAGE_FADE_OUT_MS = 300;
/** How long a page is safe from a stronger candidate once drawn: the
 *  sectors' dwell, for the same reason — two candidates a hair apart would
 *  otherwise hand one layer back and forth. */
export const CLOUD_PAGE_DWELL_MS = 1_000;
/** A candidate takes a resident's layer only when it out-scores it by this
 *  factor, and a fading victim turns back only when it out-scores its
 *  replacement by it: the sectors' admission hysteresis. */
export const CLOUD_PAGE_ADMIT_MARGIN = 1.25;
/** Cooldown after a failed load, doubling per consecutive failure up to
 *  four times: the sectors' figures. */
export const CLOUD_PAGE_RETRY_MS = 8_000;
const CLOUD_PAGE_RETRY_MAX_DOUBLINGS = 4;
/** A load older than this is given up on and its fetch aborted. */
export const CLOUD_PAGE_LOAD_TIMEOUT_MS = 60_000;
/** The day family's light edge: a page whose most lit point in frame has a
 *  Sun dot at or under this is past the twilight the deck draws and is not
 *  wanted; a resident is released only this margin further on, so a page on
 *  the terminator does not flap. The streamer's SECTOR_NIGHT_DOT and
 *  SECTOR_KEEP_LIGHT_MARGIN, which a test holds these to. */
export const CLOUD_PAGE_DAY_EDGE = -0.1;
export const CLOUD_PAGE_KEEP_LIGHT_MARGIN = 0.05;

/** What the residency does to the world, handed in. `D` is a decoded page. */
export interface CloudFieldResidencyDeps<D> {
  /** Layers in the pool. */
  layers: number;
  /** The device row's want line: device pixels a base texel must span before
   *  a page has detail to add (`profile.wantTexelPx`). */
  wantTexelPx: number;
  /** Fetch and decode one page (`row * 16 + col`); rejects on failure. The
   *  signal aborts when the residency gives the page up. */
  load(page: number, signal: AbortSignal): Promise<D>;
  /** Write one step of a decoded page into a layer: step 0 level 0, step 1
   *  levels 1 to 11. */
  upload(decoded: D, layer: number, step: 0 | 1): void;
  /** Write a page's table entry: R (0 absent, `layer + 1` resident) and G
   *  (the fade, 0 to 255). */
  writeEntry(page: number, r: number, g: number): void;
  /** Whether the sector streamer has a candidate waiting or its in-flight cap
   *  of loads running: asked only when a page could start. */
  sectorsBusy(): boolean;
  /** Said once a session, on the first page that fails. */
  warn(message: string): void;
  /** A high-resolution clock in ms, read twice an update for its own cost
   *  and never for a decision (`performance.now` in the app). */
  clock(): number;
}

/** The frame as the residency needs it, filled in place by the caller. */
export interface CloudFieldFrame {
  nowMs: number;
  /** The page level's width over the width the base sheet is drawn at now. */
  ratio: number;
  /** The deck is not drawn: its range gate or a role switch hides it. */
  hidden: boolean;
  /** The camera stands on the ground. */
  grounded: boolean;
  /** Earth's day latch holds: the globe or the clock turns the deck visibly. */
  spinning: boolean;
  /** The chart owns the frame. */
  chart: boolean;
  /** The arrival veil is up. */
  veil: boolean;
}

export type CloudPipeStage = 'idle' | 'loading' | 'decoded' | 'uploading';

/** What the residency reports for the debug line and the development bridge. */
export interface CloudFieldResidencyStats {
  /** Pages wanted this frame, and pages holding a layer. */
  wanted: number;
  resident: number;
  /** Where the one page in the pipe stands, and which page it is (−1 none). */
  pipe: CloudPipeStage;
  pipePage: number;
  /** Residents fading in or out. */
  fading: number;
  /** Pages cooling down after a failure. */
  failed: number;
  freeLayers: number;
  /** Pages whose entry was written, and pages whose entry was cleared, ever. */
  admissions: number;
  evictions: number;
  /** The last `update`'s own time, in microseconds. */
  updateMicros: number;
}

// What a layer holds when it holds no published page: nothing, or the page
// in the pipe on its way in. (A page's own `layerOf` is LAYER_FREE until it
// is published.)
const LAYER_FREE = -1;
const LAYER_PIPE = -2;

const easeInOut = (p: number): number => p * p * (3 - 2 * p);

export class CloudFieldResidency<D> {
  private readonly deps: CloudFieldResidencyDeps<D>;
  // Per page.
  private readonly layerOf = new Int16Array(PAGES).fill(LAYER_FREE);
  // A fade is its progress (0 absent, 1 full) at a time and the way it runs
  // from there, so a turn at any moment continues from where it stands.
  private readonly fadeFrom = new Float64Array(PAGES);
  private readonly fadeSince = new Float64Array(PAGES);
  private readonly direction = new Int8Array(PAGES);
  private readonly writtenR = new Uint8Array(PAGES);
  private readonly writtenG = new Uint8Array(PAGES);
  private readonly drawnFrom = new Float64Array(PAGES).fill(Number.NaN);
  private readonly failStreak = new Uint8Array(PAGES);
  private readonly retryAt = new Float64Array(PAGES);
  private readonly keptAt = new Float64Array(PAGES).fill(Number.NEGATIVE_INFINITY);
  private readonly score = new Float64Array(PAGES);
  private readonly kept = new Uint8Array(PAGES);
  private readonly wanted = new Uint8Array(PAGES);
  // Per layer: the page it holds, LAYER_FREE, or LAYER_PIPE (taken by the
  // page in the pipe, not yet published).
  private readonly pageIn: Int16Array;
  // The pipe.
  private stage: CloudPipeStage = 'idle';
  private pipePage = -1;
  private pipeGen = 0;
  private pipeController: AbortController | null = null;
  private pipeStartedMs = 0;
  private pipeDecoded: D | null = null;
  private pipeVictim = -1;
  private pipeLayer = -1;
  private pipeStep: 0 | 1 = 0;
  private pipeReadyMs = 0;
  // The frame.
  private lastNowMs = Number.NaN;
  private uploadsHeld = false;
  private stepTaken = false;
  private lost = false;
  private warned = false;
  private readonly statsOut: CloudFieldResidencyStats = {
    wanted: 0, resident: 0, pipe: 'idle', pipePage: -1, fading: 0, failed: 0, freeLayers: 0,
    admissions: 0, evictions: 0, updateMicros: 0,
  };

  constructor(deps: CloudFieldResidencyDeps<D>) {
    // A layer is named in the table as layer + 1, below the reserved codes.
    if (!(deps.layers >= 0 && deps.layers < CLOUD_TABLE_SEE_PARENT)) {
      throw new Error(`cloud field: ${deps.layers} layers cannot be named in the page table`);
    }
    this.deps = deps;
    this.pageIn = new Int16Array(deps.layers).fill(LAYER_FREE);
  }

  /**
   * One frame's decisions from the deck's demand (and an extra demand of the
   * same shape, or null): scores, the pipe, the fades, the table, an
   * admission.
   */
  update(frame: CloudFieldFrame, deck: CloudPageDemand, extra: CloudPageDemand | null): void {
    const t0 = this.deps.clock();
    const now = Number.isNaN(this.lastNowMs) ? frame.nowMs : Math.max(frame.nowMs, this.lastNowMs);
    this.lastNowMs = now;
    this.stepTaken = false;
    this.uploadsHeld = frame.veil || this.lost;
    const releaseAll = frame.hidden || frame.grounded;
    const admits = !releaseAll && !frame.spinning && !frame.chart && !frame.veil && !this.lost;
    const want = frame.ratio > 0
      ? Math.min(CLOUD_FIELD_GUARD_TEXELS[1], frame.ratio / this.deps.wantTexelPx) : 0;

    let wantedCount = 0;
    for (let p = 0; p < PAGES; p++) {
      let tWant = deck.wantTexels[p];
      let tKeep = deck.keepTexels[p];
      let c = deck.centrality[p];
      let sun = deck.sunDot[p];
      if (extra) {
        if (extra.wantTexels[p] < tWant) tWant = extra.wantTexels[p];
        if (extra.keepTexels[p] < tKeep) tKeep = extra.keepTexels[p];
        if (extra.centrality[p] > c) c = extra.centrality[p];
        if (extra.sunDot[p] > sun) sun = extra.sunDot[p];
      }
      const kept = !releaseAll && tKeep <= CLOUD_FIELD_RELEASE_TEXELS
        && sun > CLOUD_PAGE_DAY_EDGE - CLOUD_PAGE_KEEP_LIGHT_MARGIN;
      const wanted = kept && tWant <= want && sun > CLOUD_PAGE_DAY_EDGE;
      this.kept[p] = kept ? 1 : 0;
      this.wanted[p] = wanted ? 1 : 0;
      if (wanted) wantedCount += 1;
      if (kept) {
        // Zero for a page kept only by the frame's margin: nothing of it is
        // displayed, so it is the first to go after the released ones.
        this.score[p] = (want / Math.max(tWant, 1e-6)) * (0.5 + 0.5 * Math.min(1, Math.max(0, c)));
        this.keptAt[p] = now;
      } else {
        this.score[p] = 0;
      }
    }

    this.tendPipe(now);
    this.advanceFades(now);
    if (admits && this.stage === 'idle') this.admit(now);
    this.statsOut.wanted = wantedCount;
    this.statsOut.updateMicros = (this.deps.clock() - t0) * 1000;
  }

  /**
   * One upload step of the page in the pipe, when the caller's frame may carry
   * one: at most one a frame (between two updates), none under the veil or
   * with the context lost. The second step publishes the page. Returns
   * whether a step ran.
   */
  uploadStep(nowMs: number): boolean {
    if (this.stepTaken || this.uploadsHeld || this.stage !== 'uploading' || this.pipeDecoded === null) return false;
    this.stepTaken = true;
    this.deps.upload(this.pipeDecoded, this.pipeLayer, this.pipeStep);
    if (this.pipeStep === 0) {
      this.pipeStep = 1;
      this.pipeReadyMs = nowMs;
      return true;
    }
    const p = this.pipePage;
    const layer = this.pipeLayer;
    this.pageIn[layer] = p;
    this.layerOf[p] = layer;
    this.fadeFrom[p] = 0;
    this.fadeSince[p] = nowMs;
    this.direction[p] = 1;
    this.drawnFrom[p] = Number.NaN;
    this.failStreak[p] = 0;
    this.write(p, layer + 1, 0);
    this.statsOut.admissions += 1;
    this.clearPipe();
    return true;
  }

  /** How long the pipe's next upload step has been ready, in ms; 0 when there
   *  is none. The caller's rule for a step that waits too long reads it. */
  uploadWaitMs(nowMs: number): number {
    return this.stage === 'uploading' ? Math.max(0, nowMs - this.pipeReadyMs) : 0;
  }

  /** The deck was drawn with the table as last written: the dwell of every
   *  resident drawn for the first time starts now. */
  deckDrawn(nowMs: number): void {
    for (let l = 0; l < this.pageIn.length; l++) {
      const p = this.pageIn[l];
      if (p >= 0 && Number.isNaN(this.drawnFrom[p])) this.drawnFrom[p] = nowMs;
    }
  }

  /** An arrival, a tool visit or a mode switch: the load in flight aborted,
   *  a decoded page or its half-written layer dropped, residents kept. */
  cancelInFlight(): void {
    if (this.stage === 'idle') return;
    this.pipeController?.abort();
    if (this.pipeVictim >= 0) this.turn(this.pipeVictim, 1, this.lastNowMs);
    if (this.pipeLayer >= 0) this.pageIn[this.pipeLayer] = LAYER_FREE;
    this.clearPipe();
  }

  /** The context is gone, and every layer with it: every entry cleared, every
   *  layer free, the pipe dropped. Demand and cooldowns stay; nothing is
   *  admitted or uploaded until `contextRestored`. */
  contextLost(): void {
    this.lost = true;
    this.uploadsHeld = true;
    this.cancelInFlight();
    for (let l = 0; l < this.pageIn.length; l++) this.pageIn[l] = LAYER_FREE;
    for (let p = 0; p < PAGES; p++) {
      this.layerOf[p] = LAYER_FREE;
      this.fadeFrom[p] = 0;
      this.direction[p] = 0;
      this.drawnFrom[p] = Number.NaN;
      this.write(p, 0, 0);
    }
  }

  /** The pool is allocated again, empty: pages stream back in from demand. */
  contextRestored(): void {
    this.lost = false;
  }

  /** The numbers now (`wanted` and `updateMicros` as of the last update), in
   *  one object written in place. */
  stats(): Readonly<CloudFieldResidencyStats> {
    const s = this.statsOut;
    let resident = 0;
    let fading = 0;
    let free = 0;
    for (let l = 0; l < this.pageIn.length; l++) {
      const p = this.pageIn[l];
      if (p === LAYER_FREE) free += 1;
      if (p < 0) continue;
      resident += 1;
      if (this.direction[p] !== 0) fading += 1;
    }
    let failed = 0;
    for (let p = 0; p < PAGES; p++) if (this.retryAt[p] > this.lastNowMs) failed += 1;
    s.resident = resident;
    s.fading = fading;
    s.freeLayers = free;
    s.failed = failed;
    s.pipe = this.stage;
    s.pipePage = this.pipePage;
    return s;
  }

  /** A fade's progress at `now`. */
  private fadeAt(p: number, now: number): number {
    const dir = this.direction[p];
    if (dir === 0) return this.fadeFrom[p];
    const run = (now - this.fadeSince[p]) / (dir > 0 ? CLOUD_PAGE_FADE_IN_MS : CLOUD_PAGE_FADE_OUT_MS);
    return Math.min(1, Math.max(0, this.fadeFrom[p] + dir * run));
  }

  /** Run a page's fade the other way (or start it) from where it stands now. */
  private turn(p: number, dir: number, now: number): void {
    this.fadeFrom[p] = this.fadeAt(p, now);
    this.fadeSince[p] = now;
    this.direction[p] = dir;
  }

  /** Every fade at `now`, written; a fade-out that reaches zero clears its
   *  entry and frees its layer, to the page in the pipe when it was its
   *  victim. */
  private advanceFades(now: number): void {
    for (let l = 0; l < this.pageIn.length; l++) {
      const p = this.pageIn[l];
      if (p < 0) continue;
      const dir = this.direction[p];
      if (dir === 0) continue;
      const at = this.fadeAt(p, now);
      if (dir > 0 && at >= 1) {
        this.fadeFrom[p] = 1;
        this.direction[p] = 0;
      }
      if (dir < 0 && at <= 0) {
        this.fadeFrom[p] = 0;
        this.direction[p] = 0;
        this.layerOf[p] = LAYER_FREE;
        this.drawnFrom[p] = Number.NaN;
        this.write(p, 0, 0);
        this.statsOut.evictions += 1;
        if (p === this.pipeVictim) {
          this.pipeVictim = -1;
          this.takeLayer(l, now);
        } else {
          this.pageIn[l] = LAYER_FREE;
        }
        continue;
      }
      this.write(p, l + 1, Math.round(easeInOut(at) * 255));
    }
  }

  /** The pipe's own decisions: give its page up, time its load out, or find
   *  a decoded page its layer. */
  private tendPipe(now: number): void {
    if (this.stage === 'idle') return;
    const p = this.pipePage;
    if (!this.kept[p]) {
      this.cancelInFlight();
      return;
    }
    if (this.stage === 'loading') {
      if (now - this.pipeStartedMs > CLOUD_PAGE_LOAD_TIMEOUT_MS) {
        this.pipeController?.abort();
        this.fail(p, `timed out after ${CLOUD_PAGE_LOAD_TIMEOUT_MS / 1000} s`);
      }
      return;
    }
    if (this.stage !== 'decoded') return;
    const victim = this.pipeVictim;
    if (victim >= 0) {
      if (this.score[victim] <= CLOUD_PAGE_ADMIT_MARGIN * this.score[p]) return;
      // The victim is wanted again: it turns back, and the page looks for
      // other room.
      this.turn(victim, 1, now);
      this.pipeVictim = -1;
    }
    const free = this.freeLayer();
    if (free >= 0) {
      this.takeLayer(free, now);
      return;
    }
    const next = this.victimFor(p, victim, now);
    if (next < 0) {
      this.clearPipe();
      return;
    }
    this.pipeVictim = next;
    this.turn(next, -1, now);
  }

  /** The strongest wanted page that may start, started if it has room. */
  private admit(now: number): void {
    let best = -1;
    for (let p = 0; p < PAGES; p++) {
      if (!this.wanted[p] || this.layerOf[p] !== LAYER_FREE || this.retryAt[p] > now) continue;
      if (best < 0 || this.score[p] > this.score[best]) best = p;
    }
    if (best < 0) return;
    if (this.freeLayer() < 0 && this.victimFor(best, -1, now) < 0) return;
    if (this.deps.sectorsBusy()) return;
    this.startLoad(best, now);
  }

  private startLoad(p: number, now: number): void {
    const gen = ++this.pipeGen;
    const controller = new AbortController();
    this.stage = 'loading';
    this.pipePage = p;
    this.pipeController = controller;
    this.pipeStartedMs = now;
    this.deps.load(p, controller.signal).then(
      (decoded) => {
        if (gen !== this.pipeGen || this.stage !== 'loading') return;
        this.pipeDecoded = decoded;
        this.pipeController = null;
        this.stage = 'decoded';
      },
      (err: unknown) => {
        if (gen !== this.pipeGen || this.stage !== 'loading' || controller.signal.aborted) return;
        this.fail(p, err instanceof Error ? err.message : String(err));
      },
    );
  }

  /** A load that failed: its page cools down, the pipe empties, nothing was
   *  evicted for it. Said once a session. */
  private fail(p: number, why: string): void {
    this.failStreak[p] = Math.min(this.failStreak[p] + 1, 255);
    const doublings = Math.min(this.failStreak[p] - 1, CLOUD_PAGE_RETRY_MAX_DOUBLINGS);
    this.retryAt[p] = this.lastNowMs + CLOUD_PAGE_RETRY_MS * 2 ** doublings;
    if (!this.warned) {
      this.warned = true;
      const col = p % CLOUD_FIELD_GRID[0];
      this.deps.warn(`cloud field: page ${col}_${(p - col) / CLOUD_FIELD_GRID[0]} failed to load (${why}); the deck draws its base sheet there`);
    }
    this.clearPipe();
  }

  /** The decoded page takes a layer: uploads may start. */
  private takeLayer(l: number, now: number): void {
    this.pageIn[l] = LAYER_PIPE;
    this.pipeLayer = l;
    this.pipeStep = 0;
    this.pipeReadyMs = now;
    this.stage = 'uploading';
  }

  private clearPipe(): void {
    this.pipeGen += 1;
    this.stage = 'idle';
    this.pipePage = -1;
    this.pipeController = null;
    this.pipeDecoded = null;
    this.pipeVictim = -1;
    this.pipeLayer = -1;
    this.pipeStep = 0;
  }

  private freeLayer(): number {
    for (let l = 0; l < this.pageIn.length; l++) if (this.pageIn[l] === LAYER_FREE) return l;
    return -1;
  }

  /**
   * The resident a candidate may take, or −1: the weakest that is not already
   * fading out and not `excluded`, and that is either released or past its
   * dwell; the candidate must out-score it by the margin. Among released
   * pages, the one kept longest ago.
   */
  private victimFor(candidate: number, excluded: number, now: number): number {
    let weakest = -1;
    for (let l = 0; l < this.pageIn.length; l++) {
      const p = this.pageIn[l];
      if (p < 0 || p === excluded || this.direction[p] < 0) continue;
      const s = this.score[p];
      if (this.kept[p] && !(now - this.drawnFrom[p] >= CLOUD_PAGE_DWELL_MS)) continue;
      if (weakest < 0 || s < this.score[weakest]
        || (s === this.score[weakest] && this.keptAt[p] < this.keptAt[weakest])) weakest = p;
    }
    if (weakest < 0) return -1;
    return this.score[candidate] > CLOUD_PAGE_ADMIT_MARGIN * this.score[weakest] ? weakest : -1;
  }

  /** The table entry, written only when a byte of it changes. */
  private write(p: number, r: number, g: number): void {
    if (this.writtenR[p] === r && this.writtenG[p] === g) return;
    this.writtenR[p] = r;
    this.writtenG[p] = g;
    this.deps.writeEntry(p, r, g);
  }
}
