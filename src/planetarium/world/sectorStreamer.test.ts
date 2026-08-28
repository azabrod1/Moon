import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  SECTOR_ADMIT_MARGIN,
  SECTOR_INFLIGHT_CAP_DESKTOP,
  SECTOR_RELEASE_TEXEL_PX,
  SECTOR_RESIDENT_CAP_DESKTOP,
  SECTOR_RESIDENT_CAP_TOUCH,
  SECTOR_RETRY_MS,
  SECTOR_SETS,
  SECTOR_WANT_TEXEL_PX,
  SectorStreamer,
  type SectorBodyHandle,
  type SectorMeasure,
} from './sectorStreamer';
import { SECTOR_RENDER_ORDER } from './sectorMaterial';
import { SECTOR_GRID_16K, sectorCentreDirection, sectorTileTransform, dataCropLayout, SECTOR_TILE, sphereDirection } from './sectorGrid';
import { augmentSurfaceMaterial } from './surfaceShading';
import type { WarmOutcome } from './textureWarmer';

/** A scripted loader: records every URL, and lets a test resolve or fail
 *  each one later (or synchronously with `auto`). */
class FakeLoader {
  requests: Array<{ url: string; onLoad: (t: THREE.Texture) => void; onError: (e: unknown) => void; stillWanted?: () => boolean }> = [];
  auto = false;
  load = (url: string, onLoad: (t: THREE.Texture) => void, onError: (e: unknown) => void, stillWanted?: () => boolean) => {
    this.requests.push({ url, onLoad, onError, stillWanted });
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
  const handle = {
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
  return (centre: THREE.Vector3, _radius: number): SectorMeasure | null => {
    for (let r = 0; r < G.rows; r++) {
      for (let c = 0; c < G.cols; c++) {
        const d = sectorCentreDirection(G, { c, r }, new THREE.Vector3()).multiplyScalar(R);
        if (d.distanceTo(centre) < 1e-9) {
          const px = sizes[`${c}_${r}`];
          return px === undefined ? null : { pxPerLocalUnit: px / TEXEL_LEN_4K, centrality };
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
      expect.stringMatching(/textures\/tiles\/earth-day\/16k\/2_1\.webp$/),
      expect.stringMatching(/textures\/tiles\/earth-roughness\/2k\/2_1\.webp$/),
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

  it('caps residents and only evicts the weakest for a candidate that out-ranks it by the margin', () => {
    loader.auto = true;
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) { sizes[`${c}_1`] = 2 + 0.01 * c; sizes[`${c}_2`] = 2.1 + 0.01 * c; }
    // Fill the cap over a few frames (in-flight limit paces admissions).
    for (let f = 0; f < 12; f++) streamer.update('Earth', new THREE.Vector3(0, 0, 0), measureOf(sizes), f * 16);
    expect(streamer.stats().resident).toBe(SECTOR_RESIDENT_CAP_DESKTOP);
    const before = streamer.stats().bodies.Earth.resident.slice().sort();
    // A new sector slightly larger than the weakest resident does not evict it…
    const weakestPx = Math.min(...before.map((id) => sizes[id]));
    sizes['0_0'] = weakestPx * SECTOR_ADMIT_MARGIN * 0.99;
    streamer.update('Earth', new THREE.Vector3(0, 0, 0), measureOf(sizes), 1000);
    expect(streamer.stats().bodies.Earth.resident.slice().sort()).toEqual(before);
    // …one that out-ranks it by the margin does, and takes its place.
    sizes['0_0'] = weakestPx * SECTOR_ADMIT_MARGIN * 1.01;
    streamer.update('Earth', new THREE.Vector3(0, 0, 0), measureOf(sizes), 1016);
    const after = streamer.stats().bodies.Earth.resident;
    expect(after.length).toBe(SECTOR_RESIDENT_CAP_DESKTOP);
    expect(after).toContain('0_0');
  });

  it('uses the touch caps on touch devices', () => {
    const s = new SectorStreamer({ touch: true, load: loader.load, warm: warm.warm });
    s.register(earth);
    loader.auto = true;
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) sizes[`${c}_1`] = 2 + 0.01 * c;
    for (let f = 0; f < 12; f++) s.update('Earth', new THREE.Vector3(0, 0, 0), measureOf(sizes), f * 16);
    expect(s.stats().resident).toBe(SECTOR_RESIDENT_CAP_TOUCH);
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

  it('reloads a resident sector when the base gains a relief map it lacks', () => {
    loader.auto = true;
    const mars = earthHandle();
    mars.name = 'Mars';
    mars.spec = SECTOR_SETS.Mars;
    mars.material.bumpMap = null;
    mars.material.roughnessMap = null;
    mars.material.normalMap = null; // relief not arrived yet
    streamer.register(mars);
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 0);
    expect(streamer.stats().bodies.Mars.resident).toEqual(['2_1']);
    expect(loader.requests.map((r) => r.url)).toEqual([expect.stringMatching(/tiles\/mars\/16k\/2_1\.webp$/)]);
    loader.requests.length = 0;
    mars.material.normalMap = new THREE.Texture(); // MOLA relief lands
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 2 }), 16);
    // Released and re-admitted in the same frame, this time with the crop.
    expect(streamer.stats().bodies.Mars.resident).toEqual(['2_1']);
    expect(loader.requests.map((r) => r.url).sort()).toEqual([
      expect.stringMatching(/tiles\/mars-normal\/2k\/2_1\.webp$/),
      expect.stringMatching(/tiles\/mars\/16k\/2_1\.webp$/),
    ]);
    const mat = (mars.mesh.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(mat.normalMap).not.toBeNull();
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
    // Twilight — the sector centre just past the terminator (dot ≈ −0.08,
    // inside SECTOR_NIGHT_DOT) — is still fetchable: its day-side half is lit.
    streamer.dropAll();
    const twilight = sunOver(2, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(105));
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 2 }), 48, 'none', twilight);
    expect(streamer.stats().resident).toBe(1);
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
