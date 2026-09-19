/**
 * What the output path does to a Temperature-mode face between the scale
 * colour the shader writes and the pixel a reader sees, stated once in
 * TypeScript so it can be verified through the real renderer rather than
 * believed (plan F22): the face is emissive at the scale colour times
 * DIAGRAM_EXPOSURE (which keeps the top of the scale under the bloom
 * threshold), the studio's tone curve is Khronos PBR Neutral at exposure 1
 * (src/app/renderProfile.ts), and the canvas is sRGB. So a face pixel is
 *
 *   OETF( neutral( EOTF(swatch) × DIAGRAM_EXPOSURE ) )
 *
 * and diagramFaceHex says what to expect beside a swatch. neutralToneMap and
 * the transfer functions are transcriptions of three's shader chunks
 * (tonemapping_pars_fragment, colorspace_pars_fragment); a version bump that
 * changes either changes this file. tools/interior-sweep.mjs reads a face
 * pixel per region and holds it to this within a tolerance, which is the
 * verification through the actual output path. Pure: no three, no DOM.
 */
import { temperatureScaleColor } from '../temperatureScale';

/** The scale colour's gain on a face: the top stop's luminance lands under the interior bloom threshold. */
export const DIAGRAM_EXPOSURE = 0.88;

/** sRGB electro-optical transfer: an encoded channel 0..1 to linear light. Three's sRGBTransferEOTF. */
export function srgbEotf(channel: number): number {
  return channel <= 0.04045 ? channel * 0.0773993808 : Math.pow(channel * 0.9478672986 + 0.0521327014, 2.4);
}

/** Linear light to the sRGB encoding. Three's sRGBTransferOETF, its exponent included (0.41666, not 1/2.4). */
export function srgbOetf(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : Math.pow(channel, 0.41666) * 1.055 - 0.055;
}

/** Khronos PBR Neutral, as three's NeutralToneMapping: a small black lift
 *  taken off, then a compression of the peak past 0.76 toward white. */
export function neutralToneMap(linear: readonly [number, number, number], exposure = 1): [number, number, number] {
  const startCompression = 0.8 - 0.04;
  const desaturation = 0.15;
  let red = linear[0] * exposure;
  let green = linear[1] * exposure;
  let blue = linear[2] * exposure;
  const darkest = Math.min(red, green, blue);
  const offset = darkest < 0.08 ? darkest - 6.25 * darkest * darkest : 0.04;
  red -= offset;
  green -= offset;
  blue -= offset;
  const peak = Math.max(red, green, blue);
  if (peak < startCompression) return [red, green, blue];
  const d = 1 - startCompression;
  const newPeak = 1 - (d * d) / (peak + d - startCompression);
  const gain = newPeak / peak;
  red *= gain;
  green *= gain;
  blue *= gain;
  const grey = 1 - 1 / (desaturation * (peak - newPeak) + 1);
  return [red + (newPeak - red) * grey, green + (newPeak - green) * grey, blue + (newPeak - blue) * grey];
}

/** An sRGB triple 0..1 to a hex, rounded. */
export function rgbToHex(rgb: readonly [number, number, number]): number {
  const byte = (channel: number) => Math.round(Math.max(0, Math.min(1, channel)) * 255);
  return (byte(rgb[0]) << 16) | (byte(rgb[1]) << 8) | byte(rgb[2]);
}

/** The face pixel a swatch colour (sRGB 0..1) comes out as through the diagram's output path. */
export function diagramFaceRgb(swatch: readonly [number, number, number]): [number, number, number] {
  const mapped = neutralToneMap([srgbEotf(swatch[0]) * DIAGRAM_EXPOSURE, srgbEotf(swatch[1]) * DIAGRAM_EXPOSURE, srgbEotf(swatch[2]) * DIAGRAM_EXPOSURE]);
  return [srgbOetf(mapped[0]), srgbOetf(mapped[1]), srgbOetf(mapped[2])];
}

/** The face pixel at a place on the scale, sRGB hex: what the sweep expects at a region's middle. */
export function diagramFaceHex(t: number): number {
  return rgbToHex(diagramFaceRgb(temperatureScaleColor(t)));
}
