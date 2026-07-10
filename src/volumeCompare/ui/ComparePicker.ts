/**
 * The body picker for the volume-compare sentence: a centered modal (full-screen
 * click-catcher, one-modal-at-a-time — the SurfaceTargetMenu precedent) that
 * opens on a sentence chip and picks a body for that slot. Rows reuse the deck's
 * pk-row family (raw catalog names, catalog tints, sticky system headers,
 * search) via groupDeckBodies/filterDeckRows. The header restates the sentence
 * with the active slot highlighted; the already-committed other body carries a
 * role pill ("container"/"filler"), never HERE — this is not a place.
 *
 * Sun is eligible on both sides (it is absent from the catalogs, so it is added
 * as its own top row). Same-body picks are legal (N = 1.00). Rebuilds on every
 * open + on each keystroke; nothing renders per-frame.
 */
import { groupDeckBodies, filterDeckRows, type DeckRow } from '../../planetarium/deckLogic';
import { PLANETARIUM_BODIES, SUN_DATA } from '../../planetarium/planets/planetData';
import { MOONS } from '../../planetarium/planets/moonData';
import { bodyDisplayName, pluralizeBody } from '../compareLogic';

export type PickerSlot = 'container' | 'filler';

const GROUPS = groupDeckBodies(PLANETARIUM_BODIES, MOONS);
/** Flat row list for the search filter: Sun, every planet, every moon (with parent). */
const ALL_ROWS: DeckRow[] = [
  { name: 'Sun' },
  ...GROUPS.flatMap((g) => [
    { name: g.planet.name } as DeckRow,
    ...g.moons.map((m) => ({ name: m.name, parent: g.planet.name }) as DeckRow),
  ]),
];

export class ComparePicker {
  private rootEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private wired = false;

  private slot: PickerSlot = 'container';
  private container = '';
  private filler = '';

  constructor(
    private onPick: (name: string) => void,
    private onClose: () => void,
  ) {}

  bind(): void {
    this.rootEl = document.getElementById('compare-picker');
    this.listEl = document.getElementById('compare-picker-list');
    this.titleEl = document.getElementById('compare-picker-title');
    this.emptyEl = document.getElementById('compare-picker-empty');
    this.searchEl = document.getElementById('compare-picker-search') as HTMLInputElement | null;
    if (this.wired) return;
    this.wired = true;
    document.getElementById('compare-picker-close')?.addEventListener('click', () => this.close());
    this.rootEl?.addEventListener('click', (e) => {
      if (e.target === this.rootEl) this.close();
    });
    this.searchEl?.addEventListener('input', () => this.rebuild());
  }

  open(slot: PickerSlot, container: string, filler: string): void {
    if (!this.rootEl) return;
    this.slot = slot;
    this.container = container;
    this.filler = filler;
    if (this.searchEl) this.searchEl.value = '';
    this.rebuild();
    this.rootEl.classList.add('visible');
    // Focus the search on desktop (a soft keyboard on touch would cover the list).
    if (window.matchMedia('(pointer: fine)').matches) this.searchEl?.focus();
  }

  private rebuild(): void {
    if (!this.listEl) return;
    // Header: restate the sentence, active slot highlighted.
    if (this.titleEl) {
      this.titleEl.textContent = '';
      const c = document.createElement(this.slot === 'container' ? 'b' : 'span');
      c.textContent = bodyDisplayName(this.container);
      const f = document.createElement(this.slot === 'filler' ? 'b' : 'span');
      f.textContent = pluralizeBody(this.filler);
      this.titleEl.append(document.createTextNode('Fill '), c, document.createTextNode(' with '), f);
    }

    const query = this.searchEl?.value ?? '';
    const visible = filterDeckRows(query, ALL_ROWS);
    const seen = new Map<string, boolean>();
    ALL_ROWS.forEach((row, i) => seen.set(row.name, visible[i]));

    this.listEl.textContent = '';
    let any = false;
    // The already-committed OTHER body wears the role pill.
    const otherName = this.slot === 'container' ? this.filler : this.container;
    const otherRole = this.slot === 'container' ? 'filler' : 'container';

    if (seen.get('Sun')) {
      this.listEl.append(this.makeRow('Sun', SUN_DATA.color, false, otherName, otherRole));
      any = true;
    }
    for (const g of GROUPS) {
      if (!seen.get(g.planet.name)) {
        // Planet hidden, but a matching moon could still show — check the moons.
        const anyMoon = g.moons.some((m) => seen.get(m.name));
        if (!anyMoon) continue;
      }
      if (seen.get(g.planet.name)) {
        this.listEl.append(this.makeRow(g.planet.name, g.planet.color, true, otherName, otherRole));
        any = true;
      }
      for (const m of g.moons) {
        if (!seen.get(m.name)) continue;
        this.listEl.append(this.makeRow(m.name, m.color, false, otherName, otherRole, true));
        any = true;
      }
    }
    if (this.emptyEl) this.emptyEl.style.display = any ? 'none' : 'block';
    this.listEl.scrollTop = 0;
  }

  private makeRow(
    name: string,
    color: number,
    isPlanet: boolean,
    otherName: string,
    otherRole: string,
    isMoon = false,
  ): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pk-row' + (isPlanet ? ' pk-planet' : '') + (isMoon ? ' pk-moon' : '');
    const dot = document.createElement('span');
    dot.className = 'pk-dot';
    dot.style.background = `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
    const info = document.createElement('span');
    info.className = 'pk-info';
    const b = document.createElement('b');
    b.textContent = name; // raw catalog name (deck parity for search)
    info.append(b);
    row.append(dot, info);
    if (name === otherName) {
      const pill = document.createElement('span');
      pill.className = 'pk-tag-role';
      pill.textContent = otherRole;
      row.append(pill);
    }
    row.addEventListener('click', () => this.onPick(name));
    return row;
  }

  close(): void {
    if (!this.isOpen()) return;
    this.rootEl?.classList.remove('visible');
    this.onClose();
  }

  isOpen(): boolean {
    return this.rootEl?.classList.contains('visible') ?? false;
  }
}
