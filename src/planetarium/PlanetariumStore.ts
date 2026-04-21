/**
 * Persistence for the Planetarium runtime state. Auto-saves every 30s and on
 * page hide. Sanitizes on load so old or malformed saves never crash the app;
 * unknown fields fall back to defaults. Writes to localStorage + sessionStorage
 * and mirrors to IndexedDB as a defensive fallback on privacy-mode browsers.
 *
 * Compat: the pre-rename key was `orbital-sim-explore-state`. On first load
 * after an upgrade we migrate it to the new `orbital-sim-planetarium-state` key
 * and delete the old one.
 */
import { debugWarn } from '../shared/debug';

const STORAGE_KEY = 'orbital-sim-planetarium-state';
const LEGACY_STORAGE_KEY = 'orbital-sim-explore-state';
const AUTO_SAVE_INTERVAL = 30_000; // 30 seconds
const FALLBACK_DB_NAME = 'orbital-sim-storage';
const FALLBACK_STORE_NAME = 'state';

export type LandedTarget =
  | { type: 'planet'; name: string }
  | { type: 'moon'; name: string; parentPlanet: string }
  | null;

export interface PlanetariumState {
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
  astroTimeUtcMs: number;    // UTC timestamp driving realistic orbital positions
  astroTimeRate?: number;
  astroTimePaused?: boolean;
  planetScale: number;       // visual scale multiplier for planets
  showShip: boolean;         // show player ship mesh
  showConstellations?: boolean; // show constellation lines overlay
  landedOn?: LandedTarget;   // planet/moon the player is currently landed on
  systemSpeed?: number;      // system speed multiplier (fraction of c)
  systemSlowdown?: boolean;  // whether system slowdown is enabled
  autopilotTarget?: LandedTarget; // destination for fly-to autopilot
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

function sanitizePlanetariumState(raw: unknown): PlanetariumState | null {
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  const defaults = createDefaultPlanetariumState();
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
    // Legacy-save compat: pre-rename the field was `simDate`.
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
    systemSlowdown: typeof record.systemSlowdown === 'boolean' ? record.systemSlowdown : defaults.systemSlowdown,
    autopilotTarget: sanitizeLandedOn(record.autopilotTarget),
  };
}

function parseSavedState(raw: string): PlanetariumState | null {
  try {
    return sanitizePlanetariumState(JSON.parse(raw) as unknown);
  } catch (err) {
    debugWarn('Saved planetarium state JSON parse failed', err);
    return null;
  }
}

export function createDefaultPlanetariumState(): PlanetariumState {
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
    astroTimeUtcMs: Date.now(),
    astroTimeRate: 1,
    astroTimePaused: false,
    planetScale: 1,
    showShip: true,
    showConstellations: false,
    landedOn: null,
    systemSpeed: 0.083,
    systemSlowdown: true,
  };
}

export class PlanetariumStore {
  private intervalId: number | null = null;
  private getState: (() => PlanetariumState) | null = null;
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  hasSavedState(): boolean {
    return (
      this.readWebStorage('local', STORAGE_KEY) !== null ||
      this.readWebStorage('session', STORAGE_KEY) !== null ||
      this.readWebStorage('local', LEGACY_STORAGE_KEY) !== null ||
      this.readWebStorage('session', LEGACY_STORAGE_KEY) !== null
    );
  }

  async loadState(): Promise<PlanetariumState | null> {
    let raw = this.readWebStorage('local', STORAGE_KEY);
    if (!raw) raw = this.readWebStorage('session', STORAGE_KEY);
    if (!raw) raw = await this.readIndexedDb(STORAGE_KEY);

    // Legacy key migration: pre-rename the key was 'orbital-sim-explore-state'.
    // Read once, then delete so we don't keep two copies diverging.
    if (!raw) {
      raw =
        this.readWebStorage('local', LEGACY_STORAGE_KEY) ??
        this.readWebStorage('session', LEGACY_STORAGE_KEY) ??
        (await this.readIndexedDb(LEGACY_STORAGE_KEY));
      if (raw) {
        this.removeLegacyState();
      }
    }

    if (!raw) return null;

    const sanitized = parseSavedState(raw);
    if (sanitized) {
      return sanitized;
    }

    debugWarn('Saved planetarium state failed validation');
    this.clearState();
    return null;
  }

  saveState(state: PlanetariumState): void {
    state.timestamp = Date.now();
    const raw = JSON.stringify(state);
    this.writeWebStorage('local', raw);
    this.writeWebStorage('session', raw);
    void this.writeIndexedDb(raw);
  }

  startAutoSave(getState: () => PlanetariumState): void {
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
    this.removeWebStorage('local', STORAGE_KEY);
    this.removeWebStorage('session', STORAGE_KEY);
    void this.removeIndexedDb(STORAGE_KEY);
    this.removeLegacyState();
  }

  private removeLegacyState(): void {
    this.removeWebStorage('local', LEGACY_STORAGE_KEY);
    this.removeWebStorage('session', LEGACY_STORAGE_KEY);
    void this.removeIndexedDb(LEGACY_STORAGE_KEY);
  }

  private getWebStorage(kind: 'local' | 'session'): Storage | null {
    try {
      return kind === 'local' ? window.localStorage : window.sessionStorage;
    } catch (err) {
      debugWarn(`window.${kind}Storage access failed`, err);
      return null;
    }
  }

  private readWebStorage(kind: 'local' | 'session', key: string): string | null {
    const storage = this.getWebStorage(kind);
    if (!storage) return null;
    try {
      return storage.getItem(key);
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

  private removeWebStorage(kind: 'local' | 'session', key: string): void {
    const storage = this.getWebStorage(kind);
    if (!storage) return;
    try {
      storage.removeItem(key);
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

  private async readIndexedDb(key: string): Promise<string | null> {
    const db = await this.getDb();
    if (!db) return null;

    return await new Promise((resolve) => {
      try {
        const tx = db.transaction(FALLBACK_STORE_NAME, 'readonly');
        const request = tx.objectStore(FALLBACK_STORE_NAME).get(key);
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

  private async removeIndexedDb(key: string): Promise<void> {
    const db = await this.getDb();
    if (!db) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(FALLBACK_STORE_NAME, 'readwrite');
        tx.objectStore(FALLBACK_STORE_NAME).delete(key);
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
