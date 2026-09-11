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
