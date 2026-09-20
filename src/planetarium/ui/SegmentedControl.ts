/**
 * Wiring for a segmented control: a row of choices in one track, exactly one
 * of them checked.
 *
 * It RENDERS nothing. The segments are static markup in index.html, in the
 * app's own radiogroup idiom (the map's scale, the teleport strip, Look
 * inside's views), so the panel's shape is readable in the HTML and the id
 * audit can pin it. This module only connects the markup to a caller: a click
 * or an arrow key comes back as one `onPick(value)`, and the caller pushes
 * the checked state back with `setSegmentValue`.
 *
 * Every segment is tabbable, like the app's other radiogroups. A roving
 * tabindex is the stricter ARIA pattern, but it would make these two groups
 * behave unlike the five already on screen, and nothing here is long enough
 * for the extra Tab stops to be a burden.
 *
 * A segment for a choice this display does not offer is hidden rather than
 * disabled: a choice that would change nothing is not a choice, and a greyed
 * button invites a press that does nothing.
 */

import { stepChoice } from '../../app/graphicsMenu';

/** Every segment in the group, offered or not, in markup order. */
function segments(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="radio"]')];
}

/** The value a segment stands for. */
function valueOf(segment: HTMLElement | null | undefined): string {
  return segment?.dataset.value ?? '';
}

/**
 * Connect a group's clicks and arrow keys to one handler.
 *
 * Arrow keys move the check, which is what a radiogroup does — focus and
 * selection travel together. They are swallowed on the way out: the arrows
 * are the ship's yaw and pitch keys, and the window handler that reads them
 * adds whatever it hears to the held-key set, which would resume as steering
 * the moment the menu closes.
 */
export function wireSegmented(root: HTMLElement | null, onPick: (value: string) => void): void {
  if (!root) return;
  root.addEventListener('click', (event) => {
    const segment = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="radio"]');
    if (!segment || segment.hidden) return;
    onPick(valueOf(segment));
  });
  root.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
        : 0;
    if (step === 0 && event.key !== 'Home' && event.key !== 'End') return;
    const offered = segments(root).filter((segment) => !segment.hidden);
    if (offered.length === 0) return;
    const values = offered.map(valueOf);
    const from = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="radio"]');
    const next = event.key === 'Home' ? values[0]
      : event.key === 'End' ? values[values.length - 1]
        : stepChoice(values, valueOf(from), step);
    event.preventDefault();
    event.stopPropagation();
    offered[values.indexOf(next)]?.focus();
    onPick(next);
  });
}

/** Check one segment and uncheck the rest. A value no segment carries leaves
 *  the group with nothing checked, which is the honest picture of a level
 *  this display does not offer arriving from the URL. */
export function setSegmentValue(root: HTMLElement | null, value: string): void {
  if (!root) return;
  for (const segment of segments(root)) {
    const on = valueOf(segment) === value;
    segment.classList.toggle('on', on);
    segment.setAttribute('aria-checked', on ? 'true' : 'false');
  }
}

/** Show the segments this display offers and hide the rest. */
export function setSegmentOffered(root: HTMLElement | null, offered: readonly string[]): void {
  if (!root) return;
  for (const segment of segments(root)) segment.hidden = !offered.includes(valueOf(segment));
}
