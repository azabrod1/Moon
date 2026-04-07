import { debugWarn } from '../utils/debug';

const STORAGE_KEY = 'orbital-sim-explore-state';
const AUTO_SAVE_INTERVAL = 30_000; // 30 seconds

export interface ExploreState {
  positionAU: { x: number; y: number; z: number };
  headingRad: number;
  pitchRad?: number;
  speed: number;         // multiplier of default speed
  visitedPlanets: string[];
  distanceTraveled: number;  // AU
  timeElapsed: number;       // seconds
  timestamp: number;
  autopilot: boolean;        // true = auto-steer toward next planet
  layoutMode: string;        // 'aligned' or 'realistic'
  simDate: number;           // timestamp for realistic orbital positions
  astroTimeUtcMs?: number;
  astroTimeRate?: number;
  astroTimePaused?: boolean;
  planetScale: number;       // visual scale multiplier for planets
  showShip: boolean;         // show player ship mesh
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeExploreState(raw: unknown): ExploreState | null {
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  const defaults = createDefaultState();
  const positionRaw = record.positionAU;
  if (!positionRaw || typeof positionRaw !== 'object') return null;

  const positionRecord = positionRaw as Record<string, unknown>;
  const positionAU = {
    x: isFiniteNumber(positionRecord.x) ? positionRecord.x : defaults.positionAU.x,
    y: isFiniteNumber(positionRecord.y) ? positionRecord.y : defaults.positionAU.y,
    z: isFiniteNumber(positionRecord.z) ? positionRecord.z : defaults.positionAU.z,
  };

  return {
    positionAU,
    headingRad: isFiniteNumber(record.headingRad) ? record.headingRad : defaults.headingRad,
    pitchRad: isFiniteNumber(record.pitchRad) ? record.pitchRad : 0,
    speed: isFiniteNumber(record.speed) ? Math.max(0, record.speed) : defaults.speed,
    visitedPlanets: Array.isArray(record.visitedPlanets)
      ? record.visitedPlanets.filter((planet): planet is string => typeof planet === 'string')
      : defaults.visitedPlanets,
    distanceTraveled: isFiniteNumber(record.distanceTraveled) && record.distanceTraveled >= 0
      ? record.distanceTraveled
      : defaults.distanceTraveled,
    timeElapsed: isFiniteNumber(record.timeElapsed) && record.timeElapsed >= 0
      ? record.timeElapsed
      : defaults.timeElapsed,
    timestamp: isFiniteNumber(record.timestamp) ? record.timestamp : defaults.timestamp,
    autopilot: typeof record.autopilot === 'boolean' ? record.autopilot : defaults.autopilot,
    layoutMode: typeof record.layoutMode === 'string' ? record.layoutMode : defaults.layoutMode,
    simDate: isFiniteNumber(record.simDate) ? record.simDate : defaults.simDate,
    astroTimeUtcMs: isFiniteNumber(record.astroTimeUtcMs)
      ? record.astroTimeUtcMs
      : (isFiniteNumber(record.simDate) ? record.simDate : defaults.astroTimeUtcMs),
    astroTimeRate: isFiniteNumber(record.astroTimeRate) ? record.astroTimeRate : defaults.astroTimeRate,
    astroTimePaused: typeof record.astroTimePaused === 'boolean'
      ? record.astroTimePaused
      : defaults.astroTimePaused,
    planetScale: isFiniteNumber(record.planetScale)
      ? Math.min(128, Math.max(1, Math.round(record.planetScale)))
      : defaults.planetScale,
    showShip: typeof record.showShip === 'boolean' ? record.showShip : defaults.showShip,
  };
}

export function createDefaultState(): ExploreState {
  return {
    // Start inside Mercury's orbit, but far enough from the Sun to avoid a blown-out first view.
    positionAU: { x: 0.28, y: 0.015, z: -0.04 },
    headingRad: 0,
    speed: 1.0,
    visitedPlanets: [],
    distanceTraveled: 0,
    timeElapsed: 0,
    timestamp: Date.now(),
    autopilot: true,
    layoutMode: 'realistic',
    simDate: Date.now(),
    astroTimeUtcMs: Date.now(),
    astroTimeRate: 1,
    astroTimePaused: false,
    planetScale: 32,
    showShip: true,
  };
}

export class SaveManager {
  private intervalId: number | null = null;
  private getState: (() => ExploreState) | null = null;

  hasSavedState(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) !== null;
    } catch (err) {
      debugWarn('localStorage getItem failed in hasSavedState', err);
      return false;
    }
  }

  loadState(): ExploreState | null {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      debugWarn('localStorage getItem failed in loadState', err);
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const sanitized = sanitizeExploreState(parsed);
      if (!sanitized) {
        debugWarn('Saved explore state failed validation');
        this.clearState();
        return null;
      }
      return sanitized;
    } catch (err) {
      debugWarn('Saved explore state JSON parse failed', err);
      this.clearState();
      return null;
    }
  }

  saveState(state: ExploreState): void {
    state.timestamp = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      debugWarn('localStorage setItem failed in saveState', err);
    }
  }

  startAutoSave(getState: () => ExploreState): void {
    this.getState = getState;
    this.stopAutoSave();
    this.intervalId = window.setInterval(() => {
      if (this.getState) {
        this.saveState(this.getState());
      }
    }, AUTO_SAVE_INTERVAL);

    // Also save on page unload
    window.addEventListener('beforeunload', this.handleUnload);
  }

  stopAutoSave(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    window.removeEventListener('beforeunload', this.handleUnload);
  }

  clearState(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      debugWarn('localStorage removeItem failed in clearState', err);
    }
  }

  private handleUnload = () => {
    if (this.getState) {
      this.saveState(this.getState());
    }
  };
}
