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
