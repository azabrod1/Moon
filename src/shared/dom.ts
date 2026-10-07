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

/** Two probes, one per corner, each SIZED by the two insets that meet there
 *  (width from the side, height from the top or the bottom): the only way a
 *  script can read env(), and a box a ResizeObserver can watch, so a change
 *  to any one inset is a size change on one of them. */
let safeAreaProbes: [HTMLElement, HTMLElement] | null = null;
let lastSafeArea: SafeAreaInsets | null = null;
const safeAreaListeners = new Set<(insets: SafeAreaInsets) => void>();
let safeAreaObserver: ResizeObserver | null = null;

function safeAreaProbeElements(): [HTMLElement, HTMLElement] {
  if (!safeAreaProbes) {
    const probe = (width: string, height: string) => {
      const el = document.createElement('div');
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;'
        + `width:env(safe-area-inset-${width},0px);height:env(safe-area-inset-${height},0px);`;
      document.body.appendChild(el);
      return el;
    };
    safeAreaProbes = [probe('left', 'top'), probe('right', 'bottom')];
  }
  return safeAreaProbes;
}

function readSafeArea(): SafeAreaInsets {
  const [topLeft, bottomRight] = safeAreaProbeElements();
  const px = (value: string) => { const n = parseFloat(value); return Number.isFinite(n) && n > 0 ? n : 0; };
  const a = getComputedStyle(topLeft);
  const b = getComputedStyle(bottomRight);
  return { top: px(a.height), right: px(b.width), bottom: px(b.height), left: px(a.width) };
}

function sameSafeArea(a: SafeAreaInsets, b: SafeAreaInsets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/**
 * The safe-area insets, read off the probes' computed style. The page covers
 * the whole screen (index.html: `viewport-fit=cover`, so on an iPad in full
 * screen or a phone on its side the stars run under the status bar and the
 * notch) and the stylesheet keeps the edge-anchored chrome out of those bars
 * with the same env() values; chrome placed by a script — the corner chart —
 * reads them here so it keeps out of the same bars. Zero on every engine
 * without the values, and zero for an engine that has them but no bar. A
 * computed-style read, so call it on a resize rather than every frame, and
 * subscribe with `onSafeAreaChange` for the changes a resize never carries.
 */
export function safeAreaInsets(): SafeAreaInsets {
  if (typeof document === 'undefined') return { ...NO_SAFE_AREA };
  lastSafeArea = readSafeArea();
  return lastSafeArea;
}

/**
 * Every change to the insets, whether or not the viewport's size moved with
 * it: the bars are the browser's and the system's to change — a full-screen
 * transition, a status bar that hides, a rotation that moves a notch to the
 * other side of a viewport that is the same size either way — and a layout
 * that only re-reads them on a resize would hold the old bars until the next
 * one. The probes are watched by a ResizeObserver (the same mechanism the
 * canvas's box is watched by, main.ts), which fires after the layout that
 * moved them, so the read inside forces none. The listener runs with the new
 * insets, once per change, never for a report that changed nothing (the
 * observer's first report included).
 */
export function onSafeAreaChange(listener: (insets: SafeAreaInsets) => void): void {
  safeAreaListeners.add(listener);
  if (safeAreaObserver || typeof document === 'undefined' || typeof ResizeObserver !== 'function') return;
  if (!lastSafeArea) lastSafeArea = readSafeArea();
  safeAreaObserver = new ResizeObserver(() => {
    const next = readSafeArea();
    if (lastSafeArea && sameSafeArea(next, lastSafeArea)) return;
    lastSafeArea = next;
    for (const listen of safeAreaListeners) listen(next);
  });
  for (const probe of safeAreaProbeElements()) safeAreaObserver.observe(probe);
}
