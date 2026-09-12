/**
 * The depth ruler's geometry (plan §6): km ticks from the rim to the
 * centre along the near edge of a section face, region names on the
 * segments with room, annotation brackets as a second tier. Every tick is
 * placed at its PHYSICAL depth through the Readable remap, so on the
 * Readable scale the ticks visibly stretch where a thin layer was widened
 * — the ruler is how the remap stays honest.
 *
 * The faces are terraced, so the ruler is not one straight line: region
 * k's segment lies on region k's own face (at its own terrace angle) from
 * its outer display radius in to its inner one, and the segments step
 * across the shells between them. Each point is a world position on a face;
 * the caller projects them. Pure: three math only, no DOM.
 */
import * as THREE from 'three';
import { cutFaceBasis, createCutFaceBasis, createCutFrame, terraceOpeningAngle, type CutFrame, type CutFaceSide } from './cutFrame';
import { regionIndexAtRadius } from './interiorPick';
import { toDisplayFraction, type ReadableRemap } from './interiorGeometry';

export interface RulerRegionInput {
  key: string;
  name: string;
  /** Physical outer radius, km. */
  outerRadiusKm: number;
  innerRadiusKm: number;
}

export interface RulerAnnotationInput {
  name: string;
  innerRadiusKm: number;
  outerRadiusKm: number;
}

export interface RulerInput {
  frame: CutFrame;
  /** Which face carries the ruler. */
  side: CutFaceSide;
  referenceRadiusKm: number;
  remap: ReadableRemap;
  /** Display-space outer radii, inside-out (the regions' order). */
  outerDisplay: readonly number[];
  regionsInsideOut: readonly RulerRegionInput[];
  annotations: readonly RulerAnnotationInput[];
  terraceStep: number;
}

export interface RulerTick {
  depthKm: number;
  /** World position on the face. */
  point: THREE.Vector3;
  /** Whether a label is wanted here (every tick by default; the DOM thins them by spacing). */
  major: boolean;
}

export interface RulerSegment {
  key: string;
  name: string;
  /** World positions on the region's face: the outer end (shallower) and the inner end (deeper). */
  from: THREE.Vector3;
  to: THREE.Vector3;
}

export interface RulerBracket {
  name: string;
  from: THREE.Vector3;
  to: THREE.Vector3;
}

export interface RulerLayout {
  stepKm: number;
  ticks: RulerTick[];
  segments: RulerSegment[];
  brackets: RulerBracket[];
}

/** An empty layout to fill: rulerLayout reuses its entries and their vectors frame after frame. */
export function createRulerLayout(): RulerLayout {
  return { stepKm: 0, ticks: [], segments: [], brackets: [] };
}

const NICE_STEPS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000];

/** The tick spacing, km: the smallest nice step that fits at most eight ticks in the radius. */
export function niceStepKm(radiusKm: number, maxTicks = 8): number {
  for (const step of NICE_STEPS) {
    if (radiusKm / step <= maxTicks) return step;
  }
  return NICE_STEPS[NICE_STEPS.length - 1];
}

const scratchFrame = createCutFrame();
const scratchBasis = createCutFaceBasis();

/**
 * The world position of a physical depth on the ruler's face: the depth
 * becomes a display radius through the remap, that radius names the region
 * whose face (at its own terrace angle) carries it.
 */
export function rulerPoint(input: RulerInput, depthKm: number, out = new THREE.Vector3()): THREE.Vector3 {
  const physical = Math.min(1, Math.max(0, 1 - depthKm / input.referenceRadiusKm));
  const display = toDisplayFraction(input.remap, physical);
  return rulerPointAtDisplay(input, display, out);
}

function rulerPointAtDisplay(input: RulerInput, display: number, out: THREE.Vector3): THREE.Vector3 {
  const count = input.outerDisplay.length;
  const regionIndex = regionIndexAtRadius(input.outerDisplay, display);
  scratchFrame.view.copy(input.frame.view);
  scratchFrame.side.copy(input.frame.side);
  scratchFrame.hinge.copy(input.frame.hinge);
  scratchFrame.openingAngle = terraceOpeningAngle(input.frame.openingAngle, count - 1 - regionIndex, input.terraceStep);
  const basis = cutFaceBasis(scratchFrame, input.side, scratchBasis);
  return out.copy(basis.radial).multiplyScalar(display);
}

/** Lay the ruler out. With `out`, the previous layout's entries and vectors
 *  are reused (pooled), so a per-frame caller allocates nothing at rest. */
export function rulerLayout(input: RulerInput, out: RulerLayout = createRulerLayout()): RulerLayout {
  const reference = input.referenceRadiusKm;
  const stepKm = niceStepKm(reference);
  out.stepKm = stepKm;
  let tickCount = 0;
  const placeTick = (depthKm: number, major: boolean) => {
    const tick = out.ticks[tickCount] ?? (out.ticks[tickCount] = { depthKm: 0, point: new THREE.Vector3(), major: true });
    tick.depthKm = depthKm;
    tick.major = major;
    rulerPoint(input, depthKm, tick.point);
    tickCount++;
  };
  for (let depthKm = 0; depthKm <= reference + 1e-9; depthKm += stepKm) placeTick(depthKm, true);
  // The centre, when the last step does not land on it.
  const last = out.ticks[tickCount - 1];
  if (last && reference - last.depthKm > stepKm * 0.25) placeTick(reference, false);
  out.ticks.length = tickCount;

  input.regionsInsideOut.forEach((region, index) => {
    const segment = out.segments[index] ?? (out.segments[index] = { key: '', name: '', from: new THREE.Vector3(), to: new THREE.Vector3() });
    segment.key = region.key;
    segment.name = region.name;
    rulerPointAtDisplay(input, input.outerDisplay[index], segment.from);
    rulerPointAtDisplay(input, index > 0 ? input.outerDisplay[index - 1] + 1e-6 : 0, segment.to);
  });
  out.segments.length = input.regionsInsideOut.length;

  input.annotations.forEach((annotation, index) => {
    const bracket = out.brackets[index] ?? (out.brackets[index] = { name: '', from: new THREE.Vector3(), to: new THREE.Vector3() });
    bracket.name = annotation.name;
    rulerPoint(input, reference - annotation.outerRadiusKm, bracket.from);
    rulerPoint(input, reference - annotation.innerRadiusKm, bracket.to);
  });
  out.brackets.length = input.annotations.length;
  return out;
}

/** Which face carries the ruler: the one turned more toward the camera. */
export function rulerSide(frame: CutFrame, cameraDirection: THREE.Vector3): CutFaceSide {
  const a = cutFaceBasis(frame, 'a', scratchBasis).normal.dot(cameraDirection);
  const b = cutFaceBasis(frame, 'b', scratchBasis).normal.dot(cameraDirection);
  return a >= b ? 'a' : 'b';
}
