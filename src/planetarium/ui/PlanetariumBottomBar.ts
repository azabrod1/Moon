/**
 * Bottom-bar popover toggles (stats + time) for the Planetarium HUD. Each
 * toggle closes the other popover; clicking outside the bottom bar closes
 * both. Clicks inside a popover do not bubble to the outside-click handler.
 */
export class PlanetariumBottomBar {
  private statsPopover = document.getElementById('stats-popover');
  private timePopover = document.getElementById('time-popover');
  private statsChevron = document.getElementById('stats-chevron');
  private timeChevron = document.getElementById('time-chevron');

  bind(): void {
    document.getElementById('bar-stats-toggle')?.addEventListener('click', () => {
      const opening = !this.statsPopover?.classList.contains('visible');
      this.statsPopover?.classList.toggle('visible');
      this.statsChevron?.classList.toggle('expanded');
      if (opening) this.closeTime();
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
      const bottomBar = document.getElementById('planetarium-bottom-bar');
      if (bottomBar && !bottomBar.contains(e.target as Node)) {
        this.closeStats();
        this.closeTime();
      }
    });
  }

  private closeStats(): void {
    this.statsPopover?.classList.remove('visible');
    this.statsChevron?.classList.remove('expanded');
  }

  private closeTime(): void {
    this.timePopover?.classList.remove('visible');
    this.timeChevron?.classList.remove('expanded');
  }
}
