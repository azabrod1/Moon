/**
 * Render-resolution policy: how many device pixels per CSS pixel the app
 * renders at, and whether the composer's scene target multisamples.
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
 * The floor is gone; on desktop the sample count takes over below
 * MSAA_BELOW_PIXEL_RATIO. Displays at 2× and above and every phone render
 * the scene exactly as they did. Desktops between 1.5× and 2× (Windows at
 * 150–175 %) never had the floor: they keep their ratio and gain the samples,
 * which is new cost for them, taken for the antialiasing.
 *
 * Two companions of the floor's removal live elsewhere: the bloom chain is
 * pinned to its own ratio (app/bloomConfig.ts BLOOM_PIXEL_RATIO) so the glow
 * no longer narrows with density, and the no-float direct path on a 1×
 * monitor now renders native with the backbuffer's own multisampling
 * instead of the 1.5× supersample.
 */

/** Desktop cap: a 3× display renders at 2.5 device px per CSS px. */
export const MAX_TARGET_PIXEL_RATIO_DESKTOP = 2.5;
/** Mobile cap: phones at 2.6–3× render at 2 device px per CSS px. */
export const MAX_TARGET_PIXEL_RATIO_MOBILE = 2;
/**
 * Target ratios below this get a multisampled scene target; from here up the
 * display is dense enough that multisampling would add cost and change
 * nothing worth seeing. Phones (capped at 2) and 2× desktops are untouched.
 */
export const MSAA_BELOW_PIXEL_RATIO = 2;
/** Samples requested for the multisampled scene target. */
export const SCENE_TARGET_SAMPLES = 4;
/** Counts the `?msaa=` knob accepts (0 = off). */
export const MSAA_OVERRIDE_COUNTS: readonly number[] = [0, 2, 4, 8];

/** Device pixels per CSS pixel the renderer and composer are sized at. */
export function targetPixelRatio(devicePixelRatio: number, mobile: boolean): number {
  const cap = mobile ? MAX_TARGET_PIXEL_RATIO_MOBILE : MAX_TARGET_PIXEL_RATIO_DESKTOP;
  return Math.min(devicePixelRatio, cap);
}

/**
 * Sample count for the composer's scene target at a given target pixel
 * ratio. Mobile follows its old policy exactly (no samples at any density:
 * the phones this app targets are all at the 2 cap anyway, and the rest are
 * the weak GPUs). `override` is the `?msaa=` URL knob (parseMsaaOverride): a
 * number forces that count on every display; null follows the policy.
 * `supported` lists the counts the GPU completed for a half-float target
 * (gpuCapability.ts); the largest one not above the request wins, and none
 * means no multisampling.
 */
export function composerSamples(
  pixelRatio: number,
  mobile: boolean,
  override: number | null,
  supported: readonly number[],
): number {
  const policy = !mobile && pixelRatio < MSAA_BELOW_PIXEL_RATIO ? SCENE_TARGET_SAMPLES : 0;
  const wanted = override ?? policy;
  let best = 0;
  for (const samples of supported) {
    if (samples <= wanted && samples > best) best = samples;
  }
  return best;
}

/**
 * The `?msaa=` startup param: `0` turns the scene target's multisampling off,
 * `2`/`4`/`8` force that count on every display — the A/B for antialiasing
 * questions on a device, and a diagnostic rather than a setting: 4 or 8 on
 * a dense display can exhaust GPU memory. Anything else (absent, empty,
 * another number) means follow the policy.
 */
export function parseMsaaOverride(search: string): number | null {
  const raw = new URLSearchParams(search).get('msaa');
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return MSAA_OVERRIDE_COUNTS.includes(n) ? n : null;
}
