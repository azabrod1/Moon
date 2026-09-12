/**
 * The body picker the tools share: a centered modal (full-screen
 * click-catcher, one-modal-at-a-time — the SurfaceTargetMenu precedent) that
 * lists every catalog body and picks one. Rows reuse the deck's pk-row family
 * (raw catalog names, catalog tints, sticky system headers, search) via
 * groupDeckBodies/filterDeckRows. Each tool parameterises what differs: the
 * element ids it owns in index.html, whether the Sun is offered, how the
 * header reads, and an optional badge per row (the compare studio's role
 * pill, the Look-inside tool's coverage word). Rebuilds on every open and on
 * each keystroke; nothing renders per-frame.
 */
import { groupDeckBodies, filterDeckRows, type DeckRow } from '../deckLogic';
import { cssHexColor } from '../../shared/color';
import { PLANETARIUM_BODIES, SUN_DATA } from '../planets/planetData';
import { MOONS } from '../planets/moonData';

const GROUPS = groupDeckBodies(PLANETARIUM_BODIES, MOONS);
/** Flat row list for the search filter: Sun, every planet, every moon (with parent). */
const ALL_ROWS: DeckRow[] = [
  { name: 'Sun' },
  ...GROUPS.flatMap((group) => [
    { name: group.planet.name } as DeckRow,
    ...group.moons.map((moon) => ({ name: moon.name, parent: group.planet.name }) as DeckRow),
  ]),
];

export interface BodyPickerIds {
  root: string;
  list: string;
  title: string;
  search: string;
  empty: string;
  close: string;
}

export interface BodyPickerOptions {
  ids: BodyPickerIds;
  /** Whether the Sun heads the list (absent from the catalogs, added as its own row). */
  includeSun: boolean;
  /** Paint the header into the title element (cleared first). */
  renderTitle: (title: HTMLElement) => void;
  /** An optional trailing badge for a row, or null for none. */
  rowBadge?: (name: string) => HTMLElement | null;
  onPick: (name: string) => void;
  onClose: () => void;
}

export class BodyPicker {
  private rootEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private wired = false;

  constructor(private readonly options: BodyPickerOptions) {}

  bind(): void {
    const { ids } = this.options;
    this.rootEl = document.getElementById(ids.root);
    this.listEl = document.getElementById(ids.list);
    this.titleEl = document.getElementById(ids.title);
    this.emptyEl = document.getElementById(ids.empty);
    this.searchEl = document.getElementById(ids.search) as HTMLInputElement | null;
    if (this.wired) return;
    this.wired = true;
    document.getElementById(ids.close)?.addEventListener('click', () => this.close());
    this.rootEl?.addEventListener('click', (event) => {
      if (event.target === this.rootEl) this.close();
    });
    this.searchEl?.addEventListener('input', () => this.rebuild());
  }

  open(): void {
    if (!this.rootEl) return;
    if (this.searchEl) this.searchEl.value = '';
    this.rebuild();
    this.rootEl.classList.add('visible');
    // Focus the search on desktop (a soft keyboard on touch would cover the list).
    if (window.matchMedia('(pointer: fine)').matches) this.searchEl?.focus();
  }

  /** Repaint the rows (and the header) in place, e.g. after a badge's inputs changed. */
  rebuild(): void {
    if (!this.listEl) return;
    if (this.titleEl) {
      this.titleEl.textContent = '';
      this.options.renderTitle(this.titleEl);
    }
    const query = this.searchEl?.value ?? '';
    const visible = filterDeckRows(query, ALL_ROWS);
    const seen = new Map<string, boolean>();
    ALL_ROWS.forEach((row, index) => seen.set(row.name, visible[index]));

    this.listEl.textContent = '';
    let any = false;
    if (this.options.includeSun && seen.get('Sun')) {
      this.listEl.append(this.makeRow('Sun', SUN_DATA.color, false, false));
      any = true;
    }
    for (const group of GROUPS) {
      if (!seen.get(group.planet.name)) {
        // Planet hidden, but a matching moon could still show — check the moons.
        const anyMoon = group.moons.some((moon) => seen.get(moon.name));
        if (!anyMoon) continue;
      }
      if (seen.get(group.planet.name)) {
        this.listEl.append(this.makeRow(group.planet.name, group.planet.color, true, false));
        any = true;
      }
      for (const moon of group.moons) {
        if (!seen.get(moon.name)) continue;
        this.listEl.append(this.makeRow(moon.name, moon.color, false, true));
        any = true;
      }
    }
    if (this.emptyEl) this.emptyEl.style.display = any ? 'none' : 'block';
    this.listEl.scrollTop = 0;
  }

  private makeRow(name: string, color: number, isPlanet: boolean, isMoon: boolean): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pk-row' + (isPlanet ? ' pk-planet' : '') + (isMoon ? ' pk-moon' : '');
    const dot = document.createElement('span');
    dot.className = 'pk-dot';
    dot.style.background = cssHexColor(color);
    const info = document.createElement('span');
    info.className = 'pk-info';
    const label = document.createElement('b');
    label.textContent = name; // raw catalog name (deck parity for search)
    info.append(label);
    row.append(dot, info);
    const badge = this.options.rowBadge?.(name) ?? null;
    if (badge) row.append(badge);
    row.addEventListener('click', () => this.options.onPick(name));
    return row;
  }

  close(): void {
    if (!this.isOpen()) return;
    this.rootEl?.classList.remove('visible');
    this.options.onClose();
  }

  isOpen(): boolean {
    return this.rootEl?.classList.contains('visible') ?? false;
  }
}
