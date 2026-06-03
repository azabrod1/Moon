/**
 * Renders the Planetarium bottom-bar stats (distance, speed, FPS, progress
 * bar, etc.). Pure DOM consumer of PlanetariumStats — no computation lives
 * here; the caller passes in the numbers from `computeStats` plus the
 * current FPS and sun distance.
 */
import { formatAU, type PlanetariumStats } from '../stats';
import { setText } from '../../shared/dom';

const PLUTO_AU = 42;

export class PlanetariumStatsPanel {
  private rootEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;

  bind(): void {
    this.rootEl = document.getElementById('planetarium-bottom-bar');
    this.progressEl = document.getElementById('planetarium-progress-fill');
  }

  render(stats: PlanetariumStats, fps: number, distanceFromSunAU: number): void {
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

    if (this.progressEl) {
      const pct = Math.min(100, (distanceFromSunAU / PLUTO_AU) * 100);
      this.progressEl.style.width = `${pct}%`;
    }
  }
}
