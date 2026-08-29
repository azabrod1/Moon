/**
 * The cloud deck's own shading terms: the numbers that author how a whole-globe
 * cloud sheet reads, each one paired with the GLSL that uses it so the two
 * cannot drift. The deck is drawn by the same augmented surface material every
 * other body uses (world/surfaceShading), and every term here is switched on by
 * a uniform rather than by a second copy of the shader — one compiled program
 * still serves every surface in the app.
 *
 * COVERAGE IS THE ALPHA. The cloud map is a grey field, not a cut-out mask, and
 * for years the deck drew it at a flat 35 % over the whole globe: clear sky was
 * dimmed by 35 % everywhere and the thickest anvil could never exceed it, which
 * is exactly the wash a frame at orbital altitude reads as. So the deck's alpha
 * is the map's own luminance through an authored curve instead, and its opacity
 * is 1: where the map is dark there is no deck at all and the ground is at full
 * brightness, and where it is bright the deck owns the pixel.
 *
 * The curve is authored against the map's STORED luminance — what the eight-bit
 * file holds — not the linear value the sampler returns, because "clear sky"
 * and "thick cloud" are gradings of the file. On the shipped map (2K, the same
 * product every rung is cut from) the authored pair leaves 25.8 % of the globe
 * fully clear, drives 14.6 % to full opacity, and averages 0.31 over the sphere
 * by area — a third of a step from the flat 0.35 it replaces, so the disc's
 * overall exposure is where it was while its contrast is entirely different.
 *
 * The map's compression noise reaches the alpha through this curve, which is
 * new: the deck's webp is encoded at q60 because it used to draw at 0.35. The
 * curve's slope is 1.9 per unit of stored luminance, so 2/255 of encoder error
 * is 0.015 of alpha — under a quantisation step of the frame it lands in.
 */

/** Stored luminance at and below which there is no cloud at all. */
export const CLOUD_COVERAGE_LOW = 0.08;
/** ...and at which the deck is fully opaque. */
export const CLOUD_COVERAGE_HIGH = 0.6;

/**
 * The transfer the stored luminance is recovered through. The maps are ordinary
 * sRGB images and the sampler hands back linear light; 2.2 is the gamma that
 * inverts that to within a fraction of a code value over the whole range, and
 * it costs one pow against the piecewise curve's compare-and-two-branches.
 */
const STORED_GAMMA = 2.2;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * The deck's alpha at a fragment whose cloud map sampled to this LINEAR
 * luminance: 0 over clear sky, 1 under thick cloud. Mirrored exactly by
 * `cloudCoverage` in CLOUD_COVERAGE_GLSL, which is generated from the same
 * constants.
 */
export function cloudCoverageAlpha(linearLuminance: number): number {
  const stored = Math.pow(Math.max(linearLuminance, 0), 1 / STORED_GAMMA);
  return smoothstep(CLOUD_COVERAGE_LOW, CLOUD_COVERAGE_HIGH, stored);
}

/** The GLSL half of `cloudCoverageAlpha`, for the surface augmentation. */
export const CLOUD_COVERAGE_GLSL = /* glsl */`
// The cloud deck's alpha, from the coverage its own colour map states. The
// sampler returns linear light and the curve is authored on the file's stored
// values, so the transfer is undone first.
float cloudCoverage(float linearLuminance) {
  float stored = pow(max(linearLuminance, 0.0), ${(1 / STORED_GAMMA).toFixed(6)});
  return smoothstep(${CLOUD_COVERAGE_LOW.toFixed(6)}, ${CLOUD_COVERAGE_HIGH.toFixed(6)}, stored);
}
`;

/**
 * How deep the deck's relief reads, as the material's `normalScale`.
 *
 * The height field behind it is the cloud map's own brightness (gen-maps'
 * earth-clouds-normal job), which is a proxy: a bright pixel is thick cloud,
 * and thick cloud is usually tall cloud, but a bright low stratus deck is not a
 * mountain. So the relief is authored SHALLOW. At 1 the banks emboss into
 * ridges the moment the Sun is low, which is the same overstatement the Mars
 * relief was halved for; 0.6 keeps the towers legible at the terminator without
 * turning a marine layer into terrain.
 *
 * It lives on the material rather than in the map so that both rungs of the
 * relief ladder — the boot map and the sharper one an approach earns — arrive
 * at one depth and the swap reads as a sharpen rather than a pop.
 */
export const CLOUD_NORMAL_SCALE = 0.6;

/** Rec.709 luminance weights — the one place the deck's grey is measured. */
export const LUMINANCE_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/** The luminance of a sampled cloud-map colour, in whatever space it is in. */
export function luminance(r: number, g: number, b: number): number {
  return LUMINANCE_WEIGHTS[0] * r + LUMINANCE_WEIGHTS[1] * g + LUMINANCE_WEIGHTS[2] * b;
}

