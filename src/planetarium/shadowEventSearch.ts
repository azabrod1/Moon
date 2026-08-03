/**
 * The chunked upcoming-events sweep, shared by every instrument that shows what
 * a system's sky is about to do.
 *
 * A system's event list is one search per (moon, kind) spec, and a single spec
 * can cost a season's worth of ephemeris evaluations — far more than a frame
 * can afford. So the sweep is resumable: each slice spends a wall-clock budget,
 * pauses whatever spec it is inside, and picks that spec up from its own cursor
 * next frame.
 *
 * The invariant this exists to state once is the ANCHOR. `searchShadowEvent`
 * measures its horizon from `searchOriginUtcMs`, and a resumed slice must keep
 * passing the ORIGINAL start there — resuming with the pause cursor as the
 * origin slides the window forward with every slice, and a spec with no event
 * in range then never terminates. Two callers duplicating that is two places to
 * get it wrong.
 *
 * What stays with each caller: what a found event means to it, when the sweep
 * should be restarted, and whether its own surface is still on screen. This
 * module knows nothing about panels, cards or clocks.
 */

import {
  listShadowEventSpecs,
  searchShadowEvent,
  type ShadowEvent,
  type ShadowEventSpec,
} from '../astronomy/shadows';

/** One sweep in progress: which system, which specs, and where it paused. */
export interface ShadowEventSearch {
  parentPlanet: string;
  specs: ShadowEventSpec[];
  /** The spec being searched; the sweep is done when this reaches the end. */
  index: number;
  /** Where the current spec paused, or null to start it from `fromUtcMs`. */
  resumeCursorUtcMs: number | null;
  /** The instant the whole sweep searches from — and the fixed horizon anchor. */
  fromUtcMs: number;
}

/** Stable identity for a spec, so results keep one row per (moon, kind). */
export function shadowEventSpecKey(spec: ShadowEventSpec): string {
  return `${spec.kind}|${spec.moonName}`;
}

/**
 * A fresh sweep of a system's whole event set from `fromUtcMs`, or null for a
 * system with nothing to search — a moonless planet has no specs, and ticking a
 * zero-spec sweep every frame is work that can never finish anything.
 */
export function startShadowEventSearch(
  parentPlanet: string,
  fromUtcMs: number,
): ShadowEventSearch | null {
  const specs = listShadowEventSpecs(parentPlanet);
  if (specs.length === 0) return null;
  return { parentPlanet, specs, index: 0, resumeCursorUtcMs: null, fromUtcMs };
}

/**
 * Spend one frame's budget on the sweep. Events found in this slice are
 * appended to `out` (cleared first — the caller keeps one array and reads it
 * after the call); the return value says whether the sweep has finished, which
 * is when the caller drops it.
 *
 * `budgetMs` is wall clock: the slice stops at the deadline whether it is
 * between specs or inside one.
 */
export function stepShadowEventSearch(
  search: ShadowEventSearch,
  budgetMs: number,
  out: ShadowEvent[],
): boolean {
  out.length = 0;
  const deadlineMs = performance.now() + budgetMs;
  while (search.index < search.specs.length) {
    const remainingMs = deadlineMs - performance.now();
    if (remainingMs <= 0) break;
    const spec = search.specs[search.index];
    const result = searchShadowEvent(spec, search.resumeCursorUtcMs ?? search.fromUtcMs, 1, {
      timeBudgetMs: remainingMs,
      // Anchor the horizon at the original start so resumed slices can't
      // slide the search window forward forever.
      searchOriginUtcMs: search.fromUtcMs,
    });
    if (result.status === 'paused') {
      search.resumeCursorUtcMs = result.cursorUtcMs;
      break;
    }
    if (result.status === 'found') out.push(result.event);
    search.index++;
    search.resumeCursorUtcMs = null;
  }
  return search.index >= search.specs.length;
}
