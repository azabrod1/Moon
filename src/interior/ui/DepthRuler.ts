/**
 * The depth ruler on screen (plan §6): an SVG overlay that draws the
 * ruler.ts layout each frame, IN THE PLANE OF THE FACE it lies on. The
 * layout's points are world positions on the face and are projected as they
 * are; every mark hung off them — a tick, a name's offset, a bracket's arm —
 * is measured along the face's own axes in world space and projected too,
 * and each label is drawn through a transform built from the face's
 * projected axes at its anchor, so the numbers lie on the face and
 * foreshorten with it instead of floating as a flat sticker over a body seen
 * at an angle (they are kept upright and never squashed past
 * TEXT_SQUASH_FLOOR, and the ruler hides once its face turns edge-on).
 *
 * The text rules (rulerLabels.ts): the km labels are thinned as a series —
 * every second, fifth or tenth tick — never one from the middle of an even
 * sequence; the rim reads "0" and the deepest label carries the unit; a
 * label that would sit inside a core too small to hold it is dropped, so
 * the innermost region stays legible; region names go where the projection
 * leaves room (the widest segments first, none over another), and a region's
 * note sits under its name, only with it and only where the chord holds it;
 * annotation
 * brackets sit on tiers below the names, stepping apart wherever a span or
 * a name would overlap, and a bracket is drawn only WITH its name — a span
 * that has no room for its name on the body is not drawn as an anonymous
 * mark. Names and numbers are kept inside the disc's chord at their height
 * and dropped when it cannot hold them. Elements are pooled and re-posed,
 * never rebuilt per frame. Hidden on phones and while the cut is closed; it
 * fades in with the opening so it draws itself on the reveal.
 */
import * as THREE from 'three';
import type { RulerLayout } from '../ruler';
import { formatKm } from './inspectorText';
import { assignTiers, estimateTextWidth, fitInSpan, labelStride, orientTextAxes, thinLabels, type Footprint, type LabelCandidate } from './rulerLabels';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** A tick's length up from the line, px on a face seen square-on. */
const TICK_PX = 6;
/** The km labels sit this far up from the line; names this far below it. */
const LABEL_GAP_PX = 10;
const NAME_GAP_PX = 14;
/** A region's note sits this far below the line, under its name, in the smaller face. */
const NOTE_GAP_PX = 26;
const NOTE_GLYPH_PX = 5.3;
/** Labels are thinned to the width of the text between them (mono, about this wide per glyph) plus a gap. */
const LABEL_GLYPH_PX = 6.2;
const LABEL_MIN_GAP_PX = 10;
/** The unit on the deepest label: " km" in the mono face. */
const UNIT_TEXT = ' km';
/** A region name needs this much projected segment length. */
const NAME_MIN_SEGMENT_PX = 44;
/** The UI face at 10.5px runs about this wide per glyph; names are thinned by that width plus a gap. */
const NAME_GLYPH_PX = 5.8;
const NAME_MIN_GAP_PX = 8;
/** The innermost region drops the km labels that fall in it when its segment is shorter than this many label widths. */
const CORE_LABEL_ROOM = 2;
/** Brackets hang this far below the line, one tier further down each time footprints overlap. */
const BRACKET_GAP_PX = 34;
const BRACKET_ARM_PX = 4;
const BRACKET_TIER_PX = 16;
const BRACKET_PAD_PX = 6;
/** A span projected shorter than this is not a mark anyone can read. */
const BRACKET_MIN_SPAN_PX = 3;
/** The UI face at 9.5px, the annotation names' size. */
const BRACKET_GLYPH_PX = 5.3;
/** Text on a face turned away is never squashed narrower than this share of its square-on width. */
const TEXT_SQUASH_FLOOR = 0.55;
/** How far along a face axis the projection is sampled for a label's transform, world units. */
const PLANE_PROBE = 0.02;

interface Pool<T extends SVGElement> {
  elements: T[];
  used: number;
}

function pool<K extends keyof SVGElementTagNameMap>(): Pool<SVGElementTagNameMap[K]> {
  return { elements: [], used: 0 };
}

function take<K extends keyof SVGElementTagNameMap>(root: SVGSVGElement, tag: K, className: string, store: Pool<SVGElementTagNameMap[K]>): SVGElementTagNameMap[K] {
  let element = store.elements[store.used];
  if (!element) {
    element = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
    element.setAttribute('class', className);
    root.append(element);
    store.elements.push(element);
  }
  element.style.display = '';
  store.used++;
  return element;
}

function release<T extends SVGElement>(store: Pool<T>): void {
  for (let index = store.used; index < store.elements.length; index++) store.elements[index].style.display = 'none';
  store.used = 0;
}

type ScreenPoint = [number, number];

/** A label's place and the face's projected axes there: the SVG transform that lays it in the plane. */
interface PlaneText {
  at: ScreenPoint;
  /** Screen px per square-on px along the ruler (rim to centre) and along the face's up, orientation fixed for reading. */
  along: ScreenPoint;
  up: ScreenPoint;
}

const projected = new THREE.Vector3();
const probeWorld = new THREE.Vector3();
const rulerDirection = new THREE.Vector3();
const cameraRight = new THREE.Vector3();
/** Midpoints of the segments and brackets, pooled so a frame at rest allocates none. */
const midpointPool: THREE.Vector3[] = [];
function midpointOf(from: THREE.Vector3, to: THREE.Vector3, slot: number): THREE.Vector3 {
  const vector = midpointPool[slot] ?? (midpointPool[slot] = new THREE.Vector3());
  return vector.copy(from).add(to).multiplyScalar(0.5);
}

export class DepthRuler {
  private root: SVGSVGElement | null = null;
  private readonly segmentLines = pool<'line'>();
  private readonly tickLines = pool<'line'>();
  private readonly tickLabels = pool<'text'>();
  private readonly nameLabels = pool<'text'>();
  private readonly noteLabels = pool<'text'>();
  private readonly bracketPaths = pool<'path'>();
  private readonly bracketLabels = pool<'text'>();

  bind(id: string): void {
    this.root = document.getElementById(id) as SVGSVGElement | null;
  }

  hide(): void {
    if (this.root) this.root.style.display = 'none';
  }

  /**
   * Pose the ruler for this frame. `opacity` fades it with the opening;
   * `radial` and `up` are the world axes of the face the ruler lies on (the
   * half-disc's own basis, cutFrame.cutFaceBasis), which every mark is
   * measured along. Points are projected with the camera as it is; the
   * caller has already updated the camera's matrices for the frame.
   */
  render(layout: RulerLayout, camera: THREE.Camera, width: number, height: number, opacity: number, radial: THREE.Vector3, up: THREE.Vector3): void {
    const root = this.root;
    if (!root) return;
    if (opacity <= 0.01 || layout.ticks.length < 2) {
      root.style.display = 'none';
      return;
    }
    root.style.display = '';
    root.style.opacity = opacity.toFixed(3);
    root.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const toScreen = (point: THREE.Vector3): ScreenPoint | null => {
      projected.copy(point).project(camera);
      if (projected.z > 1) return null;
      return [((projected.x + 1) / 2) * width, ((1 - projected.y) / 2) * height];
    };

    // The scale a face seen square-on would draw at: screen px per world unit
    // across the body's centre, read off the camera's own right axis. Every
    // in-plane offset is authored in those px and turned into world units by it.
    const centre = layout.ticks[layout.ticks.length - 1].point;
    const centreScreen = toScreen(centre);
    cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const rightScreen = toScreen(probeWorld.copy(centre).addScaledVector(cameraRight, PLANE_PROBE));
    if (!centreScreen || !rightScreen) {
      root.style.display = 'none';
      return;
    }
    const pxPerUnit = Math.max(1e-3, Math.hypot(rightScreen[0] - centreScreen[0], rightScreen[1] - centreScreen[1]) / PLANE_PROBE);
    // The ruler runs rim to centre, against the face's radial.
    rulerDirection.copy(radial).negate();
    /** A point on the face: `point` moved `alongPx` toward the centre and `upPx` up the face, in square-on px. */
    const inPlane = (point: THREE.Vector3, alongPx: number, upPx: number): ScreenPoint | null =>
      toScreen(probeWorld.copy(point).addScaledVector(rulerDirection, alongPx / pxPerUnit).addScaledVector(up, upPx / pxPerUnit));
    /** The face's projected axes at a point, as a label's transform: upright, reading left to right, never squashed past the floor. */
    const planeText = (point: THREE.Vector3, alongPx: number, upPx: number): PlaneText | null => {
      const at = inPlane(point, alongPx, upPx);
      const alongProbe = inPlane(point, alongPx + PLANE_PROBE * pxPerUnit, upPx);
      const upProbe = inPlane(point, alongPx, upPx + PLANE_PROBE * pxPerUnit);
      if (!at || !alongProbe || !upProbe) return null;
      const scale = 1 / (PLANE_PROBE * pxPerUnit);
      const oriented = orientTextAxes(
        [(alongProbe[0] - at[0]) * scale, (alongProbe[1] - at[1]) * scale],
        [(upProbe[0] - at[0]) * scale, (upProbe[1] - at[1]) * scale],
        TEXT_SQUASH_FLOOR,
      );
      return { at, along: [oriented.along[0], oriented.along[1]], up: [oriented.up[0], oriented.up[1]] };
    };
    const placeText = (label: SVGTextElement, text: PlaneText, content: string) => {
      label.setAttribute('transform', `matrix(${text.along[0].toFixed(4)} ${text.along[1].toFixed(4)} ${(-text.up[0]).toFixed(4)} ${(-text.up[1]).toFixed(4)} ${text.at[0].toFixed(1)} ${text.at[1].toFixed(1)})`);
      label.textContent = content;
    };
    /** A text's drawn half-width on screen: its square-on half-width through the face's foreshortening. */
    const drawnHalf = (text: PlaneText, halfWidthPx: number) => halfWidthPx * Math.hypot(text.along[0], text.along[1]);

    // The ruler's screen direction, rim to centre, the axis labels are thinned and clamped on.
    const rim = toScreen(layout.ticks[0].point);
    let dirX = 1;
    let dirY = 0;
    if (rim) {
      const dx = centreScreen[0] - rim[0];
      const dy = centreScreen[1] - rim[1];
      const length = Math.hypot(dx, dy) || 1;
      dirX = dx / length;
      dirY = dy / length;
    }
    const along = (point: ScreenPoint) => (point[0] - (rim?.[0] ?? 0)) * dirX + (point[1] - (rim?.[1] ?? 0)) * dirY;
    /** The disc's extent along the ruler at `upPx` off the line, in screen along-px: the chord a
     *  label must fit. It depends on the height alone, so each height is projected once a frame. */
    const chords = new Map<number, [number, number] | null>();
    const chordAt = (upPx: number): [number, number] | null => {
      const known = chords.get(upPx);
      if (known !== undefined) return known;
      const offset = upPx / pxPerUnit;
      const half = Math.sqrt(Math.max(0, 1 - offset * offset));
      const low = inPlane(centre, -half * pxPerUnit, upPx);
      const high = inPlane(centre, half * pxPerUnit, upPx);
      let chord: [number, number] | null = null;
      if (low && high) {
        const a = along(low);
        const b = along(high);
        chord = [Math.min(a, b), Math.max(a, b)];
      }
      chords.set(upPx, chord);
      return chord;
    };
    /** A label kept inside the chord: its anchor shifted along the ruler by the difference, or null when it cannot fit. */
    const insideChord = (point: THREE.Vector3, alongPx: number, upPx: number, halfWidthPx: number): { text: PlaneText; half: number } | null => {
      const text = planeText(point, alongPx, upPx);
      const chord = chordAt(upPx);
      if (!text || !chord) return null;
      const half = drawnHalf(text, halfWidthPx);
      const here = along(text.at);
      const fitted = fitInSpan(here, half, chord[0], chord[1]);
      if (fitted === null) return null;
      if (Math.abs(fitted - here) < 0.5) return { text, half };
      // The shift, in square-on px along the ruler: screen along-px over the face's foreshortening there.
      const foreshortening = Math.max(1e-3, Math.hypot(text.along[0], text.along[1]));
      const shifted = planeText(point, alongPx + (fitted - here) / foreshortening, upPx);
      return shifted ? { text: shifted, half } : null;
    };

    // Segments: one line per region along the one straight ruler, named where
    // the projection leaves room: the widest first, none over another.
    const segmentsOnScreen: { from: ScreenPoint; to: ScreenPoint; name: string; note: string; midpoint: THREE.Vector3 }[] = [];
    const nameCandidates: LabelCandidate[] = [];
    const nameTexts: ({ text: PlaneText; half: number } | null)[] = [];
    const noteTexts: ({ text: PlaneText; half: number } | null)[] = [];
    let midpointSlot = 0;
    for (const segment of layout.segments) {
      const from = toScreen(segment.from);
      const to = toScreen(segment.to);
      if (!from || !to) continue;
      const midpoint = midpointOf(segment.from, segment.to, midpointSlot++);
      const placed = insideChord(midpoint, 0, -NAME_GAP_PX, estimateTextWidth(segment.name, NAME_GLYPH_PX) / 2);
      segmentsOnScreen.push({ from, to, name: segment.name, note: segment.note, midpoint });
      nameTexts.push(placed);
      noteTexts.push(segment.note && placed ? insideChord(midpoint, 0, -NOTE_GAP_PX, estimateTextWidth(segment.note, NOTE_GLYPH_PX) / 2) : null);
      nameCandidates.push({
        centre: placed ? along(placed.text.at) : (along(from) + along(to)) / 2,
        halfWidth: placed ? placed.half : Infinity,
        span: Math.hypot(to[0] - from[0], to[1] - from[1]),
      });
    }
    const namesKept = thinLabels(nameCandidates, { minSpanPx: NAME_MIN_SEGMENT_PX, gapPx: NAME_MIN_GAP_PX });
    segmentsOnScreen.forEach(({ from, to, name, note }, index) => {
      const line = take(root, 'line', 'ruler-seg', this.segmentLines);
      line.setAttribute('x1', from[0].toFixed(1));
      line.setAttribute('y1', from[1].toFixed(1));
      line.setAttribute('x2', to[0].toFixed(1));
      line.setAttribute('y2', to[1].toFixed(1));
      const placed = nameTexts[index];
      if (!namesKept[index] || !placed) return;
      placeText(take(root, 'text', 'ruler-name', this.nameLabels), placed.text, name);
      // The note goes with the name, where the chord holds it too.
      const notePlaced = noteTexts[index];
      if (notePlaced) placeText(take(root, 'text', 'ruler-note', this.noteLabels), notePlaced.text, note);
    });
    release(this.segmentLines);
    release(this.nameLabels);
    release(this.noteLabels);

    // The innermost region's segment: a core too small for a label keeps the labels off itself.
    const innermost = segmentsOnScreen[0] ?? null;
    const innermostAlong: [number, number] | null = innermost
      ? [Math.min(along(innermost.from), along(innermost.to)), Math.max(along(innermost.from), along(innermost.to))]
      : null;

    // Ticks, every one drawn up the face; the labels thinned as a series.
    const majors: { index: number; at: ScreenPoint; text: string; halfWidth: number; label: PlaneText | null }[] = [];
    for (let index = 0; index < layout.ticks.length; index++) {
      const tick = layout.ticks[index];
      const at = toScreen(tick.point);
      const top = inPlane(tick.point, 0, TICK_PX);
      if (!at || !top) continue;
      const line = take(root, 'line', tick.major ? 'ruler-tick' : 'ruler-tick minor', this.tickLines);
      line.setAttribute('x1', at[0].toFixed(1));
      line.setAttribute('y1', at[1].toFixed(1));
      line.setAttribute('x2', top[0].toFixed(1));
      line.setAttribute('y2', top[1].toFixed(1));
      if (!tick.major) continue;
      const text = tick.depthKm === 0 ? '0' : formatKm(tick.depthKm);
      const label = planeText(tick.point, 0, LABEL_GAP_PX);
      majors.push({ index, at, text, halfWidth: label ? drawnHalf(label, estimateTextWidth(text, LABEL_GLYPH_PX) / 2) : 0, label });
    }
    release(this.tickLines);
    const unitPx = estimateTextWidth(UNIT_TEXT, LABEL_GLYPH_PX) * (majors[0]?.label ? Math.hypot(majors[0].label.along[0], majors[0].label.along[1]) : 1);
    const stride = labelStride(majors.map((major) => along(major.at)), majors.map((major) => major.halfWidth), LABEL_MIN_GAP_PX, unitPx);
    const kept = majors.filter((_, position) => position % stride === 0).filter((major) => {
      if (!major.label) return false;
      // A label inside a core with no room for it is dropped; the core stays legible.
      if (innermostAlong && innermost) {
        const here = along(major.at);
        const inside = here > innermostAlong[0] + 0.5 && here < innermostAlong[1] - 0.5;
        const room = innermostAlong[1] - innermostAlong[0];
        if (inside && room < CORE_LABEL_ROOM * 2 * major.halfWidth) return false;
      }
      return true;
    });
    kept.forEach((major, position) => {
      const deepest = position === kept.length - 1 && kept.length > 1;
      placeText(take(root, 'text', 'ruler-label', this.tickLabels), major.label as PlaneText, deepest ? `${major.text}${UNIT_TEXT}` : major.text);
    });
    release(this.tickLabels);

    // Brackets: tiers below the names, stepping down where footprints overlap
    // along the ruler. A footprint is the span with its name, so two short
    // brackets with long names step apart even when their spans never touch
    // (the lithosphere and the transition zone sit close at the rim). A span
    // too short to read, or whose name has no room on the body, is not drawn.
    const bracketsOnScreen: { bracket: RulerLayout['brackets'][number]; midpoint: THREE.Vector3; halfNamePx: number }[] = [];
    const footprints: Footprint[] = [];
    for (const bracket of layout.brackets) {
      const from = toScreen(bracket.from);
      const to = toScreen(bracket.to);
      if (!from || !to) continue;
      if (Math.hypot(to[0] - from[0], to[1] - from[1]) < BRACKET_MIN_SPAN_PX) continue;
      const alongFrom = along(from);
      const alongTo = along(to);
      const low = Math.min(alongFrom, alongTo) - BRACKET_PAD_PX;
      const high = Math.max(alongFrom, alongTo) + BRACKET_PAD_PX;
      const midpoint = midpointOf(bracket.from, bracket.to, midpointSlot++);
      const halfNamePx = estimateTextWidth(bracket.name, BRACKET_GLYPH_PX) / 2;
      const probe = planeText(midpoint, 0, -BRACKET_GAP_PX);
      const halfNameDrawn = probe ? drawnHalf(probe, halfNamePx) : halfNamePx;
      const centreAlong = (alongFrom + alongTo) / 2;
      footprints.push({ low: Math.min(low, centreAlong - halfNameDrawn), high: Math.max(high, centreAlong + halfNameDrawn) });
      bracketsOnScreen.push({ bracket, midpoint, halfNamePx });
    }
    const tiers = assignTiers(footprints);
    bracketsOnScreen.forEach(({ bracket, midpoint, halfNamePx }, index) => {
      const gap = BRACKET_GAP_PX + tiers[index] * BRACKET_TIER_PX;
      const name = insideChord(midpoint, 0, -(gap + LABEL_GAP_PX), halfNamePx);
      const fromLow = inPlane(bracket.from, 0, -gap);
      const toLow = inPlane(bracket.to, 0, -gap);
      const fromArm = inPlane(bracket.from, 0, -gap + BRACKET_ARM_PX);
      const toArm = inPlane(bracket.to, 0, -gap + BRACKET_ARM_PX);
      if (!name || !fromLow || !toLow || !fromArm || !toArm) return;
      const path = take(root, 'path', 'ruler-bracket', this.bracketPaths);
      path.setAttribute('d', [
        `M ${fromArm[0].toFixed(1)} ${fromArm[1].toFixed(1)}`,
        `L ${fromLow[0].toFixed(1)} ${fromLow[1].toFixed(1)}`,
        `L ${toLow[0].toFixed(1)} ${toLow[1].toFixed(1)}`,
        `L ${toArm[0].toFixed(1)} ${toArm[1].toFixed(1)}`,
      ].join(' '));
      placeText(take(root, 'text', 'ruler-bracket-name', this.bracketLabels), name.text, bracket.name);
    });
    release(this.bracketPaths);
    release(this.bracketLabels);
  }
}
