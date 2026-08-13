/**
 * Planet-label de-overlap: which of the planet name labels (plus the Sun's)
 * get to draw when a pulled-back view stacks them onto near-identical pixels
 * ("SMercury", "VeEarth" at whole-system zoom).
 *
 * DOM-free by design, like the moon-label contest it mirrors: the controller
 * gathers this frame's would-be-visible labels with their screen rects and
 * applies the verdicts to the elements. The contest is greedy by rank — rank
 * is apparent brightness, so Venus outshines Mercury for the slot — with the
 * moon system's two anti-flicker devices: an incumbent defends its slot
 * against a marginally brighter newcomer, and the collision rect is stricter
 * for a label trying to ENTER than for a settled pair drifting into mild
 * overlap, so the show/hide boundary has a real hysteresis band instead of a
 * knife edge.
 *
 * The Sun's label never contests — it is the view's anchor — and arrives as a
 * blocker rect every planet label must clear.
 */

/** A label box in CSS px, top-left at the label's transform anchor (the same
 *  convention as the glare-fade rectangle test in PlanetLabels). */
export interface LabelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlanetLabelContestant extends LabelRect {
  name: string;
  /** Contest rank; higher wins a contested slot. The caller feeds negated
   *  apparent magnitude, so brightness units double as evict-margin units. */
  priority: number;
  /** Held a placed label slot at the end of last frame's contest. */
  incumbent: boolean;
  /** Policy override — the revealed body's label always places (its physical
   *  gates were already applied upstream), and still blocks lower ranks. */
  exempt: boolean;
  /** Output: whether this label draws this frame. Written by the resolver. */
  place: boolean;
}

/** How much brighter (in magnitudes) a newcomer must be to take a slot off
 *  the label that held it last frame. */
export const PLANET_LABEL_EVICT_MARGIN = 1.0;
/** Extra clearance (px per side) a label needs to ENTER a slot. */
export const PLANET_LABEL_ENTER_EXPAND_PX = 3;
/** Overlap (px per side) a settled pair tolerates before one is dropped.
 *  Together with the enter expansion this is the hysteresis band: a pair
 *  drifting apart re-admits the loser only once a real gap exists. */
export const PLANET_LABEL_SETTLED_INSET_PX = 2;

function overlaps(a: LabelRect, insetA: number, b: LabelRect, insetB: number): boolean {
  return (
    a.x + insetA < b.x + b.w - insetB &&
    b.x + insetB < a.x + a.w - insetA &&
    a.y + insetA < b.y + b.h - insetB &&
    b.y + insetB < a.y + a.h - insetA
  );
}

/** Would candidate `c` collide with an already-placed rect? A non-incumbent
 *  candidate's rect GROWS by the enter expansion (it must earn clearance); a
 *  candidate and other that are BOTH settled each SHRINK by the settled inset
 *  (a drifting settled pair tolerates mild overlap before one drops).
 *  `otherSettled` is true for placed incumbents, exempts, and blockers. */
function collides(c: PlanetLabelContestant, other: LabelRect, otherSettled: boolean): boolean {
  if (!c.incumbent) return overlaps(c, -PLANET_LABEL_ENTER_EXPAND_PX, other, 0);
  const inset = otherSettled ? PLANET_LABEL_SETTLED_INSET_PX : 0;
  return overlaps(c, inset, other, inset);
}

/**
 * Resolve the contest in place: sorts `contestants` by standing and writes
 * each one's `place`. Exempt labels rank first; everyone else by priority
 * with the incumbent defence added; name breaks ties so the order — and the
 * winner of an exact tie — is deterministic frame to frame.
 */
export function resolvePlanetLabelContest(
  contestants: PlanetLabelContestant[],
  blockers: readonly LabelRect[] = [],
): void {
  contestants.sort((a, b) => {
    if (a.exempt !== b.exempt) return a.exempt ? -1 : 1;
    const pa = a.priority + (a.incumbent ? PLANET_LABEL_EVICT_MARGIN : 0);
    const pb = b.priority + (b.incumbent ? PLANET_LABEL_EVICT_MARGIN : 0);
    if (pa !== pb) return pb - pa;
    return a.name < b.name ? -1 : 1;
  });

  for (let i = 0; i < contestants.length; i++) {
    const c = contestants[i];
    c.place = true;
    if (c.exempt) continue;
    for (const blocker of blockers) {
      if (collides(c, blocker, true)) {
        c.place = false;
        break;
      }
    }
    if (!c.place) continue;
    for (let j = 0; j < i; j++) {
      const placed = contestants[j];
      if (!placed.place) continue;
      if (collides(c, placed, placed.incumbent || placed.exempt)) {
        c.place = false;
        break;
      }
    }
  }
}
