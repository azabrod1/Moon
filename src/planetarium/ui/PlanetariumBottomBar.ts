/**
 * Bottom-bar instrument toggles. The Time popover expands up from the bar; the
 * Stats card docks bottom-right (relocated out of the bar). Opening one closes
 * the other; a click outside both the bar and the card closes both. The Stats
 * card is a single owned surface here — PlanetariumMode arbitrates one-instrument-
 * at-a-time (vs the Observatory panel) through `onStatsToggle` + the public
 * `closeStats()` / `isStatsOpen()` API.
 */
export class PlanetariumBottomBar {
  private statsPopover = document.getElementById('stats-popover');
  private timePopover = document.getElementById('time-popover');
  private statsToggle = document.getElementById('bar-stats-toggle');
  private timeChevron = document.getElementById('time-chevron');

  /** Notified when the Stats card opens (true) or closes (false), so the mode
   *  can enforce one instrument at a time (tuck the Observatory panel). */
  onStatsToggle: ((open: boolean) => void) | null = null;

  bind(): void {
    this.statsToggle?.addEventListener('click', () => this.setStats(!this.isStatsOpen()));
    this.statsToggle?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.setStats(!this.isStatsOpen()); }
    });

    document.getElementById('bar-time-toggle')?.addEventListener('click', () => {
      const opening = !this.timePopover?.classList.contains('visible');
      this.timePopover?.classList.toggle('visible');
      this.timeChevron?.classList.toggle('expanded');
      if (opening) this.closeStats();
    });

    this.timePopover?.addEventListener('click', (e) => e.stopPropagation());
    this.statsPopover?.addEventListener('click', (e) => e.stopPropagation());

    document.addEventListener('click', (e) => {
      const bar = document.getElementById('planetarium-bottom-bar');
      const t = e.target as Node;
      // The Stats card now lives outside the bar, so exclude it explicitly.
      if (bar && !bar.contains(t) && !this.statsPopover?.contains(t)) {
        this.closeStats();
        this.closeTime();
      }
    });
  }

  isStatsOpen(): boolean {
    return !!this.statsPopover?.classList.contains('visible');
  }

  /** Close the Stats card (idempotent). Clears the lit toggle + notifies the mode. */
  closeStats(): void {
    this.setStats(false);
  }

  /** Open/close the card, light the toggle, and announce the change. */
  private setStats(open: boolean): void {
    if (open === this.isStatsOpen()) return;
    this.statsPopover?.classList.toggle('visible', open);
    this.statsToggle?.classList.toggle('on', open);
    this.statsToggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) this.closeTime();
    this.onStatsToggle?.(open);
  }

  private closeTime(): void {
    this.timePopover?.classList.remove('visible');
    this.timeChevron?.classList.remove('expanded');
  }
}
