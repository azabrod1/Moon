import { describe, expect, it } from 'vitest';
import { sampleTrajectoryLinePoints } from '../astronomy/planetary';
import { KM_PER_AU } from '../astronomy/constants';
import { PLANETARIUM_BODIES } from './planets/planetData';
import {
  ANCHOR_CHUNK_SEGMENTS,
  ANCHOR_DRIFT_RATIO,
  createOrbitLineAnchorFrame,
  lineWithinAU,
  orbitLineAnchorNeedsMove,
  setOrbitLineAnchorSamples,
  writeAnchoredSegmentPairs,
  type OrbitLineAnchorFrame,
} from './orbitLineAnchor';

type V = { x: number; y: number; z: number };

/** A deterministic wobbly polyline: a helix that drifts, so no chunk sphere
 *  is a point and no two are the same. */
function helix(vertices: number): V[] {
  const out: V[] = [];
  for (let i = 0; i < vertices; i++) {
    const t = i / 20;
    out.push({ x: Math.cos(t) * 2 + t * 0.05, y: Math.sin(t) * 2, z: t * 0.3 });
  }
  return out;
}

function frameOf(points: V[]): OrbitLineAnchorFrame {
  const frame = createOrbitLineAnchorFrame();
  setOrbitLineAnchorSamples(frame, points);
  return frame;
}

/** Textbook point-to-polyline distance, no pruning: the oracle for lineWithinAU. */
function bruteDistance(points: V[], p: V): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const ex = b.x - a.x, ey = b.y - a.y, ez = b.z - a.z;
    const wx = p.x - a.x, wy = p.y - a.y, wz = p.z - a.z;
    const len2 = ex * ex + ey * ey + ez * ez;
    const t = Math.min(1, Math.max(0, len2 > 0 ? (wx * ex + wy * ey + wz * ez) / len2 : 0));
    const dx = wx - t * ex, dy = wy - t * ey, dz = wz - t * ez;
    best = Math.min(best, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return best;
}

/** Small deterministic PRNG so the sweep is the same on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('setOrbitLineAnchorSamples', () => {
  it('stores the vertices in double and builds one sound sphere per chunk', () => {
    const points = helix(300);
    const frame = frameOf(points);
    expect(frame.vertexCount).toBe(300);
    expect(frame.chunkCount).toBe(Math.ceil(299 / ANCHOR_CHUNK_SEGMENTS));
    expect(frame.samples[3 * 137 + 1]).toBe(points[137].y);
    for (let c = 0; c < frame.chunkCount; c++) {
      const first = c * ANCHOR_CHUNK_SEGMENTS;
      const last = Math.min(299, first + ANCHOR_CHUNK_SEGMENTS);
      const [cx, cy, cz, r] = frame.chunks.subarray(c * 4, c * 4 + 4);
      for (let v = first; v <= last; v++) {
        const p = points[v];
        const d = Math.hypot(p.x - cx, p.y - cy, p.z - cz);
        expect(d, `chunk ${c} vertex ${v}`).toBeLessThanOrEqual(r + 1e-12);
      }
    }
  });

  it('reuses its buffers for a same-count resample and leaves the anchor alone', () => {
    const frame = frameOf(helix(300));
    frame.anchor = { x: 1, y: 2, z: 3 };
    const samples = frame.samples;
    const chunks = frame.chunks;
    setOrbitLineAnchorSamples(frame, helix(300).map((p) => ({ x: p.x + 1, y: p.y, z: p.z })));
    expect(frame.samples).toBe(samples);
    expect(frame.chunks).toBe(chunks);
    expect(frame.anchor).toEqual({ x: 1, y: 2, z: 3 });
    expect(frame.samples[0]).toBe(helix(1)[0].x + 1);
  });

  it('is empty until written, and empty is nowhere', () => {
    const frame = createOrbitLineAnchorFrame();
    expect(frame.vertexCount).toBe(0);
    expect(lineWithinAU(frame, 0, 0, 0, 1e9)).toBe(false);
    expect(orbitLineAnchorNeedsMove(frame, 5, 5, 5)).toBe(false);
  });
});

describe('writeAnchoredSegmentPairs', () => {
  it('writes start/end pairs measured from the anchor', () => {
    const points = helix(50);
    const frame = frameOf(points);
    frame.anchor = { x: 0.5, y: -0.25, z: 2 };
    const out = new Float32Array(49 * 6);
    writeAnchoredSegmentPairs(frame, out);
    for (let i = 0; i < 49; i++) {
      expect(out[i * 6]).toBe(Math.fround(points[i].x - 0.5));
      expect(out[i * 6 + 1]).toBe(Math.fround(points[i].y + 0.25));
      expect(out[i * 6 + 2]).toBe(Math.fround(points[i].z - 2));
      expect(out[i * 6 + 3]).toBe(Math.fround(points[i + 1].x - 0.5));
      expect(out[i * 6 + 4]).toBe(Math.fround(points[i + 1].y + 0.25));
      expect(out[i * 6 + 5]).toBe(Math.fround(points[i + 1].z - 2));
    }
  });

  it('refuses a buffer of the wrong size rather than writing past a segment', () => {
    const frame = frameOf(helix(50));
    expect(() => writeAnchoredSegmentPairs(frame, new Float32Array(48 * 6))).toThrow(/49 segments/);
  });
});

describe('lineWithinAU', () => {
  it('agrees with the unpruned distance for points near, on and far from the line', () => {
    const points = helix(1000);
    const frame = frameOf(points);
    const rand = lcg(7);
    let hits = 0;
    for (let k = 0; k < 400; k++) {
      // Mostly near the line (where pruning must not lose a segment), some far.
      const base = points[Math.floor(rand() * points.length)];
      const spread = k % 4 === 0 ? 8 : 0.4;
      const p = {
        x: base.x + (rand() - 0.5) * spread,
        y: base.y + (rand() - 0.5) * spread,
        z: base.z + (rand() - 0.5) * spread,
      };
      const d = bruteDistance(points, p);
      const radius = d * (0.5 + rand() * 1.5);
      const expected = d <= radius;
      if (expected) hits++;
      expect(lineWithinAU(frame, p.x, p.y, p.z, radius), `query ${k}`).toBe(expected);
    }
    expect(hits).toBeGreaterThan(100);
    expect(hits).toBeLessThan(300);
  });

  it('finds a segment whose interior is near while both its vertices are far', () => {
    // One long straight segment: the query sits beside its middle.
    const frame = frameOf([{ x: -10, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }]);
    expect(lineWithinAU(frame, 0, 0.5, 0, 0.6)).toBe(true);
    expect(lineWithinAU(frame, 0, 0.5, 0, 0.4)).toBe(false);
  });
});

describe('orbitLineAnchorNeedsMove', () => {
  const line = frameOf([{ x: -1, y: 1e-3, z: 0 }, { x: 0, y: 1e-3, z: 0 }, { x: 1, y: 1e-3, z: 0 }]);

  it('never moves for a ship that has not left the anchor', () => {
    expect(orbitLineAnchorNeedsMove(line, 0, 0, 0)).toBe(false);
  });

  it('moves once the drift passes the ratio times the distance to the line', () => {
    // The ship is 1e-3 from the line throughout; the ratio makes the
    // threshold drift 0.1.
    const threshold = ANCHOR_DRIFT_RATIO * 1e-3;
    expect(orbitLineAnchorNeedsMove(line, threshold * 0.9, 0, 0)).toBe(false);
    expect(orbitLineAnchorNeedsMove(line, threshold * 1.1, 0, 0)).toBe(true);
  });

  it('never moves for a line the ship is nowhere near, however far it drifts', () => {
    const far = frameOf([{ x: -1, y: 50, z: 0 }, { x: 1, y: 50, z: 0 }]);
    expect(orbitLineAnchorNeedsMove(far, 40, 0, 0)).toBe(false);
  });
});

/**
 * The float32 oracle. What the GPU holds for a vertex is float32 vertex data
 * plus a float32 model translation, summed in float32 — simulated here with
 * Math.fround, in the world frame (the view rotation adds rounding of the same
 * order and changes nothing about which layout wins). The ship flies 600 km
 * along Pluto's orbit line, 1800 km beside it (Pluto's collision shell), and
 * the drawn segment's nearest point to the camera is compared with the
 * double-precision truth frame by frame. The heliocentric layout the lines
 * shipped with steps by hundreds of km as the ship crosses float32 grid
 * lines at 35 AU; the anchored layout does not.
 */
describe('float32 placement of Pluto\'s orbit line beside a moving ship', () => {
  const f = Math.fround;
  const pluto = PLANETARIUM_BODIES.find((b) => b.name === 'Pluto')!;
  const NOW = Date.UTC(2026, 8, 10, 12);
  const SEGMENTS = 8192;
  const points = sampleTrajectoryLinePoints(pluto, NOW, SEGMENTS);
  // A segment a few along from the body's own vertex: the ship sits beside
  // its middle, where both endpoints are ~1.75 Mkm away, the everyday case
  // for a ship that has followed its planet a few weeks past the resample.
  const j = SEGMENTS / 2 + 3;
  const A = points[j];
  const B = points[j + 1];
  const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z;
  const len = Math.hypot(ux, uy, uz);
  const u = { x: ux / len, y: uy / len, z: uz / len };
  // A unit vector across the line, to stand the ship beside it.
  let w = { x: u.y * 0 - u.z * 1, y: u.z * 0 - u.x * 0, z: u.x * 1 - u.y * 0 };
  const wl = Math.hypot(w.x, w.y, w.z);
  w = { x: w.x / wl, y: w.y / wl, z: w.z / wl };
  const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2 };
  const SHELL_AU = 1800 / KM_PER_AU;
  const STEP_AU = 1 / KM_PER_AU;
  const STEPS = 600;
  const start = { x: mid.x + w.x * SHELL_AU, y: mid.y + w.y * SHELL_AU, z: mid.z + w.z * SHELL_AU };

  type Place = (v: V, p: V) => [number, number, number];
  const legacy: Place = (v, p) => [f(f(v.x) + f(-p.x)), f(f(v.y) + f(-p.y)), f(f(v.z) + f(-p.z))];
  const anchor = start;
  const anchored: Place = (v, p) => [
    f(f(v.x - anchor.x) + f(anchor.x - p.x)),
    f(f(v.y - anchor.y) + f(anchor.y - p.y)),
    f(f(v.z - anchor.z) + f(anchor.z - p.z)),
  ];

  /** Worst frame-to-frame jump and worst offset of the drawn segment's point
   *  nearest the camera, both as angles at the camera (radians). */
  function sweep(place: Place): { maxJumpRad: number; maxErrorRad: number } {
    let maxJumpRad = 0;
    let maxErrorRad = 0;
    let prev: [number, number, number] | null = null;
    for (let k = 0; k <= STEPS; k++) {
      const p = { x: start.x + u.x * STEP_AU * k, y: start.y + u.y * STEP_AU * k, z: start.z + u.z * STEP_AU * k };
      const a = [A.x - p.x, A.y - p.y, A.z - p.z];
      const b = [B.x - p.x, B.y - p.y, B.z - p.z];
      const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const t = -(a[0] * e[0] + a[1] * e[1] + a[2] * e[2]) / (e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
      const near = [a[0] + t * e[0], a[1] + t * e[1], a[2] + t * e[2]];
      const dist = Math.hypot(near[0], near[1], near[2]);
      const ga = place(A, p);
      const gb = place(B, p);
      const gnear = [ga[0] + t * (gb[0] - ga[0]), ga[1] + t * (gb[1] - ga[1]), ga[2] + t * (gb[2] - ga[2])];
      const err: [number, number, number] = [gnear[0] - near[0], gnear[1] - near[1], gnear[2] - near[2]];
      maxErrorRad = Math.max(maxErrorRad, Math.hypot(...err) / dist);
      if (prev) {
        maxJumpRad = Math.max(maxJumpRad, Math.hypot(err[0] - prev[0], err[1] - prev[1], err[2] - prev[2]) / dist);
      }
      prev = err;
    }
    return { maxJumpRad, maxErrorRad };
  }

  it('the heliocentric layout jumps the line by more than a degree at a time', () => {
    const { maxJumpRad } = sweep(legacy);
    expect(maxJumpRad).toBeGreaterThan(0.02);
  });

  it('the anchored layout holds the line within a tenth of a milliradian', () => {
    // 1e-4 rad is ~0.1 px on a 60° view 1000 px tall. The residual is the
    // float32 magnitude of the segment's far endpoints (module header).
    const { maxJumpRad, maxErrorRad } = sweep(anchored);
    expect(maxJumpRad).toBeLessThan(1e-4);
    expect(maxErrorRad).toBeLessThan(2e-4);
  });

  it('the policy would not have re-anchored during that flight', () => {
    const frame = frameOf(points);
    frame.anchor = { ...start };
    const end = { x: start.x + u.x * STEP_AU * STEPS, y: start.y + u.y * STEP_AU * STEPS, z: start.z + u.z * STEP_AU * STEPS };
    expect(orbitLineAnchorNeedsMove(frame, end.x, end.y, end.z)).toBe(false);
    // …but a ship that flew a hundred times its distance to the line would.
    const farAlong = { x: start.x + u.x * SHELL_AU * 110, y: start.y + u.y * SHELL_AU * 110, z: start.z + u.z * SHELL_AU * 110 };
    expect(orbitLineAnchorNeedsMove(frame, farAlong.x, farAlong.y, farAlong.z)).toBe(true);
  });
});
