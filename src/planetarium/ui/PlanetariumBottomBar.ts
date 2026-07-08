/**
 * Bottom-bar instrument toggles. The Time panel expands up from the bar off
 * the clock readout; the Stats card docks bottom-right (relocated out of the
 * bar). Opening one closes the other; a click outside both the bar and the
 * card closes both. The Stats card is a single owned surface here —
 * PlanetariumMode arbitrates one-instrument-at-a-time (vs the Observatory
 * panel) through `onStatsToggle` + the public `closeStats()` / `isStatsOpen()`
 * API; `closeTime()` / `isTimeOpen()` give the mode's lifecycle paths
 * (landing, missions, deactivate, Esc) the same handle on the Time panel.
 */
export class PlanetariumBottomBar {
  private statsPopover = document.getElementById('stats-popover');
  private timePanel = document.getElementById('time-panel');
  private timeClock = document.getElementById('time-clock');
  private statsToggle = document.getElementById('bar-stats-toggle');

  /** Notified when the Stats card opens (true) or closes (false), so the mode
   *  can enforce one instrument at a time (tuck the Observatory panel). */
  onStatsToggle: ((open: boolean) => void) | null = null;

  bind(): void {
    this.statsToggle?.addEventListener('click', () => this.setStats(!this.isStatsOpen()));
    this.statsToggle?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.setStats(!this.isStatsOpen()); }
    });

    this.timeClock?.addEventListener('click', () => this.setTime(!this.isTimeOpen()));
    this.timeClock?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        // Stop here or the window-level handler sees Space too (ship thrust).
        e.preventDefault();
        e.stopPropagation();
        this.setTime(!this.isTimeOpen());
      }
    });

    this.timePanel?.addEventListener('click', (e) => e.stopPropagation());
    this.statsPopover?.addEventListener('click', (e) => e.stopPropagation());

    document.addEventListener('click', (e) => {
      const bar = document.getElementById('planetarium-bottom-bar');
      const t = e.target as Node;
      // The Stats card now lives outside the bar, so exclude it explicitly.
      if (bar && !bar.contains(t) && !this.statsPopover?.contains(t)) {
        this.closeStats();
      }
      // The Time panel closes on any click outside its own segment — the
      // neighbouring Space controls count as outside (per the handoff).
      const timeControl = document.getElementById('time-control');
      if (timeControl && !timeControl.contains(t)) {
        this.closeTime();
      }
    });
  }

  isStatsOpen(): boolean {
    return !!this.statsPopover?.classList.contains('visible');
  }

  isTimeOpen(): boolean {
    return !!this.timePanel?.classList.contains('visible');
  }

  /** Close the Stats card (idempotent). Clears the lit toggle + notifies the mode. */
  closeStats(): void {
    this.setStats(false);
  }

  /** Close the Time panel (idempotent). */
  closeTime(): void {
    this.setTime(false);
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

  private setTime(open: boolean): void {
    if (open === this.isTimeOpen()) return;
    this.timePanel?.classList.toggle('visible', open);
    this.timeClock?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) this.closeStats();
  }
}
