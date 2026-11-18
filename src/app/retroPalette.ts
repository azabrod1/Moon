/**
 * The retro look's 256 colours, and the lookup the picture is cut to them by.
 *
 * Spent the way a 1990s game spent a VGA palette: fifteen hand-tuned shading
 * ramps of sixteen steps for the picture (greys, steel, the blues of sea and
 * sky, greens, sand, ochre, rust, reds, violets — what the planets are made
 * of), black, and fifteen slots kept for the interface so its yellow, green,
 * navy and banded blues are exact rather than the nearest picture colour.
 * RETRO_INTERFACE_COLOURS are the same values index.html's retro block uses.
 *
 * Each ramp is a line of constant hue in OKLab from dark to light, its chroma
 * eased off at both ends (dark and light colours cannot be very colourful) and
 * pulled into the sRGB gamut, which is what a palette artist did by eye. The
 * numbers were tuned on frames of the app in the mock (planning/, not
 * committed) and are pinned by retroPalette.test.ts.
 *
 * The lookup maps every colour at 5 bits a channel to its nearest palette
 * colour in OKLab, so the shader cuts a pixel with one fetch
 * (app/RetroPresentPass.ts). 32 768 entries against 256 colours is about eight
 * million distance tests: built once, the first time the look is turned on,
 * in a few tens of milliseconds.
 */

/** sRGB in 0..255. */
export type Rgb = readonly [number, number, number];

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}
function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

/** sRGB in 0..1 to OKLab (Ottosson 2020). */
export function srgbToOklab(red: number, green: number, blue: number): [number, number, number] {
  const r = srgbToLinear(red), g = srgbToLinear(green), b = srgbToLinear(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** OKLab to sRGB in 0..1, unclamped, so a caller can tell an out-of-gamut colour. */
export function oklabToSrgb(lightness: number, labA: number, labB: number): [number, number, number] {
  const l = Math.pow(lightness + 0.3963377774 * labA + 0.2158037573 * labB, 3);
  const m = Math.pow(lightness - 0.1055613458 * labA - 0.0638541728 * labB, 3);
  const s = Math.pow(lightness - 0.0894841775 * labA - 1.2914855480 * labB, 3);
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

function inGamut(colour: readonly number[]): boolean {
  return colour.every((channel) => channel >= -0.0005 && channel <= 1.0005);
}

/** One ramp: hue in degrees, peak chroma, steps, darkest and lightest OKLab lightness. */
export type RampSpec = readonly [hueDegrees: number, peakChroma: number, steps: number, lightFrom: number, lightTo: number];

/** The fifteen picture ramps, sixteen steps each. */
export const RETRO_RAMPS: readonly RampSpec[] = [
  [260, 0.006, 16, 0.12, 1.0], // greys up to white
  [255, 0.03, 16, 0.14, 0.95], // steel
  [263, 0.16, 16, 0.14, 0.85], // deep blue: oceans, the air's limb
  [245, 0.11, 16, 0.2, 0.92], // sky blue
  [205, 0.09, 16, 0.2, 0.92], // cyan
  [150, 0.13, 16, 0.18, 0.88], // green: land
  [120, 0.08, 16, 0.2, 0.88], // olive: dry land
  [98, 0.13, 16, 0.3, 0.98], // yellow: the Sun
  [82, 0.07, 16, 0.18, 0.95], // sand: Saturn, Jupiter's zones, the Moon's tint
  [68, 0.12, 16, 0.18, 0.9], // ochre: Jupiter's belts
  [50, 0.13, 16, 0.16, 0.88], // rust: Mars
  [30, 0.17, 16, 0.16, 0.8], // red
  [350, 0.12, 16, 0.2, 0.85], // rose
  [300, 0.1, 16, 0.16, 0.85], // violet
  [280, 0.14, 16, 0.14, 0.8], // indigo
];

/** The fifteen slots kept for the interface; with black, sixteen. */
export const RETRO_INTERFACE_COLOURS: readonly string[] = [
  '#ffdd22', '#44ff44', '#117711', '#001177', '#111188', '#111199', '#2233bb', '#2244cc',
  '#4466dd', '#6688ee', '#221166', '#442288', '#6633aa', '#7744bb', '#ffffff',
];

export function hexToRgb(hex: string): Rgb {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** A ramp of one hue from dark to light. */
export function hueRamp([hueDegrees, peakChroma, steps, lightFrom, lightTo]: RampSpec): Rgb[] {
  const colours: Rgb[] = [];
  const hue = (hueDegrees * Math.PI) / 180;
  for (let step = 0; step < steps; step++) {
    const fraction = steps === 1 ? 0.5 : step / (steps - 1);
    const lightness = lightFrom + (lightTo - lightFrom) * fraction;
    let chroma = peakChroma * Math.pow(Math.sin(Math.PI * Math.min(0.98, Math.max(0.04, lightness))), 0.7);
    let colour = oklabToSrgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue));
    while (!inGamut(colour) && chroma > 0.001) {
      chroma *= 0.92;
      colour = oklabToSrgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue));
    }
    colours.push(colour.map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255)) as unknown as Rgb);
  }
  return colours;
}

/** All 256: black, the ramps in order, then the interface's slots. */
export function retroPalette(): Rgb[] {
  const colours: Rgb[] = [[0, 0, 0]];
  for (const ramp of RETRO_RAMPS) colours.push(...hueRamp(ramp));
  for (const hex of RETRO_INTERFACE_COLOURS) colours.push(hexToRgb(hex));
  return colours;
}

/** Steps a channel of the lookup has: 5 bits. */
export const RETRO_LOOKUP_STEPS = 32;

/**
 * The nearest-colour lookup as RGBA bytes for a 1024 × 32 texture: the colour
 * at 5-bit (r, g, b) is at x = r + 32·b, y = g. Alpha is 255.
 */
export function retroLookup(palette: readonly Rgb[] = retroPalette()): Uint8Array {
  const steps = RETRO_LOOKUP_STEPS;
  const labs = palette.map(([red, green, blue]) => srgbToOklab(red / 255, green / 255, blue / 255));
  const bytes = new Uint8Array(steps * steps * steps * 4);
  for (let blue = 0; blue < steps; blue++) {
    for (let green = 0; green < steps; green++) {
      for (let red = 0; red < steps; red++) {
        const [lightness, labA, labB] = srgbToOklab(red / (steps - 1), green / (steps - 1), blue / (steps - 1));
        let best = 0;
        let bestDistance = Infinity;
        for (let index = 0; index < labs.length; index++) {
          const deltaL = lightness - labs[index][0];
          const deltaA = labA - labs[index][1];
          const deltaB = labB - labs[index][2];
          const distance = deltaL * deltaL + deltaA * deltaA + deltaB * deltaB;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = index;
          }
        }
        const offset = ((green * steps * steps) + red + steps * blue) * 4;
        bytes[offset] = palette[best][0];
        bytes[offset + 1] = palette[best][1];
        bytes[offset + 2] = palette[best][2];
        bytes[offset + 3] = 255;
      }
    }
  }
  return bytes;
}
