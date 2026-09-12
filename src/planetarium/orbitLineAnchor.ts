/**
 * Where an orbit line's vertices are measured from, and when to move that.
 *
 * The scene is floating-origin: every body is posed at (world − ship) in
 * double precision each frame, so a body a few thousand km from the camera
 * carries a few thousand km of float32 coordinate and its rounding is
 * centimetres. The orbit lines were the one exception. Their vertices were
 * heliocentric float32 — Pluto's sit on a 285 km grid — and the line was
 * translated by a float32 model matrix holding −ship, another 285 km grid at
 * Pluto's distance, so the GPU subtracted two 35 AU numbers and the
 * difference stepped by hundreds of km as the ship moved: a rigid jump of the
 * whole line, which a ship 1800 km from it at Pluto's shell saw as a swing of
 * several degrees. Only the line moved that way, because only the line was
 * posed like that.
 *
 * Here each line's vertices are written relative to an anchor (a point the
 * ship was at when they were written), so what the GPU holds is small near
 * the ship, and the per-frame model translation is (anchor − ship), computed
 * in double. Both roundings then scale with the distance from the anchor
 * instead of from the Sun. The anchor is moved — the line re-written and
 * re-uploaded, which is the only cost — once the ship has drifted far enough
 * from it for that rounding to reach the screen. That is a bound, not a
 * feel:
 *
 * A float32 keeps 24 bits of mantissa, so a coordinate of size D is stored to
 * within D·2⁻²⁴ ≈ 6e-8·D. A vertex at distance D from the anchor is placed to
 * within 6e-8·D, and the model translation, of length drift = |anchor − ship|,
 * to within 6e-8·drift. For a vertex the camera sees at distance d,
 * D ≤ d + drift, so the vertex lands within 6e-8·(d + 2·drift) of where it
 * belongs, an angle of 6e-8·(1 + 2·drift/d) radians. Holding
 * drift ≤ ANCHOR_DRIFT_RATIO·d bounds that at 6e-8·(1 + 2·ratio); at 100 it
 * is 1.2e-5 rad, about 0.01 px on a 60° view 1000 px tall and under a tenth
 * of a pixel at the narrowest cruise lens. The distance that matters is the
 * one to the nearest point of the line, since the drawn segment near the
 * camera moves with its endpoints; lineWithinAU finds it from the samples
 * themselves, chunk bounding spheres first so nine lines cost a few hundred
 * sphere tests a frame and a segment scan only where the ship is close.
 *
 * What this does not remove: a vertex millions of km from the camera is held
 * in float32 at that magnitude however it is anchored (Pluto's segments are
 * 3.5 Mkm, so 0.28 km), and the segment drawn through the camera's
 * neighbourhood inherits that rounding from its two endpoints — about 0.1 px
 * for a ship at Pluto's shell. That residual is measured by
 * tools/orbit-line-probe.mjs, and shortening the segments near the camera is
 * the answer if it ever shows.
 *
 * DOM-free and three-free: plain numbers in and out, so the arithmetic that
 * decides an upload is testable against a float32 oracle.
 */

/** Drift from the anchor, as a multiple of the ship's distance to the line,
 *  past which the line is re-anchored. See the module header for the bound
 *  it holds: 6e-8·(1 + 2·ratio) radians of placement error. */
export const ANCHOR_DRIFT_RATIO = 100;

/** Segments per bounding-sphere chunk of the distance query. */
export const ANCHOR_CHUNK_SEGMENTS = 64;

/** Values per chunk record in `chunks`: centre xyz and radius. */
const CHUNK_STRIDE = 4;

export interface OrbitLineAnchorFrame {
  /** Heliocentric vertices in double precision: (segments + 1) × xyz, AU. */
  samples: Float64Array;
  /** Vertex count (segments + 1). */
  vertexCount: number;
  /** What the uploaded float32 vertices are measured from, heliocentric AU. */
  anchor: { x: number; y: number; z: number };
  /** Bounding spheres of runs of ANCHOR_CHUNK_SEGMENTS segments, CHUNK_STRIDE
   *  values each, over the heliocentric samples. */
  chunks: Float64Array;
  chunkCount: number;
}

/** A frame with no vertices, anchored at the Sun. */
export function createOrbitLineAnchorFrame(): OrbitLineAnchorFrame {
  return {
    samples: new Float64Array(0),
    vertexCount: 0,
    anchor: { x: 0, y: 0, z: 0 },
    chunks: new Float64Array(0),
    chunkCount: 0,
  };
}

/**
 * Replace the frame's samples with `points` (the polyline, heliocentric AU),
 * rebuilding the chunk spheres. Buffers are reused when the count is
 * unchanged, so the periodic resample allocates nothing. The anchor is left
 * where it was: whether the ship has drifted from it is the next frame's
 * question, and the answer is the same for old samples and new.
 */
export function setOrbitLineAnchorSamples(
  frame: OrbitLineAnchorFrame,
  points: ReadonlyArray<{ x: number; y: number; z: number }>,
): void {
  const vertexCount = points.length;
  if (frame.samples.length !== vertexCount * 3) frame.samples = new Float64Array(vertexCount * 3);
  const samples = frame.samples;
  for (let i = 0; i < vertexCount; i++) {
    const p = points[i];
    samples[i * 3] = p.x;
    samples[i * 3 + 1] = p.y;
    samples[i * 3 + 2] = p.z;
  }
  frame.vertexCount = vertexCount;

  const segments = Math.max(0, vertexCount - 1);
  const chunkCount = Math.ceil(segments / ANCHOR_CHUNK_SEGMENTS);
  if (frame.chunks.length !== chunkCount * CHUNK_STRIDE) {
    frame.chunks = new Float64Array(chunkCount * CHUNK_STRIDE);
  }
  frame.chunkCount = chunkCount;
  const chunks = frame.chunks;
  for (let c = 0; c < chunkCount; c++) {
    const first = c * ANCHOR_CHUNK_SEGMENTS;
    const last = Math.min(segments, first + ANCHOR_CHUNK_SEGMENTS); // last vertex index
    // Centre on the chunk's vertex mean, radius to its farthest vertex: not
    // the tightest sphere, but a sound one, and the query only needs sound.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let v = first; v <= last; v++) {
      cx += samples[v * 3];
      cy += samples[v * 3 + 1];
      cz += samples[v * 3 + 2];
    }
    const n = last - first + 1;
    cx /= n;
    cy /= n;
    cz /= n;
    let r2 = 0;
    for (let v = first; v <= last; v++) {
      const dx = samples[v * 3] - cx;
      const dy = samples[v * 3 + 1] - cy;
      const dz = samples[v * 3 + 2] - cz;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    const o = c * CHUNK_STRIDE;
    chunks[o] = cx;
    chunks[o + 1] = cy;
    chunks[o + 2] = cz;
    chunks[o + 3] = Math.sqrt(r2);
  }
}

/** Squared distance from (px,py,pz) to the segment (ax..bx …). */
function segmentDistanceSq(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number {
  const ex = bx - ax;
  const ey = by - ay;
  const ez = bz - az;
  const wx = px - ax;
  const wy = py - ay;
  const wz = pz - az;
  const len2 = ex * ex + ey * ey + ez * ez;
  let t = len2 > 0 ? (wx * ex + wy * ey + wz * ez) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = wx - t * ex;
  const dy = wy - t * ey;
  const dz = wz - t * ez;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Does any point of the polyline lie within `radiusAU` of (x,y,z)? Chunks
 * whose sphere is farther than that are skipped whole; the rest are scanned
 * segment by segment, and the first hit answers. A zero-vertex frame is
 * nowhere near anything.
 */
export function lineWithinAU(
  frame: OrbitLineAnchorFrame,
  x: number,
  y: number,
  z: number,
  radiusAU: number,
): boolean {
  if (frame.vertexCount < 2 || !(radiusAU >= 0)) return false;
  const { samples, chunks } = frame;
  const segments = frame.vertexCount - 1;
  const r2 = radiusAU * radiusAU;
  for (let c = 0; c < frame.chunkCount; c++) {
    const o = c * CHUNK_STRIDE;
    const dx = x - chunks[o];
    const dy = y - chunks[o + 1];
    const dz = z - chunks[o + 2];
    const reach = chunks[o + 3] + radiusAU;
    if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
    const first = c * ANCHOR_CHUNK_SEGMENTS;
    const end = Math.min(segments, first + ANCHOR_CHUNK_SEGMENTS);
    for (let s = first; s < end; s++) {
      const a = s * 3;
      if (
        segmentDistanceSq(
          x, y, z,
          samples[a], samples[a + 1], samples[a + 2],
          samples[a + 3], samples[a + 4], samples[a + 5],
        ) <= r2
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Should the line be re-anchored at the ship's position (x,y,z)? Yes once the
 * drift from the current anchor exceeds ANCHOR_DRIFT_RATIO times the ship's
 * distance to the line — i.e. the line comes within drift/ratio of the ship.
 * A ship that has not moved never re-anchors, however close the line.
 */
export function orbitLineAnchorNeedsMove(
  frame: OrbitLineAnchorFrame,
  x: number,
  y: number,
  z: number,
): boolean {
  const dx = x - frame.anchor.x;
  const dy = y - frame.anchor.y;
  const dz = z - frame.anchor.z;
  const drift = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (drift === 0) return false;
  return lineWithinAU(frame, x, y, z, drift / ANCHOR_DRIFT_RATIO);
}

/**
 * Write the polyline as LineSegmentsGeometry's instanced pairs — start xyz,
 * end xyz per segment — measured from the frame's anchor. `out` must hold
 * exactly segments × 6 floats; the caller owns the buffer so the periodic
 * resample and every re-anchor land in the same GPU allocation.
 */
export function writeAnchoredSegmentPairs(frame: OrbitLineAnchorFrame, out: Float32Array): void {
  const segments = Math.max(0, frame.vertexCount - 1);
  if (out.length !== segments * 6) {
    throw new Error(`orbit line pair buffer holds ${out.length} floats, ${segments} segments need ${segments * 6}`);
  }
  const { samples } = frame;
  const { x: ax, y: ay, z: az } = frame.anchor;
  for (let i = 0; i < segments; i++) {
    const s = i * 3;
    const o = i * 6;
    out[o] = samples[s] - ax;
    out[o + 1] = samples[s + 1] - ay;
    out[o + 2] = samples[s + 2] - az;
    out[o + 3] = samples[s + 3] - ax;
    out[o + 4] = samples[s + 4] - ay;
    out[o + 5] = samples[s + 5] - az;
  }
}
