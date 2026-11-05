import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  HAZE_EDGE,
  HazeCache,
  hazeAtlasCell,
  hazeAtlasLayout,
  hazeAtlasSample,
  hazeGroundInView,
  hazeRayDirCpu,
  hazeRayTerms,
  type HazeCacheSubject,
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
    let bound: unknown = null;
    const renderer = {
      autoClear: true,
      draws: 0,
      getRenderTarget: () => bound,
      setRenderTarget: (t: unknown) => { bound = t; },
      clear: () => {},
      render: () => { renderer.draws++; },
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
    expect(t.renderer.draws).toBe(1);
    expect(t.bound()).toBe(null); // the renderer's target put back
    t.cache.end();
    expect(t.air.uHazeOn.value).toBe(0);
    const d = setup({ draw: { width: 1000, height: 600 }, alloc: { width: 1000, height: 600 } }, true);
    d.begin();
    expect([d.air.uHazeOn.value, d.air.uHazeOnDeck.value]).toEqual([1, 1]);
    expect(d.air.uHazeSunDeck.value).toBe(d.cache.targetOf('deck')!.texture);
    expect(d.renderer.draws).toBe(2);
    d.cache.end();
    expect([d.air.uHazeOn.value, d.air.uHazeOnDeck.value]).toEqual([0, 0]);
  });

  it('switches the last frame\'s layers off before anything else, even when that frame never ended', () => {
    const t = setup({ draw: { width: 800, height: 500 }, alloc: { width: 800, height: 500 } }, true);
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
    expect(ground.viewport.toArray()).toEqual([0, 0, 2 * 451 + 300, 200]);
    let disposed = 0;
    ground.addEventListener('dispose', () => { disposed++; });
    rects.draw = { width: 900, height: 600 }; // a rung down inside the same allocation
    t.begin();
    expect(t.cache.targetOf('ground')).toBe(ground);
    expect([ground.width, ground.height]).toEqual(size);
    expect(disposed).toBe(0);
    expect(ground.viewport.toArray()).toEqual([0, 0, 2 * 451 + 225, 150]);
    const atlas = t.air.uHazeAtlas.value as THREE.Vector4;
    expect([atlas.x, atlas.y]).toEqual([225, 150]);
    expect(atlas.z).toBeCloseTo(1 / (3 * 450 + 2), 12);
    expect(t.air.uHazeStride.value).toBeCloseTo(451 / (3 * 450 + 2), 12);
    rects.alloc = { width: 2400, height: 1600 }; // a resize: the allocation itself moved
    rects.draw = { width: 2400, height: 1600 };
    t.begin();
    expect([ground.width, ground.height]).toEqual([3 * 600 + 2, 400]);
  });
});
