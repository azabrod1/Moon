/**
 * The pills a body-picker row carries when the row is about to open the
 * Look-inside tool: what this app knows about that body's inside, in the one
 * word the registry gives it (interiorRegistry.coverageBadge), lit when the
 * body draws a real model by default and dim when it draws an unresolved
 * whole — so a reader can see, before picking, which worlds have something to
 * show. A caller with something to say about where the reader already is
 * passes a lede pill first: "open now" for the body the tool is showing,
 * "here" for the one the ship is standing on.
 *
 * Two pickers share this: the tool's own "another world" picker, and the
 * planetarium's Tools row, which reaches it through a dynamic import — the
 * registry is every model's text, and the main bundle must not carry it.
 *
 * DOM only, no state: one <span class="pk-tags"> the picker appends to a row.
 */
import { coverageBadge, coverageFor } from '../data/interiorRegistry';

/** The pills for one row: the optional lede, then the coverage word. */
export function coverageTags(bodyId: string, lede: string | null = null): HTMLElement {
  const tags = document.createElement('span');
  tags.className = 'pk-tags';
  if (lede) tags.append(coveragePill(lede, true));
  const coverage = coverageFor(bodyId);
  const drawnByDefault = coverage.state === 'constrained' || coverage.state === 'competing';
  tags.append(coveragePill(coverageBadge(coverage), drawnByDefault));
  return tags;
}

function coveragePill(text: string, lit: boolean): HTMLElement {
  const pill = document.createElement('span');
  pill.className = 'pk-tag-cover' + (lit ? ' on' : '');
  pill.textContent = text;
  return pill;
}
