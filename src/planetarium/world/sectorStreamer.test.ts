import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  SECTOR_ADMIT_MARGIN,
  SECTOR_INFLIGHT_CAP_DESKTOP,
  SECTOR_RELEASE_DEVICE_PX,
  SECTOR_RESIDENT_CAP_DESKTOP,
  SECTOR_RESIDENT_CAP_TOUCH,
  SECTOR_RETRY_MS,
  SECTOR_SETS,
  SECTOR_WANT_DEVICE_PX,
  SectorStreamer,
  type SectorBodyHandle,
  type SectorMeasure,
} from './sectorStreamer';
import { SECTOR_RENDER_ORDER } from './sectorMaterial';
import { SECTOR_GRID_16K, sectorCentreDirection, sectorTileTransform, dataCropLayout, SECTOR_TILE } from './sectorGrid';
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

function earthHandle(): SectorBodyHandle & { fineCalls: number } {
  const material = new THREE.MeshStandardMaterial({
    map: new THREE.Texture(),
    bumpMap: new THREE.Texture(),
    roughnessMap: new THREE.Texture(),
  });
  augmentSurfaceMaterial(material, 'earth');
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

/** A measure that sizes a listed set of sectors (by "c_r") and hides the rest. */
function measureOf(sizes: Record<string, number>, centrality = 1) {
  return (centre: THREE.Vector3, _radius: number): SectorMeasure | null => {
    for (let r = 0; r < G.rows; r++) {
      for (let c = 0; c < G.cols; c++) {
        const d = sectorCentreDirection(G, { c, r }, new THREE.Vector3()).multiplyScalar(R);
        if (d.distanceTo(centre) < 1e-9) {
          const px = sizes[`${c}_${r}`];
          return px === undefined ? null : { devicePx: px, centrality };
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
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': SECTOR_WANT_DEVICE_PX - 1 }), 0);
    expect(loader.requests).toEqual([]);
    expect(streamer.stats().resident).toBe(0);
  });

  it('loads the colour tile plus the crops the base material carries, with sector-exact URLs', () => {
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), 0);
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
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), 0);
    expect(loader.resolveAll()).toBe(3);
    expect(earth.mesh.children.length).toBe(0); // decoded, not yet uploaded
    warm.settle('warmed');
    expect(earth.mesh.children.length).toBe(1);
    const sectorMesh = earth.mesh.children[0] as THREE.Mesh;
    expect(sectorMesh.renderOrder).toBe(SECTOR_RENDER_ORDER);
    expect(earth.fineCalls).toBe(1); // the globe was put on its fine grid first
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
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), 0);
    expect(streamer.stats().resident).toBe(1);
    const sectorMesh = earth.mesh.children[0] as THREE.Mesh;
    let disposed = 0;
    for (const t of [sectorMesh.material as THREE.MeshStandardMaterial].flatMap((m) => [m.map!, m.bumpMap!, m.roughnessMap!])) {
      t.addEventListener('dispose', () => disposed++);
    }
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': (SECTOR_WANT_DEVICE_PX + SECTOR_RELEASE_DEVICE_PX) / 2 }), 16);
    expect(streamer.stats().resident).toBe(1); // hysteresis band: stays
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': SECTOR_RELEASE_DEVICE_PX - 1 }), 32);
    expect(streamer.stats().resident).toBe(0);
    expect(earth.mesh.children.length).toBe(0);
    expect(disposed).toBe(3); // every owned texture freed
  });

  it('releases a sector that no longer faces the camera', () => {
    loader.auto = true;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), 0);
    expect(streamer.stats().resident).toBe(1);
    streamer.update('Earth', cameraOver(6, 2), measureOf({ '2_1': 900 }), 16); // antipode
    expect(streamer.stats().resident).toBe(0);
  });

  it('bounds fetches in flight', () => {
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 4; c++) sizes[`${c}_1`] = 900 + c;
    streamer.update('Earth', new THREE.Vector3(0, 0, 0), measureOf(sizes), 0); // inside: every sector faces
    expect(streamer.stats().loading).toBe(SECTOR_INFLIGHT_CAP_DESKTOP);
    // Largest first (stats list in grid order).
    expect(streamer.stats().bodies.Earth.loading.slice().sort()).toEqual(['2_1', '3_1']);
  });

  it('caps residents and only evicts the weakest for a candidate that out-ranks it by the margin', () => {
    loader.auto = true;
    const sizes: Record<string, number> = {};
    for (let c = 0; c < 8; c++) { sizes[`${c}_1`] = 1000 + c; sizes[`${c}_2`] = 1000 + 8 + c; }
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
    for (let c = 0; c < 8; c++) sizes[`${c}_1`] = 1000 + c;
    for (let f = 0; f < 12; f++) s.update('Earth', new THREE.Vector3(0, 0, 0), measureOf(sizes), f * 16);
    expect(s.stats().resident).toBe(SECTOR_RESIDENT_CAP_TOUCH);
  });

  it('a load superseded by release never materializes and drops its bytes', () => {
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), 0);
    const pending = loader.requests.splice(0);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 100 }), 16); // released while in flight
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
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), 0);
    loader.failAll();
    expect(streamer.stats().loading).toBe(0);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), SECTOR_RETRY_MS - 1);
    expect(loader.requests.length).toBe(0); // still cooling
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), SECTOR_RETRY_MS + 1);
    expect(loader.requests.length).toBe(3); // retried
    loader.failAll();
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), SECTOR_RETRY_MS + 1 + SECTOR_RETRY_MS * 1.5);
    expect(loader.requests.length).toBe(0); // second cooldown is twice as long
  });

  it('a failed upload counts as a failure (the texture is never drawn cold)', () => {
    warm.auto = 'failed';
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), 0);
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
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 900 }), 0);
    expect(streamer.stats().bodies.Mars.resident).toEqual(['2_1']);
    expect(loader.requests.map((r) => r.url)).toEqual([expect.stringMatching(/tiles\/mars\/16k\/2_1\.webp$/)]);
    loader.requests.length = 0;
    mars.material.normalMap = new THREE.Texture(); // MOLA relief lands
    streamer.update('Mars', cameraOver(2, 1), measureOf({ '2_1': 900 }), 16);
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
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), 0);
    earth.material.color.setRGB(0.5, 0.1, 0.1);
    earth.material.emissiveIntensity = 0.7;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), 16);
    const mat = (earth.mesh.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(mat.color.getHex()).toBe(earth.material.color.getHex());
    expect(mat.emissiveIntensity).toBe(0.7);
  });

  it('suspend: admissions holds residents but admits nothing; all drops everything', () => {
    loader.auto = true;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), 0);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900, '3_1': 950 }), 16, 'admissions');
    expect(streamer.stats().bodies.Earth.resident).toEqual(['2_1']);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900, '3_1': 950 }), 32, 'all');
    expect(streamer.stats().resident).toBe(0);
  });

  it('releaseAllExcept keeps the destination body; dropAll and dispose clear everything', () => {
    loader.auto = true;
    const moon = earthHandle();
    moon.name = 'Moon';
    moon.spec = SECTOR_SETS.Moon;
    moon.material.bumpMap = null;
    moon.material.roughnessMap = null;
    moon.material.normalMap = new THREE.Texture();
    streamer.register(moon);
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), 0);
    streamer.update('Moon', cameraOver(2, 1), measureOf({ '2_1': 900 }), 0);
    expect(streamer.stats().resident).toBe(2);
    streamer.releaseAllExcept(new Set(['Moon']));
    expect(streamer.stats().bodies.Earth.resident).toEqual([]);
    expect(streamer.stats().bodies.Moon.resident).toEqual(['2_1']);
    streamer.dropAll();
    expect(streamer.stats().resident).toBe(0);
    expect(streamer.has('Moon')).toBe(true);
    streamer.dispose();
    expect(streamer.has('Moon')).toBe(false);
    expect(moon.mesh.children.length).toBe(0);
  });

  it('closes the decoded bitmap once a tile is resident', () => {
    warm.auto = null;
    streamer.update('Earth', cameraOver(2, 1), measureOf({ '2_1': 900 }), 0);
    let closed = 0;
    for (const r of loader.requests.splice(0)) {
      const tex = new THREE.Texture({ close: () => { closed++; }, width: 2048, height: 2048 } as unknown as ImageBitmap);
      r.onLoad(tex);
    }
    warm.settle('warmed');
    expect(closed).toBe(3);
    expect(streamer.stats().resident).toBe(1);
  });
});
