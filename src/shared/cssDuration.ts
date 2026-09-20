/**
 * Read a CSS time back off an element, in milliseconds.
 *
 * A length that belongs to the stylesheet — a veil's fade, a panel's snap —
 * has one writer, and it is the CSS. Code that waits for it reads it here
 * rather than keeping a copy of the number, because two writers of one fact
 * drift the moment either is edited.
 *
 * `getComputedStyle` reports seconds ("0.3s") in every engine that ships
 * today, but the property is a list when several are declared ("0.3s, 0.1s")
 * and the unit is part of the value, so both are handled rather than assumed.
 */

/** Milliseconds from one computed CSS time, or `null` when there is nothing
 *  readable there: an empty string, a keyword, a number with no unit. */
export function parseCssDurationMs(declared: string): number | null {
  const first = declared.split(',')[0]?.trim() ?? '';
  if (first === '') return null;
  const value = Number.parseFloat(first);
  if (!Number.isFinite(value) || value < 0) return null;
  if (first.endsWith('ms')) return value;
  if (first.endsWith('s')) return value * 1000;
  return null; // a unitless number is not a time
}
