/**
 * Types for the map generator's texture arithmetic, hand-written because
 * tools/ sits outside the TypeScript project (tsconfig includes only src/).
 * They exist so src/planetarium/surfaceGrain.test.ts can drive the real passes
 * on a synthetic raster instead of restating what they do.
 *
 * Every raster here is one channel of a wrapping equirect map, held as a
 * Float32Array of W x H, and every distance in a spec is in DEGREES, scaled by
 * the raster's own pixels per degree.
 */

/** One value-noise octave's peak-to-peak amplitude per unit of standard
 *  deviation. */
export const NOISE_AMP_PER_SIGMA: number;

/** A noise octave: its cell size in pixels, how many cells fit across the map
 *  (so the grain meets itself at the edge), and its amplitude in counts. */
export interface Octave {
  cell: number;
  cols?: number;
  amp: number;
  /** How many pixels the amplitude was measured over. */
  samples?: number;
}

/** A straight brightness step found in a map. `from`/`to` are rows for a
 *  meridian and columns for a parallel, the columns wrapping. */
export interface Edge {
  axis: 'meridian' | 'parallel';
  /** The column (meridian) or row (parallel) the step is on. */
  at: number;
  from: number;
  to: number;
  /** How much ground the step runs along, in degrees. */
  spanDeg: number;
  /** The step in counts, positive when the far side is brighter. */
  step: number;
  score: number;
  round?: number;
}

export interface DeficitSpec {
  /** The finest band: the scale a resample takes detail from below. */
  fineDeg: number;
  /** The band the fine one is judged against — everything below this. */
  coarseDeg: number;
  /** The step the directional measure differences over. Defaults to fineDeg. */
  stepDeg?: number;
  /** The window the count is averaged over. */
  windowDeg: number;
  /** How far the answer is smoothed, so it changes over degrees. */
  wideDeg: number;
  /** Which percentile of the body's own ratio counts as fully detailed. */
  refPercentile?: number;
  /** Deficits below this are zero, so detailed ground is left untouched. */
  floor?: number;
  /** Sampling stride for the percentiles and the amplitudes. */
  stride?: number;
}

export interface FillSpec extends DeficitSpec {
  /** Octave cells, as multiples of the finest band, capped at the coarse one. */
  grainCells?: number[];
  /** Deficit at or below which ground is a reference for the amplitude. */
  referenceBelow?: number;
  /** Deficit at or above which ground counts as a coverage gap. */
  gapAbove?: number;
  /** Deficit at which the invented shape starts and finishes being removed. */
  replaceFrom?: number;
  replaceFull?: number;
  /** Bounds on the grain's scaling by local brightness. */
  toneFloor?: number;
  toneCeiling?: number;
  /** Ceiling on the solved level, in case a map measures a runaway one. */
  maxLevel?: number;
  seed?: number;
}

export interface EdgeSpec {
  /** How far either side of a line the step is measured. */
  lookDeg?: number;
  /** How far along a line the measurement is smoothed. */
  alongDeg?: number;
  /** The low pass the step is measured on. */
  smoothDeg?: number;
  /** Counts: below this a line is not a step. */
  minStep?: number;
  /** Degrees of ground a step must run along to count. */
  minSpanDeg?: number;
  /** Source pixels per cell of the grid the correction is solved on. */
  solveScale?: number;
  /** Sweeps on the coarsest grid, and on each finer one. */
  solveSweeps?: number;
  refineSweeps?: number;
  solveTolerance?: number;
  /** How close two lines may be and still both be corrected. */
  apartDeg?: number;
  /** Latitude beyond which nothing is scanned. */
  skipLatDeg?: number;
  maxEdges?: number;
  rounds?: number;
}

export interface FillResult {
  /** What to add to the band, in counts. Zero wherever the deficit is. */
  delta: Float32Array;
  /** Share of the map the removal touches, and how much of the band it takes
   *  where it does. */
  replacedFraction: number;
  replacedMean: number;

  deficit: Float32Array;
  /** The octaves as added, after the level solve. */
  octaves: Octave[];
  refOctaves: Octave[];
  gapOctaves: Octave[];
  /** The fine-band ratio a fully detailed piece of this map carries. */
  ref: number;
  /** The fine-band energy the reference ground carries, in counts. */
  energyRef: number;
  /** The median ratio over the map. */
  median: number;
  /** What the measured amplitudes had to be scaled by to carry `ref`. */
  level: number;
  /** Mean brightness of the reference ground. */
  refTone: number;
  refFraction: number;
  touchedFraction: number;
  meanDelta: number;
  peakDelta: number;
}

/**
 * Separable box blur, three passes, wrapping in x and clamping in y.
 * `radiusX` may be one radius per row, which is what a window measured in
 * degrees needs on an equirect map.
 */
export function blurMono(
  src: Float32Array, W: number, H: number, radiusX: number | Float32Array, radiusY?: number,
): Float32Array;

/** One radius per row: `basePx` at the equator, widened by 1/cos(lat). */
export function latScaledRadii(H: number, basePx: number, maxScale?: number): Float32Array;

/** Seeded value noise: the same grain every bake. */
export function valueNoise(W: number): {
  plain: (x: number, y: number) => number;
  matched: (octaves: Octave[], seed?: number) => (x: number, y: number) => number;
};

/** A cell size adjusted to tile the map's width exactly. */
export function wrappingCell(W: number, want: number): { cell: number; cols: number };

/** Per-octave amplitude of a band, one list per population. */
export function bandAmplitudes(
  band: Float32Array, W: number, H: number,
  cells: Array<number | { cell: number; cols?: number }>,
  groups: Array<(i: number) => boolean>,
  stride?: number,
): Octave[][];

/** Where the picture stopped carrying detail. */
export function detailDeficit(
  band: Float32Array, W: number, H: number, spec: DeficitSpec, pxPerDeg: number,
  valid?: Uint8Array | null,
): { deficit: Float32Array; energy: Float32Array; ref: number; median: number };

/** Give the coarse parts of a mosaic the grain the sharp parts have. */
export function coverageFill(
  band: Float32Array, W: number, H: number, spec: FillSpec, pxPerDeg: number,
  valid?: Uint8Array | null,
): FillResult;

/** The straight brightness steps in a map, worst first. `only` re-measures
 *  lines found before instead of scanning. */
export function findEdges(
  band: Float32Array, W: number, H: number, spec: EdgeSpec, pxPerDeg: number,
  valid?: Uint8Array | null, only?: Edge[] | null,
): { edges: Edge[]; lowPass: Float32Array; profileOf: (axis: Edge['axis'], at: number) => Float32Array };

/** Close those steps, in place, with a harmonic correction field. */
export function levelEdges(
  band: Float32Array, W: number, H: number, spec: EdgeSpec, pxPerDeg: number,
  valid?: Uint8Array | null,
): {
  edges: Edge[];
  /** Relaxation sweeps across every grid, and what the last one had left. */
  iterations: number;
  residual: number;
  /** How far from the mean the applied correction reaches, in counts. */
  peak: number;
  grid: { cw: number; ch: number } | null;
};
