/**
 * The depth ruler's geometry (plan §6): km ticks from the rim to the
 * centre along the near edge of a section face, region names on the
 * segments with room (a region may carry a note to go under its name — what
 * Temperature mode says of a region whose temperature nobody knows), annotation
 * brackets as a second tier. Every tick is
 * placed at its PHYSICAL depth through the Readable remap, so on the
 * Readable scale the ticks visibly stretch where a thin layer was widened
 * — the ruler is how the remap stays honest.
 *
 * One wedge is cut through the whole body, so the ruler is ONE straight
 * line: every point is the chosen face's radial direction times a display
 * radius, rim to centre, and the region segments are stretches of that one
 * line rather than steps across a terrace. Each point is a world position
 * on the face; the caller projects them. Pure: three math only, no DOM.
 */
import * as THREE from 'three';
import { cutFaceBasis, createCutFaceBasis, type CutFrame, type CutFaceSide } from './cutFrame';
import { toDisplayFraction, type ReadableRemap } from './interiorGeometry';

export interface RulerRegionInput {
  key: string;
  name: string;
  /** Physical outer radius, km. */
  outerRadiusKm: number;
  innerRadiusKm: number;
  /** A line under the name on the face, or none. */
  note?: string;
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
  /** The line under the name, '' for none; drawn only with the name. */
  note: string;
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

const scratchBasis = createCutFaceBasis();

/**
 * The world position of a physical depth on the ruler's face: the depth
 * becomes a display radius through the remap, and that radius is measured
 * along the face's radial from the centre. The face is the same one at
 * every depth, so every ruler point lies on one line.
 */
export function rulerPoint(input: RulerInput, depthKm: number, out = new THREE.Vector3()): THREE.Vector3 {
  const physical = Math.min(1, Math.max(0, 1 - depthKm / input.referenceRadiusKm));
  const display = toDisplayFraction(input.remap, physical);
  return rulerPointAtDisplay(input, display, out);
}

function rulerPointAtDisplay(input: RulerInput, display: number, out: THREE.Vector3): THREE.Vector3 {
  const basis = cutFaceBasis(input.frame, input.side, scratchBasis);
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
    const segment = out.segments[index] ?? (out.segments[index] = { key: '', name: '', note: '', from: new THREE.Vector3(), to: new THREE.Vector3() });
    segment.key = region.key;
    segment.name = region.name;
    segment.note = region.note ?? '';
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

/**
 * Which face carries the ruler, and how squarely it meets the eye: the
 * ruler goes on the face turned more toward the camera (`rulerSide`), and
 * `rulerFacing` is that face's own normal against the line of sight — 1
 * looking straight down it, 0 edge-on, negative once BOTH faces have turned
 * away. The cut is body-locked, so a reader can orbit round behind it; the
 * caller hides the ruler once the facing drops under its floor (a line of
 * ticks laid on a face seen nearly edge-on is unreadable before the face
 * turns away) rather than draw it over the back of a body they cannot see into.
 */
export function rulerSide(frame: CutFrame, cameraDirection: THREE.Vector3): CutFaceSide {
  return facingA(frame, cameraDirection) >= facingB(frame, cameraDirection) ? 'a' : 'b';
}

export function rulerFacing(frame: CutFrame, cameraDirection: THREE.Vector3): number {
  return Math.max(facingA(frame, cameraDirection), facingB(frame, cameraDirection));
}

function facingA(frame: CutFrame, cameraDirection: THREE.Vector3): number {
  return cutFaceBasis(frame, 'a', scratchBasis).normal.dot(cameraDirection);
}

function facingB(frame: CutFrame, cameraDirection: THREE.Vector3): number {
  return cutFaceBasis(frame, 'b', scratchBasis).normal.dot(cameraDirection);
}
