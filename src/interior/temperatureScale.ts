/**
 * The Temperature-mode scale (plan §5): body-specific, labelled with its
 * range, and the one definition the faces and the legend share. The colour
 * ramp is six sRGB stops from a near-black violet through crimson and
 * orange to a pale yellow, linear between stops; the shader carries the
 * same stops (linearised) and interpolates the same way, so the swatch
 * beside a region is the colour on its face. The top of the ramp stays
 * below the bloom threshold, so a diagram never blooms.
 *
 * A body's range is the span of its known temperatures, endpoint to
 * endpoint; a region whose temperature is unknown contributes nothing and
 * is drawn hatched, never as the coldest colour. Pure: no three, no DOM.
 */
import type { Quantity } from './data/interiorTypes';

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

/** Where a temperature sits on a body's scale, 0..1; clamped. */
export function temperatureT(range: TemperatureRange, kelvin: number): number {
  if (range.log) {
    const low = Math.log(Math.max(range.minK, 1));
    const high = Math.log(Math.max(range.maxK, 1));
    if (!(high > low)) return 0.5;
    return Math.min(1, Math.max(0, (Math.log(Math.max(kelvin, 1)) - low) / (high - low)));
  }
  const span = range.maxK - range.minK;
  if (!(span > 0)) return 0.5;
  return Math.min(1, Math.max(0, (kelvin - range.minK) / span));
}

/** The known endpoints of a quantity, K, or null when it says nothing. */
export function temperatureEndpoints(quantity: Quantity): { outerK: number; innerK: number; log: boolean } | null {
  if (quantity.kind === 'endpoints') {
    return { outerK: quantity.outer.value, innerK: quantity.inner.value, log: quantity.interpolation === 'log' };
  }
  if (quantity.kind === 'profile' && quantity.samples.length > 0) {
    const samples = quantity.samples;
    return { outerK: samples[samples.length - 1].value, innerK: samples[0].value, log: quantity.interpolation === 'log' };
  }
  return null;
}

/** The span of a body's known temperatures, or null when no region says. */
export function bodyTemperatureRange(quantities: readonly Quantity[]): TemperatureRange | null {
  let minK = Infinity;
  let maxK = -Infinity;
  for (const quantity of quantities) {
    const endpoints = temperatureEndpoints(quantity);
    if (!endpoints) continue;
    minK = Math.min(minK, endpoints.outerK, endpoints.innerK);
    maxK = Math.max(maxK, endpoints.outerK, endpoints.innerK);
  }
  if (!Number.isFinite(minK) || !Number.isFinite(maxK)) return null;
  return { minK, maxK, log: minK > 0 && maxK / minK > LOG_SCALE_RATIO };
}
