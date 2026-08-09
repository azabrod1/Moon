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
   *  class turns on below `unlitEnterAlpha` and off above `unlitLeaveAlpha`.
   *
   *  Enter EQUALS the label-keep gate (LABEL_DOT_MIN_ALPHA), and must: the
   *  moment a label survives only because the lit twin vouched for it, it is a
   *  dark-kept label and takes the whole treatment — the quieter style, the
   *  lit-twin contest bid, and the extra proof that the moon's own centre is
   *  unoccluded. Any gap between the two would leave a label kept alive yet
   *  neither styled nor centre-proofed, naming something that may be hidden.
   *
   *  Leave sits above enter purely for hysteresis: a dot resting on a single
   *  threshold flickers on its own photometry, and the style would pulse with
   *  it. */
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
  /** Clearance (px) between a slid anchor and the limb it slid past, so the
   *  name reads beside the moon rather than touching it. */
  slidePadPx: number;
  /** How far past the disc's centre line the anchor must travel before the
   *  slide changes sides (px). A slide is a whole chord wide, so a label that
   *  chose its side on the sign of a near-zero offset would teleport across the
   *  moon on a pixel of drift. */
  slideSideDeadBandPx: number;
}

export const MOON_LABEL_PLACEMENT_PARAMS: MoonLabelPlacementParams = {
  unlitEnterAlpha: LABEL_DOT_MIN_ALPHA,
  unlitLeaveAlpha: 0.05,
  incumbentEvictRatio: 1.3,
  leaveInsetPx: 4,
  labelHeightPx: 18,
  slidePadPx: 4,
  slideSideDeadBandPx: 8,
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

/** Where an anchor ended up after clearing the disc, and which way it went:
 *  −1 or +1 along the free axis, 0 when it never had to move. */
export interface AnchorSlide {
  x: number;
  y: number;
  side: number;
}

/**
 * Slide a margin-clamped label anchor along the margin it is pinned to until it
 * clears the moon's own disc, writing the result into `out`. Returns false when
 * nothing on that edge clears — the caller then hides the label.
 *
 * A screen-filling moon has no "just above the limb" left on screen: the clamp
 * pushes the anchor back down onto the disc face, where the name reads as
 * graffiti on the moon. The anchor rides one margin line, so the fix is
 * closed-form — the perpendicular distance from the disc centre to that line
 * fixes the half-chord, and the first clear point is the chord end plus a pad.
 *
 * The side is sticky (`prevSide`), because a slide is a whole chord wide: a
 * label choosing its side on the sign of a near-zero offset would jump the width
 * of the moon whenever the anchor breathed across the centre line. The opposite
 * side is tried only when the preferred one runs off the margin box.
 *
 * Hides rather than slides when the anchor is pinned in a corner (both margins
 * spoken for, no free axis), when neither side of the chord fits inside the
 * box, or when the slide would carry the name more than a disc radius plus its
 * own half-width from where it started.
 */
export function clampAnchorClearOfDisc(
  anchorX: number,
  anchorY: number,
  clampedX: boolean,
  clampedY: boolean,
  discX: number,
  discY: number,
  discRadiusPx: number,
  halfW: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  prevSide: number,
  out: AnchorSlide,
  params: MoonLabelPlacementParams = MOON_LABEL_PLACEMENT_PARAMS,
): boolean {
  out.x = anchorX;
  out.y = anchorY;
  out.side = 0;
  const dx = anchorX - discX;
  const dy = anchorY - discY;
  const r = discRadiusPx;
  if (dx * dx + dy * dy >= r * r) return true;
  // Only a clamped anchor can be inside: unclamped it sits exactly on the limb,
  // where this distance test would be at the mercy of float rounding.
  if (!clampedX && !clampedY) return true;
  // Pinned in a corner: both margins are spoken for, so there is no free axis
  // left to slide along.
  if (clampedX && clampedY) return false;

  const alongIsX = clampedY;
  const perp = alongIsX ? dy : dx;
  const along = alongIsX ? anchorX : anchorY;
  const foot = alongIsX ? discX : discY;
  const lo = alongIsX ? minX : minY;
  const hi = alongIsX ? maxX : maxY;
  const reach = Math.sqrt(Math.max(r * r - perp * perp, 0)) + params.slidePadPx;
  const offset = along - foot;
  let side = prevSide === 0 || Math.abs(offset) > params.slideSideDeadBandPx
    ? (offset >= 0 ? 1 : -1)
    : prevSide;

  const maxSlide = r + halfW;
  let target = foot + side * reach;
  if (target < lo || target > hi || Math.abs(target - along) > maxSlide) {
    side = -side;
    target = foot + side * reach;
    if (target < lo || target > hi || Math.abs(target - along) > maxSlide) return false;
  }
  out.side = side;
  if (alongIsX) out.x = target;
  else out.y = target;
  return true;
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

/** The nav target and the hover reveal are the two labels the player asked for
 *  by hand. When they land on the same pixels both still draw: a hover that
 *  renders nothing reads as broken, and the moon you are flying at must never
 *  vanish, so the overlap is the lesser evil. */
function bothAlwaysDraw(a: MoonLabelCandidate, b: MoonLabelCandidate): boolean {
  return (a.isTarget && b.isRevealed) || (a.isRevealed && b.isTarget);
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
 * The nav target sorts first: aiming outranks pointing, because a reveal is a
 * passing hover while the target is a commitment the player made. Then the
 * revealed moon, then visible labels outrank edge-clamped ones (an off-screen
 * moon pinned to the margin must not suppress a genuinely visible neighbour),
 * then rank by apparent footprint with the incumbent's defence folded in. Those
 * top two never suppress EACH OTHER — see bothAlwaysDraw. Incumbency lives
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
      Number(b.isTarget) - Number(a.isTarget) ||
      Number(b.isRevealed) - Number(a.isRevealed) ||
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
      if (bothAlwaysDraw(c, p)) continue;
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
