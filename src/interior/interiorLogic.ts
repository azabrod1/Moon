/**
 * The Look-inside mode's pure decisions, out of the DOM and the renderer so
 * a test can pin them (InteriorMode maps them onto the scene and the panel):
 *
 *   the cut tween      where the opening angle is between a request and its
 *                      landing — an ease-in-out over CUT_ANIMATION_S, the
 *                      chosen opening remembered apart from a ceremony's close
 *   the look mapping   the one place display and physical space meet: a
 *                      region's outer boundary, the half-width of its physical
 *                      transition and the band where its boundary might be,
 *                      each through the Readable remap, so the faces, the pick
 *                      and the ruler read one set of display radii; and its
 *                      temperature as the shader's knots, through the one
 *                      sampler (temperatureProfile) every reader of it shares
 *   the region art     each region's look — the family's, with the model's own
 *                      adjustment and the family depth tint — the one place the
 *                      legend and the faces get their colours
 *   the caption        the line under the body's name: what is drawn and how
 *                      much to trust it, the legend row of an unresolved whole,
 *                      and the thickness note under the Readable | True segment
 *   the panel lines    the short lines the panel writes about the model as a
 *                      whole — the subtitle under the body's name, the status
 *                      line on the Model & sources page, the radius with the
 *                      convention it is measured by, and the note about the
 *                      layers too thin to see — each a sentence about what is
 *                      drawn, so the DOM layer only places them
 *   the emphasis       what the faces emphasise (a hovered legend row, else
 *                      the hovered region, else the pinned one) and how its
 *                      amount eases in, switches part way and fades out
 *
 * Pure: no three, no DOM.
 */
import { MAX_OPENING_ANGLE_DEG } from './cutFrame';
import { adjustArt, artParamsFor, depthTint, type ArtParams } from './data/artParams';
import type { Coverage, InteriorModel } from './data/interiorTypes';
import { outerFractionsInsideOut, type DrawnModel } from './drawnModel';
import { toDisplayFraction, type ReadableRemap } from './interiorGeometry';
import type { SectionRegionLook } from './rendering/sectionMaterial';
import { temperatureLog } from './temperatureProfile';
import { ILLUSTRATIVE_NOTE, STRUCTURE_UNCERTAIN, THIN_LAYERS_ENLARGED } from './ui/interiorCopy';
import { formatKm, NOT_KNOWN, reviewDateText } from './ui/inspectorText';

// ---- the cut tween ----------------------------------------------------------

/** The cut opens and closes over this long, on an ease-in-out — the reader's
 *  own moves (a view button, the angle slider). A ceremony's moves carry their
 *  own lengths (interiorTransition), which is why a move states its duration. */
export const CUT_ANIMATION_S = 0.9;

export interface CutTween {
  /** The opening angle as drawn this frame, degrees. */
  angleDeg: number;
  fromDeg: number;
  toDeg: number;
  /** Seconds into the current move; at `durationS` or more the tween is at rest. */
  elapsedS: number;
  /** How long the move in flight takes: the entry's opening, a swap's close and
   *  its reopen each have their own, and the reader's own moves keep theirs. */
  durationS: number;
  /** The opening the viewer chose: what a swap reopens to, whatever a close in flight targets. */
  chosenDeg: number;
}

export function createCutTween(initialDeg: number): CutTween {
  return { angleDeg: initialDeg, fromDeg: initialDeg, toDeg: initialDeg, elapsedS: CUT_ANIMATION_S, durationS: CUT_ANIMATION_S, chosenDeg: initialDeg };
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function clampDeg(deg: number): number {
  return Math.min(MAX_OPENING_ANGLE_DEG, Math.max(0, deg));
}

/** Aim the cut at an opening: animated from where it is, or set at once.
 *  `remember` is false for a ceremony's close, which is not a chosen view;
 *  `durationS` is how long this move takes, the reader's own length unless the
 *  caller has one of its own. */
export function setCutTarget(tween: CutTween, deg: number, animate: boolean, remember = true, durationS = CUT_ANIMATION_S): void {
  const target = clampDeg(deg);
  if (remember) tween.chosenDeg = target;
  tween.fromDeg = tween.angleDeg;
  tween.toDeg = target;
  tween.durationS = Math.max(0, durationS);
  tween.elapsedS = animate ? 0 : tween.durationS;
  if (!animate) tween.angleDeg = target;
}

export function cutTweenSettled(tween: CutTween): boolean {
  return tween.elapsedS >= tween.durationS;
}

/** Advance the tween by `dt` seconds: the eased progress of the current move (1 at rest). */
export function advanceCutTween(tween: CutTween, dt: number): number {
  if (cutTweenSettled(tween)) {
    tween.angleDeg = tween.toDeg;
    return 1;
  }
  tween.elapsedS = Math.min(tween.durationS, tween.elapsedS + dt);
  const progress = easeInOutCubic(tween.elapsedS / tween.durationS);
  tween.angleDeg = tween.fromDeg + (tween.toDeg - tween.fromDeg) * progress;
  return progress;
}

/** One step of a value easing toward a target at a fixed rate. */
export function stepToward(value: number, target: number, step: number): number {
  if (value === target) return value;
  return value < target ? Math.min(target, value + step) : Math.max(target, value - step);
}

// ---- the look mapping -------------------------------------------------------

/** Each region's look, inside-out like the drawn model: the family's, with the
 *  model's own adjustment (a hue turn, a saturation) and then the family depth
 *  tint — the one place the legend and the faces get their colours. */
export function regionArtInsideOut(drawn: DrawnModel): ArtParams[] {
  const reference = drawn.referenceRadiusKm;
  return drawn.regionsInsideOut.map((region) => {
    const depthMidFraction = 1 - (region.outerRadiusKm + region.innerRadiusKm) / (2 * reference);
    const art = adjustArt(artParamsFor(region.family, region.phase), region.look ?? undefined);
    return depthTint(art, region.family, depthMidFraction);
  });
}

/**
 * The region looks the faces draw, inside-out, every radius through the
 * remap: the outer boundary; the half-width of a physical transition (its
 * two edges mapped and halved, so a widened thin layer keeps a blend that
 * fits it); the band where the boundary might be (an interval or a spread
 * of models — a qualitative note has no width to draw), which straddles the
 * boundary at every blend because the remap is monotone; and the region's
 * temperature as the shader's knots through the shared sampler
 * (temperatureProfile), which the Temperature diagram and the Materials
 * glow both read, or null when nobody knows it — drawn cold, and hatched
 * where the diagram has a scale to hatch against.
 */
export function regionLooks(
  drawn: DrawnModel,
  remap: ReadableRemap,
  artInsideOut: readonly ArtParams[],
): SectionRegionLook[] {
  const fractions = outerFractionsInsideOut(drawn);
  const reference = drawn.referenceRadiusKm;
  return drawn.regionsInsideOut.map((region, index) => {
    const halfPhysical = region.transitionKm / (2 * reference);
    const blendDisplay = halfPhysical > 0
      ? (toDisplayFraction(remap, fractions[index] + halfPhysical) - toDisplayFraction(remap, fractions[index] - halfPhysical)) / 2
      : 0;
    const location = region.region?.boundary.knowledge.location ?? null;
    const band = location && (location.kind === 'interval' || location.kind === 'modelSpread')
      ? { low: toDisplayFraction(remap, Math.max(0, location.low / reference)), high: toDisplayFraction(remap, Math.min(1, location.high / reference)) }
      : null;
    const quantity = region.region?.temperatureK ?? null;
    const knotsK = region.temperatureKnotsK;
    return {
      outerDisplay: toDisplayFraction(remap, fractions[index]),
      blendDisplay,
      art: artInsideOut[index],
      temperature: quantity && knotsK ? { knotsK, log: temperatureLog(quantity) } : null,
      bandDisplay: band && band.high > band.low ? band : null,
    };
  });
}

// ---- the caption ------------------------------------------------------------

/** What is said when nothing is drawn: this app has no model for the body, or
 *  the science has none to give it. The distinction is the reader's to know —
 *  an app that has not got round to a world must not sound like a world nobody
 *  has measured. */
const NO_MODEL_IN_APP = 'No interior model available in this app';

function nothingDrawnText(coverage: Coverage): string {
  return coverage.state === 'notYetModelled' ? NO_MODEL_IN_APP : STRUCTURE_UNCERTAIN;
}

/** The legend row for the unresolved whole: the composition column has nothing
 *  to put in it, and says so in the same words every other empty field uses. */
export function unresolvedComposition(coverage: Coverage): string {
  return coverage.state === 'notYetModelled' ? NO_MODEL_IN_APP : NOT_KNOWN;
}

// ---- the panel lines --------------------------------------------------------

/** The one short line that may sit under the body's name, and '' when there is
 *  nothing to add: an ordinary drawn model needs no caveat, whether or not it
 *  has rivals — the model switch is where a reader meets those. */
export function subtitleFor(coverage: Coverage, drawn: DrawnModel): string {
  if (!drawn.model) return nothingDrawnText(coverage);
  return drawn.illustrative ? 'Illustrative scenario' : '';
}

/** The status line on the Model & sources page: which kind of model this is and
 *  when it was last looked at. A scenario says it is a scenario and gives no
 *  date — a date on an illustration would read as a measurement's currency. */
export function modelStatusText(coverage: Coverage, drawn: DrawnModel): string {
  const model = drawn.model;
  if (!model) return nothingDrawnText(coverage);
  if (drawn.illustrative) return ILLUSTRATIVE_NOTE;
  return model.review === 'reviewed'
    ? `Reviewed model, ${reviewDateText(model.reviewedOn)}`
    : `App model awaiting scientific review, last checked ${reviewDateText(model.reviewedOn)}`;
}

/** Which radius the drawn model is measured against: a flattened body's
 *  equatorial radius and its volumetric mean differ by thousands of km, so the
 *  convention is part of the number. An unresolved whole has only the radius. */
const RADIUS_CONVENTION_WORD: Readonly<Record<InteriorModel['radiusConvention'], string>> = {
  volumetricMean: 'volumetric mean',
  equatorial: 'equatorial',
};

/** The radius on its own, with the convention it is measured by: "6,371 km, volumetric mean". */
export function radiusValueText(drawn: DrawnModel): string {
  const radius = `${formatKm(drawn.referenceRadiusKm)} km`;
  return drawn.model ? `${radius}, ${RADIUS_CONVENTION_WORD[drawn.model.radiusConvention]}` : radius;
}

/** The same as a line, under its label; the model page shows the value beside the label instead. */
export function radiusLineText(drawn: DrawnModel): string {
  return `Radius ${radiusValueText(drawn)}`;
}

/** The note beside the thickness control: what the reader is looking at, and —
 *  at true thickness — which layers the disc's current size hides. One layer is
 *  named, because a reader can then look for it; several are counted, because a
 *  list of names is longer than the note it sits in. */
export function thinLayersNoteText(readable: boolean, tooThinNames: readonly string[]): string {
  if (readable) return THIN_LAYERS_ENLARGED;
  if (tooThinNames.length === 0) return '';
  if (tooThinNames.length === 1) return `${tooThinNames[0]} is too thin to see at this size`;
  return `${tooThinNames.length} layers are too thin to see at this size`;
}

// ---- the emphasis -----------------------------------------------------------

/** Emphasis eases in and out over this long. */
export const EMPHASIS_S = 0.16;

export interface EmphasisState {
  /** The emphasised region's inside-out index, −1 for none. */
  index: number;
  /** 0..1, how far in it is. */
  amount: number;
}

export function createEmphasisState(): EmphasisState {
  return { index: -1, amount: 0 };
}

/** What the faces emphasise: a hovered legend row, else the hovered region, else the pinned one (−1 for none). */
export function emphasisTarget(legendHoverIndex: number, hoverIndex: number, pinnedIndex: number): number {
  if (legendHoverIndex >= 0) return legendHoverIndex;
  if (hoverIndex >= 0) return hoverIndex;
  return pinnedIndex;
}

/** One frame of the emphasis: toward the target by `step` (1 lands at once);
 *  a switch between regions re-eases from half way; a release fades out and
 *  only then forgets the region, so the outline never snaps. */
export function advanceEmphasis(state: EmphasisState, target: number, step: number): EmphasisState {
  if (target >= 0) {
    if (target !== state.index) {
      state.index = target;
      state.amount = Math.min(state.amount, 0.5);
    }
    state.amount = Math.min(1, state.amount + step);
  } else {
    state.amount = Math.max(0, state.amount - step);
    if (state.amount === 0) state.index = -1;
  }
  return state;
}
