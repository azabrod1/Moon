/**
 * Renders the Planetarium bottom-bar stats (distance, speed, FPS, progress
 * bar, etc.). Pure DOM consumer of PlanetariumStats — no computation lives
 * here; the caller passes in the numbers from `computeStats` plus the
 * current FPS and sun distance.
 */
import { formatAU, type PlanetariumStats } from '../stats';

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

    this.setText('stat-fps', `${fps}`);
    this.setText('stat-distance', `${formatAU(stats.distanceFromSunAU)} AU`);
    this.setText('stat-light-time', stats.lightTravelTime);
    this.setText('stat-intensity', `${stats.solarIntensityPct.toFixed(1)}%`);
    this.setText(
      'stat-speed',
      `${stats.speedC.toFixed(1)}c / ${Math.round(stats.speedKmS).toLocaleString()} km/s`,
    );
    this.setText(
      'stat-nearest',
      stats.nearestPlanet
        ? `${stats.nearestPlanet.name} ${formatAU(stats.nearestPlanet.distanceAU)}`
        : '--',
    );
    this.setText('stat-temp', `${Math.round(stats.blackbodyTempK)} K`);
    this.setText('stat-traveled', `${formatAU(stats.distanceTraveled)} AU`);
    this.setText('stat-time', stats.timeElapsed);

    if (this.progressEl) {
      const pct = Math.min(100, (distanceFromSunAU / PLUTO_AU) * 100);
      this.progressEl.style.width = `${pct}%`;
    }
  }

  private setText(id: string, text: string): void {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
}
