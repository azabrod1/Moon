/**
 * The output dither: a triangular noise of one least significant bit added
 * at every 8-bit write of the picture, so a slow gradient quantises as grain
 * too fine to see instead of as steps.
 *
 * Where it matters. The frame is drawn in half-float and leaves the chain
 * through 8-bit storage: the finishing pass's write (the canvas, or its own
 * RGBA8 target when the resample follows), EASU's write, RCAS's, and the
 * downsample's on a frame drawn larger than the canvas. A dark
 * sea at a low Sun spans a few dozen 8-bit values across the whole frame,
 * so each value is a band tens of pixels wide, and after the sRGB transfer
 * the steps near black are the widest: the arcs that ring the glint. A dither
 * at the write breaks each step into a dotted edge the eye averages away; it
 * is the same noise a film grain or a camera's sensor would have put there.
 *
 * Why triangular, and why one LSB. Uniform noise of one LSB leaves the error
 * correlated with the signal (the noise floor rises and falls with the
 * fraction being rounded); the sum of two uniforms — a triangular
 * distribution of two LSB peak to peak — is the smallest amplitude at which
 * the rounding error's mean AND variance stop depending on the signal
 * (Lipshitz, Wannamaker and Vanderkooy, 1992). It is the standard choice for
 * audio and for images alike.
 *
 * Why a fixed pattern, not a fresh one per frame. The app holds still: a
 * parked ship, a landed camera, the sky byte-identical with the clock frozen
 * is a contract elsewhere (the no-idle-motion rule). Noise that changed each
 * frame would shimmer over every still surface, and captures of the same
 * pose would never match. So the noise is a function of the pixel's position
 * alone: interleaved gradient noise (Jimenez 2014), a cheap hash whose
 * neighbouring values differ by about a third of the range, so the pattern
 * has no visible structure at one LSB. Two evaluations at positions a few
 * pixels apart make the triangle. The same value goes to all three channels:
 * a grey dither, so no colour noise is added.
 *
 * Only the write that lands on the canvas is dithered, never an intermediate.
 * Every 8-bit write rounds, and a dither at each would make each rounding
 * unbiased — but measured (planning/dither/dither-ab.mjs, 2026-10-07) a
 * dithered intermediate came out of the resample as a visible diagonal
 * hatching (EASU's taps beat against the hash's lattice) with RCAS, whose
 * denoise term is left out (app/fsr1.ts), sharpening single grains to 14
 * LSB and dark pixels to black. Dithered at the end alone, the intermediate's
 * 1 LSB steps arrive under 1 LSB of noise and read as the grain does on the
 * plain chain. Each pass carries its own uDither value and sets it per
 * render from the shared switch: the finishing pass (fused or not) and EASU
 * only when they draw the canvas, RCAS and the downsample always, since each
 * is enabled only as the canvas's writer. So every route has exactly one
 * dithered write (app/UpscalePass.ts lists them).
 *
 * `?dither=0` (any build) turns it off: the adds become exactly zero, so the
 * picture is the one the chain drew before the dither existed, byte for byte.
 * `__moon.setDither(on)` (DEV) flips it live, for an A/B inside one page.
 *
 * Pure: the GLSL text, the switch and the one uniform the passes share.
 */

/** The switch, as the value a pass copies into its own uDither when its write
 *  is the canvas: 1 on, 0 off. Shared so every pass reads it the same frame. */
export const outputDitherUniform = { value: 1 };

/** Jimenez's interleaved gradient noise, in [0, 1): the same constants the
 *  GLSL carries, so a test can hold the shader's noise to this reference. */
export function interleavedGradientNoise(x: number, y: number): number {
  const f = (v: number): number => v - Math.floor(v);
  return f(52.9829189 * f(0.06711056 * x + 0.00583715 * y));
}

/** The second evaluation's offset, in pixels: the triangle's other uniform. */
export const OUTPUT_DITHER_OFFSET: readonly [number, number] = [5, 11];

/** The dither at a pixel, in LSBs: triangular on (-1, 1). */
export function outputDitherLsb(x: number, y: number): number {
  return interleavedGradientNoise(x, y)
    + interleavedGradientNoise(x + OUTPUT_DITHER_OFFSET[0], y + OUTPUT_DITHER_OFFSET[1]) - 1;
}

/**
 * The GLSL every dithered pass carries, GLSL ES 1.00 and 3.00 alike: the
 * uniform, the noise, and the grey offset to add to a display-encoded colour
 * about to be written to 8 bits. No backticks in here: this text is pasted
 * into template strings.
 */
export const OUTPUT_DITHER_GLSL = `uniform float uDither;
// Interleaved gradient noise (Jimenez 2014): a per-pixel hash in [0, 1).
float outputDitherNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
// A triangular dither of one least significant bit, the same in all three
// channels, as a function of the pixel alone (app/outputDither.ts says why).
vec3 outputDither(vec2 fragCoord) {
  float t = outputDitherNoise(fragCoord) + outputDitherNoise(fragCoord + vec2(${OUTPUT_DITHER_OFFSET[0]}.0, ${OUTPUT_DITHER_OFFSET[1]}.0)) - 1.0;
  return vec3(uDither * t * (1.0 / 255.0));
}`;

/** The add itself, for a GLSL ES 1.00 shader that writes gl_FragColor. */
export const OUTPUT_DITHER_ADD = 'gl_FragColor.rgb += outputDither( gl_FragCoord.xy );';

/** Where three's output shader makes its last edit to the colour before the
 *  write: the sRGB transfer. The dither goes after it, inside the same guard,
 *  because the noise has to be added to the display-encoded value. */
const THREE_OUTPUT_TRANSFER = 'gl_FragColor = sRGBTransferOETF( gl_FragColor );';
const THREE_VARYING = 'varying vec2 vUv;';

/**
 * Put the dither into three's output shader text (app/FusedOutputPass.ts):
 * the declarations after the varying, the add after the transfer. A throw
 * rather than a silent no-op if a three release has reformatted the text.
 */
export function ditherOutputText(text: string): string {
  if (!text.includes(THREE_VARYING) || !text.includes(THREE_OUTPUT_TRANSFER)) {
    throw new Error('ditherOutputText: the installed three no longer carries the output shader lines this patches');
  }
  return text
    .replace(THREE_VARYING, `${THREE_VARYING}\n${OUTPUT_DITHER_GLSL}`)
    .replace(THREE_OUTPUT_TRANSFER, `${THREE_OUTPUT_TRANSFER}\n\t\t\t\t${OUTPUT_DITHER_ADD}`);
}

/** Whether a text carries the dither: the uniform, the function and the add. */
export function outputDitherIsWired(text: string): boolean {
  return text.includes('uniform float uDither;')
    && text.includes('vec3 outputDither(vec2 fragCoord)')
    && (text.includes(OUTPUT_DITHER_ADD) || text.includes('outputDither(gl_FragCoord.xy)'));
}

/** The `?dither=0` kill switch, on any build. */
export function parseDitherParam(search: string): boolean {
  return new URLSearchParams(search).get('dither') !== '0';
}

/** Turn the dither on or off, for every pass at once (the shared uniform). */
export function setOutputDither(on: boolean): void {
  outputDitherUniform.value = on ? 1 : 0;
}
