/**
 * The Look-at menu: a compact centered card listing the landed sky's
 * pickable targets (Sun / parent planet / moons / the other planets) with
 * their live apparent sizes, or for a planet its brightness. The root
 * element is a full-screen click-catcher — the Observatory panel and the
 * mobile sheet are not clickable behind it, and tapping outside the card
 * closes. Rows rebuild on every open (apparent sizes are live quantities);
 * nothing renders per-frame.
 *
 * The same card also lists where to stand ("Stand at", `openPlaces`), so the
 * two lists share one open state and every path that closes one closes the
 * other. Each open writes its own title and sub-line. The places list can
 * carry a search field: the owner answers each keystroke with the rows to
 * show (names that match, or the coordinates typed), and Enter takes the
 * first.
 */
import {
  formatDiscDeg,
  formatMagnitude,
  surfaceTargetKey,
  type SurfaceTarget,
  type SurfaceTargetChoice,
} from '../surfaceView';
import { cssHexColor } from '../../shared/color';

/** One row of the "Stand at" list. */
export interface SurfacePlaceRow {
  name: string;
  /** Under the name, smaller ("Apollo 11 · night"). */
  note: string;
  /** Right-aligned live reading ("Earth 73° up"). */
  meta: string;
  /** Where the view stands now. */
  current: boolean;
  onPick: () => void;
}

export class SurfaceTargetMenu {
  private rootEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private subEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private searchRowEl: HTMLElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  private shownList: 'targets' | 'places' | null = null;
  /** The open places list's answer to a search; null without a field. */
  private placeSearch: ((text: string) => SurfacePlaceRow[]) | null = null;
  private shownPlaceRows: SurfacePlaceRow[] = [];
  private wired = false;

  /** `onClose` fires on every open→closed transition, whatever triggered it
   *  (×, click-away, or the owner) — the owner restores label visibility
   *  there, so no close path can leave the world labels hidden. */
  constructor(
    private onPick: (target: SurfaceTarget) => void,
    private onClose: () => void,
  ) {}

  bind(): void {
    this.rootEl = document.getElementById('surface-target-menu');
    this.listEl = document.getElementById('surface-target-list');
    this.subEl = document.getElementById('surface-target-sub');
    this.titleEl = document.getElementById('surface-target-title');
    this.searchRowEl = document.getElementById('surface-target-search-row');
    this.searchEl = document.getElementById('surface-target-search') as HTMLInputElement | null;
    if (this.wired) return;
    this.wired = true;
    this.searchEl?.addEventListener('input', () => {
      if (this.placeSearch) this.renderPlaceRows(this.placeSearch(this.searchEl?.value ?? ''));
    });
    this.searchEl?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.shownPlaceRows[0]?.onPick();
    });
    document
      .getElementById('surface-target-menu-close')
      ?.addEventListener('click', () => this.close());
    this.rootEl?.addEventListener('click', (e) => {
      if (e.target === this.rootEl) this.close();
    });
  }

  /** Rebuild rows and show. `currentKey` marks the target already in view
   *  (set on in-view opens, null pre-entry). */
  open(choices: SurfaceTargetChoice[], currentKey: string | null, subText: string): void {
    if (!this.rootEl || !this.listEl) return;
    if (this.titleEl) this.titleEl.textContent = 'Look at';
    if (this.subEl) this.subEl.textContent = subText;
    this.setSearch(null);
    this.listEl.textContent = '';
    for (const choice of choices) {
      const row = document.createElement('button');
      const current = currentKey !== null && surfaceTargetKey(choice.target) === currentKey;
      row.className =
        'pk-row stm-row' +
        (choice.resolvable ? '' : ' stm-dim') +
        (current ? ' stm-current' : '');
      const dot = document.createElement('span');
      dot.className = 'pk-dot';
      dot.style.background = cssHexColor(choice.color);
      const info = document.createElement('span');
      info.className = 'pk-info';
      const name = document.createElement('b');
      name.textContent = choice.name;
      info.appendChild(name);
      row.append(dot, info);
      if (current) {
        const pill = document.createElement('span');
        pill.className = 'pk-tag-here';
        // The target you're looking AT, not where you stand — never "here".
        pill.textContent = 'current';
        row.appendChild(pill);
      }
      const meta = document.createElement('span');
      meta.className = 'stm-meta';
      // A planet is a point from here: its brightness says more than its size.
      meta.textContent = choice.magnitude !== null
        ? formatMagnitude(choice.magnitude)
        : `∅ ${formatDiscDeg(choice.discDeg)}°${choice.resolvable ? '' : ' · too small'}`;
      row.appendChild(meta);
      row.addEventListener('click', () => this.onPick(choice.target));
      this.listEl.appendChild(row);
    }
    this.show('targets');
  }

  /** The "Stand at" list: places on the landed body, each picked through
   *  its own row callback. With `search`, a field above the rows asks the
   *  owner for the rows to show as the text changes. */
  openPlaces(rows: SurfacePlaceRow[], subText: string, search?: (text: string) => SurfacePlaceRow[]): void {
    if (!this.rootEl || !this.listEl) return;
    if (this.titleEl) this.titleEl.textContent = 'Stand at';
    if (this.subEl) this.subEl.textContent = subText;
    this.setSearch(search ?? null);
    this.renderPlaceRows(rows);
    this.show('places');
  }

  private setSearch(search: ((text: string) => SurfacePlaceRow[]) | null): void {
    this.placeSearch = search;
    if (this.searchRowEl) this.searchRowEl.style.display = search ? '' : 'none';
    if (this.searchEl) this.searchEl.value = '';
  }

  private renderPlaceRows(rows: SurfacePlaceRow[]): void {
    if (!this.listEl) return;
    this.shownPlaceRows = rows;
    this.listEl.textContent = '';
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'stm-empty';
      empty.textContent = 'No place by that name. Coordinates look like 2 S 80 W.';
      this.listEl.appendChild(empty);
      return;
    }
    for (const place of rows) {
      const row = document.createElement('button');
      row.className = 'pk-row stm-row' + (place.current ? ' stm-current' : '');
      const info = document.createElement('span');
      info.className = 'pk-info';
      const name = document.createElement('b');
      name.textContent = place.name;
      const note = document.createElement('small');
      note.textContent = place.note;
      info.append(name, note);
      row.appendChild(info);
      if (place.current) {
        const pill = document.createElement('span');
        pill.className = 'pk-tag-here';
        pill.textContent = 'here';
        row.appendChild(pill);
      }
      const meta = document.createElement('span');
      meta.className = 'stm-meta';
      meta.textContent = place.meta;
      row.appendChild(meta);
      row.addEventListener('click', () => place.onPick());
      this.listEl.appendChild(row);
    }
  }

  private show(list: 'targets' | 'places'): void {
    this.shownList = list;
    this.rootEl?.classList.add('visible');
    if (this.listEl) this.listEl.scrollTop = 0;
  }

  close(): void {
    if (!this.isOpen()) return;
    this.rootEl?.classList.remove('visible');
    this.shownList = null;
    this.placeSearch = null;
    this.shownPlaceRows = [];
    this.searchEl?.blur();
    this.onClose();
  }

  isOpen(): boolean {
    return this.rootEl?.classList.contains('visible') ?? false;
  }

  /** Which list the open card shows; null when closed. */
  openList(): 'targets' | 'places' | null {
    return this.isOpen() ? this.shownList : null;
  }
}
