/**
 * Render-resolution policy: how many device pixels per CSS pixel the app
 * renders at, whether the composer's scene target multisamples and with how
 * many samples, and the ratio the bloom chain is sized at.
 *
 * Two different things antialias this app, one per render path:
 * - the direct (no-float) path draws straight into the canvas backbuffer,
 *   which the renderer creates with `antialias: true`;
 * - the composer path draws the scene into an off-screen target. The
 *   backbuffer's multisampling never reaches that target, so it carries its
 *   own sample count (main.ts buildComposer reads composerSamples).
 *
 * Before the composer target multisampled, a desktop pixel-ratio floor of 1.5
 * was doing the antialiasing by supersampling: on a 1× monitor that was
 * 2.25× the pixels through every full-screen pass, while a 2× display
 * rendered native with no antialiasing at all and its density hid the stairs.
 * The floor is gone from the scene; on desktop the sample count takes over
 * below MSAA_BELOW_PIXEL_RATIO. Every other display — desktops from 1.5× up
 * (Windows at 150 % and above, 2× Macs) and every phone — renders at the
 * resolution it did. (Point sprites under 2 device px take their own
 * sub-pixel path, lensShader.ts, which a 1.5× display's smallest stars
 * also enter.)
 *
 * The bloom chain keeps the old floor (bloomPixelRatio): its blur kernels are
 * fixed texel counts, so the chain's size decides the glow's width on
 * screen, and sizing it as before keeps every display's glow exactly what it
 * was, at exactly the cost it was. The no-float direct path on a 1× monitor
 * now renders native with the backbuffer's own multisampling instead of the
 * 1.5× supersample.
 */

/** Desktop cap: a 3× display renders at 2.5 device px per CSS px. */
export const MAX_TARGET_PIXEL_RATIO_DESKTOP = 2.5;
/** Mobile cap: phones at 2.6–3× render at 2 device px per CSS px. */
export const MAX_TARGET_PIXEL_RATIO_MOBILE = 2;
/**
 * Target ratios below this get a multisampled scene target: exactly the
 * displays the old 1.5 floor used to supersample, which now render fewer
 * pixels and pay for the samples out of the saving. From here up a display
 * keeps every pixel it had, so the samples would be pure extra cost (four
 * of them measured +75 % GPU time at 1.5× on a 2560×1440 monitor) for a
 * stairs problem density already softens; 2× desktops and phones are
 * untouched.
 */
export const MSAA_BELOW_PIXEL_RATIO = 1.5;
/**
 * Samples on a plain 1× display (a monitor at 100 %) up to 4K. Four: two
 * visibly step a planet's limb where the old supersample blended it (the
 * like-for-like Jupiter capture of 2026-09-04), four are as smooth as it at
 * 1:1, and the textures behind them stay native-sharp instead of shrunk. On
 * a 2560×1440 1× monitor four samples cost 2.44 ms of GPU against the
 * supersample's 2.1–2.7 (two: 1.91). The supersample and the samples both
 * scale with pixels, so 4K at 100 % keeps about the same saving and about
 * the same memory as before.
 */
export const SCENE_TARGET_SAMPLES = 4;
/**
 * Samples where four are not a clear win. Scaled laptops (1 < ratio < 1.5,
 * Windows at 125 %) render more pixels than a 1× window of the same CSS size
 * and measured a third over the supersample's cost with four (2.88 ms
 * against 2.13 at 1.25×), where two land within a tenth; no integrated
 * laptop GPU has been measured, and two is the cautious side. And 1×
 * displays beyond 4K (5K/6K panels at 100 %) would hold about 1.6 GB of
 * multisampled target with four, the size that has killed a tab; two keep
 * the memory near the old supersample's.
 */
export const SCENE_TARGET_SAMPLES_ECONOMY = 2;
/** Above this target pixel ratio the economy count applies. */
export const ECONOMY_ABOVE_PIXEL_RATIO = 1;
/** Above this many device pixels in the scene target (4K UHD) the economy count applies. */
export const ECONOMY_ABOVE_DEVICE_PIXELS = 3840 * 2160;
/** The renderer's old desktop floor, kept for the bloom chain alone. */
export const BLOOM_MIN_PIXEL_RATIO_DESKTOP = 1.5;
/** Counts the `?msaa=` knob accepts (0 = off). */
export const MSAA_OVERRIDE_COUNTS: readonly number[] = [0, 2, 4, 8];

/** Device pixels per CSS pixel the renderer and composer are sized at. */
export function targetPixelRatio(devicePixelRatio: number, mobile: boolean): number {
  const cap = mobile ? MAX_TARGET_PIXEL_RATIO_MOBILE : MAX_TARGET_PIXEL_RATIO_DESKTOP;
  return Math.min(devicePixelRatio, cap);
}

/**
 * Ratio the bloom mip chain is sized at: the renderer's old ratio, floor and
 * caps included, so the chain and the glow it draws are the size they were
 * on every display. Without the floor a 1× monitor's glow would draw twice
 * as wide in CSS pixels as a 2× Mac's; pinning the chain to 2× instead would
 * cost every display below 2× more bloom pixels than it ever paid.
 */
export function bloomPixelRatio(devicePixelRatio: number, mobile: boolean): number {
  const ratio = targetPixelRatio(devicePixelRatio, mobile);
  return mobile ? ratio : Math.max(ratio, BLOOM_MIN_PIXEL_RATIO_DESKTOP);
}

/**
 * The sample count the policy asks for, before the GPU's list is consulted.
 * Mobile follows its old policy exactly (no samples at any density: the
 * phones this app targets are all at the 2 cap anyway, and the rest are the
 * weak GPUs). `devicePixels` is the scene target's width × height in device
 * pixels: the economy count takes over on scaled displays and above 4K.
 */
export function policySamples(pixelRatio: number, mobile: boolean, devicePixels: number): number {
  if (mobile || pixelRatio >= MSAA_BELOW_PIXEL_RATIO) return 0;
  const economy = pixelRatio > ECONOMY_ABOVE_PIXEL_RATIO || devicePixels > ECONOMY_ABOVE_DEVICE_PIXELS;
  return economy ? SCENE_TARGET_SAMPLES_ECONOMY : SCENE_TARGET_SAMPLES;
}

/**
 * Sample count for the composer's scene target. `override` is the `?msaa=`
 * URL knob (parseMsaaOverride): a number forces that count on every display;
 * null follows policySamples. `supported` lists the counts the GPU completed
 * and resolved for a half-float target (gpuCapability.ts): the largest one
 * not above the request wins, failing that the smallest one above it — a
 * driver listing 4 and 8 but not 2 must not fall to no antialiasing at all.
 * An empty list, or a request of 0, means no multisampling.
 */
export function composerSamples(
  pixelRatio: number,
  mobile: boolean,
  devicePixels: number,
  override: number | null,
  supported: readonly number[],
): number {
  const wanted = override ?? policySamples(pixelRatio, mobile, devicePixels);
  if (wanted <= 0) return 0;
  let below = 0;
  let above = Infinity;
  for (const samples of supported) {
    if (samples <= wanted) below = Math.max(below, samples);
    else above = Math.min(above, samples);
  }
  if (below > 0) return below;
  return Number.isFinite(above) ? above : 0;
}

/**
 * The `?msaa=` startup param. `0` turns the scene target's multisampling off
 * on any build: the support kill switch, like `?sectors=0`. `2`/`4`/`8`
 * force that count on every display and are honoured on the dev server only
 * (`dev`): they are the A/B for antialiasing questions, and 4 or 8 on a
 * dense display can exhaust GPU memory, which a production URL must not be
 * able to do. Anything else (absent, empty, another number) means follow the
 * policy.
 */
export function parseMsaaOverride(search: string, dev: boolean): number | null {
  const raw = new URLSearchParams(search).get('msaa');
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!MSAA_OVERRIDE_COUNTS.includes(n)) return null;
  return n === 0 || dev ? n : null;
}
