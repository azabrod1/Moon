/**
 * Where the depth ruler's text goes once the projection has squeezed the
 * ruler. DepthRuler draws; this is the arithmetic, kept pure so the rules
 * are pinned by test. Two rules:
 *
 * - thinLabels: one row of labels along an axis, each wanting to sit centred
 *   on its own span (a region's segment). The widest spans are placed first;
 *   a label is kept when its span is long enough to deserve a name and its
 *   text clears every label already kept by the gap. So the biggest regions
 *   always read, and a foreshortened cutaway drops the names that would
 *   overprint instead of printing them on top of each other.
 * - assignTiers: brackets stack; each footprint takes the first tier where
 *   it overlaps nothing placed before it. A footprint is the bracket's span
 *   together with its name's extent, so two short brackets with long names
 *   step apart even when their spans never touch.
 * - labelStride: the km labels are thinned as a SERIES, every second, fifth
 *   or tenth tick, never one torn from the middle of an even sequence.
 * - fitInSpan: a label is kept inside the span it may occupy (the disc's
 *   chord at its height), shifted in when it hangs over, dropped when the
 *   span cannot hold it.
 * - orientTextAxes: the face's projected axes as a label's basis — turned
 *   upright, reading left to right, never squashed past a floor — so text
 *   drawn in the plane of a face stays text.
 */

export interface LabelCandidate {
  /** Where the label's centre falls along the axis, px. */
  centre: number;
  /** Half the label's text width, px. */
  halfWidth: number;
  /** Projected length of what the label names, px. */
  span: number;
}

export interface LabelRule {
  /** A span shorter than this gets no label at all. */
  minSpanPx: number;
  /** Clear space kept between two labels' text, px. */
  gapPx: number;
}

/** Which candidates keep their label, in input order. */
export function thinLabels(candidates: readonly LabelCandidate[], rule: LabelRule): boolean[] {
  const keep = candidates.map(() => false);
  const bySpan = candidates
    .map((_, index) => index)
    .sort((left, right) => candidates[right].span - candidates[left].span || left - right);
  const placed: { low: number; high: number }[] = [];
  for (const index of bySpan) {
    const candidate = candidates[index];
    if (candidate.span < rule.minSpanPx) continue;
    const low = candidate.centre - candidate.halfWidth;
    const high = candidate.centre + candidate.halfWidth;
    if (placed.some((other) => other.low < high + rule.gapPx && other.high > low - rule.gapPx)) continue;
    placed.push({ low, high });
    keep[index] = true;
  }
  return keep;
}

export interface Footprint {
  low: number;
  high: number;
}

/** The tier each footprint lands on: the lowest tier free of every earlier footprint it overlaps. */
export function assignTiers(footprints: readonly Footprint[]): number[] {
  const placed: { tier: number; low: number; high: number }[] = [];
  return footprints.map((footprint) => {
    let tier = 0;
    while (placed.some((other) => other.tier === tier && other.low < footprint.high && other.high > footprint.low)) tier++;
    placed.push({ tier, low: footprint.low, high: footprint.high });
    return tier;
  });
}

/** A label's width from its text, for a font that sets about `glyphPx` per glyph. */
export function estimateTextWidth(text: string, glyphPx: number): number {
  return text.length * glyphPx;
}

/**
 * The stride that thins one row of tick labels as a SERIES: every n-th tick
 * keeps its label, the smallest n at which every neighbouring pair of kept
 * labels clears the gap, so the numbers that remain are evenly spaced (a
 * 0 / 2,000 / 4,000 axis) instead of a sequence with holes torn in it. The
 * candidates are the major ticks in axis order, `along` where each sits on
 * the axis in px and `halfWidth` half its text's on-screen width. The unit
 * goes on the deepest kept label, so that one is `unitPx` wider on the check.
 * Past the widest stride nothing fits, and the answer is the tick count: only
 * the first label survives.
 */
export function labelStride(
  along: readonly number[],
  halfWidths: readonly number[],
  gapPx: number,
  unitPx: number,
  strides: readonly number[] = [1, 2, 5, 10],
): number {
  const count = along.length;
  if (count <= 1) return 1;
  for (const stride of strides) {
    const kept: number[] = [];
    for (let index = 0; index < count; index += stride) kept.push(index);
    const deepest = kept[kept.length - 1];
    let clear = true;
    for (let position = 1; position < kept.length && clear; position++) {
      const previous = kept[position - 1];
      const current = kept[position];
      const width = halfWidths[previous] + halfWidths[current] + (current === deepest ? unitPx / 2 : 0);
      if (Math.abs(along[current] - along[previous]) < width + gapPx) clear = false;
    }
    if (clear) return stride;
  }
  return count;
}

/**
 * Where a label centred at `centre` with half-width `halfWidth` goes to stay
 * inside [low, high]: itself when it already does, shifted to the nearer end
 * when it fits but hangs over, and null when the span is too short for it —
 * a name that cannot sit on the body is not drawn off it.
 */
export function fitInSpan(centre: number, halfWidth: number, low: number, high: number): number | null {
  if (high - low < 2 * halfWidth) return null;
  if (centre - halfWidth < low) return low + halfWidth;
  if (centre + halfWidth > high) return high - halfWidth;
  return centre;
}

export type Axis2 = readonly [number, number];

/**
 * The face's projected axes at a label's anchor, made a basis text can be
 * drawn in: `along` is the screen vector per square-on px along the ruler,
 * `up` the same up the face (screen y grows downward). Turned over when the
 * face's up points down the screen, so the glyphs stay upright; the baseline
 * reversed when the basis is mirrored, so the text reads left to right and
 * the glyphs are never mirrored; and neither axis shorter than `floor` of
 * square-on, so a face turned away keeps its text legible while the ticks
 * beside it foreshorten fully.
 */
export function orientTextAxes(along: Axis2, up: Axis2, floor: number): { along: Axis2; up: Axis2 } {
  // 0 - x rather than -x: a negated zero is still zero, not -0.
  const reversed = (axis: Axis2): Axis2 => [0 - axis[0], 0 - axis[1]];
  let baseline: Axis2 = along;
  let rise: Axis2 = up;
  if (rise[1] > 0) {
    baseline = reversed(baseline);
    rise = reversed(rise);
  }
  if (baseline[0] * -rise[1] - baseline[1] * -rise[0] < 0) baseline = reversed(baseline);
  const lifted = (axis: Axis2): Axis2 => {
    const length = Math.hypot(axis[0], axis[1]);
    if (length >= floor || length < 1e-6) return axis;
    return [(axis[0] * floor) / length, (axis[1] * floor) / length];
  };
  return { along: lifted(baseline), up: lifted(rise) };
}
