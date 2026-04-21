/**
 * Settings/menu panel for the Planetarium. Pure DOM show/hide; the
 * pause/resume of ship + time that happens while the panel is open is
 * the caller's job (see PlanetariumMode).
 */
export class PlanetariumMenuPanel {
  private el(): HTMLElement | null {
    return document.getElementById('planetarium-menu-panel');
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

  setVisible(visible: boolean): void {
    this.el()?.classList.toggle('visible', visible);
  }

  isOpen(): boolean {
    return this.el()?.classList.contains('visible') ?? false;
  }
}
