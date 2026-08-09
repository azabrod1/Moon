/**
 * Moon-label placement rules: which moons earn a label, and how the ones that
 * earn one share the screen.
 *
 * DOM-free by design — the controller gathers the candidates and applies the
 * decision to the elements. Everything here is screen-space arithmetic over
 * pooled candidate objects, so a steady-state frame allocates nothing.
 *
 * A label is earned by what the moon WOULD show fully lit, not by what it shows
 * this instant: a moon in eclipse or at new phase is still there and still
 * aimable, so its name holds through the darkness in a dimmer style rather than
 * strobing off with its dot. Every non-photometric fade — the parent-dominance
 * gate, the system edge, the disc handoff — still reaches the label, so a name
 * dies where the moon itself stops being shown.
 *
 * The contest is a greedy one: on approach a system's labels pile onto
 * near-identical pixels ("PhoDeimos") and someone must yield. Rank decides who,
 * and rank is mostly apparent footprint — but a label already on screen defends
 * its slot against a marginally larger newcomer, because two moons trading a
 * slot every few frames is worse to look at than the wrong one of them winning.
 *
 * Tuning constants live in MOON_LABEL_PLACEMENT_PARAMS; the controller keeps a
 * live copy the dev bridge merges into (`__moon.setMoonLabelPlacementParams`)
 * for tuning by eye.
 */

/** A moon's padded disc reads as more than a point at or above this radius (px):
 *  at that size the moon is its own anchor and the label needs no dot. */
export const LABEL_READABLE_RADIUS_PX = 1.0;

/** Dot alpha at or above which a sub-pixel moon is worth naming: below it there
 *  is nothing on screen for the name to point at. Read against the moon's dot
 *  alpha WITH illumination forced full, so darkness alone never strips a name. */
export const LABEL_DOT_MIN_ALPHA = 0.03;

export interface MoonLabelPlacementParams {
  /** Dark-label style band, read against the dot's ACTUAL alpha: the `.unlit`
   *  class turns on below `unlitEnterAlpha` and off above `unlitLeaveAlpha`. Two
   *  thresholds because a dot hovering near a single one flickers on its own
   *  photometry, and the style would pulse with it. */
  unlitEnterAlpha: number;
  unlitLeaveAlpha: number;
  /** How much bigger a challenger must be to take a slot off the label that
   *  held it last frame. 1 would mean no defence at all — the pair would trade
   *  the slot on every pixel of relative drift. */
  incumbentEvictRatio: number;
  /** Collision-rect inset (px per side) applied only when BOTH labels held
   *  their slots last frame: a settled pair tolerates a little more overlap
   *  before one is dropped than a newcomer needs to earn a slot in the first
   *  place. Without the two rect sizes, labels drifting across each other's
   *  boundary flicker at exactly the crossing. */
  leaveInsetPx: number;
  /** Vertical clearance between two labels (px) — the drawn line height. Rects
   *  are estimated rather than measured; reading a real one would force a
   *  layout every frame. */
  labelHeightPx: number;
}

export const MOON_LABEL_PLACEMENT_PARAMS: MoonLabelPlacementParams = {
  unlitEnterAlpha: 0.02,
  unlitLeaveAlpha: 0.05,
  incumbentEvictRatio: 1.3,
  leaveInsetPx: 4,
  labelHeightPx: 18,
};

/**
 * One moon's bid for a label slot. Pooled and reused by the controller, which
 * keeps the element and the moon record alongside; `placed` is the answer,
 * written back in place.
 */
export interface MoonLabelCandidate {
  /** Catalog name — the identity incumbency is tracked by. */
  name: string;
  sx: number;
  sy: number;
  onScreen: boolean;
  priorityPx: number;
  /** Half the estimated drawn width (px). */
  halfW: number;
  isTarget: boolean;
  isRevealed: boolean;
  isUnlit: boolean;
  placed: boolean;
}

/**
 * Rank within a tier: apparent footprint, with an incumbent's own bid inflated
 * by the eviction ratio. Expressing the defence as a scale on the incumbent's
 * priority keeps the whole contest a single total order — a challenger sorts
 * above an incumbent exactly when it beats `incumbentEvictRatio ×` its
 * priority, which is the rule itself.
 */
function rankPriority(
  c: MoonLabelCandidate,
  prevPlaced: ReadonlySet<string>,
  params: MoonLabelPlacementParams,
): number {
  return prevPlaced.has(c.name) ? c.priorityPx * params.incumbentEvictRatio : c.priorityPx;
}

/** Whether two candidate rects overlap. `settled` picks the smaller leave rect,
 *  used only when both labels were already placed last frame. */
function rectsCollide(
  a: MoonLabelCandidate,
  b: MoonLabelCandidate,
  settled: boolean,
  params: MoonLabelPlacementParams,
): boolean {
  const inset = settled ? params.leaveInsetPx : 0;
  const spanX = Math.max(0, a.halfW + b.halfW - 2 * inset);
  const spanY = Math.max(0, params.labelHeightPx - 2 * inset);
  return Math.abs(a.sx - b.sx) < spanX && Math.abs(a.sy - b.sy) < spanY;
}

/**
 * Run the de-overlap contest over `candidates`, marking `placed` on each. Sorts
 * the array in place (stable, so equal bids keep catalog order).
 *
 * The revealed moon sorts first so it always wins its contest, then the nav
 * target (a sibling's label can never suppress the moon you are flying at),
 * then visible labels outrank edge-clamped ones (an off-screen moon pinned to
 * the margin must not suppress a genuinely visible neighbour), then rank by
 * apparent footprint with the incumbent's defence folded in. Incumbency lives
 * strictly inside the last term: a moon that gains a tier this frame takes the
 * slot outright, since a tier means the player asked for that label.
 *
 * `prevPlaced` is the previous frame's placed set; pass an empty set to run the
 * contest cold (after a teleport, or the first frame of a scene).
 */
export function placeMoonLabels(
  candidates: MoonLabelCandidate[],
  prevPlaced: ReadonlySet<string>,
  params: MoonLabelPlacementParams = MOON_LABEL_PLACEMENT_PARAMS,
): void {
  candidates.sort(
    (a, b) =>
      Number(b.isRevealed) - Number(a.isRevealed) ||
      Number(b.isTarget) - Number(a.isTarget) ||
      Number(b.onScreen) - Number(a.onScreen) ||
      rankPriority(b, prevPlaced, params) - rankPriority(a, prevPlaced, params),
  );
  // In-place partition: indices [0, placedCount) hold the placed labels, so the
  // collision scan only ever walks the winners.
  let placedCount = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const cSettled = prevPlaced.has(c.name);
    let collides = false;
    for (let j = 0; j < placedCount; j++) {
      const p = candidates[j];
      if (rectsCollide(c, p, cSettled && prevPlaced.has(p.name), params)) {
        collides = true;
        break;
      }
    }
    if (collides) {
      c.placed = false;
      continue;
    }
    const swap = candidates[placedCount];
    candidates[placedCount] = c;
    candidates[i] = swap;
    placedCount++;
    c.placed = true;
  }
}
