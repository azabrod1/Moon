/**
 * Renders the Planetarium bottom-bar stats (distance, speed, FPS, etc.). Pure
 * DOM consumer of PlanetariumStats — no computation lives here; the caller
 * passes in the numbers from `computeStats` plus the current FPS.
 */
import { formatAU, type PlanetariumStats } from '../stats';

export class PlanetariumStatsPanel {
  private rootEl: HTMLElement | null = null;
  // This runs every frame: elements are looked up once at bind and each write
  // diffs against the last string, so an unchanged stat costs no DOM touch.
  private readonly cells = new Map<string, { el: HTMLElement; last: string }>();

  bind(): void {
    this.rootEl = document.getElementById('planetarium-bottom-bar');
    this.cells.clear();
    for (const id of [
      'stat-fps', 'stat-distance', 'stat-light-time', 'stat-intensity', 'stat-speed',
      'stat-nearest', 'stat-temp', 'stat-traveled', 'stat-time',
    ]) {
      const el = document.getElementById(id);
      if (el) this.cells.set(id, { el, last: '' });
    }
  }

  private set(id: string, text: string): void {
    const cell = this.cells.get(id);
    if (!cell || cell.last === text) return;
    cell.el.textContent = text;
    cell.last = text;
  }

  render(stats: PlanetariumStats, fps: number): void {
    if (!this.rootEl) return;

    this.set('stat-fps', `${fps}`);
    this.set('stat-distance', `${formatAU(stats.distanceFromSunAU)} AU`);
    this.set('stat-light-time', stats.lightTravelTime);
    this.set('stat-intensity', `${stats.solarIntensityPct.toFixed(1)}%`);
    this.set(
      'stat-speed',
      `${stats.speedC.toFixed(1)}c / ${Math.round(stats.speedKmS).toLocaleString()} km/s`,
    );
    this.set(
      'stat-nearest',
      stats.nearestPlanet
        ? `${stats.nearestPlanet.name} ${formatAU(stats.nearestPlanet.distanceAU)}`
        : '--',
    );
    this.set('stat-temp', `${Math.round(stats.blackbodyTempK)} K`);
    this.set('stat-traveled', `${formatAU(stats.distanceTraveled)} AU`);
    this.set('stat-time', stats.timeElapsed);
  }
}
