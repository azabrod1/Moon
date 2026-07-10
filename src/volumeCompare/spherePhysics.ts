/**
 * Uniform-radius sphere solver for the "how many fit?" pour — the container is a
 * glass planet, the balls are the filler planet at true relative scale.
 *
 * Units: the container inner radius is 1 studio unit; the ball radius is in the
 * same units (case A's Earth-in-Jupiter ball is ~0.09). Gravity, speeds, and the
 * mouth opening are all in studio units. Nothing here knows about km or AU.
 *
 * Design intent:
 *   - PURE: no three.js, no DOM. It owns SoA Float32Arrays and mutates them in
 *     place. The renderer reads `posX/Y/Z` + the quaternion arrays each frame.
 *   - Zero allocation in the hot loop. Every buffer is sized up front; the only
 *     reallocation is when the ball radius (and therefore the grid) changes,
 *     which happens on a case switch, never per frame. Removal scratch is a
 *     preallocated member so the melt beat allocates nothing either.
 *   - Deterministic: all randomness comes from an injected seeded RNG, so a
 *     fixed seed reproduces a pour bit-for-bit.
 *
 * Integration is semi-implicit Euler with an explicit velocity, and collisions
 * are resolved position-based (Gauss-Seidel projection) with a separate
 * velocity pass for restitution + friction on the final iteration. This is the
 * "PBD-ish" split: position projection gives stable stacks, the explicit
 * velocity gives a tunable micro-bounce and a clean impact signal for the wake
 * test and the resting grip.
 * `prevPos` is retained and drives the sleep metric (displacement / dt captures
 * both falling AND being shoved by the solver, so a jostled ball won't sleep).
 *
 * Lifecycle correctness (the part that is easy to get wrong):
 *   - The spatial hash contains ALL live spheres every substep, awake or asleep.
 *     Sleepers are immovable colliders; they never vanish from collision or wake
 *     queries. (A sleeper dropping out of the hash is why piles "melt through"
 *     each other.)
 *   - A sphere is constrained to the container only after it is flagged
 *     `entered` (its centre has dropped below the mouth plane or is inside the
 *     shell). Before that it falls freely through the spout, which sits outside
 *     the sphere.
 *   - Every removal (drain, melt, liquid-consume) wakes the neighbourhood of the
 *     removed sphere, so whatever was resting on it falls instead of hanging in
 *     the air.
 *   - Sleep requires ALL THREE: low net drift over the window, residual contact
 *     pressure under the gate (never freeze interpenetration in), and being
 *     inside the container. Wake stays impact-keyed (WAKE_SPEED). Drop any leg
 *     and you get wake-cascades, sleep-ratchet over-packing, or escapees.
 *
 * The admission ceiling is what makes "full" honest. A pour held past the brim
 * never self-stalls: the raining impacts keep the top of the pile awake and
 * soft, each arrival burrows in, and — with no ceiling — packing grows without
 * bound into a permanently churning pile. Refusing new balls at the measured
 * at-rest brim packing is precisely the product's "the container is full, melt
 * to fit the rest" moment.
 */

import type { Rng } from './rng';

export interface PhysicsParams {
  /** Ball radius in container units (container inner radius is `containerR`). */
  radius: number;
  /** Container inner radius. Studio scale pins this at 1. */
  containerR: number;
  /** Downward acceleration magnitude (units / s^2). */
  gravity: number;
  /** Bounce coefficient for ball-ball and ball-wall contacts (0 = dead). */
  restitution: number;
  /** Per-second linear velocity damping (air drag; keeps the sim from ringing). */
  linearDamping: number;
  /** Fraction of tangential contact velocity removed per contact (friction). */
  tangentialDamping: number;
  /**
   * Sleep drift tolerance as a fraction of the ball radius: a ball may sleep only
   * once its net displacement over the settle window stays within
   * `sleepEpsScale * radius`. Radius-scaled because resting jostle amplitude
   * scales with the ball — an absolute tolerance strands big balls awake (their
   * normal at-rest jostle exceeds it) while being far too loose for small ones.
   */
  sleepEpsScale: number;
  /** Substeps under the drift tolerance before a ball is put to sleep. */
  sleepFrames: number;
  /** Multiplier on the auto-sized mouth opening radius. */
  mouthRadiusScale: number;
  /** Seconds over which spin eases to zero as a ball settles. */
  spinEaseTime: number;
  /** Lateral spawn scatter as a fraction of the ball radius (0..1). */
  spawnJitter: number;
  /** Gauss-Seidel iterations per substep. */
  iterations: number;
  /** Hard ceiling on live spheres (buffer capacity). */
  maxBalls: number;
}

/**
 * The tuned "feels right" parameter set — the single home for the calibrated
 * feel so the scene and the tests never re-list (and drift) the defaults. The
 * filler's size (`radius`, in container units) and the buffer capacity
 * (`maxBalls`) are the per-session inputs; everything else is the settled feel:
 * a readable micro-bounce, a crisp fall, a clean settle, and a pour that stays
 * calm even when held past the brim. Override only what a caller is deliberately
 * changing.
 */
export function defaultPhysicsParams(radius: number, maxBalls: number): PhysicsParams {
  return {
    radius,
    maxBalls,
    containerR: 1, // studio scale: the glass container is the unit sphere
    gravity: 9.5, // earth-ish fall at studio scale (lower reads floaty at r~0.09)
    restitution: 0.25, // one readable micro-bounce, no popcorn
    linearDamping: 0.3, // crisp fall (higher looks like syrup)
    tangentialDamping: 0.12, // rolls settle without an ice-rink slide
    sleepEpsScale: 0.22, // net-drift sleep tolerance = 0.22 * radius (see field doc)
    sleepFrames: 34, // ~0.28 s calm before sleep at 120 Hz substeps
    mouthRadiusScale: 1, // opening auto-sizes to ~4 balls across, then clamps
    spinEaseTime: 0.4, // tumble visibly eases to zero into sleep
    spawnJitter: 0.5, // stream reads alive, not laminar
    iterations: 5, // Gauss-Seidel sweeps; 5 converge the brim-deep static tail
  };
}

const SPAWN_Y = 1.35; // spout height, above the container top (y = containerR)
const DT_SUB = 1 / 120; // fixed physics substep
const MAX_SUBSTEPS = 12; // matches the app's dt clamp of 0.1 s
const SPAWN_VY = -1.8; // initial downward speed (poured, not dribbled)
// A sleeper only wakes when hit by a ball MOVING at least this fast. Waking on
// overlap magnitude instead lets a deep pile's steady compression (a resting
// ball presses its neighbour deeper than any fixed overlap gate) perpetually
// re-wake sleepers — a wake-cascade equilibrium the pile never escapes. Keying
// the wake to impact speed means a falling/rolling ball wakes the pile but a
// ball merely resting under load does not.
const WAKE_SPEED = 0.35;
// Opening radius as a multiple of the ball radius (so the mouth is MOUTH_K balls
// across the DIAMETER). A ~1.3-diameter neck single-files the pour to a few
// balls/s; a ~4-ball-wide mouth leaves room for a shower-head ring (center +
// ~6 points) that feeds the pour at dozens/s — what the marquee full pour needs
// to finish in ~20-30 s.
const MOUTH_K = 4.0;

/**
 * The mouth opening for a given ball size: the radius auto-sizes to MOUTH_K
 * balls across, clamped to a sane band (tiny balls must not pinhole the pour;
 * huge ones must not uncap the whole sphere), and the plane height follows
 * from where that circle sits on the container shell. Exported so the glass
 * shader's discard cone and the solver always cut the same hole.
 */
export function mouthGeometry(
  ballRadius: number,
  containerR: number,
  mouthRadiusScale = 1,
): { mouthRadius: number; mouthPlaneY: number } {
  const mouthRadius = Math.min(Math.max(MOUTH_K * ballRadius * mouthRadiusScale, 0.14), 0.5);
  const mouthPlaneY = Math.sqrt(Math.max(0, containerR * containerR - mouthRadius * mouthRadius));
  return { mouthRadius, mouthPlaneY };
}

// Sleep pressure gate, as a fraction of the ball radius: a ball may not SLEEP
// while its residual contact overlap — the deepest raw overlap seen in the
// FINAL solver iteration of the substep — exceeds this. Sleepers are immovable
// and never move again, so sleeper-sleeper interpenetration is pinned at what a
// ball slept under: at most the gate plus whatever the final iteration's own
// projections re-introduced (Gauss-Seidel resolves contacts in sequence, so
// fixing one pair can nudge another) — a few percent of r in practice; the
// suite pins the frozen worst case below 0.36 r. Without the gate the
// drift-window sleep freezes
// balls mid-compression (net drift stays under the tolerance while a slow
// single-file pour wedges each arrival against the previous, now-sleeping, one)
// and the container ratchets to several times its physical capacity — deep
// interpenetration baked in by frozen sleepers, "packing fraction" past 4 at
// rest. Calibration (measured, 500-ball case-A pile, 3 Gauss-Seidel iterations):
// the HONEST static-load equilibrium is soft — residuals hold at p50 0.09 r,
// p99 0.20 r, max 0.23 r while the pile is at rest — while a ratcheting pile
// needs sustained residuals of 0.48 r and up. 0.35 r sits between the bands:
// static piles sleep exactly as before, structural over-packing cannot freeze.
const OVERLAP_GATE_K = 0.35;
// Admission ceiling: spawn() refuses once entered-ball volume reaches this
// fraction of the container volume. A pour held past the brim does not stall on
// its own (see the module header); the fix is to stop ADMITTING. At the ceiling
// the measured flow drops to zero while the pour is held — which is exactly the
// product's "brim" moment. 0.55 is the measured at-rest brim pack, and is also
// the highest fill where the whole pile still passes the sleep gate (at 0.60 the
// bottom of the pile wedges past the gate and ~40 balls quiver forever).
export const PACK_CEILING = 0.55;

export class SpherePhysics {
  params: PhysicsParams;
  private rng: Rng;

  // --- SoA state (indices are stable under stack-pop drain; melt/consume use a
  //     swap-with-last removal, which relocates the moved ball's index) ---
  posX: Float32Array;
  posY: Float32Array;
  posZ: Float32Array;
  prevX: Float32Array;
  prevY: Float32Array;
  prevZ: Float32Array;
  velX: Float32Array;
  velY: Float32Array;
  velZ: Float32Array;
  // Orientation quaternion (x, y, z, w) for tumble readout.
  qx: Float32Array;
  qy: Float32Array;
  qz: Float32Array;
  qw: Float32Array;
  // Angular velocity (rad/s), integrated only while awake.
  wx: Float32Array;
  wy: Float32Array;
  wz: Float32Array;
  private sleepCount: Int32Array;
  // Window anchor for the net-drift sleep test: a ball sleeps only if it stays
  // within `sleepEpsScale * radius` of this anchor for `sleepFrames` substeps. A
  // jammed ball that jostles in place (high instantaneous velocity, ~zero net
  // drift) still sleeps — the standard fix for granular piles that never calm
  // below a velocity threshold.
  private anchorX: Float32Array;
  private anchorY: Float32Array;
  private anchorZ: Float32Array;
  entered: Uint8Array;
  asleep: Uint8Array;
  // Residual contact pressure: deepest raw overlap (ball-ball or wall) seen in
  // the final solver iteration of the current substep. Zeroed at integration.
  // Public so tests/probes can assert on it.
  contactPressure: Float32Array;

  count = 0;
  // Number of `entered` balls, maintained incrementally (on entry, prefill,
  // reset, and every removal) so `packingFraction` and the admission ceiling are
  // O(1) — a pour attempts spawn() many times per frame and each reads packing.
  enteredCount = 0;
  private noSleep = false;

  // Scratch for the melt/consume removals: gathers candidate indices, then holds
  // the selected victims. Preallocated so the removal path allocates nothing.
  private meltScratch: Int32Array;

  // --- derived geometry ---
  private mouthRadius = 0;
  private mouthPlaneY = 0;

  // "Shower head": deliberate spawn points spread across the mouth disc, spaced
  // >= a diameter apart, cycled so the whole opening feeds at once. A single
  // central spawn point throttles the pour to the time one ball takes to clear
  // its own diameter (~15/s); spreading across the disc unlocks the mouth's real
  // throughput (dozens/s), which the marquee full pour needs.
  private spawnPX: Float32Array = new Float32Array(1);
  private spawnPZ: Float32Array = new Float32Array(1);
  private nSpawnPoints = 1;
  private spawnCursor = 0;

  // --- spatial hash (uniform grid, cell = 1 diameter) ---
  private cell = 0;
  private nx = 0;
  private ny = 0;
  private nz = 0;
  private minX = 0;
  private minY = 0;
  private minZ = 0;
  private cellStart: Int32Array = new Int32Array(1);
  private cellCount: Int32Array = new Int32Array(1);
  private cursor: Int32Array = new Int32Array(1);
  private sorted: Int32Array = new Int32Array(1);
  private ballCell: Int32Array = new Int32Array(1);

  private accumulator = 0;

  // Instrumentation for the bench HUD.
  lastSubsteps = 0;

  constructor(params: PhysicsParams, rng: Rng) {
    this.params = { ...params };
    this.rng = rng;
    const n = params.maxBalls;
    this.posX = new Float32Array(n);
    this.posY = new Float32Array(n);
    this.posZ = new Float32Array(n);
    this.prevX = new Float32Array(n);
    this.prevY = new Float32Array(n);
    this.prevZ = new Float32Array(n);
    this.velX = new Float32Array(n);
    this.velY = new Float32Array(n);
    this.velZ = new Float32Array(n);
    this.qx = new Float32Array(n);
    this.qy = new Float32Array(n);
    this.qz = new Float32Array(n);
    this.qw = new Float32Array(n);
    this.wx = new Float32Array(n);
    this.wy = new Float32Array(n);
    this.wz = new Float32Array(n);
    this.sleepCount = new Int32Array(n);
    this.anchorX = new Float32Array(n);
    this.anchorY = new Float32Array(n);
    this.anchorZ = new Float32Array(n);
    this.entered = new Uint8Array(n);
    this.asleep = new Uint8Array(n);
    this.contactPressure = new Float32Array(n);
    this.meltScratch = new Int32Array(n);
    this.ballCell = new Int32Array(n);
    this.sorted = new Int32Array(n);
    this.rebuildGrid();
  }

  // ---- configuration -------------------------------------------------------

  /**
   * Patch feel parameters live. `maxBalls` is deliberately not patchable: it is
   * the SoA buffer capacity, fixed at construction — growing it here would let
   * spawn() write past every array.
   */
  setParams(patch: Partial<Omit<PhysicsParams, 'maxBalls'>>): void {
    const before = this.params;
    this.params = { ...before, ...patch };
    // Radius / container / mouth changes reshape the grid + mouth geometry.
    if (
      patch.radius !== undefined ||
      patch.containerR !== undefined ||
      patch.mouthRadiusScale !== undefined
    ) {
      this.rebuildGrid();
    }
  }

  setNoSleep(v: boolean): void {
    this.noSleep = v;
  }

  private rebuildGrid(): void {
    const { radius, containerR, mouthRadiusScale } = this.params;
    const mouth = mouthGeometry(radius, containerR, mouthRadiusScale);
    this.mouthRadius = mouth.mouthRadius;
    this.mouthPlaneY = mouth.mouthPlaneY;

    this.cell = 2 * radius; // one diameter
    // Defensive cap on the uniform grid: a pathologically small radius (the
    // extreme-ratio sand pairs never reach the solver, but guard the allocation
    // regardless) would size the grid to billions of cells and throw on the
    // Int32Array. Coarsen the cell until the count is bounded; every real ball
    // radius yields a few thousand cells and never trips the cap, so the normal
    // grid is unchanged.
    const MAX_CELLS = 4_000_000;
    let nx = 1;
    let ny = 1;
    let nz = 1;
    for (let guard = 0; guard < 64; guard++) {
      const margin = this.cell;
      this.minX = -(containerR + margin);
      this.minY = -(containerR + margin);
      this.minZ = -(containerR + margin);
      const maxX = containerR + margin;
      const maxY = SPAWN_Y + margin;
      const maxZ = containerR + margin;
      nx = Math.max(1, Math.ceil((maxX - this.minX) / this.cell));
      ny = Math.max(1, Math.ceil((maxY - this.minY) / this.cell));
      nz = Math.max(1, Math.ceil((maxZ - this.minZ) / this.cell));
      if (nx * ny * nz <= MAX_CELLS) break;
      this.cell *= Math.cbrt((nx * ny * nz) / MAX_CELLS) * 1.05; // coarsen + a hair
    }
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    const nCells = this.nx * this.ny * this.nz;
    this.cellStart = new Int32Array(nCells + 1);
    this.cellCount = new Int32Array(nCells);
    this.cursor = new Int32Array(nCells);
    this.computeSpawnPoints();
  }

  private computeSpawnPoints(): void {
    const r = this.params.radius;
    const usable = Math.max(0, this.mouthRadius - r * 1.02);
    const spacing = 2.05 * r; // a diameter + a hair, so points never pre-overlap
    const px: number[] = [0];
    const pz: number[] = [0];
    for (let ringR = spacing; ringR <= usable + 1e-6; ringR += spacing) {
      const n = Math.max(1, Math.floor((2 * Math.PI * ringR) / spacing));
      const phase = ringR * 7.13; // decorrelate rings so points don't line up
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n + phase;
        px.push(Math.cos(a) * ringR);
        pz.push(Math.sin(a) * ringR);
      }
    }
    this.spawnPX = Float32Array.from(px);
    this.spawnPZ = Float32Array.from(pz);
    this.nSpawnPoints = px.length;
    this.spawnCursor = 0;
  }

  // ---- spawning / removal --------------------------------------------------

  /**
   * Spawn one ball at the spout. Returns its index, or -1 if the buffer is full,
   * the container has reached the admission ceiling, or the spout is still
   * occupied (which naturally rate-limits the pour to the physical throughput of
   * the opening and prevents spawn-overlap explosions).
   */
  spawn(): number {
    if (this.count >= this.params.maxBalls) return -1;
    if (this.packingFraction >= PACK_CEILING) return -1; // container is full — refuse
    const r = this.params.radius;
    const jitterR = this.params.spawnJitter * 0.4 * r; // per-point life, keeps points distinct
    // A shallow sub-diameter clearance: a small initial overlap is cleaned up by
    // the first solve, and the shower-head points are spaced so they don't
    // pre-overlap. Only spout-column balls (still near the opening) can block.
    const clearDist = 1.6 * r;
    const clear2 = clearDist * clearDist;

    // Walk the shower-head points from the rotating cursor until one is clear.
    let sx = 0;
    let sz = 0;
    let found = false;
    for (let attempt = 0; attempt < this.nSpawnPoints; attempt++) {
      const idx = (this.spawnCursor + attempt) % this.nSpawnPoints;
      const ang = this.rng() * Math.PI * 2;
      const jr = Math.sqrt(this.rng()) * jitterR;
      const cx = this.spawnPX[idx] + Math.cos(ang) * jr;
      const cz = this.spawnPZ[idx] + Math.sin(ang) * jr;
      let clear = true;
      for (let j = 0; j < this.count; j++) {
        if (this.posY[j] < this.mouthPlaneY) continue; // only the spout column matters
        const dx = this.posX[j] - cx;
        const dy = this.posY[j] - SPAWN_Y;
        const dz = this.posZ[j] - cz;
        if (dx * dx + dy * dy + dz * dz < clear2) { clear = false; break; }
      }
      if (clear) { sx = cx; sz = cz; this.spawnCursor = (idx + 1) % this.nSpawnPoints; found = true; break; }
    }
    if (!found) return -1; // whole opening is momentarily occupied

    const i = this.count++;
    this.posX[i] = sx;
    this.posY[i] = SPAWN_Y;
    this.posZ[i] = sz;
    this.prevX[i] = sx;
    this.prevY[i] = SPAWN_Y;
    this.prevZ[i] = sz;
    this.velX[i] = (this.rng() - 0.5) * 0.15;
    this.velY[i] = SPAWN_VY;
    this.velZ[i] = (this.rng() - 0.5) * 0.15;
    // Random orientation so continents face different ways.
    this.randomQuat(i);
    // Readable tumble: a slow random spin.
    const spin = 1.2;
    this.wx[i] = (this.rng() - 0.5) * spin;
    this.wy[i] = (this.rng() - 0.5) * spin;
    this.wz[i] = (this.rng() - 0.5) * spin;
    this.sleepCount[i] = 0;
    this.anchorX[i] = sx;
    this.anchorY[i] = SPAWN_Y;
    this.anchorZ[i] = sz;
    this.entered[i] = 0;
    this.asleep[i] = 0;
    return i;
  }

  /**
   * Remove the `k` newest balls (stack pop), waking each removed ball's
   * neighbourhood so nothing is left floating. Non-removed balls keep their
   * indices. `outRemoved` receives the removed indices newest-first and
   * `outPositions` the matching x,y,z (3 floats per removal, captured before
   * removal) — the scene reads `outPositions` to place a pop per removal, since
   * the slot the index named is gone once `count` drops. Returns the count.
   * Fractional `k` (a rate x dt caller) is floored — removal is whole-ball.
   */
  drainNewest(k: number, outRemoved?: Int32Array, outPositions?: Float32Array): number {
    k = Math.floor(k);
    let removed = 0;
    for (let c = 0; c < k && this.count > 0; c++) {
      const i = this.count - 1;
      if (outRemoved && removed < outRemoved.length) outRemoved[removed] = i;
      if (outPositions && (removed + 1) * 3 <= outPositions.length) {
        outPositions[removed * 3] = this.posX[i];
        outPositions[removed * 3 + 1] = this.posY[i];
        outPositions[removed * 3 + 2] = this.posZ[i];
      }
      this.wakeNeighbourhood(this.posX[i], this.posY[i], this.posZ[i], 2.5 * this.params.radius * 2);
      if (this.entered[i]) this.enteredCount--;
      this.count--;
      removed++;
    }
    return removed;
  }

  /**
   * Remove up to `k` entered balls, lowest first, waking each removal's
   * neighbourhood so the pile above slumps into the gap (the melt beat). Returns
   * the number removed. `outRemoved`/`outPositions` report the removed balls
   * lowest-first — indices, and pre-removal x,y,z (3 floats each). After return
   * the indices are only bookkeeping (swap-with-last removal recycled those
   * slots); the scene reads `outPositions` for where to splash a removal.
   * Fractional `k` is floored. Melt in rate-limited batches (a few per frame):
   * the removal wake reaches ~2.5 diameters, so one oversized batch can briefly
   * strand sleepers above the wake front — a continuing melt self-heals as later
   * batches climb to them, but a single bulk gulp is not a supported pattern.
   */
  meltLowest(k: number, outRemoved?: Int32Array, outPositions?: Float32Array): number {
    let m = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.entered[i]) this.meltScratch[m++] = i;
    }
    return this.removeLowestOf(m, k, outRemoved, outPositions);
  }

  /**
   * Remove up to `maxK` entered balls whose underside dips into the liquid
   * (`y - radius <= levelY`), lowest first, with the same wake + out-param
   * contract as `meltLowest` (read `outPositions`, not the recycled indices).
   * The liquid level is the caller's to compute (the cap-height math lives in
   * the logic layer). Returns the number removed. Only `entered` balls are
   * candidates by design: a ball still in the spout column is outside the glass,
   * and consuming it there would splash above the mouth — it melts a beat later,
   * once it falls through and enters.
   */
  consumeTouchingLiquid(
    levelY: number,
    maxK: number,
    outRemoved?: Int32Array,
    outPositions?: Float32Array,
  ): number {
    const r = this.params.radius;
    let m = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.entered[i] && this.posY[i] - r <= levelY) this.meltScratch[m++] = i;
    }
    return this.removeLowestOf(m, maxK, outRemoved, outPositions);
  }

  /**
   * Shared removal core for melt/consume: `meltScratch[0..m)` holds candidate
   * indices; select the `k` lowest by height, capture each position + index for
   * the caller, wake each neighbourhood, then remove them. Removal is
   * swap-with-last (dense, zero realloc); victims are removed in descending
   * index order so a swap never disturbs a not-yet-removed victim.
   */
  private removeLowestOf(
    m: number,
    k: number,
    outRemoved?: Int32Array,
    outPositions?: Float32Array,
  ): number {
    k = Math.floor(k);
    if (k > m) k = m;
    if (k <= 0) return 0;
    const scratch = this.meltScratch;

    // Partial selection sort: pull the k lowest-posY candidates to the front of
    // meltScratch[0..k), ascending by height. In place, no allocation.
    for (let a = 0; a < k; a++) {
      let best = a;
      let bestY = this.posY[scratch[a]];
      for (let b = a + 1; b < m; b++) {
        const y = this.posY[scratch[b]];
        if (y < bestY) { best = b; bestY = y; }
      }
      if (best !== a) {
        const t = scratch[a];
        scratch[a] = scratch[best];
        scratch[best] = t;
      }
    }

    // Capture positions + indices and wake neighbourhoods BEFORE any removal,
    // while every victim's slot still holds its own data. `outPositions` is the
    // durable record — the swap-remove pass below overwrites victim slots.
    const wakeR = 2.5 * this.params.radius * 2;
    for (let c = 0; c < k; c++) {
      const idx = scratch[c];
      if (outRemoved && c < outRemoved.length) outRemoved[c] = idx;
      if (outPositions && (c + 1) * 3 <= outPositions.length) {
        outPositions[c * 3] = this.posX[idx];
        outPositions[c * 3 + 1] = this.posY[idx];
        outPositions[c * 3 + 2] = this.posZ[idx];
      }
      this.wakeNeighbourhood(this.posX[idx], this.posY[idx], this.posZ[idx], wakeR);
    }

    // Sort the k victim indices descending (insertion sort; k is small), then
    // swap-remove in that order so each swap only ever moves a survivor.
    for (let a = 1; a < k; a++) {
      const v = scratch[a];
      let b = a - 1;
      while (b >= 0 && scratch[b] < v) { scratch[b + 1] = scratch[b]; b--; }
      scratch[b + 1] = v;
    }
    for (let c = 0; c < k; c++) this.swapRemove(scratch[c]);
    return k;
  }

  /**
   * Remove the ball at `idx` by moving the last live ball into its slot. The
   * moved ball keeps its position (relocation is index bookkeeping, not a
   * physical nudge) but changes index, so it is woken: the renderer rewrites the
   * instance matrix only for awake balls, and a relocated sleeper would
   * otherwise keep drawing the removed ball's transform at its new slot.
   */
  private swapRemove(idx: number): void {
    if (this.entered[idx]) this.enteredCount--;
    const last = this.count - 1;
    if (idx !== last) {
      this.posX[idx] = this.posX[last];
      this.posY[idx] = this.posY[last];
      this.posZ[idx] = this.posZ[last];
      this.prevX[idx] = this.prevX[last];
      this.prevY[idx] = this.prevY[last];
      this.prevZ[idx] = this.prevZ[last];
      this.velX[idx] = this.velX[last];
      this.velY[idx] = this.velY[last];
      this.velZ[idx] = this.velZ[last];
      this.qx[idx] = this.qx[last];
      this.qy[idx] = this.qy[last];
      this.qz[idx] = this.qz[last];
      this.qw[idx] = this.qw[last];
      this.wx[idx] = this.wx[last];
      this.wy[idx] = this.wy[last];
      this.wz[idx] = this.wz[last];
      this.contactPressure[idx] = this.contactPressure[last];
      this.entered[idx] = this.entered[last];
      // Woken at its new slot; reseat the sleep anchor to where it actually is.
      this.asleep[idx] = 0;
      this.sleepCount[idx] = 0;
      this.anchorX[idx] = this.posX[idx];
      this.anchorY[idx] = this.posY[idx];
      this.anchorZ[idx] = this.posZ[idx];
    }
    this.count--;
  }

  reset(): void {
    this.count = 0;
    this.enteredCount = 0;
    this.accumulator = 0;
  }

  /**
   * Bench-only: place up to `n` balls in a loose grid inside the shell so the
   * worst-case solve (2k awake) can be measured without waiting out the
   * rate-limited pour. Balls are `entered` and awake; call `setNoSleep(true)` to
   * hold them awake for the measurement.
   */
  prefill(n: number): void {
    this.reset();
    if (n > this.params.maxBalls) n = this.params.maxBalls; // capacity-clamped
    const r = this.params.radius;
    const R = this.params.containerR;
    const step = 2 * r * 1.03;
    const lo = -R + r;
    let placed = 0;
    for (let y = lo; y <= R - r && placed < n; y += step) {
      for (let x = lo; x <= R - r && placed < n; x += step) {
        for (let z = lo; z <= R - r && placed < n; z += step) {
          if (x * x + y * y + z * z > (R - r) * (R - r)) continue;
          const i = placed++;
          this.posX[i] = x + (this.rng() - 0.5) * r * 0.1;
          this.posY[i] = y + (this.rng() - 0.5) * r * 0.1;
          this.posZ[i] = z + (this.rng() - 0.5) * r * 0.1;
          this.prevX[i] = this.posX[i];
          this.prevY[i] = this.posY[i];
          this.prevZ[i] = this.posZ[i];
          this.velX[i] = 0;
          this.velY[i] = 0;
          this.velZ[i] = 0;
          this.randomQuat(i);
          this.wx[i] = (this.rng() - 0.5) * 0.6;
          this.wy[i] = (this.rng() - 0.5) * 0.6;
          this.wz[i] = (this.rng() - 0.5) * 0.6;
          this.sleepCount[i] = 0;
          this.anchorX[i] = this.posX[i];
          this.anchorY[i] = this.posY[i];
          this.anchorZ[i] = this.posZ[i];
          this.entered[i] = 1;
          this.asleep[i] = 0;
        }
      }
    }
    this.count = placed;
    this.enteredCount = placed; // every prefilled ball is entered
  }

  private randomQuat(i: number): void {
    // Uniform random unit quaternion (Shoemake).
    const u1 = this.rng();
    const u2 = this.rng();
    const u3 = this.rng();
    const s1 = Math.sqrt(1 - u1);
    const s2 = Math.sqrt(u1);
    this.qx[i] = s1 * Math.sin(2 * Math.PI * u2);
    this.qy[i] = s1 * Math.cos(2 * Math.PI * u2);
    this.qz[i] = s2 * Math.sin(2 * Math.PI * u3);
    this.qw[i] = s2 * Math.cos(2 * Math.PI * u3);
  }

  private wake(i: number): void {
    if (!this.asleep[i]) return;
    this.asleep[i] = 0;
    this.sleepCount[i] = 0;
    this.anchorX[i] = this.posX[i];
    this.anchorY[i] = this.posY[i];
    this.anchorZ[i] = this.posZ[i];
  }

  private wakeNeighbourhood(x: number, y: number, z: number, radius: number): void {
    const r2 = radius * radius;
    // Not a hot path (removals are occasional); a linear scan is fine and robust
    // to a stale hash.
    for (let j = 0; j < this.count; j++) {
      if (!this.asleep[j]) continue;
      const dx = this.posX[j] - x;
      const dy = this.posY[j] - y;
      const dz = this.posZ[j] - z;
      if (dx * dx + dy * dy + dz * dz < r2) this.wake(j);
    }
  }

  // ---- stepping ------------------------------------------------------------

  update(frameDt: number): void {
    const dt = Math.min(frameDt, MAX_SUBSTEPS * DT_SUB);
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= DT_SUB && steps < MAX_SUBSTEPS) {
      this.substep(DT_SUB);
      this.accumulator -= DT_SUB;
      steps++;
    }
    this.lastSubsteps = steps;
  }

  private substep(dt: number): void {
    const p = this.params;
    if (this.noSleep) {
      for (let i = 0; i < this.count; i++) this.asleep[i] = 0;
    }

    // 1. Integrate awake balls (semi-implicit Euler) and flag entry.
    const damp = Math.max(0, 1 - p.linearDamping * dt);
    const g = p.gravity;
    const R = p.containerR;
    for (let i = 0; i < this.count; i++) {
      if (this.asleep[i]) continue;
      this.contactPressure[i] = 0; // rebuilt by this substep's final iteration
      this.velY[i] -= g * dt;
      this.velX[i] *= damp;
      this.velY[i] *= damp;
      this.velZ[i] *= damp;
      this.prevX[i] = this.posX[i];
      this.prevY[i] = this.posY[i];
      this.prevZ[i] = this.posZ[i];
      this.posX[i] += this.velX[i] * dt;
      this.posY[i] += this.velY[i] * dt;
      this.posZ[i] += this.velZ[i] * dt;
      if (!this.entered[i]) {
        const inside = this.posX[i] * this.posX[i] + this.posY[i] * this.posY[i] + this.posZ[i] * this.posZ[i] < R * R;
        if (this.posY[i] < this.mouthPlaneY || inside) {
          this.entered[i] = 1;
          this.enteredCount++;
        }
      }
    }

    // 2. Rebuild the hash from ALL live balls (awake + asleep colliders).
    this.buildHash();

    // 3. Gauss-Seidel constraint solve. Position projection every iteration;
    //    velocity restitution/friction only on the final one.
    const iters = p.iterations;
    for (let it = 0; it < iters; it++) {
      this.solveIteration(it === iters - 1);
    }

    // 4. Sleep bookkeeping + spin easing + orientation integration.
    this.finalize(dt);
  }

  private buildHash(): void {
    const { nx, ny, nz, cell, minX, minY, minZ } = this;
    const nCells = nx * ny * nz;
    this.cellCount.fill(0);
    const nxny = nx * ny;
    for (let i = 0; i < this.count; i++) {
      let ix = ((this.posX[i] - minX) / cell) | 0;
      let iy = ((this.posY[i] - minY) / cell) | 0;
      let iz = ((this.posZ[i] - minZ) / cell) | 0;
      if (ix < 0) ix = 0;
      else if (ix >= nx) ix = nx - 1;
      if (iy < 0) iy = 0;
      else if (iy >= ny) iy = ny - 1;
      if (iz < 0) iz = 0;
      else if (iz >= nz) iz = nz - 1;
      const c = ix + iy * nx + iz * nxny;
      this.ballCell[i] = c;
      this.cellCount[c]++;
    }
    let acc = 0;
    for (let c = 0; c < nCells; c++) {
      this.cellStart[c] = acc;
      acc += this.cellCount[c];
      this.cursor[c] = this.cellStart[c];
    }
    this.cellStart[nCells] = acc;
    for (let i = 0; i < this.count; i++) {
      const c = this.ballCell[i];
      this.sorted[this.cursor[c]++] = i;
    }
  }

  private solveIteration(applyVelocity: boolean): void {
    const p = this.params;
    const r = p.radius;
    const R = p.containerR;
    const minDist = 2 * r;
    const minDist2 = minDist * minDist;
    const slop = 0.004 * r; // residual overlap left uncorrected → kills pile jitter
    const wallLimit = R - r;
    const e = p.restitution;
    const friction = p.tangentialDamping;
    const maxCorr = r; // clamp a single correction so a big overlap can't fling
    const { nx, ny, nz } = this;
    const nxny = nx * ny;

    for (let i = 0; i < this.count; i++) {
      if (this.asleep[i]) continue; // asleep balls never drive a contact

      const awakeSpeed2 = this.velX[i] * this.velX[i] + this.velY[i] * this.velY[i] + this.velZ[i] * this.velZ[i];
      const cx = this.ballCell[i] % nx;
      const cy = ((this.ballCell[i] / nx) | 0) % ny;
      const cz = (this.ballCell[i] / nxny) | 0;

      // --- ball-ball via 27-neighbourhood ---
      for (let dz = -1; dz <= 1; dz++) {
        const gz = cz + dz;
        if (gz < 0 || gz >= nz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const gy = cy + dy;
          if (gy < 0 || gy >= ny) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const gx = cx + dx;
            if (gx < 0 || gx >= nx) continue;
            const c = gx + gy * nx + gz * nxny;
            const end = this.cellStart[c + 1];
            for (let s = this.cellStart[c]; s < end; s++) {
              const j = this.sorted[s];
              if (j === i) continue;
              const jAsleep = this.asleep[j] === 1;
              // awake-awake pairs: resolve once, from the lower index.
              if (!jAsleep && j < i) continue;

              let ddx = this.posX[i] - this.posX[j];
              let ddy = this.posY[i] - this.posY[j];
              let ddz = this.posZ[i] - this.posZ[j];
              const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d2 >= minDist2 || d2 < 1e-12) continue;
              const dist = Math.sqrt(d2);
              const inv = 1 / dist;
              const nX = ddx * inv;
              const nY = ddy * inv;
              const nZ = ddz * inv;
              const rawOverlap = minDist - dist;
              if (applyVelocity) {
                // Final iteration doubles as the residual-pressure probe
                // (pre-correction): a converged pile reads ~slop here.
                if (rawOverlap > this.contactPressure[i]) this.contactPressure[i] = rawOverlap;
                if (!jAsleep && rawOverlap > this.contactPressure[j]) this.contactPressure[j] = rawOverlap;
              }
              let overlap = rawOverlap - slop;
              if (overlap <= 0) continue;
              if (overlap > maxCorr) overlap = maxCorr;

              // Position projection. A sleeper is immovable: the awake ball
              // takes the whole correction. Two awake balls split it.
              const wi = jAsleep ? 1 : 0.5;
              const wj = jAsleep ? 0 : 0.5;
              this.posX[i] += nX * overlap * wi;
              this.posY[i] += nY * overlap * wi;
              this.posZ[i] += nZ * overlap * wi;
              if (wj > 0) {
                this.posX[j] -= nX * overlap * wj;
                this.posY[j] -= nY * overlap * wj;
                this.posZ[j] -= nZ * overlap * wj;
              }

              // Wake a sleeper only when the awake ball hitting it is actually
              // moving (an impact), not when it merely leans under load.
              if (jAsleep && awakeSpeed2 > WAKE_SPEED * WAKE_SPEED) this.wake(j);

              if (!applyVelocity) continue;
              // Velocity: restitution + tangential friction along the contact.
              const rvx = this.velX[i] - (jAsleep ? 0 : this.velX[j]);
              const rvy = this.velY[i] - (jAsleep ? 0 : this.velY[j]);
              const rvz = this.velZ[i] - (jAsleep ? 0 : this.velZ[j]);
              const vn = rvx * nX + rvy * nY + rvz * nZ;
              if (vn < 0) {
                const jn = -(1 + e) * vn;
                const svi = jAsleep ? 1 : 0.5;
                const svj = jAsleep ? 0 : 0.5;
                this.velX[i] += nX * jn * svi;
                this.velY[i] += nY * jn * svi;
                this.velZ[i] += nZ * jn * svi;
                // tangential
                const tvx = rvx - vn * nX;
                const tvy = rvy - vn * nY;
                const tvz = rvz - vn * nZ;
                this.velX[i] -= tvx * friction * svi;
                this.velY[i] -= tvy * friction * svi;
                this.velZ[i] -= tvz * friction * svi;
                if (svj > 0) {
                  this.velX[j] -= nX * jn * svj;
                  this.velY[j] -= nY * jn * svj;
                  this.velZ[j] -= nZ * jn * svj;
                  this.velX[j] += tvx * friction * svj;
                  this.velY[j] += tvy * friction * svj;
                  this.velZ[j] += tvz * friction * svj;
                }
              }
            }
          }
        }
      }

      // --- container wall (entered balls only) ---
      if (this.entered[i]) {
        const px = this.posX[i];
        const py = this.posY[i];
        const pz = this.posZ[i];
        const d2 = px * px + py * py + pz * pz;
        if (d2 > wallLimit * wallLimit && d2 > 1e-12) {
          const dist = Math.sqrt(d2);
          const inv = 1 / dist;
          const uX = px * inv;
          const uY = py * inv;
          const uZ = pz * inv;
          // The wall always fully contains (no cap): a jammed ball squeezed
          // outward by a big neighbour must be projected all the way back inside,
          // or it can end a substep out of bounds and sleep there.
          const overlap = dist - wallLimit;
          if (applyVelocity && overlap > this.contactPressure[i]) this.contactPressure[i] = overlap;
          this.posX[i] -= uX * overlap;
          this.posY[i] -= uY * overlap;
          this.posZ[i] -= uZ * overlap;
          if (applyVelocity) {
            const vn = this.velX[i] * uX + this.velY[i] * uY + this.velZ[i] * uZ;
            if (vn > 0) {
              const jn = -(1 + e) * vn;
              this.velX[i] += uX * jn;
              this.velY[i] += uY * jn;
              this.velZ[i] += uZ * jn;
              const tvx = this.velX[i] - (this.velX[i] * uX + this.velY[i] * uY + this.velZ[i] * uZ) * uX;
              const tvy = this.velY[i] - (this.velX[i] * uX + this.velY[i] * uY + this.velZ[i] * uZ) * uY;
              const tvz = this.velZ[i] - (this.velX[i] * uX + this.velY[i] * uY + this.velZ[i] * uZ) * uZ;
              this.velX[i] -= tvx * friction;
              this.velY[i] -= tvy * friction;
              this.velZ[i] -= tvz * friction;
            }
          }
        }
      }
    }
  }

  private finalize(dt: number): void {
    const p = this.params;
    const invDt = 1 / dt;
    const driftEps = p.sleepEpsScale * p.radius; // net-drift tolerance over the window
    // Per-substep spin decay factor that reaches ~0 across spinEaseTime.
    const easeFactor = Math.exp((-dt / Math.max(p.spinEaseTime, 1e-3)) * 3);
    const gentleSpin = Math.exp(-dt * 0.15); // barely-there drag while tumbling
    // Resting grip: when a ball's instantaneous motion is low, damp its velocity
    // hard so it actually comes to rest (kills the slow creep a low-friction
    // pile would otherwise sustain) WITHOUT damping the fast fall.
    const gripBand = 0.18; // instantaneous speed (units/s) below which to grip
    const gripFactor = 0.82;
    const pressGate = OVERLAP_GATE_K * p.radius;

    for (let i = 0; i < this.count; i++) {
      if (this.asleep[i]) continue;

      // Instantaneous speed (this substep's displacement) drives the grip only.
      const dxp = this.posX[i] - this.prevX[i];
      const dyp = this.posY[i] - this.prevY[i];
      const dzp = this.posZ[i] - this.prevZ[i];
      const speed = Math.sqrt(dxp * dxp + dyp * dyp + dzp * dzp) * invDt;
      if (this.entered[i] && speed < gripBand) {
        this.velX[i] *= gripFactor;
        this.velY[i] *= gripFactor;
        this.velZ[i] *= gripFactor;
      }

      // Settle signal = net drift from the window anchor. A ball that jostles in
      // place stays near its anchor and counts as settling even if its velocity
      // never calms; a ball genuinely moving keeps resetting the anchor.
      const adx = this.posX[i] - this.anchorX[i];
      const ady = this.posY[i] - this.anchorY[i];
      const adz = this.posZ[i] - this.anchorZ[i];
      const settling = adx * adx + ady * ady + adz * adz <= driftEps * driftEps;

      if (settling) {
        this.sleepCount[i]++;
        // Ease spin to zero across the settling window — so a ball's tumble is
        // gone by the time it sleeps (a settled pile of spinning balls is broken).
        this.wx[i] *= easeFactor;
        this.wy[i] *= easeFactor;
        this.wz[i] *= easeFactor;
      } else {
        this.sleepCount[i] = 0;
        this.anchorX[i] = this.posX[i];
        this.anchorY[i] = this.posY[i];
        this.anchorZ[i] = this.posZ[i];
        // Persistent tumble while genuinely moving (falling, rolling).
        this.wx[i] *= gentleSpin;
        this.wy[i] *= gentleSpin;
        this.wz[i] *= gentleSpin;
      }
      this.integrateOrientation(i, dt);

      // Containment gate: never sleep a ball that is out of bounds. In a jam a
      // ball can jostle in place (settling=true) while momentarily squeezed
      // outside the wall; sleeping it there freezes an escaped ball forever.
      const R = p.containerR;
      const r = p.radius;
      const d2 = this.posX[i] * this.posX[i] + this.posY[i] * this.posY[i] + this.posZ[i] * this.posZ[i];
      const contained = d2 <= (R - r + 0.003) * (R - r + 0.003);

      // The pressure gate is a veto on the sleep TRANSITION only — it neither
      // pauses nor resets the drift countdown. Static-load piles spike residual
      // pressure transiently while the solver converges (a reset here starves
      // sleep in deep piles); a structurally over-packed ball is above the gate
      // EVERY substep, so the veto holds it awake until the pile genuinely
      // relaxes. Interpenetration deeper than the gate can never be frozen in.
      if (
        !this.noSleep &&
        this.entered[i] &&
        settling &&
        contained &&
        this.sleepCount[i] >= p.sleepFrames &&
        this.contactPressure[i] <= pressGate
      ) {
        this.asleep[i] = 1;
        this.velX[i] = 0;
        this.velY[i] = 0;
        this.velZ[i] = 0;
        this.wx[i] = 0;
        this.wy[i] = 0;
        this.wz[i] = 0;
      }
    }
  }

  private integrateOrientation(i: number, dt: number): void {
    const ox = this.wx[i];
    const oy = this.wy[i];
    const oz = this.wz[i];
    if (ox === 0 && oy === 0 && oz === 0) return;
    const qx = this.qx[i];
    const qy = this.qy[i];
    const qz = this.qz[i];
    const qw = this.qw[i];
    const h = 0.5 * dt;
    const nx = qx + h * (ox * qw + oy * qz - oz * qy);
    const ny = qy + h * (-ox * qz + oy * qw + oz * qx);
    const nz = qz + h * (ox * qy - oy * qx + oz * qw);
    const nw = qw + h * (-ox * qx - oy * qy - oz * qz);
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
    this.qx[i] = nx * inv;
    this.qy[i] = ny * inv;
    this.qz[i] = nz * inv;
    this.qw[i] = nw * inv;
  }

  // ---- readouts ------------------------------------------------------------

  get awakeCount(): number {
    let a = 0;
    for (let i = 0; i < this.count; i++) if (!this.asleep[i]) a++;
    return a;
  }

  get asleepCount(): number {
    return this.count - this.awakeCount;
  }

  /** Packing fraction of entered balls vs container volume (R = containerR). */
  get packingFraction(): number {
    const r = this.params.radius;
    const R = this.params.containerR;
    return (this.enteredCount * r * r * r) / (R * R * R);
  }

  getMouthRadius(): number {
    return this.mouthRadius;
  }

  /** True if any live ball holds a non-finite coordinate (blow-up guard). */
  hasNaN(): boolean {
    for (let i = 0; i < this.count; i++) {
      if (!Number.isFinite(this.posX[i]) || !Number.isFinite(this.posY[i]) || !Number.isFinite(this.posZ[i])) {
        return true;
      }
    }
    return false;
  }
}
