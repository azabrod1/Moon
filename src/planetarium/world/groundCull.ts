/**
 * Leaving covered ground out of the draw. Up close a body's ground is drawn up
 * to four times over: the globe, then each level of streamed sector tile on top
 * of it (world/sectorStreamer). The finest layer wins every pixel by its depth
 * offset, and the layers under it were meant to be rejected by the depth test
 * before they were shaded. On Apple GPUs (ANGLE on Metal, Chromium and WebKit
 * alike) they are not: every hidden layer is shaded in full and then loses, and
 * no depth state changes that (strict LESS, no offset, the globe pushed far
 * back: all measured, none moved the frame). So the layers a finer drawn tile
 * covers are not submitted at all.
 *
 * What makes that exact is the lattice. The fine globe (256 × 128 segments) and
 * every sector of every level are cut from one vertex lattice: a level-k
 * sector's triangles are the globe's triangles over its rectangle, the same
 * float32 positions in the same vertex order (sectorGrid.test.ts pins it bit for
 * bit at the radii the app builds). A tile therefore rasterises exactly the
 * pixels the cells it covers would have, and a coarser mesh with those cells
 * left out meets the tile along shared edges with no crack and no overlap.
 *
 * The unit that is left out is a LEAF: the cells under one tile of the finest
 * level the lattice allows (8 × 8 cells). Each streamed ground geometry is laid
 * out once, at construction and before its first draw, with an index of 2N
 * entries: [0, N) is its full triangle list reordered so every leaf, and every
 * aligned square of leaves — the footprint of any tile at any level — is one
 * contiguous run; [N, 2N) is scratch. A cut writes the runs left uncovered into
 * the scratch half (one sub-upload of what changed, on a coverage change only)
 * and points the draw range at them; an un-cut points it back at [0, N) and
 * uploads nothing. Reordering whole triangles of a convex, back-face-culled
 * mesh changes no pixel, so the full list draws today's picture. One index per
 * geometry, never shared and never swapped: a shared buffer would be deleted
 * under its other users by the first geometry disposed, and a swapped one would
 * re-point a vertex array object mid-session.
 *
 * Which leaves are covered is the streamer's rule (its header says when a tile
 * counts as drawn); this module only lays the index out and applies a cover.
 * Pure apart from three's BufferGeometry: no renderer, no DOM.
 */
import * as THREE from 'three';

/** One streamed ground geometry's index layout and the cover it draws. */
export interface GroundIndex {
  readonly geometry: THREE.BufferGeometry;
  /** N: entries in the full triangle list, which fills [0, N) for good. */
  readonly full: number;
  /** The leaf grid, in leaves: both powers of two. */
  readonly cols: number;
  readonly rows: number;
  /** Where each leaf's triangles start in the full list, by quadtree ordinal,
   *  with N at [cols × rows]. */
  readonly start: Uint32Array;
  /** The cover being assembled (1 = left out), by ordinal. */
  readonly next: Uint8Array;
  /** The cover the scratch half holds now, and its length in entries (-1 before
   *  it has held any). An un-cut leaves both alone, so the same cover coming
   *  back is a draw-range write and no upload. */
  readonly held: Uint8Array;
  heldCount: number;
}

const layouts = new WeakMap<THREE.BufferGeometry, GroundIndex>();

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/**
 * A leaf's place in quadtree order on a `cols × rows` leaf grid (powers of two):
 * the grid as squares of the shorter side, row-major, each in Z order. Any
 * square of `s × s` leaves with s a power of two no larger than the shorter
 * side, aligned to a multiple of s, is then the one run [ordinal of its corner,
 * + s²) — the footprint of a tile, whatever its level.
 */
export function quadtreeOrdinal(x: number, y: number, cols: number, rows: number): number {
  const side = Math.min(cols, rows);
  let z = 0;
  for (let bit = 0; (1 << bit) < side; bit++) {
    z |= ((x >> bit) & 1) << (2 * bit);
    z |= ((y >> bit) & 1) << (2 * bit + 1);
  }
  const square = Math.floor(y / side) * (cols / side) + Math.floor(x / side);
  return square * side * side + z;
}

/**
 * Reorder a sphere's triangle list (three's SphereGeometry, `width × height`
 * segments, full or partial) into quadtree order of `leaf × leaf`-cell leaves,
 * writing it to `out[0, N)`. Triangles keep their own vertex order and, inside a
 * leaf, the order they had. Returns the leaf grid and each leaf's start.
 *
 * A triangle's cell is its smallest vertex id: three's sphere builds every
 * quad's one or two triangles from its four corners, and the north-west corner
 * (row-major ids, `width + 1` a row) is the smallest in both.
 */
export function layoutSphereTriangles(
  index: ArrayLike<number>,
  width: number,
  height: number,
  leaf: number,
  out: { [i: number]: number; length: number },
): { cols: number; rows: number; start: Uint32Array } {
  const cols = width / leaf;
  const rows = height / leaf;
  if (!isPowerOfTwo(cols) || !isPowerOfTwo(rows)) {
    throw new Error(`ground index: a ${width} × ${height} sphere is not a power-of-two grid of ${leaf}-cell leaves`);
  }
  const n = index.length;
  if (out.length < n) throw new Error('ground index: the output is shorter than the triangle list');
  const leaves = cols * rows;
  const stride = width + 1;
  const ordinalOf = (t: number): number => {
    const b = Math.min(index[t], index[t + 1], index[t + 2]);
    const ix = b % stride;
    const iy = (b - ix) / stride;
    return quadtreeOrdinal(Math.floor(ix / leaf), Math.floor(iy / leaf), cols, rows);
  };
  const start = new Uint32Array(leaves + 1);
  for (let t = 0; t < n; t += 3) start[ordinalOf(t) + 1] += 3;
  for (let i = 0; i < leaves; i++) start[i + 1] += start[i];
  const cursor = start.slice(0, leaves);
  for (let t = 0; t < n; t += 3) {
    const o = ordinalOf(t);
    const at = cursor[o];
    out[at] = index[t];
    out[at + 1] = index[t + 1];
    out[at + 2] = index[t + 2];
    cursor[o] = at + 3;
  }
  return { cols, rows, start };
}

/**
 * Write the runs of the full list that `covered` leaves in (in quadtree order)
 * to `out` from `offset`, and return how many entries that is. Adjacent
 * uncovered leaves are one run, so the copy is a handful of block moves.
 */
export function writeUncoveredRuns(
  full: { subarray(begin: number, end: number): ArrayLike<number> } & ArrayLike<number>,
  start: Uint32Array,
  covered: Uint8Array,
  out: { set(src: ArrayLike<number>, offset: number): void },
  offset: number,
): number {
  let written = 0;
  const leaves = covered.length;
  let i = 0;
  while (i < leaves) {
    if (covered[i]) { i++; continue; }
    let j = i + 1;
    while (j < leaves && !covered[j]) j++;
    const from = start[i];
    const to = start[j];
    out.set(full.subarray(from, to), offset + written);
    written += to - from;
    i = j;
  }
  return written;
}

/**
 * Lay a sphere geometry out for cutting: its index becomes the 2N layout above
 * and its draw range the full list. Call it where the geometry is built, before
 * it is ever drawn — never on one that has been, whose index buffer and vertex
 * array object already exist.
 */
export function layGroundIndex(geometry: THREE.BufferGeometry, leaf: number): GroundIndex {
  const params = (geometry as Partial<THREE.SphereGeometry>).parameters;
  const index = geometry.index;
  if (!params || !index) throw new Error('ground index: only an indexed sphere geometry can be laid out');
  const width = params.widthSegments;
  const height = params.heightSegments;
  if (geometry.getAttribute('position').count !== (width + 1) * (height + 1)) {
    throw new Error(`ground index: the geometry is not the ${width} × ${height} sphere it says it is`);
  }
  const source = index.array as Uint16Array | Uint32Array;
  const full = source.length;
  const array = new (source.constructor as Uint16ArrayConstructor | Uint32ArrayConstructor)(2 * full);
  const { cols, rows, start } = layoutSphereTriangles(source, width, height, leaf, array);
  geometry.setIndex(new THREE.BufferAttribute(array, 1));
  geometry.setDrawRange(0, full);
  const gi: GroundIndex = {
    geometry, full, cols, rows, start,
    next: new Uint8Array(cols * rows),
    held: new Uint8Array(cols * rows),
    heldCount: -1,
  };
  layouts.set(geometry, gi);
  return gi;
}

/** The layout a geometry was laid out with, or undefined for any other. */
export function groundIndexOf(geometry: THREE.BufferGeometry): GroundIndex | undefined {
  return layouts.get(geometry);
}

/** Start assembling a cover: nothing left out. */
export function beginGroundCover(gi: GroundIndex): void {
  gi.next.fill(0);
}

/** Leave out the `size × size` leaves at (x, y): one tile's footprint, which
 *  is aligned to its own size by construction. */
export function coverGroundLeaves(gi: GroundIndex, x: number, y: number, size: number): void {
  const from = quadtreeOrdinal(x, y, gi.cols, gi.rows);
  gi.next.fill(1, from, from + size * size);
}

/**
 * Draw what the assembled cover leaves. Nothing covered is the full list; a
 * cover the scratch half already holds is a draw-range write; anything else
 * rewrites the scratch half and uploads exactly the entries written.
 */
export function commitGroundCover(gi: GroundIndex): void {
  const { next, held, geometry, full } = gi;
  let any = false;
  let same = gi.heldCount >= 0;
  for (let i = 0; i < next.length; i++) {
    if (next[i]) any = true;
    if (next[i] !== held[i]) same = false;
  }
  if (!any) {
    geometry.setDrawRange(0, full);
    return;
  }
  if (!same) {
    const index = geometry.index!;
    const array = index.array as Uint16Array | Uint32Array;
    const written = writeUncoveredRuns(array, gi.start, next, array, full);
    held.set(next);
    gi.heldCount = written;
    if (written > 0) {
      index.addUpdateRange(full, written);
      index.needsUpdate = true;
    }
  }
  geometry.setDrawRange(full, gi.heldCount);
}

/** Draw the whole geometry again — no upload. A geometry never laid out is
 *  left alone. */
export function uncutGround(geometry: THREE.BufferGeometry): void {
  const gi = layouts.get(geometry);
  if (gi) geometry.setDrawRange(0, gi.full);
}

/** The production kill switch: `?groundcull=0` builds every ground geometry
 *  with its own index as before and cuts nothing. */
export function parseGroundCullParam(search: string): boolean {
  return new URLSearchParams(search).get('groundcull') !== '0';
}
