import { describe, it, expect, vi } from 'vitest';
import { MoonPainter } from './MoonPainter';
import type { MoonMesh } from '../PlanetFactory';

// Minimal MoonMesh stand-ins — the painter reads/writes `painted` and reads
// `data.name` (its retry key). Names are globally unique so each moon keys its
// own failure count.
let moonSeq = 0;
function makeMoons(n: number): MoonMesh[] {
  return Array.from(
    { length: n },
    () => ({ painted: false, data: { name: `moon-${moonSeq++}` } }) as unknown as MoonMesh,
  );
}

/** A paint fn that records order and flips `painted` (as the real one does). */
function recordingPaint(log: MoonMesh[]) {
  return (m: MoonMesh) => {
    log.push(m);
    m.painted = true;
  };
}

describe('MoonPainter', () => {
  it('enqueues only unpainted moons and reports pending/empty', () => {
    const painter = new MoonPainter(() => {});
    expect(painter.isEmpty()).toBe(true);

    const moons = makeMoons(3);
    moons[0].painted = true;
    painter.enqueue('Jupiter', moons);
    expect(painter.hasPending('Jupiter')).toBe(true);
    expect(painter.isEmpty()).toBe(false);

    // A fully-painted system is not queued.
    const done = makeMoons(2).map((m) => ((m.painted = true), m));
    painter.enqueue('Saturn', done);
    expect(painter.hasPending('Saturn')).toBe(false);
  });

  it('paintSystemNow paints every unpainted moon from the authoritative list and clears the system', () => {
    const log: MoonMesh[] = [];
    const painter = new MoonPainter(recordingPaint(log));
    const moons = makeMoons(4);
    painter.enqueue('Jupiter', moons);

    painter.paintSystemNow('Jupiter', moons);
    expect(log).toHaveLength(4);
    expect(moons.every((m) => m.painted)).toBe(true);
    expect(painter.hasPending('Jupiter')).toBe(false);

    // Idempotent: a second call paints nothing (the painted guard holds).
    painter.paintSystemNow('Jupiter', moons);
    expect(log).toHaveLength(4);
  });

  it('pump always finishes at least one moon, even at budget 0', () => {
    const log: MoonMesh[] = [];
    const painter = new MoonPainter(recordingPaint(log));
    painter.enqueue('Jupiter', makeMoons(5));

    painter.pump(0, null);
    expect(log).toHaveLength(1);
    expect(painter.isEmpty()).toBe(false);
  });

  it('pump drains the preferred system first', () => {
    const painted: string[] = [];
    const a = makeMoons(2);
    const b = makeMoons(2);
    const painter = new MoonPainter((m) => {
      painted.push(a.includes(m) ? 'A' : 'B');
      m.painted = true;
    });
    painter.enqueue('A', a);
    painter.enqueue('B', b);

    // Big budget, prefer B: B's moons come out before A's.
    painter.pump(10_000, 'B');
    expect(painted.slice(0, 2)).toEqual(['B', 'B']);
    expect(painter.isEmpty()).toBe(true);
  });

  it('pump caps moons per call via maxMoons (GPU paint never trips the time budget)', () => {
    const log: MoonMesh[] = [];
    const painter = new MoonPainter(recordingPaint(log));
    painter.enqueue('Jupiter', makeMoons(10));

    // Huge time budget, but cap at 3 — only 3 paint this call.
    painter.pump(10_000, null, 3);
    expect(log).toHaveLength(3);
    expect(painter.isEmpty()).toBe(false);
  });

  it('pump eventually drains everything across calls', () => {
    const log: MoonMesh[] = [];
    const painter = new MoonPainter(recordingPaint(log));
    painter.enqueue('Jupiter', makeMoons(3));
    painter.enqueue('Saturn', makeMoons(3));

    for (let i = 0; i < 10 && !painter.isEmpty(); i++) painter.pump(0, null);
    expect(log).toHaveLength(6);
    expect(painter.isEmpty()).toBe(true);
  });

  it('a paint that throws once retries the moon; its parent stays pending until all paint', () => {
    const log: MoonMesh[] = [];
    const moons = makeMoons(3);
    const victim = moons[0];
    let thrown = false;
    const painter = new MoonPainter((m) => {
      if (m === victim && !thrown) {
        thrown = true;
        throw new Error('transient canvas failure');
      }
      log.push(m);
      m.painted = true;
    });
    painter.enqueue('Jupiter', moons);

    // First pump hits the victim and throws — the system must NOT be dropped
    // and the moon must NOT be silently unqueued.
    painter.pump(0, null);
    expect(victim.painted).toBe(false);
    expect(painter.hasPending('Jupiter')).toBe(true);

    // One moon per pump drains the rest and, eventually, the retried victim.
    for (let i = 0; i < 6 && !painter.isEmpty(); i++) painter.pump(0, null);

    expect(moons.every((m) => m.painted)).toBe(true);
    expect(log).toHaveLength(3);
    expect(painter.hasPending('Jupiter')).toBe(false);
  });

  it('a paint that always throws is dropped after the cap; its siblings still paint', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log: MoonMesh[] = [];
    const moons = makeMoons(3);
    const victim = moons[1]; // middle, to prove position independence
    const painter = new MoonPainter((m) => {
      if (m === victim) throw new Error('permanent GPU failure');
      log.push(m);
      m.painted = true;
    });
    painter.enqueue('Jupiter', moons);

    // Big budget: without the cap this would spin forever; with it, pump returns.
    for (let i = 0; i < 10 && !painter.isEmpty(); i++) painter.pump(10_000, null);

    expect(painter.isEmpty()).toBe(true); // pump completes, nothing stuck
    expect(victim.painted).toBe(false); // the broken moon is gone, still unpainted
    const siblings = moons.filter((m) => m !== victim);
    expect(siblings.every((m) => m.painted)).toBe(true); // failure never blocked siblings
    expect(log).toHaveLength(2);

    // Dropped WITH a warning that names the moon.
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes(victim.data.name))).toBe(true);
    warn.mockRestore();
  });
});
