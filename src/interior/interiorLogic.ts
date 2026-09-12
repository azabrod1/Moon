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
 *                      and the ruler read one set of display radii
 *   the region art     each region's look with the family depth tint, the one
 *                      place the legend and the faces get their colours
 *   the caption        the line under the body's name: what is drawn and how
 *                      much to trust it, the legend row of an unresolved whole,
 *                      and the thickness note under the Readable | True segment
 *   the emphasis       what the faces emphasise (a hovered legend row, else
 *                      the hovered region, else the pinned one) and how its
 *                      amount eases in, switches part way and fades out
 *
 * Pure: no three, no DOM.
 */
import { MAX_OPENING_ANGLE_DEG } from './cutFrame';
import { artParamsFor, depthTint, incandescence, type ArtParams } from './data/artParams';
import { coverageBulk, type Coverage } from './data/interiorTypes';
import { outerFractionsInsideOut, type DrawnModel } from './drawnModel';
import { toDisplayFraction, type ReadableRemap } from './interiorGeometry';
import type { SectionRegionLook } from './rendering/sectionMaterial';
import { temperatureEndpoints, type TemperatureRange } from './temperatureScale';
import { formatKm } from './ui/inspectorText';

// ---- the cut tween ----------------------------------------------------------

/** The cut opens and closes over this long, on an ease-in-out. */
export const CUT_ANIMATION_S = 0.9;

export interface CutTween {
  /** The opening angle as drawn this frame, degrees. */
  angleDeg: number;
  fromDeg: number;
  toDeg: number;
  /** Seconds into the current move; at CUT_ANIMATION_S or more the tween is at rest. */
  elapsedS: number;
  /** The opening the viewer chose: what a swap reopens to, whatever a close in flight targets. */
  chosenDeg: number;
}

export function createCutTween(initialDeg: number): CutTween {
  return { angleDeg: initialDeg, fromDeg: initialDeg, toDeg: initialDeg, elapsedS: CUT_ANIMATION_S, chosenDeg: initialDeg };
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function clampDeg(deg: number): number {
  return Math.min(MAX_OPENING_ANGLE_DEG, Math.max(0, deg));
}

/** Aim the cut at an opening: animated from where it is, or set at once.
 *  `remember` is false for a ceremony's close, which is not a chosen view. */
export function setCutTarget(tween: CutTween, deg: number, animate: boolean, remember = true): void {
  const target = clampDeg(deg);
  if (remember) tween.chosenDeg = target;
  tween.fromDeg = tween.angleDeg;
  tween.toDeg = target;
  tween.elapsedS = animate ? 0 : CUT_ANIMATION_S;
  if (!animate) tween.angleDeg = target;
}

export function cutTweenSettled(tween: CutTween): boolean {
  return tween.elapsedS >= CUT_ANIMATION_S;
}

/** Advance the tween by `dt` seconds: the eased progress of the current move (1 at rest). */
export function advanceCutTween(tween: CutTween, dt: number): number {
  if (cutTweenSettled(tween)) {
    tween.angleDeg = tween.toDeg;
    return 1;
  }
  tween.elapsedS = Math.min(CUT_ANIMATION_S, tween.elapsedS + dt);
  const progress = easeInOutCubic(tween.elapsedS / CUT_ANIMATION_S);
  tween.angleDeg = tween.fromDeg + (tween.toDeg - tween.fromDeg) * progress;
  return progress;
}

/** One step of a value easing toward a target at a fixed rate. */
export function stepToward(value: number, target: number, step: number): number {
  if (value === target) return value;
  return value < target ? Math.min(target, value + step) : Math.max(target, value - step);
}

// ---- the look mapping -------------------------------------------------------

/** Each region's look, inside-out like the drawn model, with the family
 *  depth tint applied — the one place the legend and the faces get their colours. */
export function regionArtInsideOut(drawn: DrawnModel): ArtParams[] {
  const reference = drawn.referenceRadiusKm;
  return drawn.regionsInsideOut.map((region) => {
    const depthMidFraction = 1 - (region.outerRadiusKm + region.innerRadiusKm) / (2 * reference);
    return depthTint(artParamsFor(region.family, region.phase), region.family, depthMidFraction);
  });
}

/**
 * The region looks the faces draw, inside-out, every radius through the
 * remap: the outer boundary; the half-width of a physical transition (its
 * two edges mapped and halved, so a widened thin layer keeps a blend that
 * fits it); and the band where the boundary might be (an interval or a
 * spread of models — a qualitative note has no width to draw), which
 * straddles the boundary at every blend because the remap is monotone. A
 * null temperature range draws every temperature as unknown, so the faces
 * and the legend never disagree about whether there is a scale.
 */
export function regionLooks(
  drawn: DrawnModel,
  remap: ReadableRemap,
  artInsideOut: readonly ArtParams[],
  temperatureRange: TemperatureRange | null,
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
    return {
      outerDisplay: toDisplayFraction(remap, fractions[index]),
      blendDisplay,
      art: artInsideOut[index],
      // An unknown temperature is cold, never a guessed glow; Temperature mode hatches it.
      heat: incandescence(region.temperatureK ?? 0),
      temperature: region.region && temperatureRange ? temperatureEndpoints(region.region.temperatureK) : null,
      bandDisplay: band && band.high > band.low ? band : null,
    };
  });
}

// ---- the caption ------------------------------------------------------------

/** The one line under the body chip: what is drawn and how much to trust it. */
export function captionFor(coverage: Coverage, drawn: DrawnModel): string {
  const radius = `radius ${formatKm(drawn.referenceRadiusKm)} km`;
  const model = drawn.model;
  if (model) {
    const review = model.review === 'reviewed' ? 'Reviewed model' : 'Provisional model';
    if (model.illustrative) return `Illustrative scenario, not a measurement · ${radius}`;
    if (coverage.state === 'competing') return `${review}, one of ${coverage.models.length} · ${radius}`;
    return `${review} · ${radius}`;
  }
  const bulk = coverageBulk(coverage)?.densityKgM3 ?? null;
  const density = bulk ? `bulk density ${Math.round(bulk.value).toLocaleString('en-US')} kg/m³` : 'no measured density';
  const lead = coverage.state === 'notYetModelled' ? 'Not yet modelled here' : 'Interior unresolved';
  return `${lead} · ${density}`;
}

/** The legend row for the unresolved whole. */
export function unresolvedComposition(coverage: Coverage): string {
  return coverage.state === 'notYetModelled' ? 'Not yet modelled here' : 'Not measured';
}

/** The note under the Layer thickness segment: what the reader is looking at,
 *  and — at true thickness — how many layers are too thin to see at the disc's
 *  current size, which is what Readable is there to fix. */
export function thicknessNoteText(readable: boolean, tooThinToSeeCount: number): string {
  if (readable) return 'Thin layers widened so you can see them';
  if (tooThinToSeeCount <= 0) return 'Layers at their true thickness';
  return `Layers at their true thickness · ${tooThinToSeeCount} too thin to see`;
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
