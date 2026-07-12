/**
 * Seeded solver checks for the "how many fit?" pour. Everything is deterministic
 * (fixed RNG seeds); no assertion may flake. Radii below name the three shipped
 * cases: A = Earths into Jupiter (~11 across), B = Moons into Earth, C = the jam
 * worst case at the boulder boundary (~3 across). The container inner radius is
 * 1 studio unit throughout; a ball radius is in the same units.
 *
 * The load-bearing long sims are the ratchet pin (RATCHET) and the seed-777
 * case-A matrix (MATRIX) — those stay full-length; the other pours are trimmed.
 */
import { describe, it, expect } from 'vitest';
import { SpherePhysics, defaultPhysicsParams, mouthGeometry, PACK_CEILING, type PhysicsParams } from './spherePhysics';
import { mulberry32 } from './rng';

const A = 0.0911; // case A: Earths -> Jupiter
const B = 0.2729; // case B: Moons -> Earth
const C = 0.322; // case C: jam worst case, boulder boundary
const R = 1; // container inner radius (studio unit)
const DT = 1 / 60; // frame step the app drives the solver at

function make(overrides: Partial<PhysicsParams> = {}, seed = 12345): SpherePhysics {
  return new SpherePhysics({ ...defaultPhysicsParams(A, 4096), ...overrides }, mulberry32(seed));
}

/** Pour up to `target` balls (spout clearance rate-limits), then settle. */
function pourAndSettle(sim: SpherePhysics, target: number, settleFrames = 900): SpherePhysics {
  let spawned = 0;
  let guard = 0;
  while (spawned < target && guard < 20000) {
    guard++;
    for (let s = 0; s < 3 && spawned < target; s++) {
      if (sim.spawn() >= 0) spawned++;
    }
    sim.update(DT);
  }
  for (let f = 0; f < settleFrames; f++) sim.update(DT);
  return sim;
}

/** Held pour at ~`rate`/s for `seconds` (fractional-accumulator, like the app). */
function pourRate(sim: SpherePhysics, seconds: number, rate: number): void {
  let acc = 0;
  const frames = Math.round(seconds * 60);
  for (let f = 0; f < frames; f++) {
    acc += rate * DT;
    while (acc >= 1) { sim.spawn(); acc -= 1; }
    sim.update(DT);
  }
}

function settle(sim: SpherePhysics, seconds: number): void {
  const frames = Math.round(seconds * 60);
  for (let f = 0; f < frames; f++) sim.update(DT);
}

/** Worst `(|p| + r) - R` over entered balls (how far any ball pokes the shell). */
function maxRadialExcess(sim: SpherePhysics): number {
  const r = sim.params.radius;
  let worst = 0;
  for (let i = 0; i < sim.count; i++) {
    if (!sim.entered[i]) continue;
    const d = Math.hypot(sim.posX[i], sim.posY[i], sim.posZ[i]);
    worst = Math.max(worst, d + r - sim.params.containerR);
  }
  return worst;
}

function maxSpeed(sim: SpherePhysics): number {
  let m = 0;
  for (let i = 0; i < sim.count; i++) {
    const s = Math.hypot(sim.velX[i], sim.velY[i], sim.velZ[i]);
    if (s > m) m = s;
  }
  return m;
}

/** Deepest sleeper-sleeper interpenetration (the ratchet invariant guards this). */
function worstSleeperOverlap(sim: SpherePhysics): number {
  const r = sim.params.radius;
  let worst = 0;
  for (let i = 0; i < sim.count; i++) {
    if (!sim.asleep[i]) continue;
    for (let j = i + 1; j < sim.count; j++) {
      if (!sim.asleep[j]) continue;
      const d = Math.hypot(sim.posX[i] - sim.posX[j], sim.posY[i] - sim.posY[j], sim.posZ[i] - sim.posZ[j]);
      if (2 * r - d > worst) worst = 2 * r - d;
    }
  }
  return worst;
}

/** Independent recompute of the entered count, to catch incremental-counter drift. */
function scanEnteredCount(sim: SpherePhysics): number {
  let c = 0;
  for (let i = 0; i < sim.count; i++) if (sim.entered[i]) c++;
  return c;
}

/**
 * Count asleep balls with no support: not resting on the shell's lower hemisphere
 * and no ball touching from below. A crude test — a handful of purely side-wedged
 * balls can read as unsupported — so callers demand essentially none, not zero.
 */
function countFloaters(sim: SpherePhysics): number {
  const r = sim.params.radius;
  const contact = 2 * r + 0.05 * r;
  let floaters = 0;
  for (let i = 0; i < sim.count; i++) {
    if (!sim.asleep[i]) continue;
    const px = sim.posX[i];
    const py = sim.posY[i];
    const pz = sim.posZ[i];
    const d = Math.hypot(px, py, pz);
    const onWall = d + r > sim.params.containerR - 0.02 * r && py < 0.2;
    if (onWall) continue;
    let supported = false;
    for (let j = 0; j < sim.count; j++) {
      if (j === i) continue;
      if (sim.posY[j] >= py - 0.05 * r) continue; // must be below
      const dist = Math.hypot(px - sim.posX[j], py - sim.posY[j], pz - sim.posZ[j]);
      if (dist <= contact) { supported = true; break; }
    }
    if (!supported) floaters++;
  }
  return floaters;
}

// Tests 1 and 2 both inspect the same settled case-A pile; build it once (read
// only — neither test mutates it).
let _a500: SpherePhysics | null = null;
function settledA500(): SpherePhysics {
  if (!_a500) _a500 = pourAndSettle(make(), 500);
  return _a500;
}

describe('containment + settle', () => {
  it('1. pours 500 (case A) and keeps every entered ball inside the shell', () => {
    const sim = settledA500();
    expect(sim.hasNaN()).toBe(false);
    expect(maxRadialExcess(sim)).toBeLessThanOrEqual(1e-3);
    expect(maxSpeed(sim)).toBeLessThan(1.0); // a resting pile, not a blow-up
  });

  it('2. the 500-ball pile reaches >=90% asleep by the horizon', () => {
    const sim = settledA500();
    expect(sim.asleepCount / sim.count).toBeGreaterThanOrEqual(0.9);
  });
});

describe('sleepers stay colliders', () => {
  it('3. a burst spawned onto a sleeping pile does not tunnel through it', () => {
    const sim = pourAndSettle(make(), 400);
    expect(sim.asleepCount).toBeGreaterThan(300);
    for (let f = 0; f < 240; f++) {
      for (let s = 0; s < 2; s++) sim.spawn();
      sim.update(DT);
    }
    for (let f = 0; f < 600; f++) sim.update(DT);
    // If sleepers had dropped out of the hash, the burst would fall through and
    // push the pile out of the shell.
    expect(sim.hasNaN()).toBe(false);
    expect(maxRadialExcess(sim)).toBeLessThan(3e-3);
  });
});

describe('drain wakes neighbours (no floaters)', () => {
  it('4. after draining into a settled pile, nothing hangs unsupported', () => {
    const sim = pourAndSettle(make(), 450);
    // The drain wake is load-bearing: pulling settled top balls must wake the
    // neighbourhood that rested against them. Without the wake call, removals
    // leave awakeCount flat (or lower) and this assertion fails.
    const awakeBefore = sim.awakeCount;
    sim.drainNewest(5);
    expect(sim.awakeCount).toBeGreaterThan(awakeBefore);
    for (let f = 0; f < 60; f++) {
      sim.drainNewest(3);
      sim.update(DT);
    }
    for (let f = 0; f < 700; f++) sim.update(DT);
    expect(sim.hasNaN()).toBe(false);
    expect(countFloaters(sim)).toBeLessThanOrEqual(2);
  });
});

describe('low-N jam band is stable (case C)', () => {
  it('5. ~30 chunky case-C balls settle without NaN or escaping', () => {
    const sim = make({ radius: C, sleepFrames: 40 });
    pourAndSettle(sim, 30, 1200);
    expect(sim.hasNaN()).toBe(false);
    expect(maxRadialExcess(sim)).toBeLessThan(3e-3);
    expect(maxSpeed(sim)).toBeLessThan(1.0);
  });
});

describe('sleep cannot freeze an over-packed pile (ratchet pin)', () => {
  // Pre-gate, this exact recipe measured packingFraction 4.5 "at rest" — balls
  // frozen into a container that physically holds ~30, interpenetration baked in
  // by immovable sleepers. Kept brutal: it fails without the pressure gate.
  it('6. a 60 s single-file case-C pour stays near physical packing', () => {
    const sim = make({ radius: C, sleepFrames: 40 });
    let acc = 0;
    for (let f = 0; f < 3600; f++) {
      acc += 80 * DT;
      while (acc >= 1) { sim.spawn(); acc -= 1; }
      sim.update(DT);
    }
    for (let f = 0; f < 720; f++) sim.update(DT);
    expect(sim.hasNaN()).toBe(false);
    expect(sim.packingFraction).toBeLessThan(0.72);
    // Sleepers never move, so sleeper-sleeper overlap can never exceed the gate a
    // ball slept under.
    expect(worstSleeperOverlap(sim)).toBeLessThan(0.36 * C);
  });
});

describe('case-A matrix (the port parity arbiter)', () => {
  it('7. seed 777, 60 s pour at 110/s + 12 s settle lands in band', () => {
    const sim = make({}, 777);
    pourRate(sim, 60, 110);
    settle(sim, 12);
    expect(sim.hasNaN()).toBe(false);
    const packing = sim.packingFraction;
    expect(packing).toBeGreaterThanOrEqual(0.53);
    expect(packing).toBeLessThanOrEqual(0.6);
    expect(sim.awakeCount).toBeLessThanOrEqual(5);
    expect(worstSleeperOverlap(sim)).toBeLessThan(0.36 * A);
  });
});

describe('case-B bounds', () => {
  it('8. pour + settle lands in the packing band with stability', () => {
    const sim = make({ radius: B }, 777);
    pourRate(sim, 20, 90);
    settle(sim, 12);
    expect(sim.hasNaN()).toBe(false);
    const packing = sim.packingFraction;
    expect(packing).toBeGreaterThanOrEqual(0.42);
    expect(packing).toBeLessThanOrEqual(0.65);
    expect(maxRadialExcess(sim)).toBeLessThan(3e-3);
  });
});

describe('case-C bounds', () => {
  it('9. packing band + near-still straggler bound', () => {
    const sim = make({ radius: C, sleepFrames: 40 }, 777);
    pourRate(sim, 25, 80);
    settle(sim, 12);
    expect(sim.hasNaN()).toBe(false);
    const packing = sim.packingFraction;
    expect(packing).toBeGreaterThanOrEqual(0.42);
    expect(packing).toBeLessThanOrEqual(0.65);
    expect(sim.awakeCount).toBeLessThanOrEqual(10);
    for (let i = 0; i < sim.count; i++) {
      if (sim.asleep[i]) continue;
      expect(Math.hypot(sim.velX[i], sim.velY[i], sim.velZ[i])).toBeLessThan(0.1);
    }
  });
});

describe('admission ceiling', () => {
  it('10. spawn refuses at the brim; a held pour never runs away', () => {
    const sim = make({}, 4242);
    pourRate(sim, 20, 110); // hold the pour well past the brim
    const brim = sim.packingFraction;
    expect(brim).toBeGreaterThanOrEqual(PACK_CEILING); // reached the ceiling
    expect(sim.spawn()).toBe(-1); // and now refuses
    // Continued held pouring admits at most ~one more ball as the pile settles;
    // packing does not ratchet (the pre-ceiling bug ran past 1.0).
    pourRate(sim, 15, 110);
    const oneBall = (A * A * A) / (R * R * R);
    expect(sim.packingFraction).toBeLessThanOrEqual(brim + oneBall + 1e-9);
    expect(sim.packingFraction).toBeLessThan(0.6);
  });
});

describe('determinism', () => {
  it('11. same seed + same call sequence gives bit-identical positions', () => {
    const run = (): SpherePhysics => {
      const sim = new SpherePhysics(defaultPhysicsParams(A, 4096), mulberry32(31337));
      for (let f = 0; f < 200; f++) {
        for (let s = 0; s < 2; s++) sim.spawn();
        sim.update(DT);
      }
      for (let f = 0; f < 100; f++) sim.update(DT);
      return sim;
    };
    const a = run();
    const b = run();
    expect(a.count).toBe(b.count);
    expect(a.count).toBeGreaterThan(50);
    for (let i = 0; i < a.count; i++) {
      expect(a.posX[i]).toBe(b.posX[i]);
      expect(a.posY[i]).toBe(b.posY[i]);
      expect(a.posZ[i]).toBe(b.posZ[i]);
      // Orientation + spin too: a stray unseeded random in the quat/spin path
      // would leave positions identical while tumble diverges.
      expect(a.qx[i]).toBe(b.qx[i]);
      expect(a.qy[i]).toBe(b.qy[i]);
      expect(a.qz[i]).toBe(b.qz[i]);
      expect(a.qw[i]).toBe(b.qw[i]);
      expect(a.wx[i]).toBe(b.wx[i]);
      expect(a.wy[i]).toBe(b.wy[i]);
      expect(a.wz[i]).toBe(b.wz[i]);
    }
  });
});

describe('meltLowest', () => {
  it('12. removes exactly k lowest, wakes, resettles, keeps bookkeeping', () => {
    const sim = pourAndSettle(make(), 250);
    const enteredBefore = sim.enteredCount;
    expect(enteredBefore).toBeGreaterThan(60);
    const awakeBefore = sim.awakeCount;
    const k = 30;
    const out = new Int32Array(k);
    const outPos = new Float32Array(k * 3);
    // Snapshot y before removal — swap-remove recycles victim slots, so the
    // indices in `out` no longer name the removed balls afterwards.
    const yBefore = Float32Array.from(sim.posY.subarray(0, sim.count));
    const removed = sim.meltLowest(k, out, outPos);

    expect(removed).toBe(k);
    expect(sim.enteredCount).toBe(enteredBefore - k); // exactly k entered removed
    expect(scanEnteredCount(sim)).toBe(sim.enteredCount); // counter matches reality
    expect(sim.packingFraction).toBeCloseTo((sim.enteredCount * A * A * A) / (R * R * R), 9);

    // outPositions matches the pre-removal y of each reported index.
    for (let c = 0; c < k; c++) {
      expect(outPos[c * 3 + 1]).toBeCloseTo(yBefore[out[c]], 6);
    }
    // Bottom-biased: the highest removed sits no higher than the lowest survivor
    // (2r of slack is the fair looseness the brief allows).
    let maxRemovedY = -Infinity;
    for (let c = 0; c < k; c++) maxRemovedY = Math.max(maxRemovedY, yBefore[out[c]]);
    let minSurvivorY = Infinity;
    for (let i = 0; i < sim.count; i++) if (sim.entered[i]) minSurvivorY = Math.min(minSurvivorY, sim.posY[i]);
    expect(maxRemovedY).toBeLessThanOrEqual(minSurvivorY + 2 * A);

    // Neighbourhoods woke (the pile slumps).
    expect(sim.awakeCount).toBeGreaterThan(awakeBefore);

    // Resettle: no NaN, contained, no floaters, counter still consistent.
    for (let f = 0; f < 700; f++) sim.update(DT);
    expect(sim.hasNaN()).toBe(false);
    expect(maxRadialExcess(sim)).toBeLessThan(3e-3);
    expect(countFloaters(sim)).toBeLessThanOrEqual(2);
    expect(scanEnteredCount(sim)).toBe(sim.enteredCount);
  });
});

describe('consumeTouchingLiquid', () => {
  it('13. removes exactly the y - r <= levelY entered set, nothing above', () => {
    const sim = pourAndSettle(make(), 250);
    const r = sim.params.radius;
    // A level ~40% up the settled pile, so a real subset (not all, not none)
    // has its underside in the liquid.
    const ys: number[] = [];
    for (let i = 0; i < sim.count; i++) if (sim.entered[i]) ys.push(sim.posY[i]);
    ys.sort((p, q) => p - q);
    const levelY = ys[Math.floor(ys.length * 0.4)] - r;

    let qualifying = 0;
    for (let i = 0; i < sim.count; i++) if (sim.entered[i] && sim.posY[i] - r <= levelY) qualifying++;
    expect(qualifying).toBeGreaterThan(5);
    expect(qualifying).toBeLessThan(sim.enteredCount);

    const enteredBefore = sim.enteredCount;
    const out = new Int32Array(qualifying + 8);
    const outPos = new Float32Array((qualifying + 8) * 3);
    const removed = sim.consumeTouchingLiquid(levelY, 10000, out, outPos);

    expect(removed).toBe(qualifying);
    expect(sim.enteredCount).toBe(enteredBefore - qualifying);
    expect(scanEnteredCount(sim)).toBe(sim.enteredCount);
    // Nothing at/below the level survives, and nothing above it was taken.
    for (let i = 0; i < sim.count; i++) {
      if (sim.entered[i]) expect(sim.posY[i] - r).toBeGreaterThan(levelY);
    }
    // Every reported position is genuinely at/below the level.
    for (let c = 0; c < removed; c++) {
      expect(outPos[c * 3 + 1] - r).toBeLessThanOrEqual(levelY + 1e-6);
    }
  });
});

describe('removal out-param contract', () => {
  it('14. drainNewest is newest-first; melt/consume fill out consistently', () => {
    // drainNewest reports newest-first stack indices + their positions.
    const sim = make();
    let spawned = 0;
    let guard = 0;
    while (spawned < 120 && guard < 20000) {
      guard++;
      if (sim.spawn() >= 0) spawned++;
      sim.update(DT);
    }
    const countBefore = sim.count;
    const out = new Int32Array(5);
    const outPos = new Float32Array(5 * 3);
    const posBefore = Float32Array.from(sim.posY.subarray(0, sim.count));
    const drained = sim.drainNewest(5, out, outPos);
    expect(drained).toBe(5);
    for (let c = 0; c < 5; c++) {
      expect(out[c]).toBe(countBefore - 1 - c); // newest-first
      expect(outPos[c * 3 + 1]).toBe(posBefore[countBefore - 1 - c]);
    }

    // meltLowest: filled entries are valid and distinct, count matches return.
    const sim2 = pourAndSettle(make(), 200);
    const out2 = new Int32Array(20);
    const r2 = sim2.meltLowest(15, out2);
    expect(r2).toBe(15);
    const seen2 = new Set<number>();
    for (let c = 0; c < r2; c++) {
      expect(out2[c]).toBeGreaterThanOrEqual(0);
      seen2.add(out2[c]);
    }
    expect(seen2.size).toBe(r2);

    // consumeTouchingLiquid: same — return count matches the distinct fill.
    const sim3 = pourAndSettle(make(), 200);
    const r3v = sim3.params.radius;
    const ys: number[] = [];
    for (let i = 0; i < sim3.count; i++) if (sim3.entered[i]) ys.push(sim3.posY[i]);
    ys.sort((p, q) => p - q);
    const levelY = ys[Math.floor(ys.length * 0.3)] - r3v;
    const out3 = new Int32Array(sim3.count);
    const r3 = sim3.consumeTouchingLiquid(levelY, 10000, out3);
    const seen3 = new Set<number>();
    for (let c = 0; c < r3; c++) seen3.add(out3[c]);
    expect(seen3.size).toBe(r3);
  });
});

describe('mouthGeometry (shared by solver and glass discard)', () => {
  it('15. auto-sizes to the ball, clamps both ends, sits on the shell', () => {
    // In-band: 4 balls across the opening, plane height from the shell circle.
    const mid = mouthGeometry(0.05, 1);
    expect(mid.mouthRadius).toBeCloseTo(0.2, 12);
    expect(mid.mouthPlaneY).toBeCloseTo(Math.sqrt(1 - 0.2 * 0.2), 12);
    // Tiny balls: the floor keeps the pour from pinholing.
    expect(mouthGeometry(0.001, 1).mouthRadius).toBe(0.14);
    // Huge balls: the ceiling keeps the sphere capped.
    expect(mouthGeometry(0.3, 1).mouthRadius).toBe(0.5);
    // The scale knob widens the hole before the clamp.
    expect(mouthGeometry(0.05, 1, 1.5).mouthRadius).toBeCloseTo(0.3, 12);
  });
});
