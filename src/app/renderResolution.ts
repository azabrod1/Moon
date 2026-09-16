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
 * The floor is gone from the scene wherever the scene target can multisample;
 * on desktop the sample count takes over below MSAA_BELOW_PIXEL_RATIO. Where
 * it cannot — a GPU that completed no half-float sample count, one on
 * three's render-to-texture path, or `?msaa=0` — the floor stays and such a
 * display renders exactly as it did. Every other display — desktops from
 * 1.5× up (Windows at 150 % and above, 2× Macs) and every phone — renders at
 * the resolution it did. (Point sprites under 2 device px take their own
 * sub-pixel path, lensShader.ts, which a 1.5× display's smallest stars
 * also enter.)
 *
 * The bloom chain keeps the old floor (bloomPixelRatio): its blur kernels are
 * fixed texel counts, so the chain's size decides the glow's width on
 * screen, and sizing it as before keeps every display's glow exactly what it
 * was, at exactly the cost it was. The no-float direct path on a 1× monitor
 * now renders native with the backbuffer's own multisampling instead of the
 * 1.5× supersample.
 *
 * The upscaler (app/UpscalePass.ts) splits one ratio into two. The OUTPUT
 * ratio is targetPixelRatio: the renderer and its canvas, the System Map, the
 * corner chart, the direct path. The SCENE ratio, renderPixelRatio, is what
 * the planetarium's composer is sized at — the scene, the lens, the bloom's
 * source and the tone map all draw at it — and one edge-aware resample (FSR 1
 * EASU, with RCAS after it) carries the frame up to the canvas. A phone's
 * frame at Earth's shell is GPU-bound per pixel, and 1.5 against 2 is 0.5625
 * of them. Everything that sizes a thing in the scene's own framebuffer
 * pixels — star and moon-dot point sizes, the belt's sub-pixel energy, the
 * lens sprites' framebuffer size — reads the scene ratio, which at 1.5 is the
 * configuration a 1.5× desktop display runs; the sector ladder and the
 * close-range density keep the output ratio, so the tiles and the synthesis
 * are the ones chosen for the canvas. Wide-line widths are CSS-sized (three
 * refreshes their resolution from the renderer's CSS viewport, whatever
 * target is bound) and need nothing. upscalePolicy says what a build does
 * unasked; `?upscale=` overrides it on any build.
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
 * a 2560×1440 1× monitor four samples cost 1.87 ms of GPU against the
 * supersample's 2.1–2.7 (two: 1.91); at 3840×2160 4.8 against 7.4. The
 * supersample and the samples both scale with pixels, and the memory of a
 * 4K target with four samples is about the supersample's.
 */
export const SCENE_TARGET_SAMPLES = 4;
/**
 * Samples where four are not a clear win. Scaled laptops (1 < ratio < 1.5,
 * Windows at 125 %) render more pixels than a 1× window of the same CSS size
 * and measured a third over the supersample's cost with four (2.88 ms
 * against 2.13 at 1.25×), where two land within a tenth; no integrated
 * laptop GPU has been measured, and two is the cautious side. And 1×
 * displays beyond 4K (5K/6K panels at 100 %) would hold about a gigabyte
 * of multisampled target with four (more at 6K), the size that has killed
 * a tab; two keep the memory near the old supersample's.
 */
export const SCENE_TARGET_SAMPLES_ECONOMY = 2;
/** Above this target pixel ratio the economy count applies. */
export const ECONOMY_ABOVE_PIXEL_RATIO = 1;
/** Above this many device pixels in the scene target (4K UHD) the economy count applies. */
export const ECONOMY_ABOVE_DEVICE_PIXELS = 3840 * 2160;
/**
 * The renderer's old desktop floor: still the bloom chain's everywhere, and
 * the scene's wherever the scene target cannot multisample.
 */
export const DESKTOP_FLOOR_PIXEL_RATIO = 1.5;
/** Counts the `?msaa=` knob accepts (0 = off). */
export const MSAA_OVERRIDE_COUNTS: readonly number[] = [0, 2, 4, 8];

/**
 * Device pixels per CSS pixel the renderer and composer are sized at.
 * `supersample` keeps the old desktop floor: main.ts passes it where the
 * scene target cannot multisample, so that display supersamples as it did
 * rather than rendering native with no antialiasing at all.
 */
export function targetPixelRatio(devicePixelRatio: number, mobile: boolean, supersample = false): number {
  const cap = mobile ? MAX_TARGET_PIXEL_RATIO_MOBILE : MAX_TARGET_PIXEL_RATIO_DESKTOP;
  const floor = !mobile && supersample ? DESKTOP_FLOOR_PIXEL_RATIO : 0;
  return Math.min(Math.max(devicePixelRatio, floor), cap);
}

/**
 * Ratio the bloom mip chain is sized at: the renderer's old ratio, floor and
 * caps included, so the chain and the glow it draws are the size they were
 * on every display. Without the floor a 1× monitor's glow would draw twice
 * as wide in CSS pixels as a 2× Mac's; pinning the chain to 2× instead would
 * cost every display below 2× more bloom pixels than it ever paid.
 */
export function bloomPixelRatio(devicePixelRatio: number, mobile: boolean): number {
  return targetPixelRatio(devicePixelRatio, mobile, true);
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
 * not above the request wins. Failing that, the smallest one above it — a
 * driver listing 4 and 8 but not 2 must not fall to no antialiasing at all —
 * but only where the bigger count is affordable: never above the full
 * count, and never beyond the 4K budget, where the economy count was chosen
 * for memory and a bigger target is the very allocation it avoids. An empty
 * list, or a request of 0, means no multisampling.
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
  if (!Number.isFinite(above)) return 0;
  const affordable = above <= SCENE_TARGET_SAMPLES && devicePixels <= ECONOMY_ABOVE_DEVICE_PIXELS;
  return affordable ? above : 0;
}

/** The scene ratio the upscale switch uses where nothing names one: 1.5 on a
 *  2× phone is a 1.33 upscale, inside EASU's range with the smallest loss. */
export const UPSCALE_RENDER_PIXEL_RATIO = 1.5;
/** EASU is specified good up to 2× linear; the scene ratio never goes below
 *  the output ratio over this. */
export const MAX_UPSCALE_FACTOR = 2;

/**
 * The ratio the planetarium's scene target is drawn at. `request` is the
 * scene ratio asked for (the URL, the switch, the policy); null, or a request
 * at or above the output ratio, means the upscaler is off and the scene draws
 * at the output ratio as it always did.
 */
export function renderPixelRatio(outputRatio: number, request: number | null): number {
  if (request === null || !(request > 0) || request >= outputRatio) return outputRatio;
  return Math.max(request, outputRatio / MAX_UPSCALE_FACTOR);
}

export type UpscaleFilter = 'easu' | 'bilinear';

/** What a `?upscale=` URL asked for. */
export interface UpscaleRequest {
  /** The scene ratio; null = the upscaler off. */
  renderRatio: number | null;
  /** DEV only: `bilinear` is the control arm — the same lower ratio with no
   *  upscale pass, the finishing pass drawing the smaller buffer straight to
   *  the canvas through a linear filter, which is what a browser's stretch
   *  of a smaller canvas would do. */
  filter?: UpscaleFilter;
  /** DEV only: RCAS in stops below its maximum (0 = sharpest); null = RCAS off. */
  sharpen?: number | null;
}

/**
 * The `?upscale=` startup param: a scene ratio (`?upscale=1.5`), or `0`/`off`
 * for the upscaler off — the kill switch once a policy turns it on — on any
 * build. The dev server also takes `?upscale=1.5,bilinear` (the control arm)
 * and `?sharpen=<stops>|off` (RCAS). Absent or unreadable means follow the
 * policy.
 */
export function parseUpscaleParam(search: string, dev: boolean): UpscaleRequest | null {
  const params = new URLSearchParams(search);
  const raw = params.get('upscale');
  if (raw === null || raw.trim() === '') return null;
  const [first, ...rest] = raw.split(',').map((s) => s.trim().toLowerCase());
  let renderRatio: number | null;
  if (first === 'off' || first === '0') {
    renderRatio = null;
  } else {
    const n = Number(first);
    if (!Number.isFinite(n) || !(n > 0)) return null;
    renderRatio = n;
  }
  const request: UpscaleRequest = { renderRatio };
  if (!dev) return request;
  if (rest.includes('bilinear')) request.filter = 'bilinear';
  const sharpen = params.get('sharpen');
  if (sharpen !== null) {
    const s = sharpen.trim().toLowerCase();
    if (s === 'off') request.sharpen = null;
    else {
      const n = Number(s);
      if (Number.isFinite(n) && n >= 0) request.sharpen = n;
    }
  }
  return request;
}

/**
 * The scene ratio a build uses with no `?upscale=` word: null everywhere.
 * The upscaler is the one change in this file that is meant to be seen, and
 * nothing ships until it has been seen on the phone beside the frame it
 * replaces; turning it on for a class of device is one line here, with its
 * test.
 */
export function upscalePolicy(_mobile: boolean): number | null {
  return null;
}

/** The `?ratio=` pin's bounds: below 0.5 nothing is legible, above 4 a phone's
 *  scene target alone passes 60 MB and the composer's chain multiplies it. */
export const PIXEL_RATIO_PIN_MIN = 0.5;
export const PIXEL_RATIO_PIN_MAX = 4;

/**
 * The `?ratio=` startup param, honoured on the dev server only (`dev`): pins
 * the OUTPUT ratio for the session, caps and floors ignored, so a phone can
 * be shown its full panel (`?ratio=3` on a 3× phone the policy caps at 2)
 * or a 2× Mac a 1× monitor's frame, from an address bar, as two links to
 * compare. The same pin as `__moon.pinRatio`. Absent, unreadable, or outside
 * PIXEL_RATIO_PIN_MIN..MAX means follow the policy.
 */
export function parsePixelRatioPin(search: string, dev: boolean): number | null {
  if (!dev) return null;
  const raw = new URLSearchParams(search).get('ratio');
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < PIXEL_RATIO_PIN_MIN || n > PIXEL_RATIO_PIN_MAX) return null;
  return n;
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
