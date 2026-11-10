import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  HAZE_EDGE,
  HAZE_MIN_REGION_PX,
  HAZE_REGION_PAD_CELLS,
  HAZE_REGION_PAD_PX,
  HazeCache,
  hazeAtlasCell,
  hazeAtlasLayout,
  hazeAtlasSample,
  hazeCacheGpuBytes,
  hazeGroundInView,
  hazeRayDirCpu,
  hazeRayTerms,
  hazeRegionPx,
  hazeRegionWorthDrawing,
  hazeSphereCells,
  sessionHazeCacheWarmup,
  setHazeCacheCompiled,
  setSessionHazeCache,
  type HazeCacheSubject,
  type HazeCellRect,
  type HazeSceneRects,
} from './hazeCache';
import { createSurfaceAirFx } from '../planetarium/world/surfaceShading';

/** The texels a bilinear read at texel coordinate `t` can take weight from on
 *  one axis, allowing the sampler to snap the coordinate by half a 256th. */
function footprint(t: number): [number, number] {
  const snap = 1 / 512;
  return [Math.floor(t - 0.5 - snap), Math.ceil(t - 0.5 + snap)];
}

describe('the haze cache atlas', () => {
  it('never reads beyond a block\'s drawn cells, from any pixel of any rectangle at any divisor', () => {
    let reads = 0;
    const bad: string[] = [];
    for (let div = 1; div <= 16; div++) {
      for (let w = 1; w <= 4000; w++) {
        // The drawn rectangle filling its allocation, and a rung's smaller
        // rectangle inside a larger one: the layout's stride is the
        // allocation's, the drawn cells are the rectangle's.
        for (const alloc of [w, Math.ceil(w * 1.5) + 3]) {
          const h = Math.max(1, Math.round(w * 0.6));
          const L = hazeAtlasLayout(w, h, alloc, Math.ceil(alloc * 0.6) + 1, div);
          if (L.atlasW !== 3 * L.cwAlloc + 2 || L.stride !== L.cwAlloc + 1) bad.push(`layout div ${div} w ${w}`);
          for (let block = 0; block < 3; block++) {
            const start = block * L.stride;
            for (const [x, y] of [[0.5, 0.5], [w - 0.5, h - 0.5], [w * 0.37 + 0.5, h * 0.71 + 0.5]]) {
              const [tx, ty] = hazeAtlasSample(x, y, w, h, L, block);
              reads++;
              if (L.cw === 1) {
                // One drawn cell: the read sits on its centre.
                if (Math.abs(tx - (start + 0.5)) >= 1e-3) bad.push(`x centre div ${div} w ${w} block ${block}`);
              } else {
                const [lo, hi] = footprint(tx);
                if (lo < start || hi > start + L.cw - 1) bad.push(`x div ${div} w ${w} alloc ${alloc} block ${block} at ${x}: texels ${lo}..${hi} of ${start}..${start + L.cw - 1}`);
              }
              if (L.ch === 1) {
                if (Math.abs(ty - 0.5) >= 1e-3) bad.push(`y centre div ${div} w ${w}`);
              } else {
                const [lo, hi] = footprint(ty);
                if (lo < 0 || hi > L.ch - 1) bad.push(`y div ${div} w ${w} at ${y}: rows ${lo}..${hi} of 0..${L.ch - 1}`);
              }
            }
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(reads).toBeGreaterThan(1e6);
  });

  it('clamps the read a 256th of a texel inside the outer cells', () => {
    const L = hazeAtlasLayout(1000, 600, 1500, 900, 4);
    const [first] = hazeAtlasSample(0.5, 300, 1000, 600, L, 1);
    expect(first - L.stride).toBeCloseTo(0.5 + HAZE_EDGE, 4);
    const [last] = hazeAtlasSample(999.5, 300, 1000, 600, L, 2);
    expect(last - 2 * L.stride).toBeCloseTo(L.cw - 0.5 - HAZE_EDGE, 4);
  });

  it('is laid out so the pass\'s block index inverts it, at the allocation\'s stride', () => {
    const bad: string[] = [];
    for (let div = 1; div <= 16; div++) {
      for (let w = 1; w <= 4000; w++) {
        for (const alloc of [w, w + 1, Math.ceil(w * 1.5)]) {
          const L = hazeAtlasLayout(w, 10, alloc, 10, div);
          // Every column for small layouts; around each block's two edges
          // (where a block number can be mistaken) for the rest.
          const columns: number[] = [];
          if (L.atlasW <= 600) for (let x = 0; x < L.atlasW; x++) columns.push(x);
          else for (let block = 0; block < 3; block++) {
            const start = block * L.stride;
            for (let k = -2; k <= 2; k++) columns.push(start + k, start + L.cw - 1 + k, start + L.cwAlloc + k);
          }
          let drawn = 0;
          for (const x of columns) {
            if (x < 0 || x >= L.atlasW) continue;
            const cell = hazeAtlasCell(x, L);
            const inBlock = x % L.stride < L.cw;
            if (!cell) { if (inBlock) bad.push(`div ${div} w ${w} x ${x}: undrawn`); continue; }
            drawn++;
            if (cell.local >= L.cw || cell.block * L.stride + cell.local !== x) bad.push(`div ${div} w ${w} x ${x}: ${JSON.stringify(cell)}`);
          }
          if (L.atlasW <= 600 && drawn !== 3 * L.cw) bad.push(`div ${div} w ${w} alloc ${alloc}: ${drawn} drawn of ${3 * L.cw}`);
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('is sized from the allocation alone, so a rung step does not resize it', () => {
    const full = hazeAtlasLayout(5184, 3351, 5184, 3351, 4);
    const rung = hazeAtlasLayout(3456, 2234, 5184, 3351, 4);
    expect([rung.atlasW, rung.atlasH]).toEqual([full.atlasW, full.atlasH]);
    expect([full.atlasW, full.atlasH]).toEqual([3890, 838]);
    expect([rung.cw, rung.ch]).toEqual([864, 559]);
    // A rectangle can never be laid out wider than the atlas holds.
    const clamped = hazeAtlasLayout(1200, 800, 1000, 700, 4);
    expect(clamped.cwAlloc).toBeGreaterThanOrEqual(clamped.cw);
    expect(clamped.chAlloc).toBeGreaterThanOrEqual(clamped.ch);
  });
});

describe('the haze cache rays', () => {
  it('derives the camera ray through a point of the viewport exactly as unproject does, off-axis too', () => {
    const cam = new THREE.PerspectiveCamera(71, 1.6, 1e-7, 10);
    cam.position.set(0.3, -0.2, 0.5);
    cam.rotation.set(0.4, -1.1, 0.25);
    cam.setViewOffset(1600, 1000, 37, -21, 1600, 1000);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    const ray = hazeRayTerms(cam.projectionMatrix.elements, new THREE.Vector4());
    const basis = new THREE.Matrix3().setFromMatrix4(cam.matrixWorld);
    const mine = new THREE.Vector3();
    for (const [x, y] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1], [0.37, -0.81]]) {
      hazeRayDirCpu(x, y, ray, basis, mine);
      const p = new THREE.Vector3(x, y, 0.5).unproject(cam);
      const theirs = p.sub(cam.position).normalize();
      expect(mine.angleTo(theirs)).toBeLessThan(1e-6);
    }
  });

  it('knows when a view cannot reach the ground: the Observatory looking up, and away from a far body', () => {
    const R = 4.26e-5;
    const centre = new THREE.Vector3(0, 0, 0);
    const cam = new THREE.PerspectiveCamera(10, 1.5, 1e-9, 1);
    // ~380 km up, as the Observatory's surface view stands.
    cam.position.set(0, R * 1.06, 0);
    const proj = (): ArrayLike<number> => { cam.updateProjectionMatrix(); return cam.projectionMatrix.elements; };
    const look = (x: number, y: number, z: number): boolean => {
      cam.lookAt(x, y, z);
      cam.updateMatrixWorld(true);
      return hazeGroundInView(cam.position, cam.matrixWorld, proj(), centre, R);
    };
    expect(look(0, R * 2, 0)).toBe(false); // straight up
    expect(look(R * 5, R * 1.3, 0)).toBe(false); // well above the horizon
    expect(look(0, 0, 0)).toBe(true); // straight down
    // At the horizon, which from 380 km lies acos(1/1.06), about 19.4 degrees,
    // below the level: the view sees the ground at its rim.
    const dip = Math.acos(1 / 1.06);
    expect(look(R * Math.cos(dip), R * 1.06 - R * Math.sin(dip), 0)).toBe(true);
    // A narrow view just over the level sees only sky.
    expect(look(R * 5, R * 1.06, 0)).toBe(false);
    // Far out: a body behind the camera is out of view, ahead of it in view.
    cam.position.set(0, 0, R * 8);
    expect(look(0, 0, R * 20)).toBe(false);
    expect(look(0, 0, 0)).toBe(true);
    // Aimed 70 degrees off the body from 8 R (its silhouette is 7.2 degrees
    // across the centre): a 120-degree view's corner reaches the ground, a
    // 10-degree view's does not.
    const off = THREE.MathUtils.degToRad(70);
    cam.fov = 120;
    expect(look(R * Math.sin(off), 0, R * 8 - R * Math.cos(off))).toBe(true);
    cam.fov = 10;
    expect(look(R * Math.sin(off), 0, R * 8 - R * Math.cos(off))).toBe(false);
  });
});

describe('the haze cache pass', () => {
  const R = 4.26e-5;
  const setup = (rects: HazeSceneRects, withDeck: boolean) => {
    const air = createSurfaceAirFx();
    air.uAirDensity.value = 1;
    air.uPlanetRadius.value = R;
    air.uBottomRadius.value = 1;
    air.uTopRadius.value = 1.0157;
    const globe = new THREE.Object3D();
    globe.position.set(0, 0, -1.05 * R);
    const deck = new THREE.Object3D();
    globe.add(deck);
    const subject: HazeCacheSubject = {
      air, sunDirWorld: { value: new THREE.Vector3(0, 0, 1) }, globe, deck: withDeck ? deck : null,
      deckRadius: 1.0016, moonDayLimitSin: 0.16,
    };
    let current: HazeCacheSubject | null = subject;
    const cache = new HazeCache(() => current, () => rects, { divisor: 4, grazing: 0.7, margin: 1, f32: false });
    const camera = new THREE.PerspectiveCamera(60, rects.draw.width / rects.draw.height, 1e-9, 1);
    let bound: THREE.WebGLRenderTarget | null = null;
    const renderer = {
      autoClear: true,
      draws: 0,
      /** Each draw's target and the viewport it was drawn through. */
      log: [] as { target: THREE.WebGLRenderTarget | null; viewport: number[]; scene: unknown; camera: unknown }[],
      getRenderTarget: () => bound,
      setRenderTarget: (t: THREE.WebGLRenderTarget | null) => { bound = t; },
      inits: [] as THREE.WebGLRenderTarget[],
      initRenderTarget: (t: THREE.WebGLRenderTarget) => { renderer.inits.push(t); },
      clear: () => {},
      render: (scene: unknown, camera: unknown) => {
        renderer.draws++;
        renderer.log.push({ target: bound, viewport: bound ? bound.viewport.toArray() : [], scene, camera });
      },
    };
    return {
      air, subject, cache, camera, renderer,
      setSubject: (s: HazeCacheSubject | null) => { current = s; },
      begin: () => cache.begin(renderer as unknown as THREE.WebGLRenderer, camera),
      bound: () => bound,
    };
  };

  it('publishes each drawn layer for one scene draw, and switches it off after', () => {
    const t = setup({ draw: { width: 1000, height: 600 }, alloc: { width: 1000, height: 600 } }, false);
    t.begin();
    expect(t.air.uHazeOn.value).toBe(1);
    expect(t.air.uHazeOnDeck.value).toBe(0); // no deck drawn: its layer stays off
    expect(t.air.uHazeSun.value).toBe(t.cache.targetOf('ground')!.texture);
    // One draw per block, the Moon's left out while no moonlight is bound.
    expect(t.renderer.draws).toBe(2);
    expect(t.bound()).toBe(null); // the renderer's target put back
    t.cache.end();
    expect(t.air.uHazeOn.value).toBe(0);
    const d = setup({ draw: { width: 1000, height: 600 }, alloc: { width: 1000, height: 600 } }, true);
    d.begin();
    expect([d.air.uHazeOn.value, d.air.uHazeOnDeck.value]).toEqual([1, 1]);
    expect(d.air.uHazeSunDeck.value).toBe(d.cache.targetOf('deck')!.texture);
    expect(d.renderer.draws).toBe(4);
    d.cache.end();
    expect([d.air.uHazeOn.value, d.air.uHazeOnDeck.value]).toEqual([0, 0]);
  });

  it('switches the last frame\'s layers off before anything else, even when that frame never ended', () => {
    const t = setup({ draw: { width: 1000, height: 600 }, alloc: { width: 1000, height: 600 } }, true);
    t.begin(); // a scene draw that threw: no end()
    expect(t.air.uHazeOn.value).toBe(1);
    t.setSubject(null);
    t.begin();
    expect([t.air.uHazeOn.value, t.air.uHazeOnDeck.value]).toEqual([0, 0]);
    expect(t.cache.readout().skipped).toBe('no body with live tables');
  });

  it('draws nothing for a view that cannot reach the ground', () => {
    const t = setup({ draw: { width: 800, height: 500 }, alloc: { width: 800, height: 500 } }, false);
    t.camera.lookAt(0, 0, 1); // away from the body
    t.camera.updateMatrixWorld(true);
    t.begin();
    expect(t.renderer.draws).toBe(0);
    expect(t.air.uHazeOn.value).toBe(0);
    expect(t.cache.readout().skipped).toMatch(/not in view/);
  });

  it('keeps its atlases through a rung step, and sizes them again only when the allocation moves', () => {
    const rects: HazeSceneRects = { draw: { width: 1200, height: 800 }, alloc: { width: 1800, height: 1200 } };
    const t = setup(rects, true);
    t.begin();
    const ground = t.cache.targetOf('ground')!;
    const size = [ground.width, ground.height];
    expect(size).toEqual([3 * 450 + 2, 300]);
    // From 1.05 R straight down the ground fills the view: every drawn cell of
    // each block, at the allocation's stride.
    const viewports = (): number[][] => t.renderer.log.filter((e) => e.target === ground).map((e) => e.viewport);
    expect(viewports()).toEqual([[0, 0, 300, 200], [451, 0, 300, 200]]);
    t.renderer.log.length = 0;
    let disposed = 0;
    ground.addEventListener('dispose', () => { disposed++; });
    rects.draw = { width: 900, height: 600 }; // a rung down inside the same allocation
    t.begin();
    expect(t.cache.targetOf('ground')).toBe(ground);
    expect([ground.width, ground.height]).toEqual(size);
    expect(disposed).toBe(0);
    expect(viewports()).toEqual([[0, 0, 225, 150], [451, 0, 225, 150]]);
    const atlas = t.air.uHazeAtlas.value as THREE.Vector4;
    expect([atlas.x, atlas.y]).toEqual([225, 150]);
    expect(atlas.z).toBeCloseTo(1 / (3 * 450 + 2), 12);
    expect(t.air.uHazeStride.value).toBeCloseTo(451 / (3 * 450 + 2), 12);
    rects.alloc = { width: 2400, height: 1600 }; // a resize: the allocation itself moved
    rects.draw = { width: 2400, height: 1600 };
    t.begin();
    expect([ground.width, ground.height]).toEqual([3 * 600 + 2, 400]);
  });

  it('counts its atlases in the memory envelope: width x height x 8 bytes each, from the targets that exist', () => {
    const rects: HazeSceneRects = { draw: { width: 1200, height: 800 }, alloc: { width: 1800, height: 1200 } };
    const t = setup(rects, true);
    setSessionHazeCache(t.cache);
    expect(hazeCacheGpuBytes()).toBe(0); // nothing made before the first frame that draws it
    t.begin();
    const each = (3 * 450 + 2) * 300 * 8;
    expect(t.cache.gpuBytes()).toBe(2 * each);
    expect(hazeCacheGpuBytes()).toBe(2 * each);
    rects.draw = { width: 900, height: 600 }; // a rung step: the same memory
    t.begin();
    expect(hazeCacheGpuBytes()).toBe(2 * each);
    rects.alloc = { width: 2400, height: 1600 };
    rects.draw = { width: 2400, height: 1600 };
    t.begin();
    expect(hazeCacheGpuBytes()).toBe(2 * (3 * 600 + 2) * 400 * 8);
    // About 3 bytes per allocated scene pixel.
    expect(hazeCacheGpuBytes() / (2400 * 1600)).toBeCloseTo(3, 1);
    t.cache.dispose();
    expect(hazeCacheGpuBytes()).toBe(0);
    setSessionHazeCache(null);
  });

  // Through the development knobs and readout (devSet, regions), which a production build does not have.
  it.runIf(import.meta.env.DEV)('draws each layer only over the cells its disc can reach, and nothing for a disc too small to pay', () => {
    const rects: HazeSceneRects = { draw: { width: 1600, height: 1000 }, alloc: { width: 1600, height: 1000 } };
    const t = setup(rects, true);
    // 30 R out, the body a little right of centre: a disc about 60 px across.
    t.subject.globe.position.set(0.25 * 30 * R, 0, -30 * R);
    t.cache.devSet({ minRegionPx: 0 });
    t.begin();
    const st = t.cache.readout();
    expect(st.drawn).toEqual({ ground: true, deck: true });
    const [x0, y0, x1, y1] = st.regions.ground!;
    expect(x0).toBeGreaterThan(200);
    expect(x1 - x0).toBeLessThan(30);
    expect(y1 - y0).toBeLessThan(30);
    const ground = t.cache.targetOf('ground')!;
    const stride = (ground.width - 2) / 3 + 1;
    expect(t.renderer.log.filter((e) => e.target === ground).map((e) => e.viewport))
      .toEqual([[x0, y0, x1 - x0, y1 - y0], [stride + x0, y0, x1 - x0, y1 - y0]]);
    expect(st.regionPx).toBe((x1 - x0) * (y1 - y0) * 16);
    // The same disc under a threshold above its region: nothing drawn, both
    // layers off, the surfaces exact.
    t.renderer.log.length = 0;
    t.cache.devSet({ minRegionPx: st.regionPx! + 1 });
    t.begin();
    expect(t.renderer.draws).toBe(4);
    expect([t.air.uHazeOn.value, t.air.uHazeOnDeck.value]).toEqual([0, 0]);
    expect(t.cache.readout().skipped).toBe('disc too small');
    // ...and exactly at it, drawn.
    t.cache.devSet({ minRegionPx: st.regionPx! });
    t.begin();
    expect(t.air.uHazeOn.value).toBe(1);
    t.cache.devSet({ minRegionPx: HAZE_MIN_REGION_PX });
  });

  it('draws the Moon\'s block too while moonlight is bound', () => {
    const t = setup({ draw: { width: 1000, height: 600 }, alloc: { width: 1000, height: 600 } }, false);
    (t.air.uMoonIrradiance.value as THREE.Vector3).set(0, 1e-6, 0);
    t.begin();
    expect(t.renderer.log.map((e) => e.viewport[0])).toEqual([0, 251, 502]);
  });

  it('skips, by the shipping threshold, a disc too small to pay and draws one that fills the view', () => {
    const t = setup({ draw: { width: 2880, height: 1800 }, alloc: { width: 2880, height: 1800 } }, true);
    t.subject.globe.position.set(0, 0, -30 * R); // a disc about 100 px across
    t.begin();
    expect(t.cache.readout().skipped).toBe('disc too small');
    expect(t.cache.readout().regionPx).toBeLessThan(HAZE_MIN_REGION_PX);
    expect([t.air.uHazeOn.value, t.air.uHazeOnDeck.value, t.renderer.draws]).toEqual([0, 0, 0]);
    // The atlases exist all the same, storage asked for once each, and are
    // counted: a texture rung admitted while the disc is small is admitted
    // against the memory an approach will not then take from under it.
    expect(t.renderer.inits).toHaveLength(2);
    expect(t.cache.gpuBytes()).toBeGreaterThan(0);
    const held = t.cache.gpuBytes();
    t.subject.globe.position.set(0, 0, -1.05 * R);
    t.begin();
    expect([t.air.uHazeOn.value, t.air.uHazeOnDeck.value]).toEqual([1, 1]);
    expect(t.cache.readout().regionPx).toBe(2880 * 1800);
    expect(t.renderer.inits).toHaveLength(2);
    expect(t.cache.gpuBytes()).toBe(held);
    // Each block's draw is scissored to its own viewport.
    const last = t.cache.targetOf('deck')!;
    expect(last.scissorTest).toBe(true);
    expect(last.scissor.toArray()).toEqual(last.viewport.toArray());
  });

  it('hands the idle warm-up the mesh, camera and target format the pass draws with', () => {
    const t = setup({ draw: { width: 1000, height: 600 }, alloc: { width: 1000, height: 600 } }, false);
    setSessionHazeCache(t.cache);
    const warm = sessionHazeCacheWarmup()!;
    expect((warm.root as THREE.Mesh).material).toMatchObject({ name: 'HazeCache' });
    const target = warm.createTarget();
    expect([target.width, target.height, target.texture.type, target.texture.format])
      .toEqual([1, 1, THREE.HalfFloatType, THREE.RGBAFormat]);
    t.begin();
    expect(t.renderer.log.length).toBeGreaterThan(0);
    for (const e of t.renderer.log) {
      expect(e.scene).toBe(warm.root);
      expect(e.camera).toBe(warm.camera);
      expect(e.target!.texture.type).toBe(target.texture.type);
    }
    // A session compiled without the cache has nothing to link.
    setHazeCacheCompiled(false);
    expect(sessionHazeCacheWarmup()).toBe(null);
    setHazeCacheCompiled(true);
    setSessionHazeCache(null);
  });
});

describe('the haze cache region', () => {
  /** Whether a ray from `o` along unit `d` meets the sphere. */
  const hits = (o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number): boolean => {
    const oc = c.clone().sub(o);
    const b = oc.dot(d);
    return b > 0 && oc.lengthSq() - b * b <= r * r;
  };
  /** Every cell any pixel of a W × H draw can read while it holds a fragment
   *  of the sphere: a pixel whose centre or any corner sees the sphere (a
   *  multisampled pixel is shaded at its centre when any sample is covered),
   *  read through the surfaces' own clamped coordinate, both texels of the
   *  footprint on each axis. Null when no pixel can. */
  const readCells = (cam: THREE.PerspectiveCamera, c: THREE.Vector3, r: number, W: number, H: number, div: number): HazeCellRect | null => {
    const L = hazeAtlasLayout(W, H, W, H, div);
    const ray = hazeRayTerms(cam.projectionMatrix.elements, new THREE.Vector4());
    const basis = new THREE.Matrix3().setFromMatrix4(cam.matrixWorld);
    const d = new THREE.Vector3();
    let out: HazeCellRect | null = null;
    const corners = [[0, 0], [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]];
    for (let y = 0.5; y < H; y++) {
      for (let x = 0.5; x < W; x++) {
        if (!corners.some(([ox, oy]) => hits(cam.position, hazeRayDirCpu((2 * (x + ox)) / W - 1, (2 * (y + oy)) / H - 1, ray, basis, d), c, r))) continue;
        const [tx, ty] = hazeAtlasSample(x, y, W, H, L, 0);
        const [lx, hx] = footprint(tx);
        const [ly, hy] = footprint(ty);
        out ??= { x0: lx, y0: ly, x1: hx + 1, y1: hy + 1 };
        out.x0 = Math.min(out.x0, lx); out.x1 = Math.max(out.x1, hx + 1);
        out.y0 = Math.min(out.y0, ly); out.y1 = Math.max(out.y1, hy + 1);
      }
    }
    return out;
  };
  const pose = (fov: number, aspect: number, pos: [number, number, number], at: [number, number, number], offset?: [number, number]) => {
    const cam = new THREE.PerspectiveCamera(fov, aspect, 1e-4, 1e4);
    cam.position.set(...pos);
    cam.lookAt(...at);
    if (offset) cam.setViewOffset(1000, 1000 / aspect, offset[0], offset[1], 1000, 1000 / aspect);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    return cam;
  };
  const region = (cam: THREE.PerspectiveCamera, c: THREE.Vector3, r: number, W: number, H: number, div: number) => {
    const L = hazeAtlasLayout(W, H, W, H, div);
    return hazeSphereCells(cam.matrixWorldInverse.elements, cam.projectionMatrix.elements, c, r, L.cw, L.ch, W, H, { x0: 0, y0: 0, x1: 0, y1: 0 });
  };

  it('holds every cell a fragment of the sphere can read, and little more, from any pose', () => {
    const c = new THREE.Vector3(0.3, -0.2, 0.1);
    const W = 240;
    const H = 150;
    const bad: string[] = [];
    let checked = 0;
    let read = 0;
    let clipped = 0;
    let small = 0;
    const slack = HAZE_REGION_PAD_CELLS + 1 + Math.ceil(HAZE_REGION_PAD_PX / 4);
    // Centred, off centre, partly off each edge, nearly grazing a corner; far,
    // middling and close; two fields of view; an off-axis projection.
    const cases: { dist: number; aim: [number, number, number]; fov: number; offset?: [number, number] }[] = [];
    for (const dist of [1.6, 3, 8, 30]) {
      for (const aim of [[0, 0, 0], [0.4, 0.1, 0], [1.1, 0, 0], [0, -0.9, 0.3], [-0.8, 0.7, 0.2], [0.05, 0.02, 0.9]] as [number, number, number][]) {
        for (const fov of [60, 25]) cases.push({ dist, aim: aim.map((a) => a * dist * Math.tan((fov * Math.PI) / 360)) as [number, number, number], fov });
      }
      cases.push({ dist, aim: [0, 0, 0], fov: 50, offset: [37, -21] });
    }
    for (const { dist, aim, fov, offset } of cases) {
      for (const div of [4, 1]) {
        const cam = pose(fov, W / H, [c.x + dist * 0.6, c.y + dist * 0.48, c.z + dist * 0.64], [c.x + aim[0], c.y + aim[1], c.z + aim[2]], offset);
        const want = readCells(cam, c, 1, W, H, div);
        const got = region(cam, c, 1, W, H, div);
        checked++;
        const tag = `dist ${dist} aim ${aim.map((a) => a.toFixed(2))} fov ${fov} div ${div}`;
        if (!want) continue; // nothing can read: any answer is safe
        const Lc = hazeAtlasLayout(W, H, W, H, div);
        read++;
        const full = want.x0 === 0 && want.y0 === 0 && want.x1 === Lc.cw && want.y1 === Lc.ch;
        if (!full && (want.x0 === 0 || want.y0 === 0 || want.x1 === Lc.cw || want.y1 === Lc.ch)) clipped++;
        if ((want.x1 - want.x0) * (want.y1 - want.y0) < 0.1 * Lc.cw * Lc.ch) small++;
        if (!got) { bad.push(`${tag}: none drawn, ${JSON.stringify(want)} read`); continue; }
        if (got.x0 > want.x0 || got.y0 > want.y0 || got.x1 < want.x1 || got.y1 < want.y1) {
          bad.push(`${tag}: drew ${JSON.stringify(got)}, read ${JSON.stringify(want)}`);
        }
        const L = hazeAtlasLayout(W, H, W, H, div);
        const tight = (g: number, w: number, edge: number) => g === edge || Math.abs(g - w) <= slack * (div === 1 ? 3 : 1);
        if (!tight(got.x0, want.x0, 0) || !tight(got.y0, want.y0, 0) || !tight(got.x1, want.x1, L.cw) || !tight(got.y1, want.y1, L.ch)) {
          bad.push(`${tag}: loose, drew ${JSON.stringify(got)} for ${JSON.stringify(want)}`);
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(90);
    // The cases reach what they are for: discs read, cut by an edge, and small.
    expect([read > 60, clipped > 10, small > 10]).toEqual([true, true, true]);
  });

  it('draws every cell for a sphere the camera plane cuts, and none for one behind it or off to a side', () => {
    const c = new THREE.Vector3(0, 0, 0);
    // 1.05 R, looking along the horizon: the sphere straddles the camera's plane.
    const level = pose(60, 1.6, [0, 1.05, 0], [5, 1.05, 0]);
    expect(region(level, c, 1, 800, 500, 4)).toEqual({ x0: 0, y0: 0, x1: 200, y1: 125 });
    // Inside the sphere.
    expect(region(pose(60, 1.6, [0, 0.5, 0], [1, 0.5, 0]), c, 1, 800, 500, 4)).toEqual({ x0: 0, y0: 0, x1: 200, y1: 125 });
    // Behind the camera.
    expect(region(pose(60, 1.6, [0, 0, 5], [0, 0, 10]), c, 1, 800, 500, 4)).toBe(null);
    // In front, but well outside the view to the left.
    expect(region(pose(30, 1.6, [0, 0, 5], [4, 0, 5 - 4]), c, 1, 800, 500, 4)).toBe(null);
  });

  it('is the skip rule: a region\'s cells times the divisor squared, against the threshold', () => {
    const rect = { x0: 10, y0: 20, x1: 40, y1: 35 };
    expect(hazeRegionPx(rect, 4)).toBe(30 * 15 * 16);
    expect(hazeRegionWorthDrawing(rect, 4, 30 * 15 * 16)).toBe(true);
    expect(hazeRegionWorthDrawing(rect, 4, 30 * 15 * 16 + 1)).toBe(false);
    expect(hazeRegionWorthDrawing(null, 4, 0)).toBe(false);
  });
});
