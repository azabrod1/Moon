/**
 * Tiny DOM helper for the guarded "look up by id, update only if present"
 * pattern used by the UI panels.
 *
 * Intentionally minimal — covers ONLY the null-tolerant textContent case.
 * Sites that non-null-assert (`getElementById(id)!`) or cast to a subtype
 * (`as HTMLInputElement`) keep their own lookup: a helper returning
 * `HTMLElement | null` cannot preserve the `.value`/`.checked` subtype or the
 * throw-on-missing contract.
 */

/** Set an element's text by id; no-op if the element is absent. */
export function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/** THE mobile breakpoint (CSS px) — every layout decision and media query
 *  draws this same line; changing it means changing the CSS too. */
export const MOBILE_BREAKPOINT_PX = 640;

/** Phone-width viewport, measured the way CSS media queries measure it.
 *  Sites that compare `window.innerWidth <= MOBILE_BREAKPOINT_PX` keep that
 *  idiom deliberately (innerWidth includes a desktop scrollbar, so the two
 *  can differ by its width) — use the constant there, this helper where the
 *  decision must agree with the stylesheet exactly. */
let phoneQuery: MediaQueryList | null = null;
export function isPhoneViewport(): boolean {
  // One MediaQueryList for the session: `matches` is live, and building a
  // fresh one was an allocation on every layout measure that asked.
  if (!phoneQuery) phoneQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`);
  return phoneQuery.matches;
}

/** The bars the page is laid out under: the status bar, the home indicator,
 *  a notch or camera cutout — in CSS px, zero wherever the viewport has none. */
export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_SAFE_AREA: Readonly<SafeAreaInsets> = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

let safeAreaProbe: HTMLElement | null = null;

/**
 * The safe-area insets, read the only way a script can: off a probe element
 * whose padding is `env(safe-area-inset-*)`. The page covers the whole screen
 * (index.html: `viewport-fit=cover`, so on an iPad in full screen or a phone
 * on its side the stars run under the status bar and the notch) and the
 * stylesheet keeps the edge-anchored chrome out of those bars with the same
 * env() values; chrome placed from a script — the corner chart — reads them
 * here so it keeps out of the same bars. Zero on every engine without the
 * values, and zero for an engine that has them but no bar. Reads computed
 * style, so call it on a resize rather than every frame.
 */
export function safeAreaInsets(): SafeAreaInsets {
  if (typeof document === 'undefined') return { ...NO_SAFE_AREA };
  if (!safeAreaProbe) {
    safeAreaProbe = document.createElement('div');
    safeAreaProbe.setAttribute('aria-hidden', 'true');
    safeAreaProbe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;'
      + 'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);';
    document.body.appendChild(safeAreaProbe);
  }
  const style = getComputedStyle(safeAreaProbe);
  const px = (value: string) => { const n = parseFloat(value); return Number.isFinite(n) && n > 0 ? n : 0; };
  return { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
}
