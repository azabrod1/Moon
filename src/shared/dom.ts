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
