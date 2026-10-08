import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  beginGroundCover,
  commitGroundCover,
  coverGroundLeaves,
  groundIndexOf,
  layGroundIndex,
  layoutSphereTriangles,
  parseGroundCullParam,
  quadtreeOrdinal,
  uncutGround,
  writeUncoveredRuns,
} from './groundCull';
import { SECTOR_GRID_16K, finerGrid, sectorSphereGeometry } from './sectorGrid';

/** The leaf the streamer lays out with: one level-2 tile's 8 × 8 cells. */
const LEAF = 8;
const triKey = (a: number, b: number, c: number) => (a * 65536 + b) * 65536 + c;

/** Every ordered triangle of an index range, counted. */
function triangles(index: ArrayLike<number>, from = 0, to = index.length): Map<number, number> {
  const out = new Map<number, number>();
  for (let t = from; t < to; t += 3) {
    const k = triKey(index[t], index[t + 1], index[t + 2]);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

describe('quadtree order', () => {
  it('numbers every leaf of the globe\'s 32 × 16 grid exactly once', () => {
    const seen = new Set<number>();
    for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) seen.add(quadtreeOrdinal(x, y, 32, 16));
    expect(seen.size).toBe(512);
    expect(Math.min(...seen)).toBe(0);
    expect(Math.max(...seen)).toBe(511);
  });

  it('makes every aligned square of leaves one run starting at its corner', () => {
    for (const [cols, rows] of [[32, 16], [4, 4], [2, 2], [1, 1]] as const) {
      for (let s = 1; s <= Math.min(cols, rows); s *= 2) {
        for (let y0 = 0; y0 < rows; y0 += s) {
          for (let x0 = 0; x0 < cols; x0 += s) {
            const corner = quadtreeOrdinal(x0, y0, cols, rows);
            const run = new Set<number>();
            for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) run.add(quadtreeOrdinal(x, y, cols, rows));
            expect(run.size).toBe(s * s);
            expect(Math.min(...run)).toBe(corner);
            expect(Math.max(...run)).toBe(corner + s * s - 1);
          }
        }
      }
    }
  });
});

describe('the full list in quadtree order', () => {
  const cases: Array<[string, THREE.SphereGeometry]> = [
    ['the fine globe', new THREE.SphereGeometry(1, 256, 128)],
    ['a level-0 polar sector', sectorSphereGeometry(1, SECTOR_GRID_16K, { c: 7, r: 0 }, 32)],
    ['a level-1 sector', sectorSphereGeometry(1, finerGrid(SECTOR_GRID_16K), { c: 5, r: 3 }, 16)],
    ['a level-2 south polar sector', sectorSphereGeometry(1, finerGrid(finerGrid(SECTOR_GRID_16K)), { c: 31, r: 15 }, 8)],
  ];
  for (const [name, geo] of cases) {
    it(`is the same triangles, each in its own vertex order and its own leaf, for ${name}`, () => {
      const { widthSegments: w, heightSegments: h } = geo.parameters;
      const index = geo.index!.array;
      const out = new Uint32Array(index.length);
      const { cols, rows, start } = layoutSphereTriangles(index, w, h, LEAF, out);
      expect(cols).toBe(w / LEAF);
      expect(rows).toBe(h / LEAF);
      expect(start[cols * rows]).toBe(index.length);
      expect(triangles(out)).toEqual(triangles(index));
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const o = quadtreeOrdinal(x, y, cols, rows);
          for (let t = start[o]; t < start[o + 1]; t += 3) {
            for (let k = 0; k < 3; k++) {
              const v = out[t + k];
              const ix = v % (w + 1);
              const iy = Math.floor(v / (w + 1));
              // A triangle's corners lie on its leaf's cells or their far edges.
              expect(ix).toBeGreaterThanOrEqual(x * LEAF);
              expect(ix).toBeLessThanOrEqual((x + 1) * LEAF);
              expect(iy).toBeGreaterThanOrEqual(y * LEAF);
              expect(iy).toBeLessThanOrEqual((y + 1) * LEAF);
            }
          }
        }
      }
    });
  }

  it('puts a tile\'s footprint on the globe in one run holding exactly that tile\'s triangles', () => {
    // A level-j tile (c, r) covers the globe's leaves (c, r) · 2^(2−j), 2^(2−j)
    // on a side; the run there must be its own triangles, vertex for vertex
    // through the lattice (a tile's vertex (ix, iy) is the globe's
    // (c · seg + ix, r · seg + iy)).
    const globe = new THREE.SphereGeometry(1, 256, 128);
    const out = new Uint32Array(globe.index!.count);
    const { cols, rows, start } = layoutSphereTriangles(globe.index!.array, 256, 128, LEAF, out);
    let grid = SECTOR_GRID_16K;
    for (let level = 0; level <= 2; level++) {
      const seg = 32 >> level;
      const size = 1 << (2 - level);
      for (const s of [{ c: 0, r: 0 }, { c: grid.cols - 1, r: grid.rows - 1 }, { c: grid.cols >> 1, r: 1 }]) {
        const tile = sectorSphereGeometry(1, grid, s, seg);
        const ti = tile.index!.array;
        const mapped = new Uint32Array(ti.length);
        for (let i = 0; i < ti.length; i++) {
          const ix = ti[i] % (seg + 1);
          const iy = Math.floor(ti[i] / (seg + 1));
          mapped[i] = (s.r * seg + iy) * 257 + s.c * seg + ix;
        }
        const from = quadtreeOrdinal(s.c * size, s.r * size, cols, rows);
        expect(triangles(out, start[from], start[from + size * size])).toEqual(triangles(mapped));
      }
      grid = finerGrid(grid);
    }
  });

  it('refuses a grid that is not a power-of-two number of leaves', () => {
    const geo = new THREE.SphereGeometry(1, 48, 24);
    expect(() => layoutSphereTriangles(geo.index!.array, 48, 24, LEAF, new Uint32Array(geo.index!.count))).toThrow();
  });
});

describe('uncovered runs', () => {
  it('are the full list less the covered leaves, adjacent leaves merged', () => {
    const geo = new THREE.SphereGeometry(1, 256, 128);
    const full = new Uint16Array(geo.index!.count);
    const { start } = layoutSphereTriangles(geo.index!.array, 256, 128, LEAF, full);
    const covered = new Uint8Array(512);
    for (const o of [0, 1, 2, 3, 100, 101, 511]) covered[o] = 1;
    const out = new Uint16Array(full.length);
    const written = writeUncoveredRuns(full, start, covered, out, 0);
    const expected: number[] = [];
    for (let o = 0; o < 512; o++) if (!covered[o]) for (let t = start[o]; t < start[o + 1]; t++) expected.push(full[t]);
    expect(written).toBe(expected.length);
    expect(Array.from(out.subarray(0, written))).toEqual(expected);
    expect(writeUncoveredRuns(full, start, new Uint8Array(512), out, 0)).toBe(full.length);
  });
});

describe('a laid-out ground geometry', () => {
  it('carries 2N entries of its own index type and draws the full list until cut', () => {
    const geo = new THREE.SphereGeometry(1, 256, 128);
    const before = geo.index!.array;
    const n = before.length;
    const gi = layGroundIndex(geo, LEAF);
    expect(groundIndexOf(geo)).toBe(gi);
    expect(geo.index!.array.constructor).toBe(before.constructor);
    expect(geo.index!.count).toBe(2 * n);
    expect(geo.drawRange).toEqual({ start: 0, count: n });
    expect(triangles(geo.index!.array, 0, n)).toEqual(triangles(before));
    expect(groundIndexOf(new THREE.SphereGeometry(1, 256, 128))).toBeUndefined();
  });

  it('a cover draws the uncovered runs from the scratch half and uploads only what it wrote', () => {
    const geo = sectorSphereGeometry(1, SECTOR_GRID_16K, { c: 3, r: 1 }, 32);
    const gi = layGroundIndex(geo, LEAF);
    const index = geo.index!;
    const n = gi.full;
    // One level-1 child (2 × 2 leaves) and one level-2 grandchild elsewhere.
    beginGroundCover(gi);
    coverGroundLeaves(gi, 2, 0, 2);
    coverGroundLeaves(gi, 0, 3, 1);
    const version = index.version;
    commitGroundCover(gi);
    const k = geo.drawRange.count;
    expect(geo.drawRange.start).toBe(n);
    expect(k).toBe(n - (gi.start[8] - gi.start[4]) - (gi.start[quadtreeOrdinal(0, 3, 4, 4) + 1] - gi.start[quadtreeOrdinal(0, 3, 4, 4)]));
    expect(index.version).toBe(version + 1);
    expect(index.updateRanges).toEqual([{ start: n, count: k }]);
    // What it draws plus what it left out is the whole mesh.
    const drawn = triangles(index.array, n, n + k);
    const left = new Map(triangles(index.array, gi.start[4], gi.start[8]));
    const o = quadtreeOrdinal(0, 3, 4, 4);
    for (const [key, c] of triangles(index.array, gi.start[o], gi.start[o + 1])) left.set(key, (left.get(key) ?? 0) + c);
    const sum = new Map(drawn);
    for (const [key, c] of left) sum.set(key, (sum.get(key) ?? 0) + c);
    expect(sum).toEqual(triangles(index.array, 0, n));

    // An un-cut is a draw-range write; the same cover back uploads nothing.
    index.clearUpdateRanges();
    uncutGround(geo);
    expect(geo.drawRange).toEqual({ start: 0, count: n });
    beginGroundCover(gi);
    coverGroundLeaves(gi, 2, 0, 2);
    coverGroundLeaves(gi, 0, 3, 1);
    commitGroundCover(gi);
    expect(geo.drawRange).toEqual({ start: n, count: k });
    expect(index.version).toBe(version + 1);
    expect(index.updateRanges).toEqual([]);

    // Nothing covered is the full list, and so is a cover of everything but
    // nothing drawn: every leaf covered draws an empty range.
    beginGroundCover(gi);
    commitGroundCover(gi);
    expect(geo.drawRange).toEqual({ start: 0, count: n });
    beginGroundCover(gi);
    coverGroundLeaves(gi, 0, 0, 4);
    commitGroundCover(gi);
    expect(geo.drawRange).toEqual({ start: n, count: 0 });
  });

  it('refuses a geometry that is not the sphere its parameters say', () => {
    const geo = new THREE.SphereGeometry(1, 256, 128);
    (geo.parameters as { widthSegments: number }).widthSegments = 128;
    expect(() => layGroundIndex(geo, LEAF)).toThrow();
    expect(() => layGroundIndex(new THREE.BoxGeometry(), LEAF)).toThrow();
  });
});

describe('the kill switch', () => {
  it('is on unless the URL says groundcull=0', () => {
    expect(parseGroundCullParam('')).toBe(true);
    expect(parseGroundCullParam('?auto=planetarium&groundcull=1')).toBe(true);
    expect(parseGroundCullParam('?auto=planetarium&groundcull=0')).toBe(false);
  });
});
