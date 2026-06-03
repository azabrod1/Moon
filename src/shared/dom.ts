/**
 * Tiny DOM helpers for the guarded "look up by id, update only if present"
 * pattern that recurs across the UI panels.
 *
 * Intentionally minimal — these cover ONLY the null-tolerant
 * textContent/display case. Sites that non-null-assert
 * (`getElementById(id)!`) or cast to a subtype (`as HTMLInputElement`) keep
 * their own lookup: a helper returning `HTMLElement | null` cannot preserve
 * the `.value`/`.checked` subtype or the throw-on-missing contract.
 */

/** Set an element's text by id; no-op if the element is absent. */
export function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/**
 * Show/hide an element by id; no-op if absent. `display` is the value used for
 * the shown state (defaults to `'block'`) so callers that need `flex`/`grid`
 * stay behaviour-identical.
 */
export function setDisplay(id: string, shown: boolean, display = 'block'): void {
  const el = document.getElementById(id);
  if (el) el.style.display = shown ? display : 'none';
}
