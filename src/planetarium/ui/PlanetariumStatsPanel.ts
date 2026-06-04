/**
 * Renders the Planetarium bottom-bar stats (distance, speed, FPS, etc.). Pure
 * DOM consumer of PlanetariumStats — no computation lives here; the caller
 * passes in the numbers from `computeStats` plus the current FPS.
 */
import { formatAU, type PlanetariumStats } from '../stats';
import { setText } from '../../shared/dom';

export class PlanetariumStatsPanel {
  private rootEl: HTMLElement | null = null;

  bind(): void {
    this.rootEl = document.getElementById('planetarium-bottom-bar');
  }

  render(stats: PlanetariumStats, fps: number): void {
    if (!this.rootEl) return;

    setText('stat-fps', `${fps}`);
    setText('stat-distance', `${formatAU(stats.distanceFromSunAU)} AU`);
    setText('stat-light-time', stats.lightTravelTime);
    setText('stat-intensity', `${stats.solarIntensityPct.toFixed(1)}%`);
    setText(
      'stat-speed',
      `${stats.speedC.toFixed(1)}c / ${Math.round(stats.speedKmS).toLocaleString()} km/s`,
    );
    setText(
      'stat-nearest',
      stats.nearestPlanet
        ? `${stats.nearestPlanet.name} ${formatAU(stats.nearestPlanet.distanceAU)}`
        : '--',
    );
    setText('stat-temp', `${Math.round(stats.blackbodyTempK)} K`);
    setText('stat-traveled', `${formatAU(stats.distanceTraveled)} AU`);
    setText('stat-time', stats.timeElapsed);
  }
}
