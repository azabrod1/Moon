import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  sectorNearestDirection,
  SECTOR_GRID_16K,
  SECTOR_TILE,
  ancestorSector,
  applySectorTileTransform,
  dataCropLayout,
  finerGrid,
  parentSector,
  sectorAngularRadius,
  sectorBoundingSphere,
  sectorCentreDirection,
  sectorMayFaceCamera,
  sectorSphereArgs,
  sectorSphereGeometry,
  sectorTileTransform,
  sectorUvRect,
  sphereDirection,
} from './sectorGrid';
import { DEG2RAD } from '../../shared/math/angles';

const G = SECTOR_GRID_16K;
const allSectors = () => {
  const out: { c: number; r: number }[] = [];
  for (let r = 0; r < G.rows; r++) for (let c = 0; c < G.cols; c++) out.push({ c, r });
  return out;
};

describe('sector uv rectangles', () => {
  it('tile column 0 / row 0 is the north-west corner of the equirect', () => {
    expect(sectorUvRect(G, { c: 0, r: 0 })).toEqual({ u0: 0, u1: 0.125, v0: 0.75, v1: 1 });
  });

  it('the last tile is the south-east corner', () => {
    expect(sectorUvRect(G, { c: 7, r: 3 })).toEqual({ u0: 0.875, u1: 1, v0: 0, v1: 0.25 });
  });

  it('tiles the whole map exactly once', () => {
    let area = 0;
    for (const s of allSectors()) {
      const r = sectorUvRect(G, s);
      area += (r.u1 - r.u0) * (r.v1 - r.v0);
    }
    expect(area).toBeCloseTo(1, 12);
  });
});

describe('sector levels', () => {
  it('a level doubles the grid, and a sector\'s parent is its halved coordinates', () => {
    expect(finerGrid(G)).toEqual({ cols: 16, rows: 8 });
    expect(finerGrid(finerGrid(G))).toEqual({ cols: 32, rows: 16 });
    expect(parentSector({ c: 0, r: 0 })).toEqual({ c: 0, r: 0 });
    expect(parentSector({ c: 5, r: 3 })).toEqual({ c: 2, r: 1 });
    expect(parentSector({ c: 15, r: 7 })).toEqual({ c: 7, r: 3 });
    expect(ancestorSector({ c: 21, r: 13 }, 0)).toEqual({ c: 21, r: 13 });
    expect(ancestorSector({ c: 21, r: 13 }, 1)).toEqual({ c: 10, r: 6 });
    expect(ancestorSector({ c: 21, r: 13 }, 2)).toEqual({ c: 5, r: 3 });
  });

  it('the four children of a sector tile its rectangle exactly, and none leaves it', () => {
    const child = finerGrid(G);
    for (const p of allSectors()) {
      const pr = sectorUvRect(G, p);
      let area = 0;
      for (const s of [
        { c: 2 * p.c, r: 2 * p.r }, { c: 2 * p.c + 1, r: 2 * p.r },
        { c: 2 * p.c, r: 2 * p.r + 1 }, { c: 2 * p.c + 1, r: 2 * p.r + 1 },
      ]) {
        expect(parentSector(s)).toEqual(p);
        const cr = sectorUvRect(child, s);
        expect(cr.u0).toBeGreaterThanOrEqual(pr.u0 - 1e-12);
        expect(cr.u1).toBeLessThanOrEqual(pr.u1 + 1e-12);
        expect(cr.v0).toBeGreaterThanOrEqual(pr.v0 - 1e-12);
        expect(cr.v1).toBeLessThanOrEqual(pr.v1 + 1e-12);
        area += (cr.u1 - cr.u0) * (cr.v1 - cr.v0);
      }
      expect(area).toBeCloseTo((pr.u1 - pr.u0) * (pr.v1 - pr.v0), 12);
    }
  });

  it('a child\'s vertices land on the same lattice as its parent\'s, at half the segments', () => {
    // The level halves the segments as it doubles the grid: 16 per 22.5° is
    // the same 256 × 128 sphere 32 per 45° is, so a child never fights its
    // parent (or the globe) for depth along a chord.
    const R = 1.7;
    const key = (x: number, y: number, z: number) => `${x.toFixed(9)},${y.toFixed(9)},${z.toFixed(9)}`;
    const parentSet = new Set<string>();
    for (const s of allSectors()) {
      const pos = sectorSphereGeometry(R, G, s, 32).getAttribute('position');
      for (let i = 0; i < pos.count; i++) parentSet.add(key(pos.getX(i), pos.getY(i), pos.getZ(i)));
    }
    const child = finerGrid(G);
    for (const s of [{ c: 0, r: 0 }, { c: 7, r: 3 }, { c: 10, r: 5 }, { c: 15, r: 7 }]) {
      const geo = sectorSphereGeometry(R, child, s, 16);
      const pos = geo.getAttribute('position');
      expect(pos.count).toBe(17 * 17);
      for (let i = 0; i < pos.count; i++) {
        expect(parentSet.has(key(pos.getX(i), pos.getY(i), pos.getZ(i)))).toBe(true);
      }
    }
  });

  it('a child\'s uvs stay inside its own rectangle, which is inside its parent\'s', () => {
    const child = finerGrid(G);
    for (const s of [{ c: 3, r: 2 }, { c: 14, r: 6 }]) {
      const rect = sectorUvRect(child, s);
      const parentRect = sectorUvRect(G, parentSector(s));
      const uv = sectorSphereGeometry(1, child, s, 16).getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        expect(uv.getX(i)).toBeGreaterThanOrEqual(rect.u0 - 1e-12);
        expect(uv.getX(i)).toBeLessThanOrEqual(rect.u1 + 1e-12);
        expect(uv.getY(i)).toBeGreaterThanOrEqual(rect.v0 - 1e-12);
        expect(uv.getY(i)).toBeLessThanOrEqual(rect.v1 + 1e-12);
      }
      expect(rect.u0).toBeGreaterThanOrEqual(parentRect.u0);
      expect(rect.v1).toBeLessThanOrEqual(parentRect.v1);
    }
  });
});

describe('sector tile transform', () => {
  it('maps the sector rectangle onto the tile interior (three applies uv * repeat + offset)', () => {
    const g = SECTOR_TILE.gutterX / SECTOR_TILE.width; // 8/2048
    for (const s of allSectors()) {
      const rect = sectorUvRect(G, s);
      const t = sectorTileTransform(G, s);
      expect(rect.u0 * t.repeatX + t.offsetX).toBeCloseTo(g, 12);
      expect(rect.u1 * t.repeatX + t.offsetX).toBeCloseTo(1 - g, 12);
      expect(rect.v0 * t.repeatY + t.offsetY).toBeCloseTo(g, 12);
      expect(rect.v1 * t.repeatY + t.offsetY).toBeCloseTo(1 - g, 12);
    }
  });

  it('a gutterless layout maps exactly onto [0,1]²', () => {
    const rect = sectorUvRect(G, { c: 5, r: 2 });
    const t = sectorTileTransform(G, { c: 5, r: 2 }, { width: 2048, height: 2048, gutterX: 0, gutterY: 0, spanU: 1, leadU: 0 });
    expect(rect.u0 * t.repeatX + t.offsetX).toBeCloseTo(0, 12);
    expect(rect.u1 * t.repeatX + t.offsetX).toBeCloseTo(1, 12);
    expect(rect.v0 * t.repeatY + t.offsetY).toBeCloseTo(0, 12);
    expect(rect.v1 * t.repeatY + t.offsetY).toBeCloseTo(1, 12);
  });

  it('data crops: a 2048-wide base map cuts into 272² crops (256 content + 8 gutter) mapped alike', () => {
    const layout = dataCropLayout(G, 2048);
    expect(layout).toEqual({ width: 272, height: 272, gutterX: 8, gutterY: 8, spanU: 1, leadU: 0 });
    const rect = sectorUvRect(G, { c: 1, r: 3 });
    const t = sectorTileTransform(G, { c: 1, r: 3 }, layout);
    expect(rect.u0 * t.repeatX + t.offsetX).toBeCloseTo(8 / 272, 12);
    expect(rect.u1 * t.repeatX + t.offsetX).toBeCloseTo(264 / 272, 12);
    expect(rect.v0 * t.repeatY + t.offsetY).toBeCloseTo(8 / 272, 12);
    expect(rect.v1 * t.repeatY + t.offsetY).toBeCloseTo(264 / 272, 12);
    // The transform's pixel pitch matches the base map's: one sector of a
    // 2048-wide equirect is 256 texels either way.
    expect(t.repeatX * 272).toBeCloseTo(2048, 9);
  });

  it('normal-map crops are two sectors wide with a UNIFORM transform (the tangent frame cancels)', () => {
    const layout = dataCropLayout(G, 2880, 2); // 4k/moon-normal
    expect(layout).toEqual({ width: 752, height: 376, gutterX: 16, gutterY: 8, spanU: 2, leadU: 0.5 });
    for (const s of [{ c: 0, r: 0 }, { c: 3, r: 1 }, { c: 7, r: 3 }]) {
      const t = sectorTileTransform(G, s, layout);
      // Uniform scale: three normalises its derivative tangent frame by the
      // larger axis, so only an equal u/v scale shades relief like the globe.
      expect(t.repeatX).toBeCloseTo(t.repeatY, 12);
      // The sector's own rectangle lands in the middle half of the interior.
      const rect = sectorUvRect(G, s);
      const gW = 16 / 752;
      const fW = 720 / 752;
      expect(rect.u0 * t.repeatX + t.offsetX).toBeCloseTo(gW + 0.25 * fW, 12);
      expect(rect.u1 * t.repeatX + t.offsetX).toBeCloseTo(gW + 0.75 * fW, 12);
      expect(rect.v0 * t.repeatY + t.offsetY).toBeCloseTo(8 / 376, 12);
      expect(rect.v1 * t.repeatY + t.offsetY).toBeCloseTo(368 / 376, 12);
    }
  });

  it('applies to a texture with clamped wrapping (a sector never wraps)', () => {
    const tex = new THREE.Texture();
    applySectorTileTransform(tex, G, { c: 3, r: 2 });
    expect(tex.wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect(tex.wrapT).toBe(THREE.ClampToEdgeWrapping);
    // The transform is what three's mapTransform uniform is built from.
    tex.updateMatrix();
    const g = SECTOR_TILE.gutterX / SECTOR_TILE.width;
    const p = new THREE.Vector3(0.375, 0.5, 1).applyMatrix3(tex.matrix); // sector (3,2)'s NW corner
    expect(p.x).toBeCloseTo(g, 12);
    expect(p.y).toBeCloseTo(1 - g, 12);
  });
});

describe('sector geometry', () => {
  it('sphere args partition phi and theta', () => {
    const a = sectorSphereArgs(G, { c: 2, r: 1 });
    expect(a.phiStart).toBeCloseTo(Math.PI / 2, 12);
    expect(a.phiLength).toBeCloseTo(Math.PI / 4, 12);
    expect(a.thetaStart).toBeCloseTo(Math.PI / 4, 12);
    expect(a.thetaLength).toBeCloseTo(Math.PI / 4, 12);
  });

  it('vertices coincide with the 256-segment base sphere the silhouette upgrade builds', () => {
    // 32 segments per 45° sector = 256 × 128 across the full sphere: every
    // sector vertex must land on a base-sphere vertex, or an overlaid sector
    // would fight its base for depth along every chord.
    const R = 1.7;
    const base = new THREE.SphereGeometry(R, 256, 128);
    const basePos = base.getAttribute('position');
    const key = (x: number, y: number, z: number) => `${x.toFixed(9)},${y.toFixed(9)},${z.toFixed(9)}`;
    const baseSet = new Set<string>();
    for (let i = 0; i < basePos.count; i++) baseSet.add(key(basePos.getX(i), basePos.getY(i), basePos.getZ(i)));
    for (const s of [{ c: 0, r: 0 }, { c: 3, r: 1 }, { c: 7, r: 3 }, { c: 5, r: 2 }]) {
      const geo = sectorSphereGeometry(R, G, s, 32);
      const pos = geo.getAttribute('position');
      expect(pos.count).toBe(33 * 33);
      for (let i = 0; i < pos.count; i++) {
        expect(baseSet.has(key(pos.getX(i), pos.getY(i), pos.getZ(i)))).toBe(true);
      }
    }
  });

  it('carries global equirect uvs, matching the base sphere at shared vertices', () => {
    const R = 1;
    const base = new THREE.SphereGeometry(R, 256, 128);
    const basePos = base.getAttribute('position');
    const baseUv = base.getAttribute('uv');
    const byPos = new Map<string, [number, number]>();
    const key = (x: number, y: number, z: number) => `${x.toFixed(9)},${y.toFixed(9)},${z.toFixed(9)}`;
    for (let i = 0; i < basePos.count; i++) {
      byPos.set(key(basePos.getX(i), basePos.getY(i), basePos.getZ(i)), [baseUv.getX(i), baseUv.getY(i)]);
    }
    for (const s of [{ c: 1, r: 1 }, { c: 6, r: 2 }]) {
      const geo = sectorSphereGeometry(R, G, s, 32);
      const pos = geo.getAttribute('position');
      const uv = geo.getAttribute('uv');
      const rect = sectorUvRect(G, s);
      for (let i = 0; i < pos.count; i++) {
        const u = uv.getX(i);
        const v = uv.getY(i);
        expect(u).toBeGreaterThanOrEqual(rect.u0 - 1e-12);
        expect(u).toBeLessThanOrEqual(rect.u1 + 1e-12);
        expect(v).toBeGreaterThanOrEqual(rect.v0 - 1e-12);
        expect(v).toBeLessThanOrEqual(rect.v1 + 1e-12);
        // Interior vertices (not on the seam column, where the base sphere's
        // duplicate seam vertex holds u=1) match the base sphere's uv exactly.
        const b = byPos.get(key(pos.getX(i), pos.getY(i), pos.getZ(i)));
        if (b && b[0] < 1 && u < 1) {
          expect(u).toBeCloseTo(b[0], 12);
          expect(v).toBeCloseTo(b[1], 12);
        }
      }
    }
  });

  it('keeps three\'s half-texel pole shift on the polar rows only', () => {
    const north = sectorSphereGeometry(1, G, { c: 0, r: 0 }, 32).getAttribute('uv');
    const rect = sectorUvRect(G, { c: 0, r: 0 });
    expect(north.getX(0)).toBeCloseTo(rect.u0 + (0.5 / 32) * (rect.u1 - rect.u0), 12); // apex row shifted
    const mid = sectorSphereGeometry(1, G, { c: 0, r: 1 }, 32).getAttribute('uv');
    expect(mid.getX(0)).toBeCloseTo(0, 12); // an equatorial-band sector's top row is not a pole
  });
});

describe('sector directions and extents', () => {
  it('centre direction is the parametric centre of the sector on three\'s sphere', () => {
    const d = sectorCentreDirection(G, { c: 2, r: 1 }, new THREE.Vector3());
    const expected = sphereDirection(2.5 / 8, 1.5 / 4, new THREE.Vector3());
    expect(d.distanceTo(expected)).toBeLessThan(1e-12);
    expect(d.length()).toBeCloseTo(1, 12);
  });

  it('angular radius: 31.4° for equatorial-band sectors, and every polar sector contains its pole', () => {
    const equatorial = sectorAngularRadius(G, { c: 4, r: 1 });
    expect(equatorial / DEG2RAD).toBeCloseTo(31.4, 0);
    for (let c = 0; c < G.cols; c++) {
      const rho = sectorAngularRadius(G, { c, r: 0 });
      const centre = sectorCentreDirection(G, { c, r: 0 }, new THREE.Vector3());
      expect(centre.angleTo(new THREE.Vector3(0, 1, 0))).toBeLessThanOrEqual(rho + 1e-12);
      expect(rho).toBeLessThan(35 * DEG2RAD);
    }
  });

  it('bounding sphere contains every vertex of the sector geometry', () => {
    const R = 2.5;
    for (const s of allSectors()) {
      const centre = new THREE.Vector3();
      const bs = sectorBoundingSphere(G, s, R, centre);
      const pos = sectorSphereGeometry(R, G, s, 32).getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const d = Math.hypot(pos.getX(i) - bs.centre.x, pos.getY(i) - bs.centre.y, pos.getZ(i) - bs.centre.z);
        expect(d).toBeLessThanOrEqual(bs.radius * (1 + 1e-9));
      }
    }
  });
});

describe('sectorMayFaceCamera', () => {
  const R = 1;
  it('a sector under the camera faces it; the antipodal sector does not', () => {
    const dir = sectorCentreDirection(G, { c: 2, r: 1 }, new THREE.Vector3());
    const rho = sectorAngularRadius(G, { c: 2, r: 1 });
    const above = dir.clone().multiplyScalar(3 * R);
    expect(sectorMayFaceCamera(dir, rho, above, R)).toBe(true);
    expect(sectorMayFaceCamera(dir, rho, above.clone().negate(), R)).toBe(false);
  });

  it('a sector 90° off the camera axis faces a distant camera but not a close one', () => {
    // Horizon half-angle: acos(R/d) → 84° at d = 10R (limb sectors visible),
    // 48° at d = 1.5R. With ρ ≈ 31°, the 90°-off sector is inside 84+31 but
    // outside 48+31.
    const dir = new THREE.Vector3(1, 0, 0);
    const rho = 31.4 * DEG2RAD;
    expect(sectorMayFaceCamera(dir, rho, new THREE.Vector3(0, 10 * R, 0), R)).toBe(true);
    expect(sectorMayFaceCamera(dir, rho, new THREE.Vector3(0, 1.5 * R, 0), R)).toBe(false);
  });

  it('a camera at or inside the surface sees everything (no degenerate acos)', () => {
    const dir = new THREE.Vector3(0, 0, 1);
    expect(sectorMayFaceCamera(dir, 0.5, new THREE.Vector3(0, 0, -0.5), R)).toBe(true);
  });
});

describe('sectorNearestDirection', () => {
  const G = SECTOR_GRID_16K;
  const dirOf = (u: number, v: number) => sphereDirection(u, v, new THREE.Vector3());

  it('returns the direction itself when the sector contains it', () => {
    const d = dirOf(2.3 / 8, 1.6 / 4); // inside sector (2, 1)
    const out = sectorNearestDirection(G, { c: 2, r: 1 }, d, new THREE.Vector3());
    expect(out.distanceTo(d)).toBeLessThan(1e-12);
  });

  it('clamps to the near edge of a neighbouring sector, in longitude and latitude', () => {
    const d = dirOf(2.3 / 8, 1.6 / 4);
    // Sector (3, 1) lies east: nearest point is on its western edge at the same latitude.
    expect(sectorNearestDirection(G, { c: 3, r: 1 }, d, new THREE.Vector3()).distanceTo(dirOf(3 / 8, 1.6 / 4))).toBeLessThan(1e-12);
    // Sector (2, 2) lies south: nearest point is on its northern edge at the same longitude.
    expect(sectorNearestDirection(G, { c: 2, r: 2 }, d, new THREE.Vector3()).distanceTo(dirOf(2.3 / 8, 2 / 4))).toBeLessThan(1e-12);
    // A diagonal neighbour meets at the shared corner.
    expect(sectorNearestDirection(G, { c: 3, r: 2 }, d, new THREE.Vector3()).distanceTo(dirOf(3 / 8, 2 / 4))).toBeLessThan(1e-12);
  });

  it('wraps in longitude: the eastern edge of column 7 is next to column 0', () => {
    const d = dirOf(0.2 / 8, 1.5 / 4); // just inside column 0
    const out = sectorNearestDirection(G, { c: 7, r: 1 }, d, new THREE.Vector3());
    expect(out.distanceTo(dirOf(1, 1.5 / 4))).toBeLessThan(1e-12); // column 7's eastern edge (u = 1 ≡ 0)
  });

  it('a polar sector reaches the pole itself', () => {
    const d = new THREE.Vector3(0, 1, 0); // the north pole
    const out = sectorNearestDirection(G, { c: 5, r: 0 }, d, new THREE.Vector3());
    expect(out.distanceTo(d)).toBeLessThan(1e-9);
  });
});
