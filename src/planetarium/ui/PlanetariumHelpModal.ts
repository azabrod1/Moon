/**
 * Help overlay for the Planetarium. Pure DOM show/hide; the pause/resume
 * of ship + time that happens while help is open is the caller's job.
 */
export class PlanetariumHelpModal {
  private el(): HTMLElement | null {
    return document.getElementById('planetarium-help');
  }

  show(): void {
    const el = this.el();
    if (!el || el.classList.contains('visible')) return;
    el.classList.add('visible');
  }

  hide(): void {
    const el = this.el();
    if (!el?.classList.contains('visible')) return;
    el.classList.remove('visible');
  }

  isOpen(): boolean {
    return this.el()?.classList.contains('visible') ?? false;
  }
}
