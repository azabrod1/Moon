const STORAGE_KEY = 'orbital-sim-explore-state';
const AUTO_SAVE_INTERVAL = 30_000; // 30 seconds

export interface ExploreState {
  positionAU: { x: number; y: number; z: number };
  headingRad: number;
  speed: number;         // multiplier of default speed
  visitedPlanets: string[];
  distanceTraveled: number;  // AU
  timeElapsed: number;       // seconds
  timestamp: number;
}

export function createDefaultState(): ExploreState {
  return {
    positionAU: { x: 0.05, y: 0, z: 0 }, // just outside the Sun
    headingRad: 0,  // facing outward (+X)
    speed: 1.0,
    visitedPlanets: [],
    distanceTraveled: 0,
    timeElapsed: 0,
    timestamp: Date.now(),
  };
}

export class SaveManager {
  private intervalId: number | null = null;
  private getState: (() => ExploreState) | null = null;

  hasSavedState(): boolean {
    return localStorage.getItem(STORAGE_KEY) !== null;
  }

  loadState(): ExploreState | null {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ExploreState;
    } catch {
      return null;
    }
  }

  saveState(state: ExploreState): void {
    state.timestamp = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
    localStorage.removeItem(STORAGE_KEY);
  }

  private handleUnload = () => {
    if (this.getState) {
      this.saveState(this.getState());
    }
  };
}
