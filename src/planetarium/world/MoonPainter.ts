import type { MoonMesh } from '../PlanetFactory';
import { debugWarn } from '../../shared/debug';

/**
 * Lazy, budgeted painter for moon surface textures. Moons are created with a
 * flat placeholder material; generating the procedural canvas textures for all
 * ~65 at once is the dominant first-load cost (~1.8 s desktop, far worse on a
 * slow phone), so this spreads the work across frames after the first render.
 *
 * The renderer's hard rule — a moon is never shown before it's painted — is
 * enforced at the visibility gate (updateMoonPositions), which calls
 * paintSystemNow() the moment a system would become visible. The background
 * drain (pump) is purely an optimisation that keeps that gate from doing
 * visible work. The paint function is injected so the queue is unit-testable.
 */
export class MoonPainter {
  private pending = new Map<string, MoonMesh[]>();
  /** Consecutive paint failures per moon (keyed by moon name), so a moon whose
   *  paint throws is retried a few times before being abandoned. See pump(). */
  private failures = new Map<string, number>();

  /** A moon that has thrown this many times is dropped rather than retried
   *  forever — a permanently-failing painter must not spin the queue. */
  private static readonly MAX_ATTEMPTS = 3;

  constructor(private readonly paint: (moon: MoonMesh) => void) {}

  /** Register a freshly created system's still-unpainted moons. */
  enqueue(parentName: string, moons: MoonMesh[]): void {
    const unpainted = moons.filter((m) => !m.painted);
    if (unpainted.length > 0) this.pending.set(parentName, unpainted);
  }

  hasPending(parentName: string): boolean {
    return this.pending.has(parentName);
  }

  isEmpty(): boolean {
    return this.pending.size === 0;
  }

  /**
   * Synchronously paint every still-unpainted moon in `moons` (the caller's
   * authoritative system list, not just the queued subset) and drop the system
   * from the queue. Used by the visibility gate and the arrival veil.
   */
  paintSystemNow(parentName: string, moons: MoonMesh[]): void {
    for (const m of moons) if (!m.painted) this.paint(m);
    this.pending.delete(parentName);
  }

  /**
   * Background drain: paint up to `budgetMs` of moons this frame, `preferred`
   * system first (the one the player is in or heading toward). Finishes at
   * least one moon whenever a paint succeeds, so progress is guaranteed even
   * at a tiny budget; a paint that throws ends the call instead, with that
   * moon at the back of its queue for a later frame.
   *
   * `maxMoons` caps how many moons one call paints regardless of the time
   * budget. The GPU painter returns after submitting GL commands (sub-ms on the
   * CPU clock), so the wall-clock budget never trips and a single call would
   * otherwise drain every pending system in one frame — a render-target /
   * mipmap burst. The count cap bounds that. Defaults to unbounded (the CPU
   * path, where the time budget already limits work).
   *
   * A moon is only removed from the queue once its paint RETURNS. A thrown
   * paint (transient canvas/GPU failure, or a CPU-fallback throw) rotates the
   * moon to the back of its queue and ENDS the call, so every retry falls on
   * a later frame — a throw costs almost no wall clock, so carrying on would
   * spend all three attempts in one call and the never-show-unpainted gate
   * would then hide that moon for the whole session. After MAX_ATTEMPTS
   * failures the moon is dropped (and named) so a broken painter can't spin,
   * and its siblings are never blocked either way.
   */
  pump(budgetMs: number, preferred: string | null, maxMoons = Infinity): void {
    if (this.pending.size === 0) return;
    const start = performance.now();
    let painted = 0;
    const order = [...this.pending.keys()];
    if (preferred) {
      const i = order.indexOf(preferred);
      if (i > 0) {
        order.splice(i, 1);
        order.unshift(preferred);
      }
    }
    for (const parentName of order) {
      const moons = this.pending.get(parentName);
      if (!moons) continue;
      while (moons.length > 0) {
        const moon = moons[0];
        try {
          this.paint(moon);
        } catch (err) {
          // Keep the queue correct across the throw: remove this attempt, then
          // requeue for a retry — or drop after too many failures.
          moons.shift();
          const attempts = (this.failures.get(moon.data.name) ?? 0) + 1;
          if (attempts >= MoonPainter.MAX_ATTEMPTS) {
            this.failures.delete(moon.data.name);
            debugWarn(
              `MoonPainter: dropping ${moon.data.name} after ${attempts} failed paint attempts`,
              err,
            );
          } else {
            this.failures.set(moon.data.name, attempts);
            moons.push(moon);
          }
          if (moons.length === 0) this.pending.delete(parentName);
          // The retry belongs on a LATER frame. A throw costs almost no wall
          // clock, so carrying on here would spend all three attempts inside
          // this one call and a transient failure would never get the later
          // frame the retry exists for.
          return;
        }
        moons.shift();
        painted++;
        this.failures.delete(moon.data.name);
        if (moons.length === 0) this.pending.delete(parentName);
        if (painted >= maxMoons || performance.now() - start >= budgetMs) return;
      }
    }
  }
}
