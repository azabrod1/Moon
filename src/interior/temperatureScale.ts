/**
 * The Temperature-mode scale (plan §5): body-specific, labelled with its
 * range, and the one definition the faces and the legend share. The colour
 * ramp is six sRGB stops from a near-black violet through crimson and
 * orange to a pale yellow, linear between stops IN sRGB — the space the
 * legend's CSS gradient and the swatches mix in — and the shader carries the
 * same stops, mixes them the same way and only then linearises, so the
 * colour on a face is the colour beside its row (rendering/outputTransform
 * says what the output path then does to it). The top of the ramp stays
 * below the bloom threshold, so a diagram never blooms.
 *
 * A body's range is the span of its known temperatures, every sample of a
 * profile included (temperatureProfile.temperatureExtremes); a region whose
 * temperature is unknown contributes nothing and is drawn hatched, never as
 * the coldest colour. A body whose known temperatures are all one value has
 * a scale of one value — its span is zero and the legend's bar is one colour
 * with that value at both ends — so known data is never relabelled unknown
 * by a scale too narrow to place it (plan F22). Where a temperature sits on
 * the scale (temperatureT) is the shader's sectionScaleT in TypeScript,
 * floors included, and rendering/sectionMaterial.test.ts holds the two
 * together. Pure: no three, no DOM.
 */
import type { Quantity } from './data/interiorTypes';
import { temperatureExtremes } from './temperatureProfile';

/** sRGB 0..1, cold to hot. */
export const TEMPERATURE_SCALE_STOPS: readonly (readonly [number, number, number])[] = [
  [0.07, 0.03, 0.15],
  [0.32, 0.06, 0.38],
  [0.74, 0.13, 0.22],
  [0.97, 0.47, 0.10],
  [0.99, 0.81, 0.26],
  [0.98, 0.96, 0.82],
];

export interface TemperatureRange {
  minK: number;
  maxK: number;
  /** Logarithmic when the range spans more than LOG_SCALE_RATIO (the Sun's 4,500 K to 15.7 million K). */
  log: boolean;
}

/** A range wider than this ratio is drawn on a log scale, or the cool layers all sit at the bottom. */
export const LOG_SCALE_RATIO = 50;

/** The scale colour at t ∈ [0, 1], sRGB 0..1. */
export function temperatureScaleColor(t: number): [number, number, number] {
  const stops = TEMPERATURE_SCALE_STOPS;
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(x));
  const fraction = x - index;
  const from = stops[index];
  const to = stops[index + 1];
  return [
    from[0] + (to[0] - from[0]) * fraction,
    from[1] + (to[1] - from[1]) * fraction,
    from[2] + (to[2] - from[2]) * fraction,
  ];
}

export function temperatureScaleHex(t: number): number {
  const [red, green, blue] = temperatureScaleColor(t).map((channel) => Math.round(Math.max(0, Math.min(1, channel)) * 255));
  return (red << 16) | (green << 8) | blue;
}

/** The CSS gradient of the whole ramp, for the legend's scale bar. */
export function temperatureScaleGradientCss(): string {
  const stops = TEMPERATURE_SCALE_STOPS.map((stop, index) => {
    const [red, green, blue] = stop.map((channel) => Math.round(channel * 255));
    return `rgb(${red},${green},${blue}) ${Math.round((index / (TEMPERATURE_SCALE_STOPS.length - 1)) * 100)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/** The shader's floors on a scale's span, so a degenerate range divides by
 *  these rather than by zero: one kelvin on a linear scale, 1e-4 in log space. */
export const LINEAR_SPAN_FLOOR_K = 1;
export const LOG_SPAN_FLOOR = 1e-4;

/** Where a temperature sits on a body's scale, 0..1; clamped. The same
 *  arithmetic as the faces' sectionTempT, so the legend swatch is the face. */
export function temperatureT(range: TemperatureRange, kelvin: number): number {
  if (range.log) {
    const low = Math.log(Math.max(range.minK, 1));
    const high = Math.log(Math.max(range.maxK, 1));
    return Math.min(1, Math.max(0, (Math.log(Math.max(kelvin, 1)) - low) / Math.max(high - low, LOG_SPAN_FLOOR)));
  }
  return Math.min(1, Math.max(0, (kelvin - range.minK) / Math.max(range.maxK - range.minK, LINEAR_SPAN_FLOOR_K)));
}

/** The span of a body's known temperatures, or null when no region says. A
 *  single known value is a span of zero, still a scale (see the header). */
export function bodyTemperatureRange(quantities: readonly Quantity[]): TemperatureRange | null {
  let minK = Infinity;
  let maxK = -Infinity;
  for (const quantity of quantities) {
    const extremes = temperatureExtremes(quantity);
    if (!extremes) continue;
    minK = Math.min(minK, extremes.minK);
    maxK = Math.max(maxK, extremes.maxK);
  }
  if (!Number.isFinite(minK) || !Number.isFinite(maxK)) return null;
  return { minK, maxK, log: minK > 0 && maxK / minK > LOG_SCALE_RATIO };
}
