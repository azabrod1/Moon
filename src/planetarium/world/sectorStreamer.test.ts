import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  SECTOR_ADMIT_MARGIN,
  SECTOR_ATTEMPT_TIMEOUT_MS,
  SECTOR_BUDGET_BYTES_DESKTOP,
  SECTOR_BUDGET_BYTES_TOUCH,
  SECTOR_ENVELOPE_BYTES_DESKTOP,
  SECTOR_EVICT_DWELL_MS,
  SECTOR_INFLIGHT_CAP_DESKTOP,
  SECTOR_LEVEL_16K,
  SECTOR_RELEASE_TEXEL_PX,
  SECTOR_RESIDENT_CAP_DESKTOP,
  SECTOR_RESIDENT_CAP_TOUCH,
  SECTOR_RELEASE_TEXEL_PX_TOUCH,
  SECTOR_RETRY_MS,
  SECTOR_SETS,
  SECTOR_WANT_TEXEL_PX,
  SECTOR_WANT_TEXEL_PX_TOUCH,
  SectorStreamer,
  sectorSetGpuBytes,
  type SectorBodyHandle,
  type SectorLevel,
  type SectorMeasure,
} from './sectorStreamer';
import { SECTOR_RENDER_ORDER } from './sectorMaterial';
import { SECTOR_GRID_16K, finerGrid, sectorCentreDirection, sectorTileTransform, dataCropLayout, SECTOR_TILE, sphereDirection } from './sectorGrid';
import { augmentSurfaceMaterial } from './surfaceShading';
import type { WarmOutcome } from './textureWarmer';

/** A scripted loader: records every URL, and lets a test resolve or fail
 *  each one later (or synchronously with `auto`). */
class FakeLoader {
  requests: Array<{ url: string; onLoad: (t: THREE.Texture) => void; onError: (e: unknown) => void; stillWanted?: () => boolean; signal?: AbortSignal }> = [];
  auto = false;
  load = (url: string, onLoad: (t: THREE.Texture) => void, onError: (e: unknown) => void, stillWanted?: () => boolean, signal?: AbortSignal) => {
    this.requests.push({ url, onLoad, onError, stillWanted, signal });
    if (this.auto) onLoad(new THREE.Texture());
  };
  resolveAll(): number {
    const pending = this.requests.splice(0);
    for (const r of pending) r.onLoad(new THREE.Texture());
    return pending.length;
  }
  failAll(): void {
    for (const r of this.requests.splice(0)) r.onError(new Error('404'));
  }
}

/** A scripted warm pump: settles every queued texture with one outcome. */
class FakeWarm {
  queued: Array<{ tex: THREE.Texture; done: (o: WarmOutcome) => void }> = [];
  auto: WarmOutcome | null = 'warmed';
  warm = (tex: THREE.Texture, done: (o: WarmOutcome) => void) => {
    this.queued.push({ tex, done });
    if (this.auto) done(this.auto);
  };
  settle(outcome: WarmOutcome): void {
    for (const q of this.queued.splice(0)) q.done(outcome);
  }
}

const G = SECTOR_GRID_16K;
const R = 1;
// What one Earth sector costs the budget (its 2048² tile plus its own copies
// of the bump and roughness crops) and how many of them each device holds.
const EARTH_SET_BYTES = sectorSetGpuBytes(SECTOR_SETS.Earth);
const EARTH_FITS_DESKTOP = Math.floor(SECTOR_BUDGET_BYTES_DESKTOP / EARTH_SET_BYTES);
const EARTH_FITS_TOUCH = Math.floor(SECTOR_BUDGET_BYTES_TOUCH / EARTH_SET_BYTES);
// Sizes in these tests are TEXEL magnifications (device px per base-map texel)
// for the 4K map the fake material is taken to draw (no readable image, so
// the streamer assumes 4096 wide); measureOf turns them into pxPerLocalUnit.
const TEXEL_LEN_4K = (2 * Math.PI * R) / 4096;

function earthHandle(): SectorBodyHandle & { fineCalls: number } {
  const material = new THREE.MeshStandardMaterial({
    map: new THREE.Texture(),
    bumpMap: new THREE.Texture(),
    roughnessMap: new THREE.Texture(),
  });
  augmentSurfaceMaterial(material, 'earth');
  material.userData.colorTierRank = 2; // a real boot map is on the globe
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(R, 16, 8), material);
  const handle: SectorBodyHandle & { fineCalls: number } = {
    name: 'Earth',
    spec: SECTOR_SETS.Earth,
    mesh,
    material,
    radiusAU: R,
    fineCalls: 0,
    ensureFineGeometry: () => { handle.fineCalls++; },
  };
  return handle;
}

/** Camera straight above sector (c, r) at `dist` radii. */
function cameraOver(c: number, r: number, dist = 1.5): THREE.Vector3 {
  return sectorCentreDirection(G, { c, r }, new THREE.Vector3()).multiplyScalar(dist * R);
}

/** A measure that magnifies a listed set of sectors (by "c_r", in texel px) and hides the rest. */
function measureOf(sizes: Record<string, number>, centrality = 1) {
  return measureLevels([SECTOR_LEVEL_16K], sizes, centrality);
}

/** No level-1 tiles ship yet, so the pyramid is exercised on a synthetic
 *  second level: the 16×8 grid of 2048² tiles cut from a 32512-wide source
 *  that Earth's level 1 will be. */
const LEVEL_1: SectorLevel = {
  tier: '32k',
  grid: finerGrid(SECTOR_GRID_16K),
  layout: SECTOR_TILE,
  sourceWidth: 2 * SECTOR_LEVEL_16K.sourceWidth,
};
const TWO_LEVELS = [SECTOR_LEVEL_16K, LEVEL_1];

/** Surface length of the texel a level's demand is measured against: the
 *  globe's map for level 0, the level below's source for the rest. */
function refTexelLen(levels: SectorLevel[], level: number): number {
  return level === 0 ? TEXEL_LEN_4K : (2 * Math.PI * R) / levels[level - 1].sourceWidth;
}

/** A measure over a pyramid: sizes are keyed by the stats id ("c_r" at level
 *  0, "L1/c_r" below it) and given in texel px OF THAT LEVEL'S OWN reference
 *  map, so one number means the same thing at every level. */
function measureLevels(levels: SectorLevel[], sizes: Record<string, number>, centrality = 1) {
  return (centre: THREE.Vector3, _radius?: number, _dir?: THREE.Vector3): SectorMeasure | null => {
    for (let level = 0; level < levels.length; level++) {
      const grid = levels[level].grid;
      for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) {
          const d = sectorCentreDirection(grid, { c, r }, new THREE.Vector3()).multiplyScalar(R);
          if (d.distanceTo(centre) < 1e-9) {
            const px = sizes[level === 0 ? `${c}_${r}` : `L${level}/${c}_${r}`];
            return px === undefined ? null : { pxPerLocalUnit: px / refTexelLen(levels, level), centrality };
          }
        }
      }
    }
    return null;
  };
}

describe('SectorStreamer', () => {
  let loader: FakeLoader;
  let warm: FakeWarm;
  let streamer: SectorStreamer;
  let earth: ReturnType<typeof earthHandle>;

  beforeEach(() => {
    loader = new FakeLoader();
    warm = new FakeWarm();
    streamer = new SectorStreamer({ touch: false, load: loader.load, warm: warm.warm });
    earth = earthHandle();
    streamer.register(earth);
  });

  it('asks later on touch, and releases later', () => {
    expect(SECTOR_WANT_TEXEL_PX_TOUCH).toBeGreaterThan(SECTOR_WANT_TEXEL_PX);
    const s = new SectorStreamer({ touch: true, load: loader.load, warm: warm.warm });
    s.register(earth);
    loader.auto = true;
    s.update('Earth', cameraOver(2, 1), measureOf({ '2_1': SECTOR_WANT_TEXEL_PX_TOUCH - 0.01 }), 0);
    expect(s.stats().resident).toBe(0);
    s.update('Earth', cameraOver(2, 1), measureOf({ '2_1': SECTOR_WANT_TEXEL_PX_TOUCH + 0.01 }), 16);
    expect(s.stats().resident).toBe(1);
    s.update('Earth', cameraOver(2, 1), measureOf({ '2_1': SECTOR_RELEASE_TEXEL_PX_TOUCH + 0.01 }), 32);
    expect(s.stats().resident).toBe(1);
    s.update('Earth', cameraOver(2, 1), measureOf({ '2_1': SECTOR_RELEASE_TEXEL_PX_TOUCH - 0.01 }), 48);
    expect(s.stats().resident).toBe(0);
  });

  it('requests nothing while every facing sector is under the want size', () => {
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': SECTOR_WANT_TEXEL_PX - 0.01 }), 0);
    expect(loader.requests).toEqual([]);
    expect(streamer.stats().resident).toBe(0);
  });

  it('loads the colour tile plus the crops the base material carries, with sector-exact URLs', () => {
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    const urls = loader.requests.map((r) => r.url).sort();
    expect(urls).toEqual([
      expect.stringMatching(/textures\/tiles\/earth-bump\/2k\/2_1\.webp$/),
      expect.stringMatching(/textures\/tiles\/earth-day\.v2\/16k\/2_1\.webp$/),
      expect.stringMatching(/textures\/tiles\/earth-roughness\.v2\/4k\/2_1\.webp$/),
    ]);
    expect(streamer.stats().bodies.Earth.loading).toEqual(['2_1']);
  });

  it('shows the sector only once every map is resident, as a child of the globe drawn first', () => {
    warm.auto = null; // hold uploads
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    // The globe goes onto its fine grid at admission — the fetch separates
    // that rebuild from the frame that pays the upload.
    expect(earth.fineCalls).toBe(1);
    expect(loader.resolveAll()).toBe(3);
    expect(earth.mesh.children.length).toBe(0); // decoded, not yet uploaded
    warm.settle('warmed');
    expect(earth.mesh.children.length).toBe(1);
    const sectorMesh = earth.mesh.children[0] as THREE.Mesh;
    expect(sectorMesh.renderOrder).toBe(SECTOR_RENDER_ORDER);
    expect(earth.fineCalls).toBe(1); // and not again when the tile lands
    const mat = sectorMesh.material as THREE.MeshStandardMaterial;
    expect(mat.map).not.toBe(earth.material.map);
    expect(mat.bumpMap).not.toBe(earth.material.bumpMap);
    expect(mat.roughnessMap).not.toBe(earth.material.roughnessMap);
    // Each map carries its own layout's transform: colour tile vs 2K crop.
    const tileT = sectorTileTransform(G, { c: 2, r: 1 }, SECTOR_TILE);
    const cropT = sectorTileTransform(G, { c: 2, r: 1 }, dataCropLayout(G, 2048));
    expect(mat.map!.repeat.x).toBeCloseTo(tileT.repeatX, 12);
    expect(mat.map!.offset.x).toBeCloseTo(tileT.offsetX, 12);
    expect(mat.bumpMap!.repeat.x).toBeCloseTo(cropT.repeatX, 12);
    expect(mat.map!.wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect(streamer.stats().bodies.Earth.resident).toEqual(['2_1']);
  });

  it('keeps a resident sector between release and want, and releases below release', () => {
    loader.auto = true;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    expect(streamer.stats().resident).toBe(1);
    const sectorMesh = earth.mesh.children[0] as THREE.Mesh;
    let disposed = 0;
    for (const t of [sectorMesh.material as THREE.MeshStandardMaterial].flatMap((m) => [m.map!, m.bumpMap!, m.roughnessMap!])) {
      t.addEventListener('dispose', () => disposed++);
    }
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': (SECTOR_WANT_TEXEL_PX + SECTOR_RELEASE_TEXEL_PX) / 2 }), 16);
    expect(streamer.stats().resident).toBe(1); // hysteresis band: stays
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': SECTOR_RELEASE_TEXEL_PX - 0.01 }), 32);
    expect(streamer.stats().resident).toBe(0);
    expect(earth.mesh.children.length).toBe(0);
    expect(disposed).toBe(3); // every owned texture freed
  });

  it('releases a sector that no longer faces the camera', () => {
    loader.auto = true;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    expect(streamer.stats().resident).toBe(1);
    streamer.update('Earth', cameraOver(6, 2), measureOf({ '2_1': 2 }), 16); // antipode
    expect(streamer.stats().resident).toBe(0);
  });

  it('bounds fetches in flight', () => {
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 4; c++) sizes[`${c}_1`] = 2 + 0.01 * c;
    streamer.update('Earth', new THREE.Vector3(0, 0, 0), measureOf(sizes), 0); // inside: every sector faces
    expect(streamer.stats().loading).toBe(SECTOR_INFLIGHT_CAP_DESKTOP);
    // Largest first (stats list in grid order).
    expect(streamer.stats().bodies.Earth.loading.slice().sort()).toEqual(['2_1', '3_1']);
  });

  it('holds what the byte budget holds, and only evicts for a candidate that out-ranks by the margin', () => {
    loader.auto = true;
    // The budget is what bounds the working set; the count cap is the
    // emergency ceiling above it and never binds for a set this size.
    expect(EARTH_FITS_DESKTOP).toBeLessThan(SECTOR_RESIDENT_CAP_DESKTOP);
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) { sizes[`${c}_1`] = 2 + 0.01 * c; sizes[`${c}_2`] = 2.1 + 0.01 * c; }
    // Fill the budget over a few frames (in-flight limit paces admissions).
    for (let f = 0; f < 12; f++) streamer.update('Earth', new THREE.Vector3(0, 0, 0), measureOf(sizes), f * 16);
    expect(streamer.stats().resident).toBe(EARTH_FITS_DESKTOP);
    const stats = streamer.stats();
    expect(stats.residentBytes).toBe(EARTH_FITS_DESKTOP * EARTH_SET_BYTES);
    expect(stats.residentBytes + stats.reserved).toBeLessThanOrEqual(stats.budget);
    const before = stats.bodies.Earth.resident.slice().sort();
    // A new sector slightly larger than the weakest resident does not evict it…
    const weakestPx = Math.min(...before.map((id) => sizes[id]));
    sizes['0_0'] = weakestPx * SECTOR_ADMIT_MARGIN * 0.99;
    streamer.update('Earth', new THREE.Vector3(0, 0, 0), measureOf(sizes), 2_000);
    expect(streamer.stats().bodies.Earth.resident.slice().sort()).toEqual(before);
    // …one that out-ranks it by the margin does, and takes its place.
    sizes['0_0'] = weakestPx * SECTOR_ADMIT_MARGIN * 1.01;
    streamer.update('Earth', new THREE.Vector3(0, 0, 0), measureOf(sizes), 2_016);
    const after = streamer.stats().bodies.Earth.resident;
    expect(after.length).toBe(EARTH_FITS_DESKTOP);
    expect(after).toContain('0_0');
  });

  it('holds a smaller working set on touch devices', () => {
    const s = new SectorStreamer({ touch: true, load: loader.load, warm: warm.warm });
    s.register(earth);
    loader.auto = true;
    expect(EARTH_FITS_TOUCH).toBeLessThan(EARTH_FITS_DESKTOP);
    expect(EARTH_FITS_TOUCH).toBeLessThan(SECTOR_RESIDENT_CAP_TOUCH);
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) sizes[`${c}_1`] = 2 + 0.01 * c;
    for (let f = 0; f < 12; f++) s.update('Earth', new THREE.Vector3(0, 0, 0), measureOf(sizes), f * 16);
    expect(s.stats().resident).toBe(EARTH_FITS_TOUCH);
    expect(s.stats().residentBytes).toBeLessThanOrEqual(SECTOR_BUDGET_BYTES_TOUCH);
  });

  it('a load superseded by release never materializes and drops its bytes', () => {
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    const pending = loader.requests.splice(0);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 0.1 }), 16); // released while in flight
    expect(pending[0].stillWanted!()).toBe(false);
    let disposed = 0;
    for (const p of pending) {
      const tex = new THREE.Texture();
      tex.addEventListener('dispose', () => disposed++);
      p.onLoad(tex);
    }
    expect(disposed).toBe(3);
    expect(earth.mesh.children.length).toBe(0);
    expect(streamer.stats().resident).toBe(0);
  });

  it('a failed fetch cools the sector down, doubling per consecutive failure', () => {
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    loader.failAll();
    expect(streamer.stats().loading).toBe(0);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), SECTOR_RETRY_MS - 1);
    expect(loader.requests.length).toBe(0); // still cooling
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), SECTOR_RETRY_MS + 1);
    expect(loader.requests.length).toBe(3); // retried
    loader.failAll();
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), SECTOR_RETRY_MS + 1 + SECTOR_RETRY_MS * 1.5);
    expect(loader.requests.length).toBe(0); // second cooldown is twice as long
  });

  it('a failed upload counts as a failure (the texture is never drawn cold)', () => {
    warm.auto = 'failed';
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    loader.resolveAll();
    expect(earth.mesh.children.length).toBe(0);
    expect(streamer.stats().resident).toBe(0);
    expect(streamer.stats().loading).toBe(0);
  });

  /** A Mars whose relief has not arrived: sectors load colour only. */
  function marsWithoutRelief(): ReturnType<typeof earthHandle> {
    const mars = earthHandle();
    mars.name = 'Mars';
    mars.spec = SECTOR_SETS.Mars;
    mars.material.bumpMap = null;
    mars.material.roughnessMap = null;
    mars.material.normalMap = null;
    streamer.register(mars);
    return mars;
  }
  const sectorMesh = (h: SectorBodyHandle) => h.mesh.children[0] as THREE.Mesh;
  const sectorMat = (h: SectorBodyHandle) => sectorMesh(h).material as THREE.MeshStandardMaterial;
  const disposed = (r: { addEventListener: THREE.Texture['addEventListener'] }) => {
    let d = false;
    (r as THREE.Texture).addEventListener('dispose', () => { d = true; });
    return () => d;
  };

  it('reloads a resident sector in place when the base gains a relief map it lacks', () => {
    const mars = marsWithoutRelief();
    loader.auto = true;
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    expect(streamer.stats().bodies.Mars.resident).toEqual(['2_1']);
    expect(loader.requests.map((r) => r.url)).toEqual([expect.stringMatching(/tiles\/mars\.v2\/16k\/2_1\.webp$/)]);
    loader.requests.length = 0;
    const before = sectorMesh(mars);
    const colourTile = sectorMat(mars).map!;
    const oldMaterialGone = disposed(sectorMat(mars));
    loader.auto = false;
    mars.material.normalMap = new THREE.Texture(); // MOLA relief lands
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16);
    // Only the crop is fetched — the colour tile is the same URL and the one
    // upload that costs — and the old sector keeps drawing meanwhile.
    expect(loader.requests.map((r) => r.url)).toEqual([expect.stringMatching(/tiles\/mars-normal\.v2\/2k\/2_1\.webp$/)]);
    expect(streamer.stats().bodies.Mars.resident).toEqual(['2_1']);
    expect(streamer.stats().bodies.Mars.reloading).toEqual(['2_1']);
    expect(streamer.stats().inflight).toBe(1);
    expect(streamer.stats().loading).toBe(0);
    expect(sectorMesh(mars)).toBe(before);
    expect(mars.mesh.children).toHaveLength(1);
    loader.resolveAll();
    // The swap: new mesh with the crop, old material disposed, colour tile
    // and geometry reused.
    expect(mars.mesh.children).toHaveLength(1);
    expect(sectorMesh(mars)).not.toBe(before);
    expect(sectorMesh(mars).geometry).toBe(before.geometry);
    expect(sectorMat(mars).normalMap).not.toBeNull();
    expect(sectorMat(mars).map).toBe(colourTile);
    expect(oldMaterialGone()).toBe(true);
    expect(streamer.stats().bodies.Mars.reloading).toEqual([]);
    expect(streamer.stats().bodies.Mars.resident).toEqual(['2_1']);
    // Settled: the next frame asks for nothing more.
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 32);
    expect(loader.requests).toEqual([]);
  });

  it('does not reload a resident where no fetch is allowed — past the limb, on the night side', () => {
    const mars = marsWithoutRelief();
    loader.auto = true;
    const sunOver = (c: number, r: number) => sectorCentreDirection(G, { c, r }, new THREE.Vector3());
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0, 'none', sunOver(2, 1));
    loader.auto = false;
    loader.requests.length = 0;
    mars.material.normalMap = new THREE.Texture();
    // Sunset first: the resident stays (kept while big) but nothing is fetched for it.
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16, 'none', sunOver(6, 2));
    expect(streamer.stats().bodies.Mars.resident).toEqual(['2_1']);
    expect(loader.requests).toEqual([]);
    // Sunrise: now it reloads.
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 32, 'none', sunOver(2, 1));
    expect(loader.requests.map((r) => r.url)).toEqual([expect.stringMatching(/tiles\/mars-normal\.v2\/2k\/2_1\.webp$/)]);
  });

  it('keeps a resident drawing when its reload fails, and retries after the backoff', () => {
    const mars = marsWithoutRelief();
    loader.auto = true;
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    const before = sectorMesh(mars);
    loader.auto = false;
    loader.requests.length = 0;
    mars.material.normalMap = new THREE.Texture();
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16);
    expect(loader.requests).toHaveLength(1);
    loader.failAll();
    expect(streamer.stats().bodies.Mars.resident).toEqual(['2_1']);
    expect(sectorMesh(mars)).toBe(before);
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 32);
    expect(loader.requests).toEqual([]); // cooling down, not hammering
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 32 + SECTOR_RETRY_MS);
    expect(loader.requests.map((r) => r.url)).toEqual([expect.stringMatching(/tiles\/mars-normal\.v2\/2k\/2_1\.webp$/)]);
  });

  it('abandons a reload whose set the base no longer has, keeping the resident', () => {
    const mars = marsWithoutRelief();
    loader.auto = true;
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    const before = sectorMesh(mars);
    loader.auto = false;
    mars.material.normalMap = new THREE.Texture();
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16);
    const request = loader.requests.splice(0)[0];
    mars.material.normalMap = null; // the relief went away again
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 32);
    expect(loader.requests).toEqual([]);
    expect(sectorMesh(mars)).toBe(before);
    // The late crop finds its attempt gone and disposes itself.
    const late = new THREE.Texture();
    const lateGone = disposed(late);
    request.onLoad(late);
    expect(lateGone()).toBe(true);
    expect(sectorMesh(mars)).toBe(before);
  });

  it('drops a crop without a fetch when the base loses that map', () => {
    loader.auto = true;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    expect(sectorMat(earth).bumpMap).not.toBeNull();
    const colourTile = sectorMat(earth).map!;
    const oldBump = sectorMat(earth).bumpMap!;
    const bumpGone = disposed(oldBump);
    loader.requests.length = 0;
    earth.material.bumpMap = null;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16);
    expect(loader.requests).toEqual([]);
    expect(sectorMat(earth).bumpMap).toBeNull();
    expect(sectorMat(earth).map).toBe(colourTile);
    expect(bumpGone()).toBe(true);
    expect(streamer.stats().bodies.Earth.resident).toEqual(['2_1']);
  });

  it('reports the GPU bytes its textures hold, from their sizes', () => {
    const sized = (w: number, h: number) => { const t = new THREE.Texture(); t.image = { width: w, height: h }; return t; };
    loader.load = (url, onLoad) => onLoad(/earth-day/.test(url) ? sized(2048, 2048) : sized(272, 272));
    const s = new SectorStreamer({ touch: false, load: loader.load, warm: warm.warm });
    s.register(earth);
    s.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    // One colour tile plus two crops (bump, roughness), RGBA8 with mips.
    const tile = Math.round(2048 * 2048 * 4 * (4 / 3));
    const crop = Math.round(272 * 272 * 4 * (4 / 3));
    expect(s.stats().bodies.Earth.gpuBytes).toBe(tile + 2 * crop);
    expect(s.stats().gpuBytes).toBe(tile + 2 * crop);
    // The figure survives the bitmap being closed after upload.
    const mat = (earth.mesh.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    mat.map!.image = undefined;
    expect(s.stats().gpuBytes).toBe(tile + 2 * crop);
    s.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 0.1 }), 16);
    expect(s.stats().gpuBytes).toBe(0);
  });

  it('aborts the fetches of a sector released while they are in the air', () => {
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    expect(loader.requests.length).toBeGreaterThan(0);
    expect(loader.requests.every((r) => r.signal && !r.signal.aborted)).toBe(true);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 0.1 }), 16);
    expect(loader.requests.every((r) => r.signal!.aborted)).toBe(true);
  });

  it('gives up on a load that never settles, aborts it, and retries after the backoff', () => {
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    const first = loader.requests.splice(0);
    expect(first.length).toBeGreaterThan(0);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), SECTOR_ATTEMPT_TIMEOUT_MS);
    expect(streamer.stats().bodies.Earth.loading).toEqual(['2_1']); // not yet
    expect(loader.requests).toEqual([]);
    const t = SECTOR_ATTEMPT_TIMEOUT_MS + 1;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), t);
    expect(streamer.stats().bodies.Earth.loading).toEqual([]);
    expect(first.every((r) => r.signal!.aborted)).toBe(true);
    expect(loader.requests).toEqual([]); // cooling down before the retry
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), t + SECTOR_RETRY_MS);
    expect(loader.requests.length).toBe(first.length);
    // The hung callbacks, arriving now, are ignored.
    const late = new THREE.Texture();
    first[0].onLoad(late);
    expect(streamer.stats().bodies.Earth.loading).toEqual(['2_1']);
    expect(streamer.stats().bodies.Earth.resident).toEqual([]);
  });

  it('counts an in-place reload against the in-flight cap', () => {
    const mars = marsWithoutRelief();
    loader.auto = true;
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2, '3_1': 1.9, '1_1': 1.8 }), 0);
    expect(streamer.stats().bodies.Mars.resident.sort()).toEqual(['1_1', '2_1', '3_1']);
    loader.auto = false;
    loader.requests.length = 0;
    mars.material.normalMap = new THREE.Texture();
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2, '3_1': 1.9, '1_1': 1.8, '2_0': 1.7 }), 16);
    // Two reloads fill the desktop cap; the third resident and the new 2_0 wait.
    expect(loader.requests).toHaveLength(SECTOR_INFLIGHT_CAP_DESKTOP);
    expect(loader.requests.every((r) => /mars-normal/.test(r.url))).toBe(true);
    expect(streamer.stats().bodies.Mars.resident.sort()).toEqual(['1_1', '2_1', '3_1']);
    loader.resolveAll();
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2, '3_1': 1.9, '1_1': 1.8, '2_0': 1.7 }), 32);
    // The third reload goes first, then the admission (its tile and crop).
    expect(loader.requests.map((r) => r.url).sort()).toEqual([
      expect.stringMatching(/tiles\/mars-normal\.v2\/2k\/1_1\.webp$/),
      expect.stringMatching(/tiles\/mars-normal\.v2\/2k\/2_0\.webp$/),
      expect.stringMatching(/tiles\/mars\.v2\/16k\/2_0\.webp$/),
    ]);
  });

  it('mirrors the base material scalars onto live sectors every frame', () => {
    loader.auto = true;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    earth.material.color.setRGB(0.5, 0.1, 0.1);
    earth.material.emissiveIntensity = 0.7;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16);
    const mat = (earth.mesh.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(mat.color.getHex()).toBe(earth.material.color.getHex());
    expect(mat.emissiveIntensity).toBe(0.7);
  });

  it('suspend: admissions holds residents but admits nothing; all drops everything', () => {
    loader.auto = true;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2, '3_1': 2.2 }), 16, 'admissions');
    expect(streamer.stats().bodies.Earth.resident).toEqual(['2_1']);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2, '3_1': 2.2 }), 32, 'all');
    expect(streamer.stats().resident).toBe(0);
  });

  it('dropAll clears every body but keeps them registered; dispose forgets them', () => {
    loader.auto = true;
    const moon = earthHandle();
    moon.name = 'Moon';
    moon.spec = SECTOR_SETS.Moon;
    moon.material.bumpMap = null;
    moon.material.roughnessMap = null;
    moon.material.normalMap = new THREE.Texture();
    streamer.register(moon);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    streamer.update('Moon', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    expect(streamer.stats().resident).toBe(2);
    streamer.dropAll();
    expect(streamer.stats().resident).toBe(0);
    expect(streamer.has('Moon')).toBe(true);
    streamer.update('Moon', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16); // streams back in
    expect(streamer.stats().bodies.Moon.resident).toEqual(['2_1']);
    streamer.dispose();
    expect(streamer.has('Moon')).toBe(false);
    expect(moon.mesh.children.length).toBe(0);
  });

  it('a release while decoded maps wait in the warm queue disposes them (dequeued, never uploaded)', () => {
    warm.auto = null; // hold the pump
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    let disposed = 0;
    for (const r of loader.requests.splice(0)) {
      const tex = new THREE.Texture();
      tex.addEventListener('dispose', () => disposed++);
      r.onLoad(tex); // decoded, now queued for warming
    }
    expect(warm.queued.length).toBe(3);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 0.1 }), 16); // released while queued
    expect(disposed).toBe(3);
    warm.settle('disposed'); // what the real pump reports for a disposed entry
    expect(earth.mesh.children.length).toBe(0);
    expect(streamer.stats().resident).toBe(0);
    expect(streamer.stats().loading).toBe(0);
  });

  it('never streams over a globe still on its procedural floor', () => {
    loader.auto = true;
    earth.material.userData.colorTierRank = 0; // boot fetch failed: procedural fallback showing
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    expect(loader.requests.length).toBe(0);
    expect(streamer.stats().resident).toBe(0);
    earth.material.userData.colorTierRank = 2; // the real map lands
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16);
    expect(streamer.stats().resident).toBe(1);
    // …and a base that loses its real map (never in practice, but the gate
    // is one predicate) drops its sectors.
    earth.material.userData.colorTierRank = 0;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 32);
    expect(streamer.stats().resident).toBe(0);
  });

  it('streams nothing while a crop slot shows a procedural stand-in, then everything once the real map lands', () => {
    loader.auto = true;
    (earth.material.roughnessMap as THREE.Texture).userData.proceduralFallback = true;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    expect(loader.requests.length).toBe(0); // a sector cut without that map would shade differently
    expect(streamer.stats().resident).toBe(0);
    earth.material.roughnessMap = new THREE.Texture(); // the late fetch lands
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16);
    expect(streamer.stats().bodies.Earth.resident).toEqual(['2_1']);
    const mat = (earth.mesh.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(mat.roughnessMap).not.toBeNull();
    expect(mat.bumpMap).not.toBeNull();
    // …and a stand-in appearing under resident sectors drops them.
    (earth.material.roughnessMap as THREE.Texture).userData.proceduralFallback = true;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 32);
    expect(streamer.stats().resident).toBe(0);
  });

  it('normal-map crops load with the two-sector-wide uniform transform', () => {
    loader.auto = true;
    const moon = earthHandle();
    moon.name = 'Moon';
    moon.spec = SECTOR_SETS.Moon;
    moon.material.bumpMap = null;
    moon.material.roughnessMap = null;
    moon.material.normalMap = new THREE.Texture();
    streamer.register(moon);
    streamer.update('Moon', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    const mat = (moon.mesh.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(mat.normalMap).not.toBeNull();
    expect(mat.normalMap!.repeat.x).toBeCloseTo(mat.normalMap!.repeat.y, 6);
    const expected = sectorTileTransform(G, { c: 2, r: 1 }, dataCropLayout(G, 2880, 2));
    expect(mat.normalMap!.offset.x).toBeCloseTo(expected.offsetX, 12);
    expect(mat.normalMap!.repeat.x).toBeCloseTo(expected.repeatX, 12);
  });

  it('closes the decoded bitmap once a tile is resident', () => {
    warm.auto = null;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    let closed = 0;
    for (const r of loader.requests.splice(0)) {
      const tex = new THREE.Texture({ close: () => { closed++; }, width: 2048, height: 2048 } as unknown as ImageBitmap);
      r.onLoad(tex);
    }
    warm.settle('warmed');
    expect(closed).toBe(3);
    expect(streamer.stats().resident).toBe(1);
  });

  it('measures magnification against the map actually on the globe: an 8K base needs twice the zoom of a 4K one', () => {
    loader.auto = true;
    // measureOf's numbers are texel px for a 4K map; the same on-screen scale
    // over an 8K map is half as many pixels per (twice as fine) texel.
    earth.material.map!.image = { width: 8192, height: 4096 }; // the Moon's 8K rung
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 * SECTOR_WANT_TEXEL_PX - 0.02 }), 0);
    expect(loader.requests.length).toBe(0); // 1.24 texel px on the 8K map: it still out-resolves a tile
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 * SECTOR_WANT_TEXEL_PX + 0.02 }), 16);
    expect(streamer.stats().resident).toBe(1);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 * SECTOR_RELEASE_TEXEL_PX + 0.02 }), 32);
    expect(streamer.stats().resident).toBe(1); // hysteresis band on the 8K scale
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 * SECTOR_RELEASE_TEXEL_PX - 0.02 }), 48);
    expect(streamer.stats().resident).toBe(0);
    // A 2K boot map is magnified twice as much at the same on-screen scale.
    earth.material.map!.image = { width: 2048, height: 1024 };
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': SECTOR_WANT_TEXEL_PX / 2 + 0.02 }), 64);
    expect(streamer.stats().resident).toBe(1);
  });

  it('measures against the ladder top a body will reach, not the boot map it still draws', () => {
    loader.auto = true;
    // A Moon booting on 2K with an 8K rung: measured against 2K, a sector
    // would be admitted now and released the moment the 8K lands.
    earth.material.map!.image = { width: 2048, height: 1024 };
    earth.topMapWidth = 8192;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 * SECTOR_WANT_TEXEL_PX - 0.02 }), 0);
    expect(loader.requests.length).toBe(0);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 * SECTOR_WANT_TEXEL_PX + 0.02 }), 16);
    expect(streamer.stats().resident).toBe(1);
    // The drawn map wins when it is the wider (Earth boots at 4096 with no ladder).
    streamer.dropAll();
    earth.material.map!.image = { width: 4096, height: 2048 };
    earth.topMapWidth = 2048;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': SECTOR_WANT_TEXEL_PX + 0.02 }), 32);
    expect(streamer.stats().resident).toBe(1);
  });

  it('releases everything without measuring when even the nearest texel is under the release size', () => {
    loader.auto = true;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    expect(streamer.stats().resident).toBe(1);
    let measured = 0;
    const counting = (centre: THREE.Vector3, radius: number) => { measured++; return measureOf({ '2_1': 2 })(centre, radius); };
    streamer.update('Earth', cameraOver(2, 1), counting, 16, 'none', null, (SECTOR_RELEASE_TEXEL_PX - 0.01) / TEXEL_LEN_4K);
    expect(measured).toBe(0);
    expect(streamer.stats().resident).toBe(0);
  });

  it('keeps a big resident sector that left the frame, but never fetches one', () => {
    loader.auto = true;
    const off = (px: number) => (centre: THREE.Vector3): SectorMeasure | null => {
      const d = sectorCentreDirection(G, { c: 2, r: 1 }, new THREE.Vector3()).multiplyScalar(R);
      return d.distanceTo(centre) < 1e-9 ? { pxPerLocalUnit: px / TEXEL_LEN_4K, centrality: 0, offscreen: true } : null;
    };
    streamer.update('Earth', cameraOver(2, 1), off(2), 0);
    expect(loader.requests.length).toBe(0); // off-frame: nothing to sharpen
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16);
    expect(streamer.stats().resident).toBe(1);
    streamer.update('Earth', cameraOver(2, 1), off(2), 32); // panned off the frame
    expect(streamer.stats().resident).toBe(1); // one pan away: kept
    streamer.update('Earth', cameraOver(2, 1), off(SECTOR_RELEASE_TEXEL_PX - 0.01), 48);
    expect(streamer.stats().resident).toBe(0); // …until it is small as well
  });

  it('never fetches a sector deep on the night side; a resident one stays while it is big', () => {
    loader.auto = true;
    const sunOver = (c: number, r: number) => sectorCentreDirection(G, { c, r }, new THREE.Vector3());
    // Sun over the antipode of sector 2_1: the sector is deep in the night.
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0, 'none', sunOver(6, 2));
    expect(loader.requests.length).toBe(0);
    // Sun over the sector: fetched.
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16, 'none', sunOver(2, 1));
    expect(streamer.stats().resident).toBe(1);
    // Sunset: kept while big (score 0 — the first to go under cap pressure).
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 32, 'none', sunOver(6, 2));
    expect(streamer.stats().resident).toBe(1);
    // Twilight — the sector centre just past the terminator (dot ≈ −0.08) —
    // is still fetchable: its day-side half is lit.
    streamer.dropAll();
    const twilight = sunOver(2, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(105));
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 48, 'none', twilight);
    expect(streamer.stats().resident).toBe(1);
    // The centre well into the night (dot ≈ −0.44) but the sector's sunward
    // corner still 5° on the day side: that lit strip is fetchable too.
    const centre = sectorCentreDirection(G, { c: 2, r: 1 }, new THREE.Vector3());
    const corner = sphereDirection(2 / G.cols, 2 / G.rows, new THREE.Vector3()); // west edge, equator
    const sunPastCornerBy = (deg: number) => {
      const axis = new THREE.Vector3().crossVectors(centre, corner).normalize();
      return corner.clone().applyAxisAngle(axis, THREE.MathUtils.degToRad(deg));
    };
    streamer.dropAll();
    const cornerLit = sunPastCornerBy(85);
    expect(centre.dot(cornerLit)).toBeLessThan(-0.4);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 64, 'none', cornerLit);
    expect(streamer.stats().resident).toBe(1);
    // And once even that corner is past the twilight margin, nothing.
    streamer.dropAll();
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 80, 'none', sunPastCornerBy(100));
    expect(streamer.stats().resident).toBe(0);
  });

  it('a crop failing while the colour tile waits in the warm queue counts as ONE failure', () => {
    // The real pump reports 'disposed' synchronously from inside tex.dispose()
    // (once — the callback is consumed); this fake does the same, so the
    // failure path is exercised re-entrantly.
    const hookWarm = (tex: THREE.Texture, done: (o: WarmOutcome) => void) => {
      let pending: typeof done | null = done;
      tex.addEventListener('dispose', () => { const d = pending; pending = null; d?.('disposed'); });
    };
    const s = new SectorStreamer({ touch: false, load: loader.load, warm: hookWarm });
    s.register(earth);
    s.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    const [first, ...rest] = loader.requests.splice(0);
    first.onLoad(new THREE.Texture()); // colour tile decoded and queued
    rest[0].onError(new Error('404')); // a crop fails: the queued tile is disposed → 'disposed' re-enters
    expect(s.stats().loading).toBe(0);
    // One failure, one base cooldown: retried right after SECTOR_RETRY_MS.
    s.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), SECTOR_RETRY_MS + 1);
    expect(loader.requests.length).toBe(3);
  });

  /** Earth with the synthetic second level wired on. */
  function twoLevelEarth(): ReturnType<typeof earthHandle> {
    const h = earthHandle();
    h.spec = { ...SECTOR_SETS.Earth, levels: TWO_LEVELS };
    streamer.register(h);
    return h;
  }
  const G1 = LEVEL_1.grid;
  const overLevel1 = (c: number, r: number, dist = 1.5) =>
    sectorCentreDirection(G1, { c, r }, new THREE.Vector3()).multiplyScalar(dist * R);

  it('a finer level fetches its own colour tile and its parent\'s crops, through the parent\'s transform', () => {
    loader.auto = true;
    const earth2 = twoLevelEarth();
    // Child (5, 3) is a quarter of level 0's (2, 1); both are past their own
    // threshold at this pose, and each fetches its own copy of the crop.
    streamer.update('Earth', overLevel1(5, 3), measureLevels(TWO_LEVELS, { '2_1': 2, 'L1/5_3': 2 }), 0);
    expect(loader.requests.map((r) => r.url).sort()).toEqual([
      expect.stringMatching(/tiles\/earth-bump\/2k\/2_1\.webp$/),
      expect.stringMatching(/tiles\/earth-bump\/2k\/2_1\.webp$/),
      expect.stringMatching(/tiles\/earth-day\.v2\/16k\/2_1\.webp$/),
      expect.stringMatching(/tiles\/earth-day\.v2\/32k\/5_3\.webp$/),
      expect.stringMatching(/tiles\/earth-roughness\.v2\/4k\/2_1\.webp$/),
      expect.stringMatching(/tiles\/earth-roughness\.v2\/4k\/2_1\.webp$/),
    ]);
    const child = (earth2.mesh.children as THREE.Mesh[]).find((m) => m.renderOrder === SECTOR_RENDER_ORDER - 1)!;
    const mat = child.material as THREE.MeshStandardMaterial;
    // The colour tile carries its own level's transform…
    const tileT = sectorTileTransform(G1, { c: 5, r: 3 }, SECTOR_TILE);
    expect(mat.map!.offset.x).toBeCloseTo(tileT.offsetX, 12);
    expect(mat.map!.repeat.x).toBeCloseTo(tileT.repeatX, 12);
    // …and each crop the PARENT's, verbatim: the mesh's uvs are global, so a
    // quarter of the parent's rectangle lands on a quarter of the crop.
    for (const [slot, layout] of [
      ['bumpMap', dataCropLayout(G, 2048)], ['roughnessMap', dataCropLayout(G, 4096)],
    ] as const) {
      const parentT = sectorTileTransform(G, { c: 2, r: 1 }, layout);
      expect(mat[slot]!.offset.x).toBeCloseTo(parentT.offsetX, 12);
      expect(mat[slot]!.offset.y).toBeCloseTo(parentT.offsetY, 12);
      expect(mat[slot]!.repeat.x).toBeCloseTo(parentT.repeatX, 12);
      expect(mat[slot]!.repeat.y).toBeCloseTo(parentT.repeatY, 12);
    }
  });

  it('a finer sector draws before the level above it, on half the segments', () => {
    loader.auto = true;
    const earth2 = twoLevelEarth();
    streamer.update('Earth', overLevel1(5, 3), measureLevels(TWO_LEVELS, { '2_1': 2, 'L1/5_3': 2 }), 0);
    const meshes = earth2.mesh.children as THREE.Mesh[];
    expect(meshes).toHaveLength(2);
    const byOrder = meshes.slice().sort((a, b) => a.renderOrder - b.renderOrder);
    expect(byOrder.map((m) => m.renderOrder)).toEqual([SECTOR_RENDER_ORDER - 1, SECTOR_RENDER_ORDER]);
    for (const m of byOrder) {
      const mat = m.material as THREE.MeshStandardMaterial;
      const level = m.renderOrder === SECTOR_RENDER_ORDER ? 0 : 1;
      expect(mat.polygonOffsetFactor).toBe(0); // never a slope term: it grows at the limb
      expect(mat.polygonOffsetUnits).toBe(-(level + 1));
      expect(m.geometry.getAttribute('position').count).toBe(level === 0 ? 33 * 33 : 17 * 17);
    }
  });

  it('stats keep the level-0 ids flat and namespace the levels below, with per-level counts', () => {
    loader.auto = true;
    twoLevelEarth();
    streamer.update('Earth', overLevel1(5, 3), measureLevels(TWO_LEVELS, { '2_1': 2, 'L1/5_3': 2 }), 0);
    const body = streamer.stats().bodies.Earth;
    expect(body.resident.slice().sort()).toEqual(['2_1', 'L1/5_3']);
    expect(body.byLevel.map((l) => l.resident)).toEqual([1, 1]);
    expect(body.byLevel[1].gpuBytes).toBe(0); // the fakes carry no image
    // A single-level body still reports one level and bare ids.
    const mars = marsWithoutRelief();
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    expect(streamer.stats().bodies.Mars.resident).toEqual(['2_1']);
    expect(streamer.stats().bodies.Mars.byLevel).toHaveLength(1);
    expect(mars.mesh.children).toHaveLength(1);
  });

  /** Every level-0 sector at a size, for filling the working set. */
  function field(px: (c: number, r: number) => number): Record<string, number> {
    const sizes: Record<string, number> = {};
    for (let r = 0; r < G.rows; r++) for (let c = 0; c < G.cols; c++) sizes[`${c}_${r}`] = px(c, r);
    return sizes;
  }
  const INSIDE = new THREE.Vector3(0, 0, 0); // every sector faces a camera at the centre

  it('wants a finer sector only where the level above it has run out of texels', () => {
    loader.auto = true;
    twoLevelEarth();
    const cam = overLevel1(5, 3);
    // The parent is magnified, its own source is not: nothing finer is asked
    // for, and the child is not even measured.
    let measured = 0;
    const counting = (sizes: Record<string, number>) => {
      const inner = measureLevels(TWO_LEVELS, sizes);
      return (centre: THREE.Vector3, radius: number, dir: THREE.Vector3) => { measured++; return inner(centre, radius, dir); };
    };
    streamer.update('Earth', cam, counting({ '2_1': 4, 'L1/5_3': SECTOR_WANT_TEXEL_PX - 0.01 }), 0);
    expect(streamer.stats().bodies.Earth.resident).toEqual(['2_1']);
    // …and once the level-0 source is magnified too, the child joins it.
    streamer.update('Earth', cam, measureLevels(TWO_LEVELS, { '2_1': 4, 'L1/5_3': SECTOR_WANT_TEXEL_PX + 0.01 }), 16);
    expect(streamer.stats().bodies.Earth.resident.slice().sort()).toEqual(['2_1', 'L1/5_3']);
    // A sub-tree under a parent with nothing to add costs no projection.
    const beforeGated = measured;
    streamer.update('Earth', cam, counting({}), 32);
    expect(measured - beforeGated).toBeLessThanOrEqual(G.cols * G.rows);
  });

  it('a finer sector can take a coarser one\'s place: ranking is by how far past its own threshold', () => {
    loader.auto = true;
    twoLevelEarth();
    // A field just past the want size, and one child four times past its own.
    // In raw texel px the child measures a quarter of any of them.
    const sizes = { ...field(() => 1.1), '2_1': 4, 'L1/5_3': 4 };
    for (let f = 0; f < 4; f++) streamer.update('Earth', INSIDE, measureLevels(TWO_LEVELS, sizes), f * 16);
    const resident = streamer.stats().bodies.Earth.resident;
    expect(resident).toContain('L1/5_3');
    expect(resident).toContain('2_1');
    expect(resident.filter((id) => id.startsWith('L1/'))).toHaveLength(1);
  });

  it('never evicts a sector a finer one is drawing over', () => {
    loader.auto = true;
    twoLevelEarth();
    const strong = { ...field(() => 1.5), '2_1': 5, 'L1/5_3': 3 };
    for (let f = 0; f < 4; f++) streamer.update('Earth', INSIDE, measureLevels(TWO_LEVELS, strong), f * 16);
    const full = streamer.stats().bodies.Earth.resident.slice().sort();
    expect(full).toContain('2_1');
    expect(full).toContain('L1/5_3');
    // The parent's own magnification falls to the hysteresis band — the
    // weakest thing resident — while its child stays sharp. A newcomer that
    // out-ranks everything takes the weakest sector WITHOUT a resident child.
    const weakParent = { ...strong, '2_1': 0.7 };
    streamer.update('Earth', INSIDE, measureLevels(TWO_LEVELS, weakParent), 5_000);
    for (let f = 0; f < 4; f++) {
      streamer.update('Earth', INSIDE, measureLevels(TWO_LEVELS, { ...weakParent, '7_3': 40 }), 6_000 + f * 16);
    }
    const after = streamer.stats().bodies.Earth.resident;
    expect(after).toContain('7_3');
    expect(after).toContain('2_1'); // held under its child, though it ranks last
    expect(after).toContain('L1/5_3');
    expect(after.length).toBe(full.length);
  });

  it('suppresses a parent every child of which is resident, and wants it back the moment one is lost', () => {
    twoLevelEarth();
    const children = { 'L1/4_2': 3, 'L1/5_2': 3, 'L1/4_3': 3, 'L1/5_3': 3 };
    const cam = overLevel1(5, 3);
    // The parent's own tile fails once and cools down; its children land.
    streamer.update('Earth', cam, measureLevels(TWO_LEVELS, { '2_1': 4 }), 0);
    loader.failAll();
    loader.auto = true;
    for (let f = 1; f <= 4; f++) streamer.update('Earth', cam, measureLevels(TWO_LEVELS, { '2_1': 4, ...children }), f * 16);
    expect(streamer.stats().bodies.Earth.resident.slice().sort())
      .toEqual(['L1/4_2', 'L1/4_3', 'L1/5_2', 'L1/5_3']);
    // Past the cooldown it is wanted and idle, but nothing of it would show.
    loader.requests.length = 0;
    streamer.update('Earth', cam, measureLevels(TWO_LEVELS, { '2_1': 4, ...children }), SECTOR_RETRY_MS + 100);
    expect(loader.requests).toEqual([]);
    // Lose one child and the parent is the fallback under the other three.
    const oneLost = { ...children, 'L1/4_2': SECTOR_RELEASE_TEXEL_PX - 0.01 };
    streamer.update('Earth', cam, measureLevels(TWO_LEVELS, { '2_1': 4, ...oneLost }), SECTOR_RETRY_MS + 200);
    expect(loader.requests.map((r) => r.url)).toContainEqual(
      expect.stringMatching(/tiles\/earth-day\.v2\/16k\/2_1\.webp$/),
    );
  });

  it('ranks every body against the same frame when the caller brackets them', () => {
    loader.auto = true;
    const moon = earthHandle();
    moon.name = 'Moon';
    moon.spec = SECTOR_SETS.Moon;
    moon.material.bumpMap = null;
    moon.material.roughnessMap = null;
    moon.material.normalMap = new THREE.Texture();
    streamer.register(moon);
    const earthSizes = measureOf(field(() => 2));
    const moonSizes = measureOf(field(() => 6));
    const run = (first: 'Earth' | 'Moon') => {
      streamer.dropAll();
      for (let f = 0; f < 4; f++) {
        streamer.beginFrame();
        const t = 10_000 + f * 16;
        if (first === 'Earth') {
          streamer.update('Earth', INSIDE, earthSizes, t);
          streamer.update('Moon', INSIDE, moonSizes, t);
        } else {
          streamer.update('Moon', INSIDE, moonSizes, t);
          streamer.update('Earth', INSIDE, earthSizes, t);
        }
        streamer.endFrame();
      }
      const s = streamer.stats();
      return { earth: s.bodies.Earth.resident.length, moon: s.bodies.Moon.resident.length };
    };
    const earthFirst = run('Earth');
    expect(run('Moon')).toEqual(earthFirst);
    // …and the working set goes to the body that is actually magnified.
    expect(earthFirst.moon).toBeGreaterThan(0);
    expect(earthFirst.earth).toBe(0);
  });

  it('reserves what a load will hold before it starts, and gives it back when the load does not land', () => {
    streamer.update('Earth', INSIDE, measureOf({ '2_1': 2, '3_1': 1.9 }), 0);
    let s = streamer.stats();
    // Two loads in flight hold nothing on the GPU yet and have committed
    // their full sets: the figure that keeps two 22 MiB tiles from landing
    // on a budget with room for one.
    expect(s.loading).toBe(SECTOR_INFLIGHT_CAP_DESKTOP);
    expect(s.reserved).toBe(SECTOR_INFLIGHT_CAP_DESKTOP * EARTH_SET_BYTES);
    expect(s.residentBytes).toBe(0);
    expect(s.gpuBytes).toBe(0);
    expect(s.residentBytes + s.reserved).toBeLessThanOrEqual(s.budget);
    loader.failAll();
    expect(streamer.stats().reserved).toBe(0);
    // What lands is held as resident bytes instead, and dropAll gives back both.
    loader.auto = true;
    streamer.update('Earth', INSIDE, measureOf({ '2_1': 2 }), SECTOR_RETRY_MS + 1);
    s = streamer.stats();
    expect(s.residentBytes).toBe(EARTH_SET_BYTES);
    expect(s.reserved).toBe(0);
    streamer.dropAll();
    s = streamer.stats();
    expect(s.residentBytes).toBe(0);
    expect(s.reserved).toBe(0);
  });

  it('takes the sector budget out of one envelope with the globe maps, and gives sectors back when it shrinks', () => {
    loader.auto = true;
    expect(streamer.stats().budget).toBe(SECTOR_BUDGET_BYTES_DESKTOP);
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) { sizes[`${c}_1`] = 2 + 0.01 * c; sizes[`${c}_2`] = 2.1 + 0.01 * c; }
    streamer.update('Earth', INSIDE, measureOf(sizes), 0);
    expect(streamer.stats().resident).toBe(EARTH_FITS_DESKTOP);
    // The globe maps grow (an 8K rung lands) and the envelope leaves the
    // sectors room for three.
    streamer.setGlobalMapBytes(SECTOR_ENVELOPE_BYTES_DESKTOP - 3 * EARTH_SET_BYTES);
    expect(streamer.stats().budget).toBe(3 * EARTH_SET_BYTES);
    streamer.update('Earth', INSIDE, measureOf(sizes), 16);
    const s = streamer.stats();
    expect(s.resident).toBe(3);
    expect(s.residentBytes + s.reserved).toBeLessThanOrEqual(s.budget);
    // The three kept are the strongest.
    expect(s.bodies.Earth.resident.slice().sort()).toEqual(['5_2', '6_2', '7_2']);
  });

  it('a budget collapse and a base map landing in the same frame never overshoot the budget', () => {
    loader.auto = true;
    earth.material.roughnessMap = null; // the gloss map has not landed yet
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) { sizes[`${c}_1`] = 2 + 0.01 * c; sizes[`${c}_2`] = 2.1 + 0.01 * c; }
    for (let f = 0; f < 24; f++) streamer.update('Earth', INSIDE, measureOf(sizes), f * 16);
    expect(streamer.stats().resident).toBeGreaterThan(4);
    // One frame carries both: the gloss map lands (every resident is drawn
    // under the old signature and wants reloading) and the envelope closes to
    // less than one set (every resident has to go). The reload list must not
    // hand a released slot a fetch budgeted for the crops it was missing.
    loader.auto = false;
    loader.requests.length = 0;
    earth.material.roughnessMap = new THREE.Texture();
    streamer.setGlobalMapBytes(SECTOR_ENVELOPE_BYTES_DESKTOP - Math.round(0.6 * EARTH_SET_BYTES));
    streamer.update('Earth', INSIDE, measureOf(sizes), 10_000);
    const s = streamer.stats();
    expect(s.residentBytes + s.reserved).toBeLessThanOrEqual(s.budget);
    // …and nothing is in the air for a slot that gave its maps up.
    expect(loader.requests).toEqual([]);
    expect(s.inflight).toBe(0);
  });

  it('leaves a sector alone for a moment after admitting it, whatever turns up next', () => {
    loader.auto = true;
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) { sizes[`${c}_1`] = 2 + 0.01 * c; sizes[`${c}_2`] = 2.1 + 0.01 * c; }
    streamer.update('Earth', INSIDE, measureOf(sizes), 0);
    const before = streamer.stats().bodies.Earth.resident.slice().sort();
    // A far stronger candidate, while everything resident is seconds old.
    const withNewcomer = { ...sizes, '0_0': 50 };
    streamer.update('Earth', INSIDE, measureOf(withNewcomer), SECTOR_EVICT_DWELL_MS - 1);
    expect(streamer.stats().bodies.Earth.resident.slice().sort()).toEqual(before);
    streamer.update('Earth', INSIDE, measureOf(withNewcomer), SECTOR_EVICT_DWELL_MS);
    expect(streamer.stats().bodies.Earth.resident).toContain('0_0');
  });

  it('settles under budget pressure: two hundred frames at one pose, no churn and no starved child', () => {
    loader.auto = true;
    twoLevelEarth();
    const sizes = {
      ...field((c, r) => 1.5 + 0.01 * (c + G.cols * r)),
      '2_1': 8, 'L1/4_2': 4, 'L1/5_2': 4, 'L1/4_3': 4, 'L1/5_3': 4,
    };
    const measure = measureLevels(TWO_LEVELS, sizes);
    let churn = 0;
    let previous = '';
    for (let f = 0; f < 200; f++) {
      streamer.update('Earth', INSIDE, measure, f * 16);
      const now = streamer.stats().bodies.Earth.resident.slice().sort().join(' ');
      if (f > 0 && now !== previous) churn += 1;
      previous = now;
    }
    expect(churn).toBe(0);
    const s = streamer.stats();
    // The parent and all four of its children are resident: a finer level
    // that ranks above the coarse field is not starved by it.
    for (const id of ['2_1', 'L1/4_2', 'L1/5_2', 'L1/4_3', 'L1/5_3']) {
      expect(s.bodies.Earth.resident).toContain(id);
    }
    expect(s.bodies.Earth.byLevel[1].resident).toBe(4);
    expect(s.residentBytes + s.reserved).toBeLessThanOrEqual(s.budget);
    expect(s.resident).toBe(EARTH_FITS_DESKTOP);
  });

  it('drops every level on context loss and streams them all back', () => {
    loader.auto = true;
    twoLevelEarth();
    const measure = measureLevels(TWO_LEVELS, { '2_1': 4, 'L1/5_3': 4 });
    streamer.update('Earth', overLevel1(5, 3), measure, 0);
    const before = streamer.stats().bodies.Earth.resident.slice().sort();
    expect(before).toEqual(['2_1', 'L1/5_3']);
    streamer.dropAll();
    let s = streamer.stats();
    expect(s.resident).toBe(0);
    expect(s.residentBytes).toBe(0);
    expect(s.reserved).toBe(0);
    streamer.update('Earth', overLevel1(5, 3), measure, 16);
    s = streamer.stats();
    expect(s.bodies.Earth.resident.slice().sort()).toEqual(before);
    expect(s.residentBytes).toBe(2 * EARTH_SET_BYTES);
  });

  it('asks the measure about each sector at its point nearest the camera, not its centre', () => {
    const asked = new Map<string, THREE.Vector3>();
    const recording = (centre: THREE.Vector3, _r: number, surfaceDir: THREE.Vector3): SectorMeasure | null => {
      for (let r = 0; r < G.rows; r++) for (let c = 0; c < G.cols; c++) {
        const d = sectorCentreDirection(G, { c, r }, new THREE.Vector3()).multiplyScalar(R);
        if (d.distanceTo(centre) < 1e-9) asked.set(`${c}_${r}`, surfaceDir.clone());
      }
      return null;
    };
    const cam = cameraOver(2, 1);
    streamer.update('Earth', cam, recording, 0);
    // The sector under the camera is measured at the sub-camera point…
    expect(asked.get('2_1')!.distanceTo(cam.clone().normalize())).toBeLessThan(1e-12);
    // …its eastern neighbour at that neighbour's western edge, same latitude.
    const edge = sphereDirection(3 / 8, 1.5 / 4, new THREE.Vector3());
    expect(asked.get('3_1')!.distanceTo(edge)).toBeLessThan(1e-12);
  });
});
