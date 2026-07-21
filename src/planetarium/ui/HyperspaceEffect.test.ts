import { afterEach, describe, expect, it } from 'vitest';
import {
  HYPERSPACE_ACCEL_MS,
  HYPERSPACE_EXIT_MS,
  HyperspaceEffect,
  advanceHyperspaceDepth,
  hyperspaceMotion,
  projectedHyperspaceRadius,
} from './HyperspaceEffect';

/** Minimal canvas-2D + rAF harness so the class lifecycle can be exercised in
 *  the node test env. Every 2D call is a no-op; rAF frames run on demand. */
function installCanvasHarness() {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = {
    raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, win: g.window,
  };
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

describe('hyperspace motion', () => {
  it('accelerates stars into longer perspective streaks', () => {
    const start = hyperspaceMotion(0, null);
    const cruise = hyperspaceMotion(HYPERSPACE_ACCEL_MS, null);
    expect(cruise.speed).toBeGreaterThan(start.speed * 10);
    expect(cruise.trail).toBeGreaterThan(start.trail * 20);
    expect(cruise.tunnel).toBeGreaterThan(start.tunnel);
  });

  it('moves every star outward from the vanishing point as it approaches the viewer', () => {
    const beforeDepth = 1.1;
    const afterDepth = advanceHyperspaceDepth(beforeDepth, 1.4, 1 / 60);
    expect(afterDepth).toBeLessThan(beforeDepth);
    expect(projectedHyperspaceRadius(0.5, afterDepth)).toBeGreaterThan(
      projectedHyperspaceRadius(0.5, beforeDepth),
    );
  });

  it('decelerates and flashes around the exit midpoint', () => {
    const midpoint = hyperspaceMotion(0, HYPERSPACE_EXIT_MS / 2);
    const end = hyperspaceMotion(0, HYPERSPACE_EXIT_MS);
    expect(midpoint.flash).toBeCloseTo(1, 10);
    expect(end.speed).toBeLessThan(midpoint.speed);
    expect(end.trail).toBeLessThan(midpoint.trail);
    expect(end.flash).toBeCloseTo(0, 10);
  });
});

describe('hyperspace effect lifecycle', () => {
  let harness: ReturnType<typeof installCanvasHarness> | null = null;
  afterEach(() => harness?.restore());

  it('starts, drives, exits, and stops without leaking the frame loop', () => {
    const h = installCanvasHarness();
    harness = h;
    const effect = new HyperspaceEffect(h.canvas);

    // Not started: exit is a no-op.
    expect(effect.beginExit()).toBe(0);

    effect.start({ x: 0.5, y: 0.5 });
    expect(h.scheduled.size).toBe(1); // one frame pending
    expect(() => h.runFrame(16)).not.toThrow();
    expect(h.scheduled.size).toBe(1); // frame re-scheduled

    // Running: exit reports its configured duration and the loop keeps going.
    expect(effect.beginExit()).toBe(HYPERSPACE_EXIT_MS);
    expect(() => h.runFrame(500)).not.toThrow();

    effect.stop();
    expect(h.scheduled.size).toBe(0); // frame cancelled — no orphan loop

    // Idempotent once stopped.
    expect(() => effect.stop()).not.toThrow();
    expect(effect.beginExit()).toBe(0);
  });
});
