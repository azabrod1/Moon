import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import {
  SECTOR_ADMIT_MARGIN,
  SECTOR_ATTEMPT_TIMEOUT_MS,
  SECTOR_EVICT_DWELL_MS,
  SECTOR_KEEP_LIGHT_MARGIN,
  SECTOR_MAX_LEVEL,
  SECTOR_NIGHT_DOT,
  SECTOR_RETRY_MS,
  SECTOR_SEGMENTS,
  SECTOR_SETS,
  SectorStreamer,
  daySectorFamily,
  sectorFamilyKey,
  sectorLevel16k,
  sectorLevel32k,
  levelSourceWidth,
  resetTileFetchNoticeForTests,
  sectorSetGpuBytes,
  tileSet,
  type SectorBodyHandle,
  type SectorLevel,
  type SectorMeasure,
  type SectorSetSpec,
} from './sectorStreamer';
import { APPLE_PHONE_PROFILE, UNMEASURED_DESKTOP_PROFILE, UNMEASURED_TOUCH_PROFILE } from './gpuEnvelope';
import {
  appliedTierHeldBytes,
  bindTierAdmission,
  ladderMapReferenceWidth,
  makeTextureUpgrade,
  RESTORE_STANDIN_WIDTH,
  setUpgradeTextureLoader,
  startTierRelease,
  TIER_RANK,
} from './textureLadder';
import { equirectMapGpuBytes } from './textureBytes';
import { SECTOR_RENDER_ORDER } from './sectorMaterial';
import { createEarthNightShellMaterial, earthNightSectorFamily } from './earthNightMaterial';
import { createSurfaceAirFx } from './surfaceShading';
import { EARTH_NIGHT_MIX_LIT, earthNightMix } from '../../shared/shaders/atmosphere';
import { SECTOR_GRID_16K, ancestorSector, finerGrid, sectorCentreDirection, sectorNearestDirection, sectorTileTransform, dataCropLayout, SECTOR_TILE, sphereDirection } from './sectorGrid';
import { augmentSurfaceMaterial } from './surfaceShading';
import type { WarmOutcome } from './textureWarmer';
import { mapTexture } from '../testing/upgradeHarness';

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
/** The two sets of device numbers the streamer is built with today. The
 *  streamer takes numbers, not a device guess, so a test says which. */
const DESKTOP = UNMEASURED_DESKTOP_PROFILE;
/** An Android or other-platform phone or tablet: the numbers the app shipped
 *  with, kept because no device on those platforms has been measured. */
const TOUCH = UNMEASURED_TOUCH_PROFILE;
/** An Apple phone, which holds the desktop numbers on a measurement. */
const APPLE_PHONE = APPLE_PHONE_PROFILE;
/** The same desktop numbers with no sector floor. Most of the tests below
 *  squeeze the budget to one set or to nothing to watch what the streamer
 *  gives up first — a squeeze the shipped floor is there to prevent, and
 *  which would otherwise stop the eviction machinery from being exercised at
 *  all. The floor's own behaviour is pinned in its own describe block. */
const NO_FLOOR = { ...DESKTOP, sectorFloorBytes: 0 };
const EARTH_SET_BYTES = sectorSetGpuBytes(SECTOR_SETS.Earth);
const EARTH_FITS_DESKTOP = Math.floor(DESKTOP.ceilingBytes / EARTH_SET_BYTES);
const EARTH_FITS_TOUCH = Math.floor(TOUCH.ceilingBytes / EARTH_SET_BYTES);
// Sizes in these tests are TEXEL magnifications (device px per base-map texel)
// for the 4K map the fake material is taken to draw (no readable image, so
// the streamer assumes 4096 wide); measureOf turns them into pxPerLocalUnit.
const TEXEL_LEN_4K = (2 * Math.PI * R) / 4096;

type TestHandle = SectorBodyHandle & { fineCalls: number; material: THREE.MeshStandardMaterial };

function earthHandle(): TestHandle {
  const material = new THREE.MeshStandardMaterial({
    map: new THREE.Texture(),
    bumpMap: new THREE.Texture(),
    roughnessMap: new THREE.Texture(),
  });
  augmentSurfaceMaterial(material, 'earth');
  material.userData.colorTierRank = 2; // a real boot map is on the globe
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(R, 16, 8), material);
  const handle: TestHandle = {
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

/** The 16K level every shipped body's pyramid starts at. */
const LEVEL_0 = SECTOR_SETS.Earth.levels[0];

/** A measure that magnifies a listed set of sectors (by "c_r", in texel px) and hides the rest. */
function measureOf(sizes: Record<string, number>, centrality = 1) {
  return measureLevels([LEVEL_0], sizes, centrality);
}

/** Earth's shipped level 1: the 16×8 grid of 2048² tiles cut from a
 *  32512-wide source. The pyramid is exercised on the real thing. */
const LEVEL_1: SectorLevel = SECTOR_SETS.Earth.levels[1];
const TWO_LEVELS = [LEVEL_0, LEVEL_1];
/** The step between the two levels: a level-1 sector's demand is read against
 *  level 0's source, which is this many times finer than the globe's own map,
 *  so at one spot a child reads that many times fewer px per texel than its
 *  parent. It is also the globe magnification at which a child first has
 *  anything to add — the campaign's "~4 px per 16K texel" wall. */
const LEVEL_STEP = levelSourceWidth(LEVEL_0) / 4096;
const CHILD_WANT_PX = DESKTOP.wantTexelPx * LEVEL_STEP;

/** A measure over a pyramid. Sizes are keyed by LEVEL-0 sector and given in
 *  device px per texel of the GLOBE's map there — one physical magnification
 *  per place on the sphere, which is what a projection can actually produce.
 *  Every level over that place is measured through the same number, so a
 *  level cannot be handed a magnification its parent does not have: the
 *  streamer derives each level's own texel reading from it, and a child
 *  comes out at its parent's divided by the level step.
 *
 *  `offscreen` is per SLOT (by stats id): frame membership really is a
 *  per-sector fact, and a parent's nearest point can leave the frame while a
 *  child's stays on it. */
function measureLevels(
  levels: SectorLevel[],
  sizes: Record<string, number>,
  centrality = 1,
  offscreen: ReadonlySet<string> = new Set(),
  /** Radius the measured body's sectors are built at — the night family's is
   *  its shell's, a thousandth above the globe's. */
  radius = R,
) {
  return (centre: THREE.Vector3, _radius?: number, _dir?: THREE.Vector3): SectorMeasure | null => {
    for (let level = 0; level < levels.length; level++) {
      const grid = levels[level].grid;
      for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) {
          const d = sectorCentreDirection(grid, { c, r }, new THREE.Vector3()).multiplyScalar(radius);
          if (d.distanceTo(centre) < 1e-9) {
            const base = ancestorSector({ c, r }, level);
            const px = sizes[`${base.c}_${base.r}`];
            if (px === undefined) return null;
            const id = level === 0 ? `${c}_${r}` : `L${level}/${c}_${r}`;
            return {
              pxPerLocalUnit: px / ((2 * Math.PI * radius) / 4096),
              centrality,
              offscreen: offscreen.has(id),
            };
          }
        }
      }
    }
    return null;
  };
}

// --- Earth's night family: a second set of sectors on the night shell -------

/** The night shell's radius. PlanetFactory builds it a thousandth of a radius
 *  above the globe, and the sectors that replace it are built at the same
 *  height — a sector at the globe's radius would sit under the shell it is
 *  there to suppress. */
const NIGHT_R = R * 1.001;
/** Earth's night pyramid: the Black Marble sets, no crops (relief and gloss
 *  are daylight terms), so a night sector costs its colour tile alone. */
const NIGHT_SPEC: SectorSetSpec = {
  crops: {},
  levels: [sectorLevel16k('earth-night.v2'), sectorLevel32k('earth-night.v2')],
};
const NIGHT_SET_BYTES = sectorSetGpuBytes(NIGHT_SPEC);

function earthNightHandle(): TestHandle & { material: THREE.ShaderMaterial } {
  const material = createEarthNightShellMaterial(new THREE.Texture(), createSurfaceAirFx());
  material.userData.colorTierRank = 2; // a real boot map is on the shell
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(NIGHT_R, 16, 8), material);
  const handle = {
    name: 'Earth',
    spec: NIGHT_SPEC,
    mesh,
    material,
    family: earthNightSectorFamily(material),
    radiusAU: NIGHT_R,
    fineCalls: 0,
    ensureFineGeometry: () => { handle.fineCalls++; },
  } as unknown as TestHandle & { material: THREE.ShaderMaterial };
  return handle;
}

/** A measure for the night family's sectors, on the shell's radius. */
function measureNight(sizes: Record<string, number>, centrality = 1) {
  return measureLevels(NIGHT_SPEC.levels, sizes, centrality, new Set(), NIGHT_R);
}

const NIGHT_KEY = sectorFamilyKey('Earth', 'night');
const SEC = { c: 2, r: 1 };

/** The sun as an exact unit vector, `deg` around the pole from straight over
 *  sector 2_1: 0 is noon there, 180 is midnight. */
function sunPastSector(deg: number): THREE.Vector3 {
  return sectorCentreDirection(G, SEC, new THREE.Vector3())
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));
}

/** The sun cosine at the sector's most lit and darkest points — what the two
 *  families' gates are read at. */
function sectorSunExtremes(sun: THREE.Vector3): { lit: number; dark: number } {
  const at = (dir: THREE.Vector3) => sectorNearestDirection(G, SEC, dir, new THREE.Vector3()).dot(sun);
  return { lit: at(sun), dark: at(sun.clone().negate()) };
}

/** The sun placed so that one of those two extremes reads exactly `target`.
 *  Both fall as the sun leaves the sector, so a bisection lands on the gate's
 *  own input — which is what lets a test sit INSIDE the release margin rather
 *  than somewhere near it. */
function sunWhereExtremeIs(which: 'lit' | 'dark', target: number): THREE.Vector3 {
  let lo = 0;
  let hi = 180;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (sectorSunExtremes(sunPastSector(mid))[which] > target) lo = mid;
    else hi = mid;
  }
  return sunPastSector((lo + hi) / 2);
}

describe('SectorStreamer', () => {
  let loader: FakeLoader;
  let warm: FakeWarm;
  let streamer: SectorStreamer;
  let earth: ReturnType<typeof earthHandle>;

  beforeEach(() => {
    loader = new FakeLoader();
    warm = new FakeWarm();
    streamer = new SectorStreamer({ limits: NO_FLOOR, load: loader.load, warm: warm.warm });
    earth = earthHandle();
    streamer.register(earth);
  });

  it('asks later on touch, and releases later', () => {
    expect(TOUCH.wantTexelPx).toBeGreaterThan(DESKTOP.wantTexelPx);
    const s = new SectorStreamer({ limits: TOUCH, load: loader.load, warm: warm.warm });
    s.register(earth);
    loader.auto = true;
    s.update('Earth', cameraOver(2, 1), measureOf({ '2_1': TOUCH.wantTexelPx - 0.01 }), 0);
    expect(s.stats().resident).toBe(0);
    s.update('Earth', cameraOver(2, 1), measureOf({ '2_1': TOUCH.wantTexelPx + 0.01 }), 16);
    expect(s.stats().resident).toBe(1);
    s.update('Earth', cameraOver(2, 1), measureOf({ '2_1': TOUCH.releaseTexelPx + 0.01 }), 32);
    expect(s.stats().resident).toBe(1);
    s.update('Earth', cameraOver(2, 1), measureOf({ '2_1': TOUCH.releaseTexelPx - 0.01 }), 48);
    expect(s.stats().resident).toBe(0);
  });

  it('requests nothing while every facing sector is under the want size', () => {
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': DESKTOP.wantTexelPx - 0.01 }), 0);
    expect(loader.requests).toEqual([]);
    expect(streamer.stats().resident).toBe(0);
  });

  it('loads the colour tile plus the crops the base material carries, with sector-exact URLs', () => {
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    const urls = loader.requests.map((r) => r.url).sort();
    expect(urls).toEqual([
      expect.stringMatching(/textures\/tiles\/earth-bump\/2k\.[0-9a-f]{8}\/2_1\.webp$/),
      expect.stringMatching(/textures\/tiles\/earth-day\.v2\/16k\.[0-9a-f]{8}\/2_1\.webp$/),
      expect.stringMatching(/textures\/tiles\/earth-roughness\.v2\/4k\.[0-9a-f]{8}\/2_1\.webp$/),
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
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': (DESKTOP.wantTexelPx + DESKTOP.releaseTexelPx) / 2 }), 16);
    expect(streamer.stats().resident).toBe(1); // hysteresis band: stays
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': DESKTOP.releaseTexelPx - 0.01 }), 32);
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
    expect(streamer.stats().loading).toBe(DESKTOP.inflightCap);
    // Largest first (stats list in grid order).
    expect(streamer.stats().bodies.Earth.loading.slice().sort()).toEqual(['2_1', '3_1']);
  });

  it('holds what the byte budget holds, and only evicts for a candidate that out-ranks by the margin', () => {
    loader.auto = true;
    // The budget is what bounds the working set; the count cap is the
    // emergency ceiling above it and never binds for a set this size.
    expect(EARTH_FITS_DESKTOP).toBeLessThan(DESKTOP.residentCap);
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) { sizes[`${c}_1`] = 2 + 0.01 * c; sizes[`${c}_2`] = 2.1 + 0.01 * c; }
    // Fill the budget over a few frames (in-flight limit paces admissions).
    for (let f = 0; f < 12; f++) streamer.update('Earth', new THREE.Vector3(0, 0, 0), measureOf(sizes), f * 16);
    expect(streamer.stats().resident).toBe(EARTH_FITS_DESKTOP);
    const stats = streamer.stats();
    expect(stats.budgetedBytes).toBe(EARTH_FITS_DESKTOP * EARTH_SET_BYTES);
    expect(stats.budgetedBytes + stats.reserved).toBeLessThanOrEqual(stats.budget);
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

  it('holds six Earth sectors on a phone and eleven on a desktop', () => {
    expect(EARTH_FITS_TOUCH).toBe(6);
    expect(EARTH_FITS_DESKTOP).toBe(11);
  });

  it('holds a smaller working set on touch devices', () => {
    const s = new SectorStreamer({ limits: TOUCH, load: loader.load, warm: warm.warm });
    s.register(earth);
    loader.auto = true;
    expect(EARTH_FITS_TOUCH).toBeLessThan(EARTH_FITS_DESKTOP);
    expect(EARTH_FITS_TOUCH).toBeLessThan(TOUCH.residentCap);
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) sizes[`${c}_1`] = 2 + 0.01 * c;
    for (let f = 0; f < 12; f++) s.update('Earth', new THREE.Vector3(0, 0, 0), measureOf(sizes), f * 16);
    expect(s.stats().resident).toBe(EARTH_FITS_TOUCH);
    expect(s.stats().budgetedBytes).toBeLessThanOrEqual(TOUCH.ceilingBytes);
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
    expect(loader.requests.map((r) => r.url)).toEqual([expect.stringMatching(/tiles\/mars\.v2\/16k\.[0-9a-f]{8}\/2_1\.webp$/)]);
    loader.requests.length = 0;
    const before = sectorMesh(mars);
    const colourTile = sectorMat(mars).map!;
    const oldMaterialGone = disposed(sectorMat(mars));
    loader.auto = false;
    mars.material.normalMap = new THREE.Texture(); // MOLA relief lands
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16);
    // Only the crop is fetched — the colour tile is the same URL and the one
    // upload that costs — and the old sector keeps drawing meanwhile.
    expect(loader.requests.map((r) => r.url)).toEqual([expect.stringMatching(/tiles\/mars-normal\.v2\/2k\.[0-9a-f]{8}\/2_1\.webp$/)]);
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

  it('does not reload a resident where no fetch is allowed — past the limb, past the terminator', () => {
    const mars = marsWithoutRelief();
    loader.auto = true;
    const sunOver = (c: number, r: number) => sectorCentreDirection(G, { c, r }, new THREE.Vector3());
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0, 'none', sunOver(2, 1));
    loader.auto = false;
    loader.requests.length = 0;
    mars.material.normalMap = new THREE.Texture();
    // Dusk, inside the margin the resident is held through: it stays, and
    // nothing is fetched for it.
    const dusk = sunWhereExtremeIs('lit', SECTOR_NIGHT_DOT - SECTOR_KEEP_LIGHT_MARGIN / 2);
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16, 'none', dusk);
    expect(streamer.stats().bodies.Mars.resident).toEqual(['2_1']);
    expect(loader.requests).toEqual([]);
    // Sunrise: now it reloads.
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 32, 'none', sunOver(2, 1));
    expect(loader.requests.map((r) => r.url)).toEqual([expect.stringMatching(/tiles\/mars-normal\.v2\/2k\.[0-9a-f]{8}\/2_1\.webp$/)]);
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
    expect(loader.requests.map((r) => r.url)).toEqual([expect.stringMatching(/tiles\/mars-normal\.v2\/2k\.[0-9a-f]{8}\/2_1\.webp$/)]);
  });

  it('warns once that a tile did not load, naming the set and the URL', () => {
    // A tile failure is invisible by design: the base map carries on. A wrong
    // tile origin or a set that was never published would otherwise look like
    // nothing more than a slightly soft planet. It goes through debugWarn, so
    // it reaches the ?debug=1 overlay in a build as well as the console — a
    // wrong tile origin only exists in a build.
    resetTileFetchNoticeForTests();
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
      loader.failAll();
      expect(warned).toHaveBeenCalledTimes(1);
      const line = String(warned.mock.calls[0][0]);
      // debugWarn's prefix: the same line reaches window.__dbgLog, which is
      // the ?debug=1 overlay on a device with no console to read.
      expect(line.startsWith('[WARN] ')).toBe(true);
      expect(line).toMatch(/tiles\/earth-day\.v2\/16k\.[0-9a-f]{8}\/2_1\.webp/);
      expect(line).toContain('earth-day.v2/16k');
      // One line is all a session gets: every later failure carries the same
      // information as the first.
      streamer.update('Earth', cameraOver(3, 1), measureOf({ '3_1': 2 }), 4 * SECTOR_RETRY_MS);
      loader.failAll();
      expect(warned).toHaveBeenCalledTimes(1);
    } finally {
      warned.mockRestore();
    }
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
    const s = new SectorStreamer({ limits: DESKTOP, load: loader.load, warm: warm.warm });
    s.register(earth);
    s.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    // One colour tile plus two crops (bump, roughness), RGBA8 with mips.
    const tile = Math.round(2048 * 2048 * 4 * (4 / 3));
    const crop = Math.round(272 * 272 * 4 * (4 / 3));
    expect(s.stats().bodies.Earth.measuredGpuBytes).toBe(tile + 2 * crop);
    expect(s.stats().measuredGpuBytes).toBe(tile + 2 * crop);
    // The figure survives the bitmap being closed after upload.
    const mat = (earth.mesh.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    mat.map!.image = undefined;
    expect(s.stats().measuredGpuBytes).toBe(tile + 2 * crop);
    s.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 0.1 }), 16);
    expect(s.stats().measuredGpuBytes).toBe(0);
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

  it('expires a hung load on a frame that measures nothing, and admits nothing there', () => {
    // The world render stops (the chart owns the frame) but the fetch in
    // flight keeps ageing: a request that hung must not hold its slot in the
    // in-flight allowance until the chart closes.
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    const first = loader.requests.splice(0);
    expect(first.length).toBeGreaterThan(0);
    streamer.maintain(0, SECTOR_ATTEMPT_TIMEOUT_MS);
    expect(streamer.stats().bodies.Earth.loading).toEqual(['2_1']); // not yet
    streamer.maintain(0, SECTOR_ATTEMPT_TIMEOUT_MS + 1);
    expect(streamer.stats().bodies.Earth.loading).toEqual([]);
    expect(streamer.stats().reserved).toBe(0);
    expect(first.every((r) => r.signal!.aborted)).toBe(true);
    // And nothing is measured or fetched for a surface the frame never drew.
    expect(loader.requests).toEqual([]);
  });

  it('gives sectors back on a frame that measures nothing, when the envelope closed behind it', () => {
    loader.auto = true;
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) { sizes[`${c}_1`] = 2 + 0.01 * c; sizes[`${c}_2`] = 2.1 + 0.01 * c; }
    streamer.update('Earth', INSIDE, measureOf(sizes), 0);
    expect(streamer.stats().resident).toBe(EARTH_FITS_DESKTOP);
    // A globe map lands while the chart is up: the sectors' share of the
    // envelope shrinks, and they give it back on that frame rather than
    // sitting over the envelope until the chart closes.
    streamer.maintain(DESKTOP.envelopeBytes - 2 * EARTH_SET_BYTES, 16);
    const s = streamer.stats();
    expect(s.budget).toBe(2 * EARTH_SET_BYTES);
    expect(s.resident).toBe(2);
    expect(s.budgetedBytes + s.reserved).toBeLessThanOrEqual(s.budget);
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
    expect(loader.requests).toHaveLength(DESKTOP.inflightCap);
    expect(loader.requests.every((r) => /mars-normal/.test(r.url))).toBe(true);
    expect(streamer.stats().bodies.Mars.resident.sort()).toEqual(['1_1', '2_1', '3_1']);
    loader.resolveAll();
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2, '3_1': 1.9, '1_1': 1.8, '2_0': 1.7 }), 32);
    // The third reload goes first, then the admission (its tile and crop).
    expect(loader.requests.map((r) => r.url).sort()).toEqual([
      expect.stringMatching(/tiles\/mars-normal\.v2\/2k\.[0-9a-f]{8}\/1_1\.webp$/),
      expect.stringMatching(/tiles\/mars-normal\.v2\/2k\.[0-9a-f]{8}\/2_0\.webp$/),
      expect.stringMatching(/tiles\/mars\.v2\/16k\.[0-9a-f]{8}\/2_0\.webp$/),
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
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 * DESKTOP.wantTexelPx - 0.02 }), 0);
    expect(loader.requests.length).toBe(0); // 1.24 texel px on the 8K map: it still out-resolves a tile
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 * DESKTOP.wantTexelPx + 0.02 }), 16);
    expect(streamer.stats().resident).toBe(1);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 * DESKTOP.releaseTexelPx + 0.02 }), 32);
    expect(streamer.stats().resident).toBe(1); // hysteresis band on the 8K scale
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 * DESKTOP.releaseTexelPx - 0.02 }), 48);
    expect(streamer.stats().resident).toBe(0);
    // A 2K boot map is magnified twice as much at the same on-screen scale.
    earth.material.map!.image = { width: 2048, height: 1024 };
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': DESKTOP.wantTexelPx / 2 + 0.02 }), 64);
    expect(streamer.stats().resident).toBe(1);
  });

  it('measures against the ladder top a body will reach, not the boot map it still draws', () => {
    loader.auto = true;
    // A Moon booting on 2K with an 8K rung: measured against 2K, a sector
    // would be admitted now and released the moment the 8K lands.
    earth.material.map!.image = { width: 2048, height: 1024 };
    earth.topMapWidth = () => 8192;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 * DESKTOP.wantTexelPx - 0.02 }), 0);
    expect(loader.requests.length).toBe(0);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 * DESKTOP.wantTexelPx + 0.02 }), 16);
    expect(streamer.stats().resident).toBe(1);
    // A body with no ladder reads the map it draws instead: Earth's globe map
    // boots at 4096 and nothing ever swaps it.
    streamer.dropAll();
    earth.material.map!.image = { width: 4096, height: 2048 };
    earth.topMapWidth = undefined;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': DESKTOP.wantTexelPx - 0.02 }), 32);
    expect(streamer.stats().resident).toBe(0);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': DESKTOP.wantTexelPx + 0.02 }), 48);
    expect(streamer.stats().resident).toBe(1);
  });

  it('takes the ladder\'s answer as the whole reference, however wide the image is', () => {
    loader.auto = true;
    // The texture's image is not the map: an applied rung swaps a small
    // stand-in into it once the upload is paid, so nothing about the image
    // may raise or lower what a laddered body is measured against.
    earth.topMapWidth = () => 2048;
    earth.material.map!.image = { width: 4096, height: 2048 };
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 1 }), 0);
    expect(streamer.stats().bodies.Earth.maxTexelPx).toBeCloseTo(2, 10);
    streamer.dropAll();
    earth.material.map!.image = { width: 128, height: 64 };
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 1 }), 16);
    expect(streamer.stats().bodies.Earth.maxTexelPx).toBeCloseTo(2, 10);
  });

  it('measures a released rung against the map it draws, not the stand-in in its image', () => {
    loader.auto = true;
    // The whole seam, as the app wires it: a laddered body answers from its
    // ladder, and the ladder is under enough pressure to have given its rung
    // back. The globe draws its 2048-wide boot map; the image behind it is
    // the stand-in a context restore would re-upload from. Measured against
    // THAT, every tile would be admitted at the ratio of the two widths, and
    // none of them could ever fall under the release size again.
    const up = makeTextureUpgrade('mars', earth.material)!;
    earth.topMapWidth = () => ladderMapReferenceWidth(up);
    bindTierAdmission(() => 'blocked');
    try {
      up.appliedTier = null;
      earth.material.map!.image = { width: RESTORE_STANDIN_WIDTH, height: RESTORE_STANDIN_WIDTH / 2 };
      streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 1 }), 0);
      const onStandin = streamer.stats().bodies.Earth.maxTexelPx;
      streamer.dropAll();
      // The same pose with the real boot map still in the image slot.
      earth.material.map!.image = { width: 2048, height: 1024 };
      streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 1 }), 16);
      const onRealMap = streamer.stats().bodies.Earth.maxTexelPx;
      expect(onStandin / onRealMap).toBeCloseTo(1, 10);
      expect(onStandin).toBeCloseTo(2, 10); // 4096/2048 x the 4K-scale size asked for
    } finally {
      bindTierAdmission(null);
    }
  });

  it('releases everything without measuring when even the nearest texel is under the release size', () => {
    loader.auto = true;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    expect(streamer.stats().resident).toBe(1);
    let measured = 0;
    const counting = (centre: THREE.Vector3, radius: number) => { measured++; return measureOf({ '2_1': 2 })(centre, radius); };
    streamer.update('Earth', cameraOver(2, 1), counting, 16, 'none', null, (DESKTOP.releaseTexelPx - 0.01) / TEXEL_LEN_4K);
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
    streamer.update('Earth', cameraOver(2, 1), off(DESKTOP.releaseTexelPx - 0.01), 48);
    expect(streamer.stats().resident).toBe(0); // …until it is small as well
  });

  it('never fetches a sector deep on the night side, and gives up a resident the sun leaves', () => {
    loader.auto = true;
    const sunOver = (c: number, r: number) => sectorCentreDirection(G, { c, r }, new THREE.Vector3());
    // Sun over the antipode of sector 2_1: the sector is deep in the night.
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0, 'none', sunOver(6, 2));
    expect(loader.requests.length).toBe(0);
    // Sun over the sector: fetched.
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16, 'none', sunOver(2, 1));
    expect(streamer.stats().resident).toBe(1);
    // Sunset, and the clock keeps running under a parked camera: the sector
    // is as big as it ever was, and draws nothing at all. It goes.
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 32, 'none', sunOver(6, 2));
    expect(streamer.stats().resident).toBe(0);
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

  it('keeps a resident through the release margin past the gate, and lets it go after', () => {
    loader.auto = true;
    // The gate that admits and the gate that releases are the same test a
    // margin apart, so a terminator creeping across a sector cannot flap a
    // 23 MiB upload: the sector is refused a fresh tile the moment its most
    // lit point passes the twilight margin, keeps the one it has for the
    // whole of SECTOR_KEEP_LIGHT_MARGIN past it, and only then gives it up.
    const inBand = sunWhereExtremeIs('lit', SECTOR_NIGHT_DOT - SECTOR_KEEP_LIGHT_MARGIN / 2);
    const past = sunWhereExtremeIs('lit', SECTOR_NIGHT_DOT - SECTOR_KEEP_LIGHT_MARGIN - 0.01);
    expect(sectorSunExtremes(inBand).lit).toBeCloseTo(SECTOR_NIGHT_DOT - SECTOR_KEEP_LIGHT_MARGIN / 2, 6);
    expect(sectorSunExtremes(past).lit).toBeCloseTo(SECTOR_NIGHT_DOT - SECTOR_KEEP_LIGHT_MARGIN - 0.01, 6);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0, 'none', sunPastSector(0));
    expect(streamer.stats().resident).toBe(1);
    // Inside the band: refused a new tile, and keeping the one it has.
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16, 'none', inBand);
    expect(streamer.stats().resident).toBe(1);
    expect(streamer.stats().bodies.Earth.scores['2_1']).toBeUndefined();
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 32, 'none', past);
    expect(streamer.stats().resident).toBe(0);
    // And the release is a release, not a flap: a sunset walked one degree at
    // a time, then a sunrise, is one drop and one admission — not a pair per
    // step across the edge.
    streamer.dropAll();
    let flips = 0;
    let held = 0;
    let t = 100;
    const step = (sun: THREE.Vector3) => {
      streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), (t += 16), 'none', sun);
      const now = streamer.stats().resident;
      if (now !== held) flips += 1;
      held = now;
    };
    for (let deg = 0; deg <= 180; deg += 1) step(sunPastSector(deg));
    expect(held).toBe(0);
    for (let deg = 180; deg >= 0; deg -= 1) step(sunPastSector(deg));
    expect(held).toBe(1);
    expect(flips).toBe(3); // the first admission, the sunset, the sunrise
  });

  it('a crop failing while the colour tile waits in the warm queue counts as ONE failure', () => {
    // The real pump reports 'disposed' synchronously from inside tex.dispose()
    // (once — the callback is consumed); this fake does the same, so the
    // failure path is exercised re-entrantly.
    const hookWarm = (tex: THREE.Texture, done: (o: WarmOutcome) => void) => {
      let pending: typeof done | null = done;
      tex.addEventListener('dispose', () => { const d = pending; pending = null; d?.('disposed'); });
    };
    const s = new SectorStreamer({ limits: DESKTOP, load: loader.load, warm: hookWarm });
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
    // Twice past the magnification at which level 0's own source runs out:
    // sector (2, 1) and all four of the level-1 sectors inside it are asked
    // for, and each child fetches its own copy of the parent's crops.
    const measure = measureLevels(TWO_LEVELS, { '2_1': 2 * CHILD_WANT_PX });
    for (let f = 0; f < 6; f++) streamer.update('Earth', overLevel1(5, 3), measure, f * 16);
    expect(streamer.stats().bodies.Earth.resident.slice().sort())
      .toEqual(['2_1', 'L1/4_2', 'L1/4_3', 'L1/5_2', 'L1/5_3']);
    const urls = loader.requests.map((r) => r.url);
    expect(urls).toContainEqual(expect.stringMatching(/tiles\/earth-day\.v2\/16k\.[0-9a-f]{8}\/2_1\.webp$/));
    // Each level names its own set, so each carries its own hash: a child's
    // URL cannot resolve through its parent's.
    for (const c of ['4_2', '5_2', '4_3', '5_3']) {
      expect(urls).toContainEqual(expect.stringMatching(new RegExp(`tiles/earth-day\\.v2/32k\\.[0-9a-f]{8}/${c}\\.webp$`)));
    }
    // The parent's crop tile, once per sector that draws it: the parent and
    // its four children.
    expect(urls.filter((u) => /tiles\/earth-bump\/2k\.[0-9a-f]{8}\/2_1\.webp$/.test(u))).toHaveLength(5);
    expect(urls.filter((u) => /tiles\/earth-roughness\.v2\/4k\.[0-9a-f]{8}\/2_1\.webp$/.test(u))).toHaveLength(5);
    const child = (earth2.mesh.children as THREE.Mesh[]).find((m) => m.name.endsWith('L1/5_3'))!;
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

  /** The Moon's planned level 1: its source stops at 27360 across, so its
   *  tiles are cut at the native 1710 px of content — a 1726² NPOT tile and a
   *  1.68× step, not the 2× and 2048² the other two bodies get. */
  const MOON_LEVEL_1: SectorLevel = {
    set: tileSet('moon', '27k'),
    grid: finerGrid(SECTOR_GRID_16K),
    layout: { width: 1726, height: 1726, gutterX: 8, gutterY: 8, spanU: 1, leadU: 0 },
  };

  it('carries an NPOT finer level at its own size: url, transform, segments and bytes', () => {
    expect(levelSourceWidth(MOON_LEVEL_1)).toBe(16 * 1710);
    expect(levelSourceWidth(MOON_LEVEL_1) / levelSourceWidth(LEVEL_0)).toBeCloseTo(1.683, 3);
    const levels = [LEVEL_0, MOON_LEVEL_1];
    const spec = { ...SECTOR_SETS.Moon, levels };
    const moon = earthHandle();
    moon.name = 'Moon';
    moon.spec = spec;
    moon.material.bumpMap = null;
    moon.material.roughnessMap = null;
    moon.material.normalMap = new THREE.Texture();
    streamer.register(moon);
    // The bytes are committed from the layouts before a byte is fetched: the
    // NPOT tile plus the parent's normal crop, and nothing rounded to 2048².
    const childBytes = Math.round(1726 * 1726 * 4 * (4 / 3))
      + Math.round(dataCropLayout(G, 2880, 2).width * dataCropLayout(G, 2880, 2).height * 4 * (4 / 3));
    expect(sectorSetGpuBytes(spec, 1)).toBe(childBytes);
    expect(sectorSetGpuBytes(spec, 1)).toBeLessThan(sectorSetGpuBytes(spec, 0));
    // Children only: the parent is held back by its cooldown after one
    // failure, so the reservation in flight is the finer level's own.
    streamer.update('Moon', overLevel1(5, 3), measureLevels(levels, { '2_1': CHILD_WANT_PX - 0.01 }), 0);
    loader.failAll();
    loader.auto = true;
    warm.auto = null;
    streamer.update('Moon', overLevel1(5, 3), measureLevels(levels, { '2_1': 2 * CHILD_WANT_PX }), 16);
    expect(streamer.stats().reserved).toBe(2 * childBytes); // two loads allowed at once
    expect(loader.requests.map((r) => r.url).sort()).toEqual([
      expect.stringMatching(/tiles\/moon-normal\/4k\.[0-9a-f]{8}\/2_1\.webp$/),
      expect.stringMatching(/tiles\/moon-normal\/4k\.[0-9a-f]{8}\/2_1\.webp$/),
      expect.stringMatching(/tiles\/moon\/27k\.\/4_2\.webp$/),
      expect.stringMatching(/tiles\/moon\/27k\.\/5_2\.webp$/),
    ]);
    warm.settle('warmed');
    const s = streamer.stats();
    expect(s.reserved).toBe(0);
    expect(s.budgetedBytes).toBe(2 * childBytes);
    expect(s.bodies.Moon.resident).toEqual(['L1/4_2', 'L1/5_2']);
    // The colour tile reads through its own NPOT layout, the crop through
    // the parent's two-sector-wide one.
    const mesh = (moon.mesh.children as THREE.Mesh[]).find((m) => m.name.endsWith('L1/4_2'))!;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const tileT = sectorTileTransform(MOON_LEVEL_1.grid, { c: 4, r: 2 }, MOON_LEVEL_1.layout);
    expect(mat.map!.offset.x).toBeCloseTo(tileT.offsetX, 12);
    expect(mat.map!.repeat.x).toBeCloseTo(tileT.repeatX, 12);
    expect(mat.map!.repeat.y).toBeCloseTo(tileT.repeatY, 12);
    const cropT = sectorTileTransform(G, { c: 2, r: 1 }, dataCropLayout(G, 2880, 2));
    expect(mat.normalMap!.offset.x).toBeCloseTo(cropT.offsetX, 12);
    expect(mat.normalMap!.repeat.x).toBeCloseTo(cropT.repeatX, 12);
    // Half the segments of the level above, on the globe's own lattice.
    expect(mesh.geometry.getAttribute('position').count).toBe(17 * 17);
  });

  it('a finer sector draws before the level above it, on half the segments', () => {
    loader.auto = true;
    const earth2 = twoLevelEarth();
    const measure = measureLevels(TWO_LEVELS, { '2_1': 2 * CHILD_WANT_PX });
    for (let f = 0; f < 6; f++) streamer.update('Earth', overLevel1(5, 3), measure, f * 16);
    const meshes = earth2.mesh.children as THREE.Mesh[];
    expect(meshes).toHaveLength(5);
    const byOrder = meshes.slice().sort((a, b) => a.renderOrder - b.renderOrder);
    expect(byOrder[0].renderOrder).toBe(SECTOR_RENDER_ORDER - 1);
    expect(byOrder[4].renderOrder).toBe(SECTOR_RENDER_ORDER);
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
    const measure = measureLevels(TWO_LEVELS, { '2_1': 2 * CHILD_WANT_PX });
    for (let f = 0; f < 6; f++) streamer.update('Earth', overLevel1(5, 3), measure, f * 16);
    const body = streamer.stats().bodies.Earth;
    expect(body.resident.slice().sort()).toEqual(['2_1', 'L1/4_2', 'L1/4_3', 'L1/5_2', 'L1/5_3']);
    expect(body.byLevel.map((l) => l.resident)).toEqual([1, 4]);
    expect(body.byLevel[1].measuredGpuBytes).toBe(0); // the fakes carry no image
    // A single-level body still reports one level and bare ids.
    const mars = marsWithoutRelief();
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    expect(streamer.stats().bodies.Mars.resident).toEqual(['2_1']);
    expect(streamer.stats().bodies.Mars.byLevel).toHaveLength(1);
    expect(mars.mesh.children).toHaveLength(1);
  });

  it('stats name every sector the selection wanted, with the score that ranked it', () => {
    // The resident list says what got in; without the scores beside it there
    // is no way to tell a level nothing demands from a level the byte budget
    // is refusing — which is the whole question a finer level raises.
    loader.auto = true;
    twoLevelEarth();
    const measure = measureLevels(TWO_LEVELS, { '2_1': 2 * CHILD_WANT_PX });
    for (let f = 0; f < 6; f++) streamer.update('Earth', overLevel1(5, 3), measure, f * 16);
    const body = streamer.stats().bodies.Earth;
    expect(Object.keys(body.scores).sort()).toEqual(body.resident.slice().sort());
    // A child scores its parent's divided by the level step, by design: the
    // parent covers four times the ground for the same bytes.
    for (const child of ['L1/4_2', 'L1/4_3', 'L1/5_2', 'L1/5_3']) {
      expect(body.scores[child], child).toBeCloseTo(body.scores['2_1'] / LEVEL_STEP, 6);
    }
    // Nothing off the frame or under the threshold is listed at all.
    expect(body.scores['0_0']).toBeUndefined();
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
    streamer.update('Earth', cam, counting({ '2_1': CHILD_WANT_PX - 0.01 }), 0);
    expect(streamer.stats().bodies.Earth.resident).toEqual(['2_1']);
    // …and once the globe is magnified past the level step — which is when
    // level 0's own source runs out of texels — the children join it.
    streamer.update('Earth', cam, measureLevels(TWO_LEVELS, { '2_1': CHILD_WANT_PX + 0.01 }), 16);
    const resident = streamer.stats().bodies.Earth.resident;
    expect(resident).toContain('2_1');
    expect(resident.filter((id) => id.startsWith('L1/')).length).toBeGreaterThan(0);
    // A sub-tree under a parent with nothing to add costs no projection.
    const beforeGated = measured;
    streamer.update('Earth', cam, counting({}), 32);
    expect(measured - beforeGated).toBeLessThanOrEqual(G.cols * G.rows);
  });

  it('a finer sector takes a coarser one\'s place when it reads further past the want size', () => {
    loader.auto = true;
    twoLevelEarth();
    // A field of level-0 sectors barely past the want size, and one spot
    // magnified far enough that even the children there — reading their
    // parent's magnification divided by the level step — are four times past
    // it. The finer level is not outranked by the coarse field.
    const sizes = { ...field(() => 1.1), '2_1': 4 * CHILD_WANT_PX };
    for (let f = 0; f < 40; f++) streamer.update('Earth', INSIDE, measureLevels(TWO_LEVELS, sizes), f * 16);
    const s = streamer.stats();
    expect(s.bodies.Earth.resident).toContain('2_1');
    expect(s.bodies.Earth.byLevel[1].resident).toBe(4);
    expect(s.resident).toBe(EARTH_FITS_DESKTOP);
    expect(s.budgetedBytes + s.reserved).toBeLessThanOrEqual(s.budget);
  });

  it('never evicts a sector a finer one is drawing over', () => {
    loader.auto = true;
    twoLevelEarth();
    const strong = { ...field(() => 1.5), '2_1': 2 * CHILD_WANT_PX };
    for (let f = 0; f < 40; f++) streamer.update('Earth', INSIDE, measureLevels(TWO_LEVELS, strong), f * 16);
    const full = streamer.stats().bodies.Earth.resident.slice().sort();
    expect(full).toContain('2_1');
    expect(full.filter((id) => id.startsWith('L1/'))).toHaveLength(4);
    // The parent's own nearest point swings off the frame while its
    // children's stay on it: it scores nothing and is the weakest thing
    // resident. A newcomer that out-ranks everything still takes a sector
    // WITHOUT a resident child instead.
    const parentOff = new Set(['2_1']);
    streamer.update('Earth', INSIDE, measureLevels(TWO_LEVELS, strong, 1, parentOff), 5_000);
    for (let f = 0; f < 4; f++) {
      streamer.update('Earth', INSIDE, measureLevels(TWO_LEVELS, { ...strong, '7_3': 40 }, 1, parentOff), 6_000 + f * 16);
    }
    const after = streamer.stats().bodies.Earth.resident;
    expect(after).toContain('7_3');
    expect(after).toContain('2_1'); // held under its children, though it ranks last
    expect(after.filter((id) => id.startsWith('L1/2_'))).toHaveLength(0);
    expect(streamer.stats().bodies.Earth.byLevel[1].resident).toBeGreaterThan(0);
  });

  it('takes a parent along with the last child drawing over it, in one call', () => {
    loader.auto = true;
    const earth2 = twoLevelEarth();
    // A body whose set is bigger than one Earth sector but smaller than two,
    // so the only room for it is a child AND the parent that child covers.
    const bigSpec: SectorSetSpec = {
      ...SECTOR_SETS.Earth,
      crops: { ...SECTOR_SETS.Earth.crops, normalMap: tileSet('mars-normal.v2', '2k') },
    };
    const BIG_SET_BYTES = sectorSetGpuBytes(bigSpec);
    expect(BIG_SET_BYTES).toBeGreaterThan(EARTH_SET_BYTES);
    expect(BIG_SET_BYTES).toBeLessThan(2 * EARTH_SET_BYTES);
    const big = earthHandle();
    big.name = 'Big';
    big.spec = bigSpec;
    big.material.normalMap = new THREE.Texture();
    streamer.register(big);
    // One spot magnified past the level step, with three of the four finer
    // sectors there off the frame: the parent ends up with exactly one child
    // drawing over it.
    const sizes = { '2_1': 2 * CHILD_WANT_PX };
    const away = new Set(['L1/4_3', 'L1/5_2', 'L1/5_3']);
    const earthMeasure = measureLevels(TWO_LEVELS, sizes, 1, away);
    streamer.update('Earth', INSIDE, earthMeasure, 0);
    streamer.update('Earth', INSIDE, earthMeasure, 16); // drawn: the dwell starts
    expect(streamer.stats().bodies.Earth.resident.slice().sort()).toEqual(['2_1', 'L1/4_2']);
    // The order the two are given up in has to be child first: a parent
    // released early would drop the surface under a sector still drawing.
    const dropped: string[] = [];
    for (const mesh of earth2.mesh.children as THREE.Mesh[]) {
      const name = mesh.name;
      (mesh.material as THREE.MeshStandardMaterial).map!.addEventListener('dispose', () => dropped.push(name));
    }
    // Room for exactly what the two of them hold, and a far stronger
    // candidate that needs all of it.
    streamer.setGlobalMapBytes(DESKTOP.envelopeBytes - 2 * EARTH_SET_BYTES);
    expect(streamer.stats().resident).toBe(2);
    streamer.beginFrame();
    streamer.update('Earth', INSIDE, earthMeasure, 2_000);
    streamer.update('Big', INSIDE, measureOf({ '0_0': 40 }), 2_000);
    streamer.endFrame();
    const s = streamer.stats();
    expect(s.bodies.Big.resident).toEqual(['0_0']);
    expect(s.bodies.Earth.resident).toEqual([]);
    expect(dropped).toEqual(['Earth sector L1/4_2', 'Earth sector 2_1']);
    expect(s.budgetedBytes + s.reserved).toBeLessThanOrEqual(s.budget);
  });

  it('suppresses a parent every child of which is resident, and wants it back the moment one is lost', () => {
    twoLevelEarth();
    const cam = overLevel1(5, 3);
    const measure = measureLevels(TWO_LEVELS, { '2_1': 2 * CHILD_WANT_PX });
    // The parent's own tile fails once and cools down. At this magnification
    // level 0's source has not run out yet, so nothing finer is in flight to
    // fail with it; its children land on the frames after.
    streamer.update('Earth', cam, measureLevels(TWO_LEVELS, { '2_1': CHILD_WANT_PX - 0.01 }), 0);
    loader.failAll();
    loader.auto = true;
    for (let f = 1; f <= 8; f++) streamer.update('Earth', cam, measure, f * 16);
    expect(streamer.stats().bodies.Earth.resident.slice().sort())
      .toEqual(['L1/4_2', 'L1/4_3', 'L1/5_2', 'L1/5_3']);
    // Past the cooldown it is wanted and idle, but nothing of it would show.
    loader.requests.length = 0;
    streamer.update('Earth', cam, measure, SECTOR_RETRY_MS + 100);
    expect(loader.requests).toEqual([]);
    // The camera drops to a hover close enough that one of the four children
    // goes over the horizon and is released. The parent is the fallback
    // under the other three, and is asked for again.
    streamer.update('Earth', overLevel1(4, 2, 1.03), measure, SECTOR_RETRY_MS + 200);
    expect(streamer.stats().bodies.Earth.byLevel[1].resident).toBe(3);
    expect(loader.requests.map((r) => r.url)).toContainEqual(
      expect.stringMatching(/tiles\/earth-day\.v2\/16k\.[0-9a-f]{8}\/2_1\.webp$/),
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
    expect(s.loading).toBe(DESKTOP.inflightCap);
    expect(s.reserved).toBe(DESKTOP.inflightCap * EARTH_SET_BYTES);
    expect(s.budgetedBytes).toBe(0);
    expect(s.measuredGpuBytes).toBe(0);
    expect(s.budgetedBytes + s.reserved).toBeLessThanOrEqual(s.budget);
    loader.failAll();
    expect(streamer.stats().reserved).toBe(0);
    // What lands is held as resident bytes instead, and dropAll gives back both.
    loader.auto = true;
    streamer.update('Earth', INSIDE, measureOf({ '2_1': 2 }), SECTOR_RETRY_MS + 1);
    s = streamer.stats();
    expect(s.budgetedBytes).toBe(EARTH_SET_BYTES);
    expect(s.reserved).toBe(0);
    streamer.dropAll();
    s = streamer.stats();
    expect(s.budgetedBytes).toBe(0);
    expect(s.reserved).toBe(0);
  });

  it('takes the sector budget out of one envelope with the globe maps, and gives sectors back when it shrinks', () => {
    loader.auto = true;
    expect(streamer.stats().budget).toBe(DESKTOP.ceilingBytes);
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) { sizes[`${c}_1`] = 2 + 0.01 * c; sizes[`${c}_2`] = 2.1 + 0.01 * c; }
    streamer.update('Earth', INSIDE, measureOf(sizes), 0);
    expect(streamer.stats().resident).toBe(EARTH_FITS_DESKTOP);
    // The globe maps grow (an 8K rung lands) and the envelope leaves the
    // sectors room for three.
    streamer.setGlobalMapBytes(DESKTOP.envelopeBytes - 3 * EARTH_SET_BYTES);
    expect(streamer.stats().budget).toBe(3 * EARTH_SET_BYTES);
    streamer.update('Earth', INSIDE, measureOf(sizes), 16);
    const s = streamer.stats();
    expect(s.resident).toBe(3);
    expect(s.budgetedBytes + s.reserved).toBeLessThanOrEqual(s.budget);
    // The three kept are the strongest.
    expect(s.bodies.Earth.resident.slice().sort()).toEqual(['5_2', '6_2', '7_2']);
  });

  /** A body whose tiles are a quarter the size of Earth's and carry no
   *  crops — the small-set case a level below the coarsest is, and the Moon's
   *  1726² tiles are. */
  const SMALL_LEVEL: SectorLevel = {
    set: tileSet('moon', '8k'),
    grid: SECTOR_GRID_16K,
    layout: { ...SECTOR_TILE, width: 1024, height: 1024 },
  };
  function smallTileBody(): ReturnType<typeof earthHandle> {
    const h = earthHandle();
    h.name = 'Small';
    h.spec = { crops: {}, levels: [SMALL_LEVEL] };
    h.material.bumpMap = null;
    h.material.roughnessMap = null;
    streamer.register(h);
    return h;
  }

  it('a candidate too big for the room left does not block a smaller one behind it', () => {
    loader.auto = true;
    smallTileBody();
    const small = sectorSetGpuBytes({ crops: {}, levels: [SMALL_LEVEL] });
    expect(small).toBeLessThan(EARTH_SET_BYTES);
    // Four Earth sectors, all past the dwell and all ranking together.
    const earthSizes = { '2_1': 3, '3_1': 3, '4_1': 3, '5_1': 3 };
    for (let f = 0; f < 8; f++) streamer.update('Earth', INSIDE, measureOf(earthSizes), f * 16);
    const held = streamer.stats().budgetedBytes;
    expect(streamer.stats().resident).toBe(4);
    // Leave room for one small set and nothing like an Earth one.
    streamer.setGlobalMapBytes(DESKTOP.envelopeBytes - held - 2 * small);
    // The strongest candidate is an Earth sector that would need a victim it
    // does not out-rank by the margin; behind it a small tile that fits in
    // the room already free.
    streamer.beginFrame();
    streamer.update('Earth', INSIDE, measureOf({ ...earthSizes, '0_0': 3 * SECTOR_ADMIT_MARGIN * 0.9 }), 10_000);
    streamer.update('Small', INSIDE, measureOf({ '0_0': 2 }), 10_000);
    streamer.endFrame();
    const s = streamer.stats();
    expect(s.bodies.Earth.resident).not.toContain('0_0'); // blocked by the margin
    expect(s.bodies.Small.resident.concat(s.bodies.Small.loading)).toEqual(['0_0']);
    expect(s.budgetedBytes + s.reserved).toBeLessThanOrEqual(s.budget);
  });

  it('gives back a whole pyramid in one call, parents included', () => {
    loader.auto = true;
    twoLevelEarth();
    // A parent and all four of its children resident: every parent is
    // protected by a child, so the first sweep can only see leaves.
    const measure = measureLevels(TWO_LEVELS, { '2_1': 2 * CHILD_WANT_PX });
    for (let f = 0; f < 8; f++) streamer.update('Earth', INSIDE, measure, f * 16);
    const before = streamer.stats();
    expect(before.bodies.Earth.byLevel.map((l) => l.resident)).toEqual([1, 4]);
    // The envelope closes on it entirely.
    streamer.setGlobalMapBytes(DESKTOP.envelopeBytes);
    const s = streamer.stats();
    expect(s.budget).toBe(0);
    expect(s.budgetedBytes + s.reserved).toBe(0);
    expect(s.resident).toBe(0);
  });

  it('says once when the budget falls under one whole set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A budget that cannot hold one set is the same silence as a budget of
      // nothing: no tile is admitted with it, and a fraction of a set is not
      // a smaller tile. The warning is what tells a soft surface from a
      // fault, so it fires there rather than at zero.
      streamer.setGlobalMapBytes(DESKTOP.envelopeBytes - EARTH_SET_BYTES);
      expect(warn).not.toHaveBeenCalled();
      streamer.setGlobalMapBytes(DESKTOP.envelopeBytes - EARTH_SET_BYTES + 1);
      expect(streamer.stats().budget).toBeLessThan(EARTH_SET_BYTES);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('below one sector set');
      // Once: a per-frame figure that stays there must not become a log.
      streamer.setGlobalMapBytes(DESKTOP.envelopeBytes);
      expect(streamer.stats().budget).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('gives sectors back the moment the envelope closes, not on the next frame', () => {
    loader.auto = true;
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) { sizes[`${c}_1`] = 2 + 0.01 * c; sizes[`${c}_2`] = 2.1 + 0.01 * c; }
    for (let f = 0; f < 24; f++) streamer.update('Earth', INSIDE, measureOf(sizes), f * 16);
    expect(streamer.stats().resident).toBe(EARTH_FITS_DESKTOP);
    // A globe map lands between frames. Nothing calls update() before the
    // next stats() read, and the invariant still has to hold in it.
    streamer.setGlobalMapBytes(DESKTOP.envelopeBytes - 2 * EARTH_SET_BYTES);
    const s = streamer.stats();
    expect(s.resident).toBe(2);
    expect(s.budgetedBytes + s.reserved).toBeLessThanOrEqual(s.budget);
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
    streamer.setGlobalMapBytes(DESKTOP.envelopeBytes - Math.round(0.6 * EARTH_SET_BYTES));
    streamer.update('Earth', INSIDE, measureOf(sizes), 10_000);
    const s = streamer.stats();
    expect(s.budgetedBytes + s.reserved).toBeLessThanOrEqual(s.budget);
    // …and nothing is in the air for a slot that gave its maps up.
    expect(loader.requests).toEqual([]);
    expect(s.inflight).toBe(0);
  });

  it('leaves a sector alone for a moment after admitting it, whatever turns up next', () => {
    loader.auto = true;
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) { sizes[`${c}_1`] = 2 + 0.01 * c; sizes[`${c}_2`] = 2.1 + 0.01 * c; }
    streamer.update('Earth', INSIDE, measureOf(sizes), 0);
    const drawn = 16;
    streamer.update('Earth', INSIDE, measureOf(sizes), drawn); // the frame they first draw on
    const before = streamer.stats().bodies.Earth.resident.slice().sort();
    // A far stronger candidate, while everything resident is a moment old.
    const withNewcomer = { ...sizes, '0_0': 50 };
    streamer.update('Earth', INSIDE, measureOf(withNewcomer), drawn + SECTOR_EVICT_DWELL_MS - 1);
    expect(streamer.stats().bodies.Earth.resident.slice().sort()).toEqual(before);
    streamer.update('Earth', INSIDE, measureOf(withNewcomer), drawn + SECTOR_EVICT_DWELL_MS);
    expect(streamer.stats().bodies.Earth.resident).toContain('0_0');
  });

  it('a frame left open by a throw does not hold the streamer in measure-only mode', () => {
    loader.auto = true;
    streamer.beginFrame();
    streamer.update('Earth', INSIDE, measureOf({ '2_1': 6 }), 0);
    // Something between the two calls threw: endFrame never ran. The mode
    // pairs them in a finally, and a teardown closes the frame regardless.
    streamer.dropAll();
    expect(streamer.stats().resident).toBe(0);
    streamer.update('Earth', INSIDE, measureOf({ '2_1': 6 }), 16);
    expect(streamer.stats().bodies.Earth.resident).toEqual(['2_1']);
  });

  it('a body unregistered inside an open frame is not reconciled at the end of it', () => {
    loader.auto = true;
    streamer.beginFrame();
    streamer.update('Earth', INSIDE, measureOf({ '2_1': 6 }), 0);
    streamer.unregister('Earth');
    streamer.endFrame();
    expect(streamer.has('Earth')).toBe(false);
    expect(loader.requests).toEqual([]);
    expect(streamer.stats().reserved).toBe(0);
  });

  it('refuses a set deeper than the segment lattice can carry', () => {
    // Every level halves the segments; the deepest allowed still leaves a
    // sector more than three across, which is where three clamps a sphere.
    expect(SECTOR_SEGMENTS >> SECTOR_MAX_LEVEL).toBeGreaterThanOrEqual(3);
    const level = (i: number): SectorLevel => ({
      set: tileSet('earth-day.v2', `${i}`),
      grid: { cols: SECTOR_GRID_16K.cols << i, rows: SECTOR_GRID_16K.rows << i },
      layout: SECTOR_TILE,
    });
    const deep = earthHandle();
    deep.name = 'Deep';
    const levels = [];
    for (let i = 0; i <= SECTOR_MAX_LEVEL; i++) levels.push(level(i));
    deep.spec = { ...SECTOR_SETS.Earth, levels };
    expect(() => streamer.register(deep)).not.toThrow();
    deep.spec = { ...SECTOR_SETS.Earth, levels: [...levels, level(SECTOR_MAX_LEVEL + 1)] };
    expect(() => streamer.register(deep)).toThrow(/sector levels/);
    // The refused registration left the body it replaced alone.
    expect(streamer.has('Deep')).toBe(true);
    expect(() => streamer.register({ ...deep, spec: { ...SECTOR_SETS.Earth, levels: [] } })).toThrow();
  });

  it('takes the fetch pool by the whole set, so no set starts that the pool cannot carry', () => {
    // A set of four maps against a pool of six: one goes, the second waits
    // however much slot allowance and budget there is.
    const spec: SectorSetSpec = {
      ...SECTOR_SETS.Earth,
      crops: {
        ...SECTOR_SETS.Earth.crops,
        normalMap: tileSet('mars-normal.v2', '2k'),
      },
    };
    const big = earthHandle();
    big.name = 'Big';
    big.spec = spec;
    big.material.normalMap = new THREE.Texture();
    streamer.register(big);
    streamer.update('Big', INSIDE, measureOf({ '2_1': 3, '3_1': 2 }), 0);
    expect(loader.requests).toHaveLength(4);
    expect(loader.requests.length).toBeLessThanOrEqual(DESKTOP.fetchPool);
    expect(streamer.stats().inflight).toBe(1);
    expect(streamer.stats().reserved).toBe(sectorSetGpuBytes(spec));
  });

  it('starts the eviction dwell on the frame a tile is first drawn, not when its fetch lands', () => {
    // Room for exactly one Earth set, so every admission is a replacement.
    streamer.setGlobalMapBytes(DESKTOP.envelopeBytes - EARTH_SET_BYTES);
    streamer.update('Earth', INSIDE, measureOf({ '2_1': 2 }), 0);
    expect(streamer.stats().bodies.Earth.loading).toEqual(['2_1']);
    // A far stronger candidate takes the reservation while the fetch is
    // still in the air: nothing has been uploaded for it to protect.
    streamer.update('Earth', INSIDE, measureOf({ '2_1': 2, '5_2': 40 }), 16);
    expect(streamer.stats().bodies.Earth.loading).toEqual(['5_2']);
    // The tile lands and uploads on a frame that draws no surface at all —
    // the warm pump runs under the open system map too — and the frame that
    // first shows the sector comes minutes later.
    loader.resolveAll();
    expect(streamer.stats().bodies.Earth.resident).toEqual(['5_2']);
    const shown = 600_000;
    const pressure = measureOf({ '5_2': 40, '0_0': 400 });
    streamer.update('Earth', INSIDE, pressure, shown);
    expect(streamer.stats().bodies.Earth.resident).toEqual(['5_2']); // its first frame on screen
    // From there the upload is safe for the dwell however strong the next
    // candidate is…
    streamer.update('Earth', INSIDE, pressure, shown + SECTOR_EVICT_DWELL_MS - 1);
    expect(streamer.stats().bodies.Earth.resident).toEqual(['5_2']);
    // …and no longer.
    streamer.update('Earth', INSIDE, pressure, shown + SECTOR_EVICT_DWELL_MS);
    expect(streamer.stats().bodies.Earth.loading).toEqual(['0_0']);
  });

  it('settles under budget pressure: two hundred frames at one pose, no churn and no starved child', () => {
    loader.auto = true;
    twoLevelEarth();
    const sizes = {
      ...field((c, r) => 1.5 + 0.01 * (c + G.cols * r)),
      '2_1': 2 * CHILD_WANT_PX,
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
    expect(s.budgetedBytes + s.reserved).toBeLessThanOrEqual(s.budget);
    expect(s.resident).toBe(EARTH_FITS_DESKTOP);
  });

  it('drops every level on context loss and streams them all back', () => {
    loader.auto = true;
    twoLevelEarth();
    const measure = measureLevels(TWO_LEVELS, { '2_1': 2 * CHILD_WANT_PX });
    for (let f = 0; f < 6; f++) streamer.update('Earth', overLevel1(5, 3), measure, f * 16);
    const before = streamer.stats().bodies.Earth.resident.slice().sort();
    expect(before).toEqual(['2_1', 'L1/4_2', 'L1/4_3', 'L1/5_2', 'L1/5_3']);
    streamer.dropAll();
    let s = streamer.stats();
    expect(s.resident).toBe(0);
    expect(s.budgetedBytes).toBe(0);
    expect(s.reserved).toBe(0);
    for (let f = 6; f < 12; f++) streamer.update('Earth', overLevel1(5, 3), measure, f * 16);
    s = streamer.stats();
    expect(s.bodies.Earth.resident.slice().sort()).toEqual(before);
    expect(s.budgetedBytes).toBe(5 * EARTH_SET_BYTES);
  });

  /** The scripted level-0 session both golden traces run — a pose, a pan, a
   *  globe map landing on the budget, one candidate sharp enough to evict a
   *  resident, a context loss — with every fetch the streamer starts and
   *  every tile it drops recorded in order. Any change to what level 0
   *  admits, when it admits it, or what it gives up first shows as a diff.
   *  The script is the same for every set of device numbers; only the
   *  envelope it is handed and the trace it produces differ. */
  function goldenTrace(
    make: (load: FakeLoader['load']) => SectorStreamer,
    envelopeBytes: number,
  ): { events: string[]; stats: ReturnType<SectorStreamer['stats']> } {
    const events: string[] = [];
    let frame = 0;
    // The set key is part of the id, not only the tier: a body with a second
    // family publishes a level-0 set of its own at the same 16k tier, and a
    // tier-only pattern would record its tiles as this trace's.
    const tileId = (url: string) => /\/earth-day\.v2\/16k\.[0-9a-f]{8}\/(\d+_\d+)\.webp$/.exec(url)?.[1] ?? null;
    const pending: Array<() => void> = [];
    const recording = (url: string, onLoad: (t: THREE.Texture) => void) => {
      const id = tileId(url);
      if (id) events.push(`f${frame} +${id}`);
      const tex = new THREE.Texture();
      if (id) tex.addEventListener('dispose', () => events.push(`f${frame} -${id}`));
      pending.push(() => onLoad(tex));
    };
    const s = make(recording);
    s.register(earthHandle());
    // Room for four sets, so the working set is decided by the budget from
    // the first frame rather than by the count cap.
    s.setGlobalMapBytes(envelopeBytes - 4 * EARTH_SET_BYTES);
    const poseA = { '2_1': 3.0, '3_1': 2.6, '1_1': 2.2, '4_1': 1.8, '2_2': 1.4, '3_2': 1.2 };
    // A pan east: three of the six leave the measure, one drops under the
    // release size, and three sectors ahead of the camera come up.
    const poseB = { '4_1': 3.0, '5_1': 2.6, '3_1': 2.2, '6_1': 1.8, '4_2': 1.4, '2_1': 0.5 };
    let clock = 0;
    const run = (sizes: Record<string, number>, frames: number) => {
      for (let i = 0; i < frames; i++) {
        s.update('Earth', INSIDE, measureOf(sizes), clock, 'none', sun);
        // The fetches in flight land between frames.
        for (const settle of pending.splice(0)) settle();
        frame += 1;
        clock += 16;
      }
    };
    // A real sun, over the north pole: the day family's gate and its weight
    // ramp both run, where a null sun would pin lightFraction at 1 and leave
    // this trace blind to the one term every body's day sectors are ranked
    // by. At this sun every sector the script poses is fetchable, and the
    // northern row it admits from is lit at every sample point — the southern
    // row it never admits from is the one the ramp scales down.
    const sun = new THREE.Vector3(0, 1, 0);
    // The script is frames, so it needs somewhere to spend the seconds a
    // sector is protected for after it appears.
    const hold = (ms: number) => {
      clock += ms;
      events.push(`f${frame} * ${ms / 1000}s of looking`);
    };
    run(poseA, 4);
    hold(2_000);
    run(poseA, 2);
    run(poseB, 3);
    hold(2_000);
    run(poseB, 2);
    events.push(`f${frame} * the globe's own map grows: room for two sets`);
    s.setGlobalMapBytes(envelopeBytes - 2 * EARTH_SET_BYTES);
    run(poseB, 2);
    hold(2_000);
    // A sector ahead of the camera comes up sharp enough to be worth a
    // resident one: the only eviction in the script that is not a give-back.
    const poseC = { ...poseB, '7_1': 12 };
    run(poseC, 3);
    events.push(`f${frame} * context loss`);
    s.dropAll();
    run(poseC, 3);
    const stats = s.stats();
    expect(stats.budgetedBytes + stats.reserved).toBeLessThanOrEqual(stats.budget);
    recordTrace(events);
    return { events, stats };
  }

  /** Re-records the traces instead of leaving them to be transcribed by hand:
   *
   *    UPDATE_TRACES=1 npx vitest run --dir src --disableConsoleIntercept \
   *      -t 'golden trace'
   *
   *  (the intercept flag is what lets a passing test's output through).
   *
   *  Three literals hold one script and nothing keeps them consistent with
   *  each other, so a legitimate change to what level 0 admits means
   *  re-recording all three — and a change nobody is willing to re-record by
   *  hand is a change nobody makes.
   *
   *  It prints, and never writes: the narrative markers interleaved in the
   *  literals below are what makes them readable, and only a person can carry
   *  those across to a new recording. Unset — every ordinary run, CI included
   *  — nothing prints and the literals below are the assertion. */
  function recordTrace(events: string[]): void {
    if (!process.env.UPDATE_TRACES) return;
    // Single quotes except where the entry has an apostrophe in it, which is
    // what the literals below already do.
    const quote = (e: string) => (e.includes("'") ? JSON.stringify(e) : `'${e}'`);
    const lines = events.map((e) => `      ${quote(e)},`).join('\n');
    console.log(
      `\n// re-recorded: ${expect.getState().currentTestName ?? 'golden trace'}\n` +
      `    expect(events).toEqual([\n${lines}\n    ]);\n`,
    );
  }

  it('takes the same level-0 decisions in the same order: a golden trace', () => {
    const { events, stats } = goldenTrace(
      (load) => new SectorStreamer({ limits: DESKTOP, load, warm: warm.warm }),
      DESKTOP.envelopeBytes,
    );
    expect(events).toEqual([
      // Two admissions a frame (the in-flight cap), strongest first, until the
      // budget is full at four; the two under it never out-rank the weakest
      // by the margin, dwell or no dwell.
      'f0 +2_1',
      'f0 +3_1',
      'f1 +1_1',
      'f1 +4_1',
      'f4 * 2s of looking',
      // The pan: one sector leaves the measure, one falls under the release
      // size, and the two strongest of what is now ahead take their room.
      'f6 -1_1',
      'f6 -2_1',
      'f6 +5_1',
      'f6 +6_1',
      'f9 * 2s of looking',
      // The give-back is immediate and takes the weakest first — but only as
      // far as the floor: the script asks for room for two sets and a desktop
      // keeps three whatever the globe maps have taken, so the third set
      // stays where it used to go.
      "f11 * the globe's own map grows: room for two sets",
      'f11 -6_1',
      'f13 * 2s of looking',
      // The one eviction for a candidate: it out-ranks the weakest resident
      // by more than the margin, and takes exactly that one sector.
      'f13 -3_1',
      'f13 +7_1',
      // Everything is dropped and streams back, strongest first, into the
      // budget as it now stands — three sets, so one of them lands a frame
      // later than the two the in-flight cap admits at once.
      'f16 * context loss',
      'f16 -4_1',
      'f16 -5_1',
      'f16 -7_1',
      'f16 +7_1',
      'f16 +4_1',
      'f17 +5_1',
    ]);
    // And the day family's light weight really is in the ranking these
    // decisions came out of: the northern row the script admits from is lit
    // at all six sample points and scores its magnification whole, while the
    // southern row is lit at three of them and scores half of its own.
    // (Desktop wants a tile at 1.0 device px per texel, so a score IS the
    // weighted magnification here.)
    expect(stats.bodies.Earth.scores['4_1']).toBeCloseTo(3.0, 9);
    expect(stats.bodies.Earth.scores['4_2']).toBeCloseTo(1.4 / 2, 9);
  });

  it('takes the same level-0 decisions on an Android phone: a golden trace', () => {
    const { events } = goldenTrace(
      (load) => new SectorStreamer({ limits: TOUCH, load, warm: warm.warm }),
      TOUCH.envelopeBytes,
    );
    // An Android or other-platform touch device, on the numbers the app
    // shipped with: the same script, the same four sets, the same order —
    // one admission a frame instead of two, because its in-flight cap is 1.
    // The budget is its smaller envelope less the same four sets, so what
    // the working set holds is unchanged; only the pace differs.
    expect(events).toEqual([
      'f0 +2_1',
      'f1 +3_1',
      'f2 +1_1',
      'f3 +4_1',
      'f4 * 2s of looking',
      'f6 -1_1',
      'f6 -2_1',
      'f6 +5_1',
      'f7 +6_1',
      'f9 * 2s of looking',
      "f11 * the globe's own map grows: room for two sets",
      'f11 -6_1',
      'f11 -3_1',
      'f13 * 2s of looking',
      'f13 -5_1',
      'f13 +7_1',
      'f16 * context loss',
      'f16 -4_1',
      'f16 -7_1',
      'f16 +7_1',
      'f17 +4_1',
    ]);
  });

  it('takes the desktop decisions on an Apple phone: a golden trace', () => {
    const { events } = goldenTrace(
      (load) => new SectorStreamer({ limits: APPLE_PHONE, load, warm: warm.warm }),
      APPLE_PHONE.envelopeBytes,
    );
    // A phone-shaped device on the measured numbers. Read against the
    // Android trace above, the differences are the whole of what the
    // measurement bought: two admissions a frame instead of one (f0 takes
    // 2_1 AND 3_1), and a floor of three sets instead of two — which is why
    // the globe map growing at f11 gives back one sector here and two there,
    // and why the context loss streams three back rather than two.
    expect(events).toEqual([
      'f0 +2_1',
      'f0 +3_1',
      'f1 +1_1',
      'f1 +4_1',
      'f4 * 2s of looking',
      'f6 -1_1',
      'f6 -2_1',
      'f6 +5_1',
      'f6 +6_1',
      'f9 * 2s of looking',
      "f11 * the globe's own map grows: room for two sets",
      'f11 -6_1',
      'f13 * 2s of looking',
      'f13 -3_1',
      'f13 +7_1',
      'f16 * context loss',
      'f16 -4_1',
      'f16 -5_1',
      'f16 -7_1',
      'f16 +7_1',
      'f16 +4_1',
      'f17 +5_1',
    ]);
    // And it IS the desktop trace: the same script over the same numbers
    // takes the same decisions, which is what "the desktop row on a phone"
    // means when it is spent rather than written down.
    const desktop = goldenTrace(
      (load) => new SectorStreamer({ limits: DESKTOP, load, warm: warm.warm }),
      DESKTOP.envelopeBytes,
    );
    expect(events).toEqual(desktop.events);
  });

  it('scales a day sector by how much of it the sun is on', () => {
    // The day family's own ramp, the counterpart of the night shell's mask:
    // nothing at the twilight margin its gate refuses past, everything in
    // full sun, and a smooth step between — so a sector crossing the
    // terminator gives up its score gradually instead of at a line. This is
    // the term every registered day family is ranked through, the Moon's and
    // Mars's included.
    const weight = daySectorFamily(new THREE.MeshStandardMaterial()).weight;
    expect(weight(SECTOR_NIGHT_DOT)).toBe(0);
    expect(weight(SECTOR_NIGHT_DOT - 0.5)).toBe(0);
    expect(weight(0)).toBe(1);
    expect(weight(1)).toBe(1);
    expect(weight(SECTOR_NIGHT_DOT / 2)).toBeCloseTo(0.5, 12);
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

describe('a body\'s night family: a second set of sectors on the night shell', () => {
  let loader: FakeLoader;
  let warm: FakeWarm;
  let streamer: SectorStreamer;
  let day: TestHandle;
  let night: TestHandle & { material: THREE.ShaderMaterial };

  beforeEach(() => {
    loader = new FakeLoader();
    warm = new FakeWarm();
    streamer = new SectorStreamer({ limits: DESKTOP, load: loader.load, warm: warm.warm });
    day = earthHandle();
    night = earthNightHandle();
    streamer.register(day);
    streamer.register(night);
  });

  /** One frame in which both of Earth's families are measured before either
   *  is admitted — how the mode drives them. `sizes` is in device px per texel
   *  of the 4K map, the same physical magnification for both. */
  function frame(
    sizes: Record<string, number>,
    sun: THREE.Vector3 | null,
    nowMs: number,
    nightSizes: Record<string, number> = sizes,
  ): void {
    streamer.beginFrame();
    streamer.update('Earth', cameraOver(2, 1), measureOf(sizes), nowMs, 'none', sun);
    streamer.update(NIGHT_KEY, cameraOver(2, 1), measureNight(nightSizes), nowMs, 'none', sun);
    streamer.endFrame();
  }

  const held = () => {
    const ids = streamer.stats().bodies.Earth?.resident ?? [];
    return {
      day: ids.filter((id) => !id.startsWith('night/')),
      night: ids.filter((id) => id.startsWith('night/')),
    };
  };

  it('wants a sector on the mirror of the day rule, at three exact sun angles', () => {
    loader.auto = true;
    // Noon over the sector, 15 deg past the terminator, midnight — the sun an
    // exact unit vector each time. Day is refused once its MOST LIT point is
    // past the twilight margin; night until its DARKEST point is past the
    // shell's lit edge, which is the same test read from the other end.
    const cases: Array<{ deg: number; day: boolean; night: boolean }> = [
      { deg: 0, day: true, night: false },
      { deg: 105, day: true, night: true },
      { deg: 180, day: false, night: true },
    ];
    let t = 0;
    for (const c of cases) {
      streamer.dropAll();
      const sun = sunPastSector(c.deg);
      frame({ '2_1': 2 }, sun, (t += 1000));
      const { lit, dark } = sectorSunExtremes(sun);
      const what = `sun ${c.deg} deg past the sector (lit ${lit.toFixed(3)}, dark ${dark.toFixed(3)})`;
      expect(held().day.length > 0, `day at ${what}`).toBe(c.day);
      expect(held().night.length > 0, `night at ${what}`).toBe(c.night);
      // …and the residency really is the predicate, not a coincidence of pose.
      expect(held().day.length > 0).toBe(lit >= SECTOR_NIGHT_DOT);
      expect(held().night.length > 0).toBe(dark < EARTH_NIGHT_MIX_LIT);
    }
  });

  it('wants BOTH families across the terminator, each scaled by what it lights', () => {
    loader.auto = true;
    const sun = sunPastSector(105);
    frame({ '2_1': 2 }, sun, 1000);
    const scores = streamer.stats().bodies.Earth.scores;
    expect(held().day).toEqual(['2_1']);
    expect(held().night).toEqual(['night/2_1']);
    // The unscaled score this magnification and centrality would give.
    const full = 2 / DESKTOP.wantTexelPx;
    expect(scores['2_1']).toBeLessThan(full);
    expect(scores['night/2_1']).toBeLessThan(full);
    // The night score IS the shell's own mask, averaged over the sector's four
    // corners, its centre and the darkest point its gate is read at.
    const u0 = SEC.c / G.cols;
    const u1 = (SEC.c + 1) / G.cols;
    const v0 = SEC.r / G.rows;
    const v1 = (SEC.r + 1) / G.rows;
    const samples = [
      sphereDirection(u0, v0, new THREE.Vector3()),
      sphereDirection(u1, v0, new THREE.Vector3()),
      sphereDirection(u0, v1, new THREE.Vector3()),
      sphereDirection(u1, v1, new THREE.Vector3()),
      sectorCentreDirection(G, SEC, new THREE.Vector3()),
      sectorNearestDirection(G, SEC, sun.clone().negate(), new THREE.Vector3()),
    ];
    const mix = samples.reduce((a, d) => a + earthNightMix(d.dot(sun)), 0) / samples.length;
    expect(scores['night/2_1']).toBeCloseTo(full * mix, 9);
  });

  it('hands the terminator to whichever family lights more of it', () => {
    loader.auto = true;
    const scoresAt = (deg: number) => {
      streamer.dropAll();
      frame({ '2_1': 2 }, sunPastSector(deg), 1000 * deg + 1000);
      const s = streamer.stats().bodies.Earth.scores;
      return { day: s['2_1'] ?? 0, night: s['night/2_1'] ?? 0 };
    };
    const early = scoresAt(95); // the sector is mostly still in daylight
    const late = scoresAt(160); // …and mostly in the dark
    expect(early.day).toBeGreaterThan(early.night);
    expect(late.night).toBeGreaterThan(late.day);
  });

  it('gives up a night resident the sunrise reaches, a margin past its own edge', () => {
    loader.auto = true;
    // The mirror of the day family's release, read on the shell's own edge:
    // once the DARKEST point of a night sector has risen past the lit edge,
    // no pixel of it draws anything and its tile is the day family's to
    // spend. Held through the margin first, so a sector sitting on the
    // terminator cannot flap one.
    const inBand = sunWhereExtremeIs('dark', EARTH_NIGHT_MIX_LIT + SECTOR_KEEP_LIGHT_MARGIN / 2);
    const past = sunWhereExtremeIs('dark', EARTH_NIGHT_MIX_LIT + SECTOR_KEEP_LIGHT_MARGIN + 0.01);
    expect(sectorSunExtremes(inBand).dark).toBeCloseTo(EARTH_NIGHT_MIX_LIT + SECTOR_KEEP_LIGHT_MARGIN / 2, 6);
    expect(sectorSunExtremes(past).dark).toBeCloseTo(EARTH_NIGHT_MIX_LIT + SECTOR_KEEP_LIGHT_MARGIN + 0.01, 6);
    frame({ '2_1': 2 }, sunPastSector(180), 1000);
    expect(held().night).toEqual(['night/2_1']);
    // Past the fetch gate, inside the margin: no new tile, and it keeps the
    // one it has.
    frame({ '2_1': 2 }, inBand, 2000);
    expect(held().night).toEqual(['night/2_1']);
    expect(streamer.stats().bodies.Earth.scores['night/2_1']).toBeUndefined();
    frame({ '2_1': 2 }, past, 3000);
    expect(held().night).toEqual([]);
  });

  it('reserves a night sector\'s colour tile and nothing else', () => {
    // No crops: relief and gloss are daylight terms with no slot in the night
    // material, so a night sector is one 2048 tile where a day one is a tile
    // plus its own copies of the bump and roughness crops.
    expect(NIGHT_SET_BYTES).toBe(Math.round(2048 * 2048 * 4 * (4 / 3)));
    expect(NIGHT_SET_BYTES).toBeLessThan(EARTH_SET_BYTES);
    streamer.update(NIGHT_KEY, cameraOver(2, 1), measureNight({ '2_1': 2 }), 0);
    expect(loader.requests.map((r) => r.url).filter((u) => /earth-night/.test(u))).toHaveLength(1);
    expect(loader.requests).toHaveLength(1);
    expect(streamer.stats().reserved).toBe(NIGHT_SET_BYTES);
    loader.resolveAll();
    expect(streamer.stats().budgetedBytes).toBe(NIGHT_SET_BYTES);
    const mesh = night.mesh.children[0] as THREE.Mesh;
    expect(mesh.renderOrder).toBe(SECTOR_RENDER_ORDER);
  });

  it('evicts across families by score alone, in both directions', () => {
    loader.auto = true;
    // Room for one set of either family. The squeeze is on the CEILING, not
    // on the globe maps: a desktop's floor keeps three sets whatever those
    // maps have taken, and the budget is clamped by the ceiling either way.
    streamer = new SectorStreamer({
      limits: { ...DESKTOP, ceilingBytes: EARTH_SET_BYTES },
      load: loader.load,
      warm: warm.warm,
    });
    streamer.register(day);
    streamer.register(night);
    const strong = 2 * SECTOR_ADMIT_MARGIN + 0.5;
    const stronger = strong * SECTOR_ADMIT_MARGIN + 0.5;
    let clock = 0;
    // A resident is safe until it has been drawn for a second, so each pose
    // gets a frame to appear on and a second past the dwell.
    const hold = (sizes: Record<string, number>, nightSizes: Record<string, number>) => {
      frame(sizes, null, (clock += 16), nightSizes);
      frame(sizes, null, (clock += SECTOR_EVICT_DWELL_MS + 100), nightSizes);
    };
    // The night family takes the room first, nothing being asked of the day
    // one…
    hold({}, { '2_1': 2 });
    expect(held()).toEqual({ day: [], night: ['night/2_1'] });
    // …and a day sector that out-ranks it by more than the margin takes it.
    hold({ '3_1': strong }, { '2_1': 2 });
    expect(held()).toEqual({ day: ['3_1'], night: [] });
    // The mirror, same margin the other way: nothing here reads the side.
    hold({ '3_1': strong }, { '1_1': stronger });
    expect(held()).toEqual({ day: [], night: ['night/1_1'] });
  });

  it('drops both families on a context loss and streams both back', () => {
    loader.auto = true;
    frame({ '2_1': 2 }, null, 0);
    expect(day.mesh.children).toHaveLength(1);
    expect(night.mesh.children).toHaveLength(1);
    streamer.dropAll();
    expect(day.mesh.children).toHaveLength(0);
    expect(night.mesh.children).toHaveLength(0);
    expect(streamer.stats().resident).toBe(0);
    frame({ '2_1': 2 }, null, 32);
    expect(streamer.stats().resident).toBe(2);
  });

  it('splits the merged line by lighting side, so terminator contention is readable', () => {
    // The merged entry says the body holds two sets; only byFamily says which
    // side each went to, and that is the whole question at the terminator,
    // where both families rank on one budget.
    loader.auto = true;
    frame({ '2_1': 2 }, null, 0);
    const earth = streamer.stats().bodies.Earth;
    expect(earth.resident).toHaveLength(2);
    expect(earth.byFamily.day?.resident).toBe(1);
    expect(earth.byFamily.night?.resident).toBe(1);
    // Both views count the same slots.
    expect((earth.byFamily.day?.budgetedBytes ?? 0) + (earth.byFamily.night?.budgetedBytes ?? 0))
      .toBe(streamer.stats().budgetedBytes);
    expect((earth.byFamily.day?.measuredGpuBytes ?? 0) + (earth.byFamily.night?.measuredGpuBytes ?? 0))
      .toBe(earth.measuredGpuBytes);
  });

  it('lists only the sides a body actually has', () => {
    loader.auto = true;
    frame({ '2_1': 2 }, null, 0);
    streamer.unregister(NIGHT_KEY);
    expect(Object.keys(streamer.stats().bodies.Earth.byFamily)).toEqual(['day']);
  });

  it('keys the families apart but reports one line per body', () => {
    loader.auto = true;
    frame({ '2_1': 2 }, null, 0);
    // Registering the night family did not evict the day one, and both are
    // under the body's own name with the night slots namespaced inside it.
    expect(Object.keys(streamer.stats().bodies)).toEqual(['Earth']);
    expect(streamer.stats().bodies.Earth.resident.slice().sort()).toEqual(['2_1', 'night/2_1']);
    expect(streamer.stats().bodies.Earth.byLevel[0].resident).toBe(2);
    expect(streamer.has('Earth')).toBe(true);
    expect(streamer.has(NIGHT_KEY)).toBe(true);
    // Dropping one family leaves the other standing.
    streamer.unregister('Earth');
    expect(streamer.has('Earth')).toBe(false);
    expect(streamer.has(NIGHT_KEY)).toBe(true);
    expect(streamer.stats().bodies.Earth.resident).toEqual(['night/2_1']);
    expect(day.mesh.children).toHaveLength(0);
    expect(night.mesh.children).toHaveLength(1);
  });
});

describe('the sector floor', () => {
  let loader: FakeLoader;
  let warm: FakeWarm;

  beforeEach(() => {
    loader = new FakeLoader();
    warm = new FakeWarm();
  });

  const withFloor = (limits = DESKTOP) =>
    new SectorStreamer({ limits, load: loader.load, warm: warm.warm });
  const INSIDE = new THREE.Vector3(0, 0, 0); // every sector faces a camera at the centre

  it('is whole Earth sector sets: two on a phone, three on a desktop', () => {
    // A fraction of a set would be budget nothing can spend.
    expect(TOUCH.sectorFloorBytes).toBe(2 * sectorSetGpuBytes(SECTOR_SETS.Earth));
    expect(DESKTOP.sectorFloorBytes).toBe(3 * sectorSetGpuBytes(SECTOR_SETS.Earth));
  });

  it('keeps a budget for the tiles however much the globe maps have taken', () => {
    const s = withFloor();
    s.register(earthHandle());
    s.setGlobalMapBytes(DESKTOP.envelopeBytes);
    expect(s.stats().budget).toBe(DESKTOP.sectorFloorBytes);
    // Even asked for more than the whole envelope: the ladder cannot borrow
    // against the floor by overshooting it.
    s.setGlobalMapBytes(4 * DESKTOP.envelopeBytes);
    expect(s.stats().budget).toBe(DESKTOP.sectorFloorBytes);
    expect(s.stats().floor).toBe(DESKTOP.sectorFloorBytes);
  });

  it('holds a working set at the floor rather than going quiet', () => {
    const s = withFloor();
    s.register(earthHandle());
    loader.auto = true;
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) { sizes[`${c}_1`] = 2 + 0.01 * c; sizes[`${c}_2`] = 2.1 + 0.01 * c; }
    for (let f = 0; f < 24; f++) s.update('Earth', INSIDE, measureOf(sizes), f * 16);
    expect(s.stats().resident).toBe(EARTH_FITS_DESKTOP);
    // The globe maps take the whole envelope. Three sets are still drawn:
    // the surface at 20x magnification keeps the tiles it needs most.
    s.setGlobalMapBytes(DESKTOP.envelopeBytes);
    const held = s.stats();
    expect(held.resident).toBe(3);
    expect(held.budgetedBytes + held.reserved).toBeLessThanOrEqual(held.budget);
  });

  it('owes nothing while no body can want a tile', () => {
    // `?sectors=0` builds no streamer at all; a mode between activations has
    // one with nothing registered. Neither may make the ladder reserve
    // memory for tiles that cannot load.
    const s = withFloor();
    expect(s.floorBytes()).toBe(0);
    s.setGlobalMapBytes(DESKTOP.envelopeBytes);
    expect(s.stats().budget).toBe(0);
    s.register(earthHandle());
    expect(s.floorBytes()).toBe(DESKTOP.sectorFloorBytes);
    expect(s.stats().budget).toBe(DESKTOP.sectorFloorBytes);
  });

  it('never gives the tiles more than their ceiling to honour a floor', () => {
    const s = new SectorStreamer({
      limits: { ...TOUCH, sectorFloorBytes: 4 * TOUCH.ceilingBytes },
      load: loader.load,
      warm: warm.warm,
    });
    s.register(earthHandle());
    s.setGlobalMapBytes(TOUCH.envelopeBytes);
    expect(s.stats().budget).toBe(TOUCH.ceilingBytes);
  });

  it('leaves the budget alone while the envelope has room', () => {
    // The floor is a floor, not a reservation: it takes nothing from the
    // tiles when the globe maps are small, which is every desktop session.
    const s = withFloor();
    s.register(earthHandle());
    s.setGlobalMapBytes(0);
    expect(s.stats().budget).toBe(DESKTOP.ceilingBytes);
    s.setGlobalMapBytes(DESKTOP.envelopeBytes - DESKTOP.ceilingBytes);
    expect(s.stats().budget).toBe(DESKTOP.ceilingBytes);
    s.setGlobalMapBytes(DESKTOP.envelopeBytes - 4 * EARTH_SET_BYTES);
    expect(s.stats().budget).toBe(4 * EARTH_SET_BYTES);
  });
});

describe('the transient of a globe-map swap', () => {
  let loader: FakeLoader;
  let warm: FakeWarm;
  let restoreTierLoader: (() => void) | null = null;
  let tierFetch: Array<{ onLoad: (t: THREE.Texture) => void }> = [];
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    loader = new FakeLoader();
    warm = new FakeWarm();
    tierFetch = [];
    const previous = setUpgradeTextureLoader((_url, onLoad) => { tierFetch.push({ onLoad }); });
    restoreTierLoader = () => setUpgradeTextureLoader(previous);
  });

  afterEach(() => {
    restoreTierLoader?.();
    restoreTierLoader = null;
  });

  it('trims the tiles for both maps before the low one is assigned', async () => {
    const SET = EARTH_SET_BYTES;
    const HIGH = equirectMapGpuBytes(4096); // the rung being given back
    const LOW = equirectMapGpuBytes(2048); // the boot map replacing it
    // An envelope the globe map plus three sector sets fill exactly, with no
    // floor, so the squeeze the transient causes is visible in the tiles.
    const limits = {
      ...DESKTOP,
      sectorFloorBytes: 0,
      envelopeBytes: HIGH + 3 * SET,
      ceilingBytes: 4 * SET,
    };
    const streamer = new SectorStreamer({ limits, load: loader.load, warm: warm.warm });
    streamer.register(earthHandle());
    loader.auto = true;
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 6; c++) sizes[`${c}_1`] = 2 + 0.01 * c;
    const inside = new THREE.Vector3(0, 0, 0); // every sector faces a camera at the centre

    const material = new THREE.MeshStandardMaterial();
    const up = makeTextureUpgrade('mars', material)!;
    up.appliedTier = '4k';
    material.map = mapTexture(4096);
    material.userData.colorTierRank = TIER_RANK['4k'];
    const tellStreamer = () => streamer.setGlobalMapBytes(appliedTierHeldBytes(up));

    tellStreamer();
    for (let f = 0; f < 8; f++) streamer.update('Earth', inside, measureOf(sizes), f * 16);
    const before = streamer.stats();
    expect(before.budget).toBe(3 * SET);
    expect(before.resident).toBe(3);

    let during: ReturnType<typeof streamer.stats> | null = null;
    let drawnAtChange: number | undefined;
    startTierRelease(up, 0, {
      onLedgerChange: () => {
        tellStreamer();
        during = streamer.stats();
        drawnAtChange = (material.map!.image as { width: number }).width;
      },
    });
    tierFetch[0].onLoad(mapTexture(2048));
    await flush();

    const seen = during!;
    // The body was still drawing its 4K map when the tiles were trimmed: the
    // transient is charged and answered before it is spent, not a frame after
    // the peak has passed.
    expect(drawnAtChange).toBe(4096);
    expect(seen.globalBytes).toBe(HIGH + LOW);
    expect(seen.budget).toBe(3 * SET - LOW);
    expect(seen.resident).toBe(2);
    expect(seen.budgetedBytes + seen.reserved).toBeLessThanOrEqual(seen.budget);

    tellStreamer();
    const after = streamer.stats();
    // Back on the boot map every device carries anyway, which is not the
    // ladder's optional weight: the tiles have the whole envelope again.
    expect(after.globalBytes).toBe(0);
    expect(up.appliedTier).toBeNull();
    expect(after.budgetedBytes + after.reserved).toBeLessThanOrEqual(after.budget);
    material.dispose();
  });
});
