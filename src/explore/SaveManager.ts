import { debugWarn } from '../utils/debug';

const STORAGE_KEY = 'orbital-sim-explore-state';
const AUTO_SAVE_INTERVAL = 30_000; // 30 seconds
const FALLBACK_DB_NAME = 'orbital-sim-storage';
const FALLBACK_STORE_NAME = 'state';

export type LandedTarget =
  | { type: 'planet'; name: string }
  | { type: 'moon'; name: string; parentPlanet: string }
  | null;

export interface ExploreState {
  positionAU: { x: number; y: number; z: number };
  headingRad: number;
  pitchRad?: number;
  speed: number;         // multiplier of default speed
  moving?: boolean;
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
  showConstellations?: boolean; // show constellation lines overlay
  landedOn?: LandedTarget;   // planet/moon the player is currently landed on
  systemSpeed?: number;      // system speed multiplier (fraction of c)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeLandedOn(raw: unknown): LandedTarget {
  if (!raw || typeof raw !== 'object') return null;
  const lo = raw as Record<string, unknown>;
  if (lo.type === 'planet' && typeof lo.name === 'string') {
    return { type: 'planet', name: lo.name };
  }
  if (lo.type === 'moon' && typeof lo.name === 'string' && typeof lo.parentPlanet === 'string') {
    return { type: 'moon', name: lo.name, parentPlanet: lo.parentPlanet };
  }
  return null;
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
    moving: typeof record.moving === 'boolean' ? record.moving : defaults.moving,
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
    showConstellations: typeof record.showConstellations === 'boolean' ? record.showConstellations : defaults.showConstellations,
    landedOn: sanitizeLandedOn(record.landedOn),
    systemSpeed: isFiniteNumber(record.systemSpeed)
      ? Math.max(0, Math.min(0.4, record.systemSpeed))
      : defaults.systemSpeed,
  };
}

function parseSavedState(raw: string): ExploreState | null {
  try {
    return sanitizeExploreState(JSON.parse(raw) as unknown);
  } catch (err) {
    debugWarn('Saved explore state JSON parse failed', err);
    return null;
  }
}

export function createDefaultState(): ExploreState {
  return {
    // Start inside Mercury's orbit, but far enough from the Sun to avoid a blown-out first view.
    positionAU: { x: 0.28, y: 0.015, z: -0.04 },
    headingRad: 0,
    speed: 1.0,
    moving: true,
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
    planetScale: 1,
    showShip: true,
    showConstellations: false,
    landedOn: null,
    systemSpeed: 0.083,
  };
}

export class SaveManager {
  private intervalId: number | null = null;
  private getState: (() => ExploreState) | null = null;
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  hasSavedState(): boolean {
    return this.readWebStorage('local') !== null || this.readWebStorage('session') !== null;
  }

  async loadState(): Promise<ExploreState | null> {
    let raw = this.readWebStorage('local');
    if (!raw) raw = this.readWebStorage('session');
    if (!raw) raw = await this.readIndexedDb();
    if (!raw) return null;

    const sanitized = parseSavedState(raw);
    if (sanitized) {
      return sanitized;
    }

    debugWarn('Saved explore state failed validation');
    this.clearState();
    return null;
  }

  saveState(state: ExploreState): void {
    state.timestamp = Date.now();
    const raw = JSON.stringify(state);
    this.writeWebStorage('local', raw);
    this.writeWebStorage('session', raw);
    void this.writeIndexedDb(raw);
  }

  startAutoSave(getState: () => ExploreState): void {
    this.getState = getState;
    this.stopAutoSave();
    this.intervalId = window.setInterval(() => {
      if (this.getState) {
        this.saveState(this.getState());
      }
    }, AUTO_SAVE_INTERVAL);

    // Persist immediately so resume works even before the first autosave tick.
    this.saveState(getState());

    // Also save on page unload/hide for better reliability across browsers.
    window.addEventListener('beforeunload', this.handleUnload);
    window.addEventListener('pagehide', this.handleUnload);
  }

  stopAutoSave(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    window.removeEventListener('beforeunload', this.handleUnload);
    window.removeEventListener('pagehide', this.handleUnload);
  }

  clearState(): void {
    this.removeWebStorage('local');
    this.removeWebStorage('session');
    void this.removeIndexedDb();
  }

  private getWebStorage(kind: 'local' | 'session'): Storage | null {
    try {
      return kind === 'local' ? window.localStorage : window.sessionStorage;
    } catch (err) {
      debugWarn(`window.${kind}Storage access failed`, err);
      return null;
    }
  }

  private readWebStorage(kind: 'local' | 'session'): string | null {
    const storage = this.getWebStorage(kind);
    if (!storage) return null;
    try {
      return storage.getItem(STORAGE_KEY);
    } catch (err) {
      debugWarn(`${kind}Storage getItem failed in loadState`, err);
      return null;
    }
  }

  private writeWebStorage(kind: 'local' | 'session', raw: string): void {
    const storage = this.getWebStorage(kind);
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, raw);
    } catch (err) {
      debugWarn(`${kind}Storage setItem failed in saveState`, err);
    }
  }

  private removeWebStorage(kind: 'local' | 'session'): void {
    const storage = this.getWebStorage(kind);
    if (!storage) return;
    try {
      storage.removeItem(STORAGE_KEY);
    } catch (err) {
      debugWarn(`${kind}Storage removeItem failed in clearState`, err);
    }
  }

  private getDb(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === 'undefined') {
      this.dbPromise = Promise.resolve(null);
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(FALLBACK_DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(FALLBACK_STORE_NAME)) {
            db.createObjectStore(FALLBACK_STORE_NAME);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          debugWarn('indexedDB open failed', request.error);
          resolve(null);
        };
      } catch (err) {
        debugWarn('indexedDB open threw', err);
        resolve(null);
      }
    });

    return this.dbPromise;
  }

  private async readIndexedDb(): Promise<string | null> {
    const db = await this.getDb();
    if (!db) return null;

    return await new Promise((resolve) => {
      try {
        const tx = db.transaction(FALLBACK_STORE_NAME, 'readonly');
        const request = tx.objectStore(FALLBACK_STORE_NAME).get(STORAGE_KEY);
        request.onsuccess = () => {
          resolve(typeof request.result === 'string' ? request.result : null);
        };
        request.onerror = () => {
          debugWarn('indexedDB get failed', request.error);
          resolve(null);
        };
      } catch (err) {
        debugWarn('indexedDB get threw', err);
        resolve(null);
      }
    });
  }

  private async writeIndexedDb(raw: string): Promise<void> {
    const db = await this.getDb();
    if (!db) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(FALLBACK_STORE_NAME, 'readwrite');
        tx.objectStore(FALLBACK_STORE_NAME).put(raw, STORAGE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          debugWarn('indexedDB put failed', tx.error);
          resolve();
        };
      } catch (err) {
        debugWarn('indexedDB put threw', err);
        resolve();
      }
    });
  }

  private async removeIndexedDb(): Promise<void> {
    const db = await this.getDb();
    if (!db) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(FALLBACK_STORE_NAME, 'readwrite');
        tx.objectStore(FALLBACK_STORE_NAME).delete(STORAGE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          debugWarn('indexedDB delete failed', tx.error);
          resolve();
        };
      } catch (err) {
        debugWarn('indexedDB delete threw', err);
        resolve();
      }
    });
  }

  private handleUnload = () => {
    if (this.getState) {
      this.saveState(this.getState());
    }
  };
}
