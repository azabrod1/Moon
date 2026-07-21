import { afterEach, describe, expect, it } from 'vitest';
import {
  STAR_TREK_WARP_ACCEL_MS,
  STAR_TREK_WARP_EXIT_MS,
  StarTrekWarpEffect,
  advanceStarTrekWarpPoint,
  screenSpaceWarpDirection,
  starTrekWarpMotion,
  upstreamWarpSpawn,
} from './StarTrekWarpEffect';

/** Minimal canvas-2D + rAF harness so the class lifecycle runs in node. */
function installCanvasHarness() {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, win: g.window };
  const scheduled = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  g.requestAnimationFrame = (cb: FrameRequestCallback) => { const id = nextId++; scheduled.set(id, cb); return id; };
  g.cancelAnimationFrame = (id: number) => { scheduled.delete(id); };
  g.window = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1 };
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get: (_t, prop) => (prop === 'createRadialGradient' ? () => gradient : () => {}),
    set: () => true,
  });
  const canvas = {
    width: 0, height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 1280, height: 720 }),
  } as unknown as HTMLCanvasElement;
  const runFrame = (nowMs: number) => {
    const entries = [...scheduled]; scheduled.clear();
    for (const [, cb] of entries) cb(nowMs);
  };
  const restore = () => {
    g.requestAnimationFrame = saved.raf; g.cancelAnimationFrame = saved.caf; g.window = saved.win;
  };
  return { canvas, scheduled, runFrame, restore };
}

describe('Star Trek warp motion', () => {
  it('accelerates points into clean slit-scan streaks', () => {
    const start = starTrekWarpMotion(0, null);
    const cruise = starTrekWarpMotion(STAR_TREK_WARP_ACCEL_MS, null);
    expect(cruise.speed).toBeGreaterThan(start.speed * 20);
    expect(cruise.trail).toBeGreaterThan(start.trail * 40);
    expect(cruise.chroma).toBeGreaterThan(start.chroma);
  });

  it('moves stars opposite an arbitrary projected ship heading', () => {
    const direction = screenSpaceWarpDirection({ x: 10, y: 10 }, { x: 13, y: 14 });
    const next = advanceStarTrekWarpPoint(80, 60, direction, 120, 1, 1 / 60);
    expect(direction.x).toBeCloseTo(0.6);
    expect(direction.y).toBeCloseTo(0.8);
    expect(next.x).toBeLessThan(80);
    expect(next.y).toBeLessThan(60);
  });

  it('keeps depth parallax along the projected heading', () => {
    const direction = { x: 0, y: -1 };
    const near = advanceStarTrekWarpPoint(80, 60, direction, 120, 1, 1 / 60);
    const far = advanceStarTrekWarpPoint(80, 60, direction, 120, 0.1, 1 / 60);
    expect(near.x).toBe(80);
    expect(far.x).toBe(80);
    expect(near.y).toBeGreaterThan(far.y);
    expect(far.y).toBeGreaterThan(60);
  });

  it('uses screen-up when the ship points directly through the camera axis', () => {
    expect(screenSpaceWarpDirection({ x: 20, y: 30 }, { x: 20, y: 30 })).toEqual({ x: 0, y: -1 });
  });

  it('respawns vertical and horizontal fields on a visible upstream edge', () => {
    expect(upstreamWarpSpawn({ x: 0, y: -1 }, 0.5, 0.35, 0.1)).toEqual({ x: 0.35, y: -0.1 });
    expect(upstreamWarpSpawn({ x: 1, y: 0 }, 0.5, 0.65, 0.1)).toEqual({ x: 1.1, y: 0.65 });
  });

  it('distributes diagonal respawns according to the heading components', () => {
    expect(upstreamWarpSpawn({ x: 0.75, y: -0.25 }, 0.2, 0.4, 0.08)).toEqual({ x: 1.08, y: 0.4 });
    expect(upstreamWarpSpawn({ x: 0.75, y: -0.25 }, 0.95, 0.4, 0.08)).toEqual({ x: 0.4, y: -0.08 });
  });

  it('returns streaks to point stars during exit', () => {
    const midpoint = starTrekWarpMotion(0, STAR_TREK_WARP_EXIT_MS / 2);
    const end = starTrekWarpMotion(0, STAR_TREK_WARP_EXIT_MS);
    expect(midpoint.flare).toBeGreaterThan(0);
    expect(end.speed).toBeLessThan(midpoint.speed);
    expect(end.trail).toBeLessThan(midpoint.trail);
    expect(end.flare).toBeCloseTo(0, 10);
  });
});

describe('Star Trek warp effect lifecycle', () => {
  let harness: ReturnType<typeof installCanvasHarness> | null = null;
  afterEach(() => harness?.restore());

  it('starts, drives, exits, and stops without leaking the frame loop', () => {
    const h = installCanvasHarness();
    harness = h;
    const effect = new StarTrekWarpEffect(h.canvas);

    expect(effect.beginExit()).toBe(0); // not started

    effect.start({ x: 0.5, y: 0.5 }, { x: 0.42, y: -0.9 });
    expect(h.scheduled.size).toBe(1);
    expect(() => h.runFrame(16)).not.toThrow();
    expect(h.scheduled.size).toBe(1); // re-scheduled

    expect(effect.beginExit()).toBe(STAR_TREK_WARP_EXIT_MS);
    expect(() => h.runFrame(500)).not.toThrow();

    effect.stop();
    expect(h.scheduled.size).toBe(0); // no orphan loop

    expect(() => effect.stop()).not.toThrow();
    expect(effect.beginExit()).toBe(0);
  });
});
