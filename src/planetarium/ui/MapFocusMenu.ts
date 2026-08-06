/**
 * The map's Focus picker: a searchable list of every body the chart's camera
 * will fly to, hanging above the console.
 *
 * Built on the deck's row family (`pk-row`, `pk-dot`, `pk-info`, `pk-tag-here`)
 * with `mfm-*` overrides — the Look-at menu's idiom. The deck's own row DOM and
 * sticky machinery are not extractable; its pure search filter is, and that is
 * what the query runs through, so a search here behaves exactly as a search
 * there does.
 *
 * DOM-thin: the markup lives in index.html, the rows arrive finished from a
 * pure builder, and the highlight/scroll bookkeeping is the only state here.
 */

import { filterDeckRows } from '../deckLogic';
import type { MapFocusRow } from '../map/mapFocusRows';
import { anchorAboveMapConsole } from './MapHUD';

export class MapFocusMenu {
  private rootEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  private wired = false;
  /** Every row built for this open, and the buttons painting them — index for
   *  index, so the filter's answer maps straight onto the DOM. */
  private rows: MapFocusRow[] = [];
  private buttons: HTMLButtonElement[] = [];
  private highlight = -1;

  constructor(private readonly onPick: (name: string) => void) {}

  bind(): void {
    this.rootEl = document.getElementById('map-focus-menu');
    this.listEl = document.getElementById('map-focus-list');
    this.emptyEl = document.getElementById('map-focus-empty');
    this.searchEl = document.getElementById('map-focus-search') as HTMLInputElement | null;
    if (this.wired) return;
    this.wired = true;
    this.searchEl?.addEventListener('input', () => this.applyFilter());
    // The input owns the list keys while it holds focus: the document handler
    // bails on INPUT targets, so each Enter commits exactly once (the deck
    // search's idiom).
    this.searchEl?.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.moveHighlight(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.moveHighlight(-1); }
      if (e.key === 'Enter') { e.preventDefault(); this.commitHighlight(); }
    });
  }

  isOpen(): boolean {
    return !!this.rootEl?.classList.contains('visible');
  }

  /** Rebuild and show. The query starts empty every time: this list is opened
   *  to go somewhere, and the last trip's search says nothing about this one. */
  open(rows: MapFocusRow[]): void {
    this.bind();
    if (!this.rootEl || !this.listEl) return;
    this.rows = rows;
    this.buttons = [];
    this.listEl.textContent = '';
    for (const row of rows) {
      this.listEl.appendChild(this.buildRow(row));
    }
    if (this.searchEl) this.searchEl.value = '';
    this.applyFilter();
    this.rootEl.classList.add('visible');
    anchorAboveMapConsole(this.rootEl);
    this.listEl.scrollTop = 0;
    // The row you are standing on is worth walking in: on the full catalog it
    // sits below the fold, and a pill nobody can see marks nothing.
    this.buttons.find((b) => b.classList.contains('here'))
      ?.scrollIntoView({ block: 'center' });
    // A pointer user types straight into it; a keyboard user arrows from here.
    this.searchEl?.focus();
  }

  /** Re-seat against the console after a viewport change: the console swaps
   *  between a corner grid and a bottom strip at the breakpoint, and an open
   *  popover anchored to the old shape can land on top of the new one. */
  reanchor(): void {
    if (this.isOpen() && this.rootEl) anchorAboveMapConsole(this.rootEl);
  }

  /** Closing blurs the search as well: a picker dismissed by Esc must not leave
   *  the keyboard inside a field the chart's own keys have to reach. */
  close(): void {
    if (!this.isOpen()) return;
    this.rootEl?.classList.remove('visible');
    this.searchEl?.blur();
    this.setHighlight(-1);
  }

  /** A printable key with the list open types into the search, wherever the
   *  keyboard was. The deck's rule, and the reason M and T do not fire their
   *  own actions while this stands open — "Mars" has to be typeable. */
  focusSearch(): void {
    this.searchEl?.focus();
  }

  /** Step the highlight over the rows the filter left visible. Stepping claims
   *  the keyboard for the list: focus moves into the search, so the Enter that
   *  follows commits the highlight rather than re-clicking whatever row button
   *  happened to hold focus when the arrows started. */
  moveHighlight(delta: number): void {
    this.searchEl?.focus();
    const visible = this.buttons
      .map((btn, i) => (btn.style.display === 'none' ? -1 : i))
      .filter((i) => i >= 0);
    if (visible.length === 0) return;
    const at = visible.indexOf(this.highlight);
    const next = at < 0
      ? (delta > 0 ? visible[0] : visible[visible.length - 1])
      : visible[(at + delta + visible.length) % visible.length];
    this.setHighlight(next);
    this.buttons[next]?.scrollIntoView({ block: 'nearest' });
  }

  /** Enter: commit the highlighted row, or the only one a search has left. */
  commitHighlight(): void {
    const visible = this.buttons
      .map((btn, i) => (btn.style.display === 'none' ? -1 : i))
      .filter((i) => i >= 0);
    const index = this.highlight >= 0 && visible.includes(this.highlight)
      ? this.highlight
      : (visible.length === 1 ? visible[0] : -1);
    if (index < 0) return;
    this.onPick(this.rows[index].name);
  }

  private buildRow(row: MapFocusRow): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    // The deck's own two row shapes: a planet is a sticky header its moons
    // scroll beneath, a moon is indented under it.
    btn.className = `pk-row mfm-row ${row.parent ? 'pk-moon' : 'pk-planet'}`;
    const dot = document.createElement('span');
    dot.className = 'pk-dot';
    dot.style.background = `#${row.color.toString(16).padStart(6, '0')}`;
    const info = document.createElement('span');
    info.className = 'pk-info';
    const name = document.createElement('b');
    // Raw catalog names, as the deck's rows carry them: the search matches what
    // the row says.
    name.textContent = row.name;
    info.appendChild(name);
    btn.append(dot, info);
    if (row.here) {
      const pill = document.createElement('span');
      pill.className = 'pk-tag-here';
      // Where you are standing — the deck's word for the same thing.
      pill.textContent = 'here';
      btn.classList.add('here', 'mfm-current');
      btn.appendChild(pill);
    }
    btn.addEventListener('click', () => this.onPick(row.name));
    this.buttons.push(btn);
    return btn;
  }

  private applyFilter(): void {
    const query = this.searchEl?.value ?? '';
    const visible = filterDeckRows(query, this.rows);
    let any = false;
    for (let i = 0; i < this.buttons.length; i++) {
      this.buttons[i].style.display = visible[i] ? '' : 'none';
      if (visible[i]) any = true;
    }
    this.emptyEl?.classList.toggle('visible', !any);
    // A highlight the filter has hidden is not a highlight any more.
    if (this.highlight >= 0 && !visible[this.highlight]) this.setHighlight(-1);
  }

  private setHighlight(index: number): void {
    if (this.highlight >= 0) this.buttons[this.highlight]?.classList.remove('hl');
    this.highlight = index;
    if (index >= 0) this.buttons[index]?.classList.add('hl');
  }
}
