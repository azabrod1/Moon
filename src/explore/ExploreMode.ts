import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  CREATE_SOLAR_SYSTEM_TOTAL_UNITS,
  createSolarSystem,
  type SolarSystemObjects,
  type LayoutMode,
} from './SolarSystem';
import { PlayerShip } from './PlayerShip';
import { PlanetMarkers } from './PlanetMarker';
import { SaveManager, createDefaultState, type ExploreState, type LandedTarget } from './SaveManager';
import { computeStats, formatAU } from './StatsPanel';
import { ALL_BODIES, SUN_DATA, type PlanetData } from './planets/planetData';
import { createMoonMeshes, type MoonMesh } from './PlanetFactory';
import {
  advanceExploreTime,
  computeBodyState,
  formatDateCompact,
  formatTimeRateLabel,
  formatUtcInputValue,
  parseUtcInputValue,
  type ExploreTimeState,
} from './astronomy';
import { BRIGHT_STAR_CATALOG } from './data/brightStars';
import { Constellations } from './Constellations';
import { getMoonsByPlanet } from './planets/moonData';
import {
  HISTORIC_JOURNEYS,
  type HistoricJourney,
  type HistoricMissionId,
  type HistoricMilestone,
} from './historicJourney';

type ScriptedTransfer = {
  elapsed: number;
  duration: number;
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
  startHeading: number;
  endHeading: number;
  startPitch: number;
  endPitch: number;
  endMoving: boolean;
};

export const FIRST_EXPLORE_ACTIVATION_TOTAL_UNITS = CREATE_SOLAR_SYSTEM_TOTAL_UNITS + 1;

export interface ExploreActivationProgress {
  completedUnits: number;
  totalUnits: number;
}

export class ExploreMode {
  private static readonly TIME_RATE_PRESETS = [1, 60, 1200, 3600, 21600, 86400, 604800, 2592000, 31557600];
  private static readonly SHIP_CLEARANCE_AU = (1_737.4 / 149_597_870.7) * 1.5;
  private static readonly UI_REFRESH_INTERVAL_S = 1 / 8;
  private static readonly EARTH_DETAIL_MIN_DISTANCE_AU = 0.03;
  private static readonly EARTH_DETAIL_MIN_ANGULAR_DIAMETER_RAD = 0.003;
  private static readonly MOON_PREWARM_START_DELAY_MS = 1500;
  private static readonly MOON_PREWARM_IDLE_TIMEOUT_MS = 1000;
  private static readonly MOON_PREWARM_FALLBACK_DELAY_MS = 250;
  private static readonly MOON_PREWARM_MIN_IDLE_BUDGET_MS = 8;
  private static readonly MISSION_CONTROL_IDS = [
    'explore-btn-travel',
    'explore-btn-autopilot',
    'explore-speed-up',
    'explore-speed-down',
  ] as const;

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;

  private solarSystem: SolarSystemObjects | null = null;
  private player: PlayerShip;
  private markers: PlanetMarkers | null = null;
  private saveManager: SaveManager;
  private starfield: THREE.Points | null = null;
  private constellations: Constellations | null = null;
  private showConstellations = false;

  // Planet world positions in AU (true positions, not offset)
  private planetWorldPositions = new Map<string, { x: number; y: number; z: number }>();

  // Planet moons: map from planet name to array of moon meshes
  private planetMoons = new Map<string, MoonMesh[]>();

  // Keyboard state
  private keys = new Set<string>();

  // Orbit crossing notifications
  private lastCrossedOrbit: string | null = null;
  private notificationTimeout: number | null = null;
  private uiWired = false;

  // Autopilot: auto-steer toward target
  private autopilot = true;
  private autopilotTarget: NonNullable<LandedTarget> | null = null;

  // Moon world positions in AU (true positions, not offset)
  private moonWorldPositions = new Map<string, { x: number; y: number; z: number }>();

  // Planet layout mode
  private layoutMode: LayoutMode = 'realistic';

  private timeState: ExploreTimeState = {
    currentUtcMs: Date.now(),
    rate: 1,
    paused: false,
  };

  // Planet visual scale multiplier (real scale = 1)
  private planetScale = 1;

  // Dual-speed system: throttle near planets
  private systemSpeedFactor = 1.0; // 1 = open space, 0 = deep in system
  private nearestSystemPlanet: string | null = null;
  private inSystemMode = false;
  private throttleOverride = false; // true = user temporarily disabled system throttle (tap)
  private systemSlowdown = true;   // false = user permanently disabled via settings

  // Show player ship mesh for size comparison
  private showShip = true;

  // Touch and gyro flight state
  private touchYaw = 0;
  private touchPitch = 0;
  private touchThrottle = 0;
  private activeFlightTouchId: number | null = null;
  private gyroEnabled = false;
  private gyroAvailability: 'unknown' | 'granted' | 'denied' | 'unavailable' = 'unknown';
  private gyroBaseline: { yawDeg: number; pitchDeg: number } | null = null;
  private gyroScreenAngle = 0;
  private gyroYaw = 0;
  private gyroPitch = 0;

  // Chase camera state
  private userOrbiting = false;
  private userOrbitTimeout: number | null = null;

  // Landed mode: camera orbits a planet/moon while ship is hidden
  private landedOn: LandedTarget = null;
  private preLandSpeed = 0;
  private preLandAutopilot = false;
  private nearbyLandTarget: NonNullable<LandedTarget> | null = null;
  private travelSelection: NonNullable<LandedTarget> | null = null;
  private travelMenuAutopilotMode = false;

  // Moon labels
  private moonLabels = new Map<string, HTMLDivElement>();
  private moonLabelContainer: HTMLDivElement | null = null;
  private cancelResumePrompt: (() => void) | null = null;

  // Sun label
  private sunLabel: HTMLDivElement | null = null;
  private sunLabelVisible = false;
  private lastSunTransform = '';
  private lastSunDistText = '';

  // FPS tracking (uses wall-clock time, not dt, for accuracy)
  private fpsFrames = 0;
  private fpsLastTime = performance.now();
  private fpsDisplay = 0;

  // UI elements
  private statsEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private notificationEl: HTMLElement | null = null;
  private speedValueEl: HTMLElement | null = null;
  private speedLabelEl: HTMLElement | null = null;
  private speedCenterEl: HTMLElement | null = null;
  private timeValueEl: HTMLElement | null = null;
  private timeRateEl: HTMLElement | null = null;
  private timeInputEl: HTMLInputElement | null = null;
  private lastTimeLabel = '';
  private lastTimeRateLabel = '';

  private lastTimeInputValue = '';
  private uiRefreshAccumulator = ExploreMode.UI_REFRESH_INTERVAL_S;
  private activeVoyagerJourney: HistoricJourney | null = null;
  private voyagerMilestoneIndex = 0;
  private voyagerPanelDismissed = false;
  private scriptedTransfer: ScriptedTransfer | null = null;
  private preMissionState: ExploreState | null = null;
  private preMissionMenuVisible = false;
  private deferredResumePromptState: ExploreState | null = null;
  private _menuPausedShip = false;
  private _menuPausedTime = false;

  private closeMenuPanel() {
    const panel = document.getElementById('explore-menu-panel');
    if (!panel?.classList.contains('visible')) return;
    panel.classList.remove('visible');
    if (this._menuPausedShip) this.player.moving = true;
    if (this._menuPausedTime) this.timeState.paused = false;
    this._menuPausedShip = false;
    this._menuPausedTime = false;
  }

  active = false;
  private useBloom: boolean;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    useBloom = true,
  ) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.useBloom = useBloom;
    this.player = new PlayerShip();
    this.saveManager = new SaveManager();

    // Create controls (will be configured on activate)
    this.controls = new OrbitControls(camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.enabled = false;
    this.controls.minDistance = 0.00001;
    this.controls.maxDistance = 5;

    // Detect when user manually orbits (so chase cam yields temporarily)
    this.controls.addEventListener('start', () => {
      this.userOrbiting = true;
      if (this.userOrbitTimeout !== null) clearTimeout(this.userOrbitTimeout);
    });
    this.controls.addEventListener('end', () => {
      // Resume chase cam after 2s of no interaction
      if (this.userOrbitTimeout !== null) clearTimeout(this.userOrbitTimeout);
      this.userOrbitTimeout = window.setTimeout(() => { this.userOrbiting = false; }, 2000);
    });

    // Key handlers
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleDeviceOrientation = this.handleDeviceOrientation.bind(this);
  }

  hasLoadedSolarSystem(): boolean {
    return this.solarSystem !== null;
  }

  async activate(onProgress?: (progress: ExploreActivationProgress) => void): Promise<void> {
    this.active = true;
    const reportActivationProgress = (completedUnits: number) => {
      onProgress?.({
        completedUnits,
        totalUnits: FIRST_EXPLORE_ACTIVATION_TOTAL_UNITS,
      });
    };

    // Show explore UI
    const exploreUI = document.getElementById('explore-ui');
    if (exploreUI) exploreUI.style.display = 'block';

    // Cache UI element references
    this.statsEl = document.getElementById('explore-bottom-bar');
    this.progressEl = document.getElementById('explore-progress-fill');
    this.notificationEl = document.getElementById('explore-notification');
    this.speedValueEl = document.getElementById('explore-speed-value');
    this.speedLabelEl = document.getElementById('explore-speed-label');
    this.speedCenterEl = document.querySelector('.speed-center') as HTMLElement | null;
    this.timeValueEl = document.getElementById('explore-time-value');
    this.timeRateEl = document.getElementById('explore-time-rate');
    this.timeInputEl = document.getElementById('explore-time-input') as HTMLInputElement;

    const savedState = await this.saveManager.loadState();
    const initialDefaultState = savedState ? null : createDefaultState();
    if (initialDefaultState) {
      // Persist a starter journey immediately so slow mobile loads can still resume.
      this.saveManager.saveState(initialDefaultState);
    }
    const shouldPromptForResume = !this.solarSystem && !!savedState;
    reportActivationProgress(this.solarSystem ? CREATE_SOLAR_SYSTEM_TOTAL_UNITS : 0);

    // Create solar system if not yet created
    if (!this.solarSystem) {
      const initialWorldUtcMs =
        savedState?.astroTimeUtcMs
        ?? savedState?.simDate
        ?? this.timeState.currentUtcMs;
      try {
        this.solarSystem = await createSolarSystem((progress) => {
          reportActivationProgress(progress.completedUnits);
        }, this.useBloom, this.layoutMode, new Date(initialWorldUtcMs));
      } catch (error) {
        this.cancelResumePrompt?.();
        throw error;
      }

      // Add everything to scene
      this.scene.add(this.solarSystem.sun);
      this.scene.add(this.solarSystem.ambientLight);
      this.scene.add(this.solarSystem.asteroidBelt);

      for (const planet of this.solarSystem.planets) {
        this.scene.add(planet.group);
        // Store world positions
        const pos = planet.group.position;
        planet.group.userData.worldPosAU = { x: pos.x, y: pos.y, z: pos.z };
        this.planetWorldPositions.set(planet.data.name, { x: pos.x, y: pos.y, z: pos.z });

        // Create moons for this planet
        const moons = createMoonMeshes(planet.data.name);
        if (moons.length > 0) {
          this.planetMoons.set(planet.data.name, moons);
          for (const m of moons) {
            planet.group.add(m.mesh);
          }
        }

        // Create moon label container if needed
        if (!this.moonLabelContainer) {
          this.moonLabelContainer = document.createElement('div');
          this.moonLabelContainer.id = 'moon-labels';
          this.moonLabelContainer.style.cssText =
            'position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:9;overflow:visible;';
          document.body.appendChild(this.moonLabelContainer);
        }
        // Create HTML labels for each moon
        for (const m of moons) {
          const label = document.createElement('div');
          label.className = 'moon-label';
          label.textContent = m.data.name;
          label.style.display = 'none';
          this.moonLabelContainer.appendChild(label);
          this.moonLabels.set(m.data.name, label);
        }
      }

      for (const orbit of this.solarSystem.orbitLines) {
        this.scene.add(orbit);
      }

      this.scene.add(this.player.group);
      reportActivationProgress(CREATE_SOLAR_SYSTEM_TOTAL_UNITS);
    }

    // Create markers
    if (!this.markers) {
      this.markers = new PlanetMarkers(this.scene, this.camera);
    }

    // Create starfield for explore mode (much larger)
    if (!this.starfield) {
      this.starfield = this.createExploreStarfield();
      this.scene.add(this.starfield);
    }

    if (savedState && shouldPromptForResume) {
      this.restoreState(savedState);
      this.deferredResumePromptState = savedState;
    } else if (savedState) {
      this.restoreState(savedState);
    } else {
      this.restoreState(initialDefaultState ?? createDefaultState());
      this.pointTowardMercury();
      // Auto-engage autopilot toward Mercury for new users
      this.autopilotTarget = { type: 'planet', name: 'Mercury' };
      this.autopilot = true;
      this.updateAutopilotButton();
      this.showIntroText();
    }

    if (this.showConstellations) {
      this.ensureConstellationsReady();
    }

    // Configure camera
    this.controls.enabled = true;
    if (!this.landedOn) {
      this.updateCameraFollow();
    }

    // Start auto-save
    this.saveManager.startAutoSave(() => this.getState());

    // Wire up keyboard
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    if (this.gyroEnabled) {
      window.addEventListener('deviceorientation', this.handleDeviceOrientation);
    }

    // Wire up UI controls (once only)
    if (!this.uiWired) {
      this.wireUpUI();
      this.uiWired = true;
    }

    // Show all solar system objects
    this.setObjectsVisible(true);
    // If landed, the ship should stay hidden
    if (this.landedOn) {
      this.player.group.visible = false;
    }

    // Restore moon labels visibility
    if (this.moonLabelContainer) {
      this.moonLabelContainer.style.display = '';
    }
    this.uiRefreshAccumulator = ExploreMode.UI_REFRESH_INTERVAL_S;
    this.updateMissionControlState();
    reportActivationProgress(FIRST_EXPLORE_ACTIVATION_TOTAL_UNITS);
  }

  private ensureConstellationsReady() {
    if (!this.constellations) {
      this.constellations = new Constellations();
      this.scene.add(this.constellations.lines);
    }
    this.constellations.setVisible(this.showConstellations);
  }

  async showDeferredResumePromptIfNeeded(): Promise<void> {
    const savedState = this.deferredResumePromptState;
    if (!savedState || !this.active) return;

    this.deferredResumePromptState = null;
    const shouldResume = await this.showResumePrompt(savedState);
    if (!this.active || shouldResume) return;

    if (this.landedOn) {
      this.exitLandedMode();
    }
    this.saveManager.clearState();
    this.restoreState(createDefaultState());
    this.pointTowardMercury();
    this.autopilotTarget = { type: 'planet', name: 'Mercury' };
    this.autopilot = true;
    this.updateAutopilotButton();
    this.showIntroText();
  }

  deactivate(): void {
    this.cancelResumePrompt?.();

    // Exit landed mode cleanly before deactivation
    if (this.landedOn) {
      this.exitLandedMode();
    }

    this.active = false;

    // Save before leaving
    this.saveManager.saveState(this.getState());
    this.saveManager.stopAutoSave();

    // Remove keyboard handlers
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('deviceorientation', this.handleDeviceOrientation);
    this.touchYaw = 0;
    this.touchPitch = 0;
    this.touchThrottle = 0;
    this.gyroBaseline = null;
    this.gyroYaw = 0;
    this.gyroPitch = 0;
    this.uiRefreshAccumulator = ExploreMode.UI_REFRESH_INTERVAL_S;

    // Disable controls
    this.controls.enabled = false;

    // Hide explore UI
    const exploreUI = document.getElementById('explore-ui');
    if (exploreUI) exploreUI.style.display = 'none';

    // Hide all solar system objects
    this.setObjectsVisible(false);

    // Clean up markers
    if (this.markers) {
      this.markers.dispose();
      this.markers = null;
    }

    // Hide moon labels
    if (this.moonLabelContainer) {
      this.moonLabelContainer.style.display = 'none';
    }
  }

  private setObjectsVisible(visible: boolean) {
    if (this.solarSystem) {
      this.solarSystem.sun.visible = visible;
      this.solarSystem.asteroidBelt.visible = visible;
      this.solarSystem.ambientLight.visible = visible;
      for (const p of this.solarSystem.planets) p.group.visible = visible;
      for (const o of this.solarSystem.orbitLines) o.visible = visible;
    }
    this.player.group.visible = visible && this.showShip;
    if (this.starfield) this.starfield.visible = visible;
    if (this.constellations) this.constellations.setVisible(visible && this.showConstellations);
  }

  update(dt: number): void {
    if (!this.active || !this.solarSystem) return;

    // Landed mode: camera orbits body, skip flight controls
    if (this.landedOn) {
      this.updateLanded(dt);
      return;
    }

    const isScriptedTransfer = this.updateScriptedTransfer(dt);
    if (!isScriptedTransfer) {
      // Process keyboard input
      this.processInput();

      // Autopilot: steer toward target if no manual input
      if (this.autopilot && this.autopilotTarget && this.player.yawInput === 0 && this.player.pitchInput === 0) {
        this.applyAutopilot();
      }

      // Compute system speed throttle before player update
      const throttleResult = this.computeSystemSpeedFactor();
      this.systemSpeedFactor = throttleResult.factor;
      this.nearestSystemPlanet = throttleResult.planet;
      this.player.systemSpeedFactor = (this.throttleOverride || !this.systemSlowdown) ? 1.0 : this.systemSpeedFactor;

      // Update player
      this.player.update(dt);
    }
    this.timeState = advanceExploreTime(this.timeState, dt);
    this.rebuildPlanetPositions(dt);

    // Apply floating origin: offset everything by player position
    this.applyFloatingOrigin();

    // Update camera follow
    this.updateCameraFollow();
    this.controls.update();

    // FPS tracking (wall-clock, independent of dt capping)
    this.fpsFrames++;
    const fpsNow = performance.now();
    const fpsElapsed = (fpsNow - this.fpsLastTime) / 1000;
    if (fpsElapsed >= 0.5) {
      this.fpsDisplay = Math.round(this.fpsFrames / fpsElapsed);
      this.fpsFrames = 0;
      this.fpsLastTime = fpsNow;
    }

    this.uiRefreshAccumulator += dt;
    const shouldRefreshUi = this.uiRefreshAccumulator >= ExploreMode.UI_REFRESH_INTERVAL_S;
    if (shouldRefreshUi) {
      this.uiRefreshAccumulator %= ExploreMode.UI_REFRESH_INTERVAL_S;
    }

    // Update markers
    if (this.markers) {
      // Pass scene-space positions (already offset)
      const scenePositions = new Map<string, { x: number; y: number; z: number }>();
      for (const planet of this.solarSystem.planets) {
        scenePositions.set(planet.data.name, {
          x: planet.group.position.x,
          y: planet.group.position.y,
          z: planet.group.position.z,
        });
      }
      this.markers.update(scenePositions, { x: 0, y: 0, z: 0 }, this.renderer);
    }

    // Update constellation labels
    if (this.constellations && this.showConstellations) {
      this.constellations.updateLabels(
        this.camera,
        this.renderer.domElement.clientWidth,
        this.renderer.domElement.clientHeight,
      );
    }

    // Update Sun label
    this.updateSunLabel();

    this.updatePlanetScaling();
    this.player.group.scale.setScalar(0.5);
    this.resolvePlanetCollisions();

    // Check orbit crossings and visits after scale/collision are applied so the
    // reachable interaction shell matches the visual shell.
    this.checkOrbitCrossings();
    this.checkPlanetVisits();
    this.checkProximityLand();

    this.updateMoonPositions();
    if (this.autopilotTarget) {
      this.checkAutopilotArrival();
    }
    this.updateSunShader(dt);
    this.updateOrbitLineVisibility();

    // Update stats/time overlays on a lower cadence than the render loop to avoid
    // forcing layout/style work every frame.
    if (shouldRefreshUi) {
      this.updateStatsUI();
      this.updateTimeUI();
      this.updateSpeedSlider();
    }
  }

  private applyFloatingOrigin() {
    if (!this.solarSystem) return;

    const px = this.player.posX;
    const py = this.player.posY;
    const pz = this.player.posZ;

    // Offset Sun
    this.solarSystem.sun.position.set(-px, -py, -pz);

    // Offset planets
    for (const planet of this.solarSystem.planets) {
      const wp = planet.group.userData.worldPosAU as { x: number; y: number; z: number };
      planet.group.position.set(wp.x - px, wp.y - py, wp.z - pz);
    }

    // Offset orbit lines
    for (const orbit of this.solarSystem.orbitLines) {
      orbit.position.set(-px, -py, -pz);
    }

    // Offset asteroid belt
    this.solarSystem.asteroidBelt.position.set(-px, -py, -pz);

    // Player is at origin (or very close)
    this.player.group.position.set(0, 0, 0);

    // Starfield + constellations follow camera (always centered on player)
    if (this.starfield) {
      this.starfield.position.set(0, 0, 0);
    }
    if (this.constellations) {
      this.constellations.lines.position.set(0, 0, 0);
    }
  }

  private updateCameraFollow() {
    // Player is always at scene origin due to floating origin
    this.controls.target.set(0, 0, 0);

    // Chase camera: smoothly lerp behind the ship unless user is orbiting
    if (this.userOrbiting) return;

    const camDist = 0.000094;
    const forward = this.player.getForwardDirection();
    const idealPos = new THREE.Vector3(
      -forward.x * camDist,
      -forward.y * camDist + camDist * 0.35,
      -forward.z * camDist,
    );

    // Smooth follow — faster when actively turning
    const turning = Math.abs(this.player.yawInput) + Math.abs(this.player.pitchInput);
    const lerpSpeed = turning > 0 ? 0.06 : 0.025;
    this.camera.position.lerp(idealPos, lerpSpeed);
  }

  private getMoonAngleRad(moon: MoonMesh['data']): number {
    const moonTimeSeconds = this.timeState.currentUtcMs / 1000;
    const orbitalAngle = (moonTimeSeconds / (moon.orbitalPeriodDays * 86400)) * Math.PI * 2;
    return orbitalAngle + THREE.MathUtils.degToRad(moon.orbitalPhaseDeg);
  }

  private getMoonSystemThresholdAU(planetRadiusAU: number, moons: MoonMesh[]): number {
    let farthestOrbitAU = 0;
    for (const moon of moons) {
      farthestOrbitAU = Math.max(farthestOrbitAU, moon.data.orbitalRadiusAU);
    }

    return Math.max(planetRadiusAU * 120, farthestOrbitAU * 1.15, 0.3);
  }

  private getLandedBodyWorldPosition(): { x: number; y: number; z: number } | null {
    if (!this.landedOn) return null;
    if (this.landedOn.type === 'planet') {
      return this.planetWorldPositions.get(this.landedOn.name) ?? null;
    }
    // Moon: parent position + real orbital offset (unscaled).
    // The player sits at the moon's true AU position. The camera target
    // is adjusted in updateLanded to account for the visual offset caused
    // by planet group scaling.
    const parentPlanet = this.landedOn.parentPlanet;
    const parentPos = this.planetWorldPositions.get(parentPlanet);
    if (!parentPos) return null;
    const moons = this.planetMoons.get(parentPlanet);
    if (!moons) return null;
    const moonMesh = moons.find(m => m.data.name === this.landedOn!.name);
    if (!moonMesh) return null;
    const angle = this.getMoonAngleRad(moonMesh.data);
    const r = moonMesh.data.orbitalRadiusAU;
    return {
      x: parentPos.x + r * Math.cos(angle),
      y: parentPos.y,
      z: parentPos.z + r * Math.sin(angle),
    };
  }

  private getLandedBodyRadiusAU(): number {
    if (!this.landedOn) return 0;
    if (this.landedOn.type === 'planet') {
      const body = ALL_BODIES.find(b => b.name === this.landedOn!.name);
      return body ? body.radiusAU : 0;
    }
    const moons = this.planetMoons.get(this.landedOn.parentPlanet);
    if (!moons) return 0;
    const moonMesh = moons.find(m => m.data.name === this.landedOn!.name);
    return moonMesh ? moonMesh.data.radiusAU : 0;
  }

  private computeSystemSpeedFactor(): { factor: number; planet: string | null } {
    let minFactor = 1.0;
    let nearestPlanet: string | null = null;

    // Check all planets
    for (const body of ALL_BODIES) {
      const wp = this.planetWorldPositions.get(body.name);
      if (!wp) continue;
      const dx = this.player.posX - wp.x;
      const dy = this.player.posY - wp.y;
      const dz = this.player.posZ - wp.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const systemRadius = body.systemRadiusAU;
      if (dist >= systemRadius) continue;

      const inner = systemRadius * 0.05;
      const t = Math.min(1, Math.max(0, (dist - inner) / (systemRadius - inner)));
      const factor = t * t * (3 - 2 * t); // smoothstep
      if (factor < minFactor) {
        minFactor = factor;
        nearestPlanet = body.name;
      }
    }

    // Check Sun (always at origin in world coordinates)
    {
      const dist = Math.sqrt(
        this.player.posX * this.player.posX +
        this.player.posY * this.player.posY +
        this.player.posZ * this.player.posZ,
      );
      const sunSystemRadius = 0.01;
      if (dist < sunSystemRadius) {
        const inner = sunSystemRadius * 0.05;
        const t = Math.min(1, Math.max(0, (dist - inner) / (sunSystemRadius - inner)));
        const factor = t * t * (3 - 2 * t);
        if (factor < minFactor) {
          minFactor = factor;
          nearestPlanet = 'Sun';
        }
      }
    }

    return { factor: minFactor, planet: nearestPlanet };
  }

  private updatePlanetScaling() {
    if (!this.solarSystem) return;
    for (const planet of this.solarSystem.planets) {
      planet.group.scale.setScalar(1);

      // Atmosphere alpha: fade in as player approaches the planet's system radius
      if (planet.atmosphere) {
        const wp = planet.group.userData.worldPosAU as { x: number; y: number; z: number };
        const dx = this.player.posX - wp.x;
        const dy = this.player.posY - wp.y;
        const dz = this.player.posZ - wp.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const systemR = planet.data.systemRadiusAU;
        const innerR = systemR * 0.1;
        const linear = 1 - Math.min(1, Math.max(0, (dist - innerR) / (systemR - innerR)));
        const t = linear * linear * (3 - 2 * linear);
        const glowMat = planet.atmosphere.material as THREE.ShaderMaterial;
        if (glowMat.uniforms?.alphaScale) {
          glowMat.uniforms.alphaScale.value = 0.15 + 0.3 * t;
        }
      }

      if (planet.data.name === 'Earth') {
        const wp = planet.group.userData.worldPosAU as { x: number; y: number; z: number };
        const dx = this.player.posX - wp.x;
        const dy = this.player.posY - wp.y;
        const dz = this.player.posZ - wp.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const renderedAngularDiameter = dist > 1e-8
          ? (planet.data.radiusAU * 2) / dist
          : Infinity;
        const keepEarthDetail =
          dist <= ExploreMode.EARTH_DETAIL_MIN_DISTANCE_AU ||
          renderedAngularDiameter >= ExploreMode.EARTH_DETAIL_MIN_ANGULAR_DIAMETER_RAD;
        if (planet.nightMesh) planet.nightMesh.visible = keepEarthDetail;
        if (planet.cloudsMesh) planet.cloudsMesh.visible = keepEarthDetail;
      }
    }

    this.player.setProfile(this.activeVoyagerJourney?.shipProfile ?? 'default');
  }

  private updateMoonPositions() {
    if (!this.solarSystem) return;
    for (const planet of this.solarSystem.planets) {
      const moons = this.planetMoons.get(planet.data.name);
      if (!moons || moons.length === 0) continue;

      const wp = planet.group.userData.worldPosAU as { x: number; y: number; z: number };
      const dx = this.player.posX - wp.x;
      const dy = this.player.posY - wp.y;
      const dz = this.player.posZ - wp.z;
      const distToPlayer = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const threshold = this.getMoonSystemThresholdAU(planet.data.radiusAU, moons);
      const visible = distToPlayer < threshold;
      const parentR = planet.data.radiusAU;

      const shouldRefreshMoonLabels = this.moonLabelContainer !== null;
      const canvasW = shouldRefreshMoonLabels ? this.renderer.domElement.clientWidth : 0;
      const canvasH = shouldRefreshMoonLabels ? this.renderer.domElement.clientHeight : 0;
      const tempV = shouldRefreshMoonLabels ? new THREE.Vector3() : null;

      for (const m of moons) {
        const label = this.moonLabels.get(m.data.name);
        m.mesh.visible = visible;
        if (visible) {
          const angle = this.getMoonAngleRad(m.data);
          const r = m.data.orbitalRadiusAU;
          m.mesh.position.set(r * Math.cos(angle), 0, r * Math.sin(angle));

          // Store moon world position (planet AU pos + orbital offset)
          this.moonWorldPositions.set(m.data.name, {
            x: wp.x + r * Math.cos(angle),
            y: wp.y,
            z: wp.z + r * Math.sin(angle),
          });

          const realRatio = m.data.radiusAU / parentR;
          const minRatio = 0.05;
          if (realRatio < minRatio) {
            m.mesh.scale.setScalar(minRatio / realRatio);
          } else {
            m.mesh.scale.setScalar(1);
          }

          if (label && shouldRefreshMoonLabels && tempV) {
            m.mesh.getWorldPosition(tempV);
            tempV.project(this.camera);
            if (tempV.z < 1) {
              let sx = (tempV.x * 0.5 + 0.5) * canvasW;
              let sy = (-tempV.y * 0.5 + 0.5) * canvasH;
              const margin = 30;
              const onScreen = sx >= margin && sx <= canvasW - margin &&
                               sy >= margin && sy <= canvasH - margin;
              sx = Math.max(margin, Math.min(canvasW - margin, sx));
              sy = Math.max(margin, Math.min(canvasH - margin, sy));
              label.style.display = 'block';
              label.style.left = `${sx}px`;
              label.style.top = `${sy}px`;
              label.classList.toggle('edge', !onScreen);
            } else {
              label.style.display = 'none';
            }
          }
        } else if (label && label.style.display !== 'none') {
          label.style.display = 'none';
        }
      }
    }
  }

  private updateSunShader(dt: number) {
    if (!this.solarSystem) return;
    const sunMat = this.solarSystem.sun.userData.sunMaterial as THREE.ShaderMaterial | undefined;
    if (sunMat) {
      sunMat.uniforms.time.value += dt;
    }
  }

  private updateOrbitLineVisibility() {
    if (!this.solarSystem) return;
    for (let i = 0; i < this.solarSystem.orbitLines.length; i++) {
      const orbit = this.solarSystem.orbitLines[i];
      const body = ALL_BODIES[i];
      const distToOrbit = Math.abs(this.player.getDistanceFromSun() - body.semiMajorAxisAU);
      const fadeRange = Math.max(body.semiMajorAxisAU * 0.3, 1.0);
      const opacity = Math.max(0.05, Math.min(0.4, 1 - distToOrbit / fadeRange));
      (orbit.material as THREE.LineBasicMaterial).opacity = opacity;
    }
  }

  private processInput() {
    if (this.landedOn) return;
    // Flight controls
    const yawFromKeys =
      (this.keys.has('arrowright') || this.keys.has('d') ? 1 : 0) -
      (this.keys.has('arrowleft') || this.keys.has('a') ? 1 : 0);
    let yaw = yawFromKeys;
    yaw = THREE.MathUtils.clamp(yaw + this.touchYaw + this.gyroYaw, -1, 1);
    this.player.yawInput = yaw;

    const pitchFromKeys =
      (this.keys.has('arrowup') ? 1 : 0) -
      (this.keys.has('arrowdown') ? 1 : 0);
    let pitch = pitchFromKeys;
    pitch = THREE.MathUtils.clamp(pitch + this.touchPitch + this.gyroPitch, -1, 1);
    this.player.pitchInput = pitch;

    // Throttle (keyboard + touch)
    let throttle =
      (this.keys.has('w') ? 1 : 0) -
      (this.keys.has('s') ? 1 : 0);
    if (this.touchThrottle !== 0) throttle = this.touchThrottle;

    // Any manual steering input disengages autopilot
    if (this.autopilot && (yaw !== 0 || pitch !== 0 || throttle !== 0)) {
      this.disableAutopilot();
    }

    if (throttle > 0) {
      // Accelerate — route to whichever speed mode is active
      if (this.inSystemMode) {
        if (this.player.systemSpeedMultiplier < 0.001) {
          this.player.systemSpeedMultiplier = Math.min(this.player.systemSpeedMultiplier + 0.0001, PlayerShip.SYSTEM_SPEED_MAX);
        } else {
          this.player.systemSpeedMultiplier = Math.min(this.player.systemSpeedMultiplier * 1.01, PlayerShip.SYSTEM_SPEED_MAX);
        }
      } else {
        if (this.player.speedMultiplier < 0.05) {
          this.player.speedMultiplier = Math.min(this.player.speedMultiplier + 0.002, PlayerShip.SPEED_MAX);
        } else {
          this.player.speedMultiplier = Math.min(this.player.speedMultiplier * 1.01, PlayerShip.SPEED_MAX);
        }
      }
      this.updateSpeedSlider();
    }
    if (throttle < 0) {
      // Decelerate — route to whichever speed mode is active
      if (this.inSystemMode) {
        this.player.systemSpeedMultiplier = Math.max(this.player.systemSpeedMultiplier * 0.99 - 0.0001, 0);
      } else {
        this.player.speedMultiplier = Math.max(this.player.speedMultiplier * 0.99 - 0.001, 0);
      }
      this.updateSpeedSlider();
    }
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (!this.active) return;

    // Escape always works — even while typing in search input
    if (e.key === 'Escape') {
      if (this.isTravelMenuOpen()) { this.closeTravelMenu(); return; }
      if (this.landedOn) { this.exitLandedMode(); return; }
    }

    // Don't capture other keys if typing in an input
    if ((e.target as HTMLElement).tagName === 'INPUT') return;

    // T opens/closes travel menu
    if (e.key.toLowerCase() === 't') {
      if (this.isMissionActive()) return;
      this.toggleTravelMenu();
      return;
    }

    // Suppress all other keys while landed
    if (this.landedOn) return;
    if (this.isMissionActive()) return;

    this.keys.add(e.key.toLowerCase());

    // Space toggles pause
    if (e.key === ' ') {
      e.preventDefault();
      this.player.moving = !this.player.moving;
      this.updatePauseButtonLabel();
    }

    // P toggles autopilot
    if (e.key.toLowerCase() === 'p') {
      this.toggleAutopilot();
    }
  }

  private handleKeyUp(e: KeyboardEvent) {
    this.keys.delete(e.key.toLowerCase());
  }

  private checkOrbitCrossings() {
    const playerDist = this.player.getDistanceFromSun();

    for (const body of ALL_BODIES) {
      const orbitDist = body.semiMajorAxisAU;
      const crossThreshold = Math.max(orbitDist * 0.005, 0.01);

      if (Math.abs(playerDist - orbitDist) < crossThreshold) {
        if (this.lastCrossedOrbit !== body.name) {
          this.lastCrossedOrbit = body.name;
          this.showNotification(`Crossing ${body.name}'s orbit \u2014 ${body.semiMajorAxisAU.toFixed(2)} AU`);
        }
        return;
      }
    }

    // Clear when not near any orbit
    if (this.lastCrossedOrbit) {
      const lastBody = ALL_BODIES.find(b => b.name === this.lastCrossedOrbit);
      if (lastBody) {
        const dist = Math.abs(this.player.getDistanceFromSun() - lastBody.semiMajorAxisAU);
        if (dist > Math.max(lastBody.semiMajorAxisAU * 0.02, 0.05)) {
          this.lastCrossedOrbit = null;
        }
      }
    }
  }

  private checkPlanetVisits() {
    if (!this.solarSystem) return;

    for (const planet of this.solarSystem.planets) {
      const pos = planet.group.userData.worldPosAU as { x: number; y: number; z: number } | undefined;
      if (!pos) continue;
      const dx = this.player.posX - pos.x;
      const dy = this.player.posY - pos.y;
      const dz = this.player.posZ - pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const visitDist = Math.max(
        planet.data.radiusAU * 10,
        this.getPlanetCollisionRadius(planet.data.radiusAU, planet.group.scale.x) * 1.02,
      );

      // "Visit" if within 10× planet radius
      if (dist < visitDist && !this.player.visitedPlanets.has(planet.data.name)) {
        this.player.visitedPlanets.add(planet.data.name);
        this.showNotification(`Arrived at ${planet.data.name}! ${planet.data.description}`);
      }
    }
  }

  private checkProximityLand() {
    if (!this.solarSystem || this.landedOn) {
      this.setNearbyLandTarget(null);
      return;
    }

    let closest: NonNullable<LandedTarget> | null = null;
    let closestDist = Infinity;

    // Check planets
    for (const planet of this.solarSystem.planets) {
      const wp = planet.group.userData.worldPosAU as { x: number; y: number; z: number } | undefined;
      if (!wp) continue;
      const dx = this.player.posX - wp.x;
      const dy = this.player.posY - wp.y;
      const dz = this.player.posZ - wp.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const threshold = this.getPlanetCollisionRadius(planet.data.radiusAU, planet.group.scale.x) * 2;
      if (dist < threshold && dist < closestDist) {
        closestDist = dist;
        closest = { type: 'planet', name: planet.data.name };
      }

      // Check moons of nearby planets using real AU positions
      const moons = this.planetMoons.get(planet.data.name);
      if (!moons) continue;
      const moonThreshold = this.getMoonSystemThresholdAU(planet.data.radiusAU, moons);
      if (dist > moonThreshold) continue;
      for (const m of moons) {
        // Compute moon's real AU position (parent + orbital offset)
        const angle = this.getMoonAngleRad(m.data);
        const r = m.data.orbitalRadiusAU;
        const moonRealX = wp.x + r * Math.cos(angle);
        const moonRealY = wp.y;
        const moonRealZ = wp.z + r * Math.sin(angle);
        const mdx = this.player.posX - moonRealX;
        const mdy = this.player.posY - moonRealY;
        const mdz = this.player.posZ - moonRealZ;
        const md = Math.sqrt(mdx * mdx + mdy * mdy + mdz * mdz);
        const moonLandThreshold = Math.max(m.data.radiusAU * this.planetScale * 3, 0.0003);
        if (md < moonLandThreshold && md < closestDist) {
          closestDist = md;
          closest = { type: 'moon', name: m.data.name, parentPlanet: planet.data.name };
        }
      }
    }

    this.setNearbyLandTarget(closest);
  }

  private setNearbyLandTarget(target: NonNullable<LandedTarget> | null) {
    if (this.isMissionActive()) {
      this.nearbyLandTarget = null;
      const btn = document.getElementById('explore-btn-land');
      if (btn) btn.style.display = 'none';
      return;
    }

    const prevName = this.nearbyLandTarget?.name ?? null;
    const newName = target?.name ?? null;
    if (prevName === newName) return;

    this.nearbyLandTarget = target;
    const btn = document.getElementById('explore-btn-land');
    const nameEl = document.getElementById('land-body-name');
    if (btn) btn.style.display = target ? '' : 'none';
    if (nameEl) nameEl.textContent = target?.name ?? '';
  }

  private showIntroText() {
    try {
      if (localStorage.getItem('explore-intro-seen')) return;
    } catch { /* private browsing — show it once per session */ }
    const el = document.getElementById('explore-intro');
    if (!el) return;
    el.classList.add('visible');
    const dismiss = () => {
      el.classList.remove('visible');
      el.removeEventListener('click', dismiss);
      window.removeEventListener('keydown', dismiss);
      try { localStorage.setItem('explore-intro-seen', '1'); } catch { /* ignore */ }
    };
    el.addEventListener('click', dismiss);
    window.addEventListener('keydown', dismiss, { once: true });
    setTimeout(dismiss, 12000);
  }

  private showNotification(text: string) {
    if (!this.notificationEl) return;
    this.notificationEl.textContent = text;
    this.notificationEl.classList.add('visible');

    if (this.notificationTimeout) clearTimeout(this.notificationTimeout);
    this.notificationTimeout = window.setTimeout(() => {
      this.notificationEl?.classList.remove('visible');
    }, 4000);
  }

  private updateStatsUI() {
    if (!this.statsEl) return;

    const stats = computeStats(
      this.player.posX, this.player.posY, this.player.posZ,
      this.player.speedAUPerS,
      this.player.distanceTraveled,
      this.player.timeElapsed,
      this.planetWorldPositions,
    );

    // Update stats panel
    this.setStatText('stat-fps', `${this.fpsDisplay}`);
    this.setStatText('stat-distance', `${formatAU(stats.distanceFromSunAU)} AU`);
    this.setStatText('stat-light-time', stats.lightTravelTime);
    this.setStatText('stat-intensity', `${stats.solarIntensityPct.toFixed(1)}%`);
    this.setStatText('stat-speed', `${stats.speedC.toFixed(1)}c / ${Math.round(stats.speedKmS).toLocaleString()} km/s`);
    this.setStatText('stat-nearest',
      stats.nearestPlanet ? `${stats.nearestPlanet.name} ${formatAU(stats.nearestPlanet.distanceAU)}` : '--');
    this.setStatText('stat-temp', `${Math.round(stats.blackbodyTempK)} K`);
    this.setStatText('stat-traveled', `${formatAU(stats.distanceTraveled)} AU`);
    this.setStatText('stat-time', stats.timeElapsed);

    // Update progress bar (0 to ~40 AU = Pluto)
    if (this.progressEl) {
      const pct = Math.min(100, (this.player.getDistanceFromSun() / 42) * 100);
      this.progressEl.style.width = `${pct}%`;
    }
  }

  private readonly _sunProjV = new THREE.Vector3();

  private updateSunLabel() {
    if (!this.sunLabel || !this.solarSystem) return;
    const sunPos = this.solarSystem.sun.position;
    this._sunProjV.set(sunPos.x, sunPos.y, sunPos.z);
    this._sunProjV.project(this.camera);

    const canvas = this.renderer.domElement;
    const screenX = (this._sunProjV.x * 0.5 + 0.5) * canvas.clientWidth;
    const screenY = (-this._sunProjV.y * 0.5 + 0.5) * canvas.clientHeight;

    if (this._sunProjV.z < 1 && screenX > -50 && screenX < canvas.clientWidth + 50 &&
        screenY > -50 && screenY < canvas.clientHeight + 50) {
      if (!this.sunLabelVisible) {
        this.sunLabel.style.display = 'block';
        this.sunLabelVisible = true;
      }
      const transform = `translate(${screenX}px, ${screenY + 16}px)`;
      if (transform !== this.lastSunTransform) {
        this.sunLabel.style.transform = transform;
        this.lastSunTransform = transform;
      }
      const distAU = this.player.getDistanceFromSun();
      const distText = distAU < 0.01
        ? `${(distAU * 149597870.7).toFixed(0)} km`
        : `${distAU.toFixed(2)} AU`;
      if (distText !== this.lastSunDistText) {
        const distEl = this.sunLabel.querySelector('.planet-label-dist');
        if (distEl) distEl.textContent = distText;
        this.lastSunDistText = distText;
      }
    } else if (this.sunLabelVisible) {
      this.sunLabel.style.display = 'none';
      this.sunLabelVisible = false;
    }
  }

  private setStatText(id: string, text: string) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  private formatSystemSpeed(speedMultiplier: number): string {
    const kmPerS = speedMultiplier * 299792.458;
    if (kmPerS < 1000) return Math.round(kmPerS) + ' km/s';
    return Math.round(kmPerS / 1000) + 'k km/s';
  }

  private updateSpeedSlider() {
    // Update mode detection with hysteresis (but override forces space mode)
    if (this.throttleOverride || !this.systemSlowdown) {
      this.inSystemMode = false;
    } else if (this.systemSpeedFactor < 0.5) {
      this.inSystemMode = true;
    } else if (this.systemSpeedFactor > 0.6) {
      this.inSystemMode = false;
    }

    // Auto-disable override when leaving all planet systems
    if (this.throttleOverride && this.systemSpeedFactor >= 1.0) {
      this.throttleOverride = false;
    }

    if (this.speedLabelEl) {
      this.speedLabelEl.textContent = this.inSystemMode
        ? (this.nearestSystemPlanet ?? 'System')
        : 'Space';
    }

    // Visual feedback for override state
    if (this.speedCenterEl) {
      this.speedCenterEl.classList.toggle('throttle-override', this.throttleOverride);
    }
    if (this.speedValueEl) {
      if (this.inSystemMode) {
        this.speedValueEl.textContent = this.player.systemSpeedMultiplier < 0.0005
          ? '0 km/s'
          : this.formatSystemSpeed(this.player.systemSpeedMultiplier);
      } else {
        this.speedValueEl.textContent = this.player.speedMultiplier < 0.01
          ? '0c'
          : `${this.player.speedC.toFixed(1)}c`;
      }
    }
  }

  private updatePauseButtonLabel() {
    const btn = document.getElementById('explore-btn-pause');
    if (btn) btn.textContent = this.player.moving ? '\u23F8' : '\u25B6';
  }

  private isMissionActive(): boolean {
    return this.activeVoyagerJourney !== null;
  }

  private setVoyagerPanelVisible(visible: boolean) {
    document.getElementById('voyager-panel')?.classList.toggle('visible', visible);
    const reopenBtn = document.getElementById('voyager-reopen');
    const journey = this.activeVoyagerJourney;
    if (!reopenBtn) return;

    if (!journey || visible || !this.voyagerPanelDismissed) {
      reopenBtn.classList.remove('visible');
      return;
    }

    reopenBtn.textContent = `${journey.label} · ${this.voyagerMilestoneIndex + 1}/${journey.milestones.length}`;
    reopenBtn.classList.add('visible');
  }

  private dismissVoyagerPanel() {
    if (!this.isMissionActive()) return;
    this.voyagerPanelDismissed = true;
    this.setVoyagerPanelVisible(false);
  }

  private collapseHistoricJourneyMenu() {
    document.getElementById('explore-historic-submenu')?.classList.remove('visible');
    document.getElementById('explore-btn-historic')?.classList.remove('expanded');
  }

  private rememberPreMissionState() {
    if (this.activeVoyagerJourney) return;
    this.preMissionState = this.getState();
    this.preMissionMenuVisible =
      document.getElementById('explore-menu-panel')?.classList.contains('visible') ?? false;
  }

  private restorePreMissionState() {
    const previousState = this.preMissionState;
    const previousMenuVisible = this.preMissionMenuVisible;
    this.preMissionState = null;
    this.preMissionMenuVisible = false;

    if (!previousState) return;

    this.restoreState(previousState);
    document.getElementById('explore-menu-panel')?.classList.toggle('visible', previousMenuVisible);
  }

  private updateMissionControlState() {
    const missionActive = this.isMissionActive();

    for (const id of ExploreMode.MISSION_CONTROL_IDS) {
      const button = document.getElementById(id) as HTMLButtonElement | null;
      if (button) button.disabled = missionActive;
    }

    const bottomBar = document.getElementById('explore-bottom-bar');
    if (bottomBar) {
      bottomBar.style.opacity = missionActive ? '0.45' : '';
      bottomBar.style.display = missionActive || this.landedOn ? 'none' : '';
    }

    const speedStatRow = document.getElementById('stat-speed-row');
    if (speedStatRow) speedStatRow.style.display = missionActive ? 'none' : '';

    const landBtn = document.getElementById('explore-btn-land');
    if (landBtn) {
      landBtn.style.display = missionActive ? 'none' : (this.nearbyLandTarget ? '' : 'none');
      (landBtn as HTMLButtonElement).disabled = missionActive;
    }

    const leaveBtn = document.getElementById('explore-btn-leave') as HTMLButtonElement | null;
    if (leaveBtn) leaveBtn.disabled = missionActive;

    const touchZone = document.getElementById('touch-flight-zone');
    if (touchZone) {
      touchZone.style.pointerEvents = missionActive ? 'none' : '';
      if (missionActive) {
        touchZone.classList.remove('active');
        this.activeFlightTouchId = null;
        this.touchYaw = 0;
        this.touchPitch = 0;
        this.touchThrottle = 0;
      }
    }

    if (missionActive) {
      this.keys.clear();
      this.closeTravelMenu();
    }
  }

  private wireUpUI() {
    // Tap speed center to toggle system throttle override (temporary)
    document.querySelector('.speed-center')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      if (!this.systemSlowdown) return; // already disabled globally
      this.throttleOverride = !this.throttleOverride;
      this.updateSpeedSlider();
    });

    document.getElementById('explore-speed-up')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      if (this.inSystemMode) {
        if (this.player.systemSpeedMultiplier < 0.001) {
          this.player.systemSpeedMultiplier = 0.001;
        } else {
          this.player.systemSpeedMultiplier = Math.min(this.player.systemSpeedMultiplier * 1.35, PlayerShip.SYSTEM_SPEED_MAX);
        }
      } else {
        if (this.player.speedMultiplier < 0.05) {
          this.player.speedMultiplier = 0.05;
        } else {
          this.player.speedMultiplier = Math.min(this.player.speedMultiplier * 1.35, PlayerShip.SPEED_MAX);
        }
      }
      this.updateSpeedSlider();
    });
    document.getElementById('explore-speed-down')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      if (this.inSystemMode) {
        if (this.player.systemSpeedMultiplier < 0.002) {
          this.player.systemSpeedMultiplier = 0;
        } else {
          this.player.systemSpeedMultiplier = Math.max(this.player.systemSpeedMultiplier * 0.72, 0);
        }
      } else {
        if (this.player.speedMultiplier < 0.06) {
          this.player.speedMultiplier = 0;
        } else {
          this.player.speedMultiplier = Math.max(this.player.speedMultiplier * 0.72, 0);
        }
      }
      this.updateSpeedSlider();
    });

    // Save button
    document.getElementById('explore-btn-save')?.addEventListener('click', () => {
      this.saveManager.saveState(this.getState());
      this.showNotification('Game saved!');
    });

    // New Journey button
    document.getElementById('explore-btn-new')?.addEventListener('click', () => {
      if (this.landedOn) this.exitLandedMode();
      this.stopVoyagerJourney();
      this.saveManager.clearState();
      this.restoreState(createDefaultState());
      this.pointTowardMercury();
      this.autopilotTarget = { type: 'planet', name: 'Mercury' };
      this.autopilot = true;
      this.updateAutopilotButton();
      this.showNotification('New journey started!');
    });

    document.getElementById('explore-btn-voyager-1')?.addEventListener('click', () => {
      void this.startVoyagerJourney('voyager1');
    });
    document.getElementById('explore-btn-voyager-2')?.addEventListener('click', () => {
      void this.startVoyagerJourney('voyager2');
    });
    document.getElementById('explore-btn-cassini')?.addEventListener('click', () => {
      void this.startVoyagerJourney('cassini');
    });
    document.getElementById('explore-btn-new-horizons')?.addEventListener('click', () => {
      void this.startVoyagerJourney('newHorizons');
    });
    document.getElementById('explore-btn-juno')?.addEventListener('click', () => {
      void this.startVoyagerJourney('juno');
    });
    document.getElementById('voyager-close')?.addEventListener('click', () => {
      this.dismissVoyagerPanel();
    });
    document.getElementById('voyager-reopen')?.addEventListener('click', () => {
      this.showVoyagerMilestone(this.voyagerMilestoneIndex);
    });
    document.getElementById('voyager-exit')?.addEventListener('click', () => {
      this.stopVoyagerJourney();
    });
    document.getElementById('voyager-prev')?.addEventListener('click', () => {
      this.showVoyagerMilestone(this.voyagerMilestoneIndex - 1);
    });
    document.getElementById('voyager-next')?.addEventListener('click', () => {
      this.showVoyagerMilestone(this.voyagerMilestoneIndex + 1);
    });

    // Autopilot toggle
    document.getElementById('explore-btn-autopilot')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      this.toggleAutopilot();
    });

    // Menu panel toggle — auto-pause while open
    document.getElementById('explore-btn-menu')?.addEventListener('click', () => {
      const panel = document.getElementById('explore-menu-panel');
      if (!panel) return;
      const wasVisible = panel.classList.contains('visible');
      if (wasVisible) {
        this.closeMenuPanel();
      } else {
        // Opening: pause ship + time
        this._menuPausedShip = this.player.moving;
        this._menuPausedTime = !this.timeState.paused;
        this.player.moving = false;
        this.timeState.paused = true;
        panel.classList.add('visible');
      }
    });
    document.getElementById('explore-btn-historic')?.addEventListener('click', () => {
      const submenu = document.getElementById('explore-historic-submenu');
      const trigger = document.getElementById('explore-btn-historic');
      const expanded = submenu?.classList.toggle('visible') ?? false;
      trigger?.classList.toggle('expanded', expanded);
    });

    // Bottom bar popover toggles (stats + time)
    const statsPopover = document.getElementById('stats-popover');
    const timePopover = document.getElementById('time-popover');
    const statsChevron = document.getElementById('stats-chevron');
    const timeChevron = document.getElementById('time-chevron');

    document.getElementById('bar-stats-toggle')?.addEventListener('click', () => {
      const opening = !statsPopover?.classList.contains('visible');
      statsPopover?.classList.toggle('visible');
      statsChevron?.classList.toggle('expanded');
      if (opening) {
        timePopover?.classList.remove('visible');
        timeChevron?.classList.remove('expanded');
      }
    });

    document.getElementById('bar-time-toggle')?.addEventListener('click', () => {
      const opening = !timePopover?.classList.contains('visible');
      timePopover?.classList.toggle('visible');
      timeChevron?.classList.toggle('expanded');
      if (opening) {
        statsPopover?.classList.remove('visible');
        statsChevron?.classList.remove('expanded');
      }
    });

    // Prevent clicks inside popovers from closing them
    timePopover?.addEventListener('click', (e) => e.stopPropagation());
    statsPopover?.addEventListener('click', (e) => e.stopPropagation());

    // Close popovers when clicking outside the bottom bar
    document.addEventListener('click', (e) => {
      const bottomBar = document.getElementById('explore-bottom-bar');
      if (bottomBar && !bottomBar.contains(e.target as Node)) {
        statsPopover?.classList.remove('visible');
        statsChevron?.classList.remove('expanded');
        timePopover?.classList.remove('visible');
        timeChevron?.classList.remove('expanded');
      }
    });

    // Sun label
    const labelContainer = document.getElementById('planet-labels');
    if (labelContainer) {
      this.sunLabel = document.createElement('div');
      this.sunLabel.className = 'planet-label';
      this.sunLabel.innerHTML = '<span class="planet-label-name">Sun</span><span class="planet-label-dist"></span>';
      this.sunLabel.style.display = 'none';
      labelContainer.appendChild(this.sunLabel);
    }

    // Astronomy time controls
    document.getElementById('explore-time-pause')?.addEventListener('click', () => {
      this.timeState.paused = !this.timeState.paused;
      this.updateTimeUI();
    });
    document.getElementById('explore-time-play')?.addEventListener('click', () => {
      this.timeState.paused = false;
      if (this.timeState.rate < 0) this.timeState.rate *= -1;
      this.updateTimeUI();
    });
    document.getElementById('explore-time-reverse')?.addEventListener('click', () => {
      this.timeState.paused = false;
      this.timeState.rate = -Math.abs(this.timeState.rate);
      this.updateTimeUI();
    });
    document.getElementById('explore-time-slower')?.addEventListener('click', () => {
      this.stepTimeRate(-1);
    });
    document.getElementById('explore-time-faster')?.addEventListener('click', () => {
      this.stepTimeRate(1);
    });
    document.getElementById('explore-time-now')?.addEventListener('click', () => {
      this.timeState.currentUtcMs = Date.now();
      this.rebuildPlanetPositions();
      this.updateTimeUI();
    });
    if (this.timeInputEl) {
      this.timeInputEl.value = formatUtcInputValue(this.timeState.currentUtcMs);
      this.timeInputEl.addEventListener('change', () => {
        const utcMs = parseUtcInputValue(this.timeInputEl?.value ?? '');
        if (utcMs !== null) {
          this.timeState.currentUtcMs = utcMs;
          this.rebuildPlanetPositions();
          this.updateTimeUI();
        }
      });
    }

    // Show ship toggle
    document.getElementById('settings-ship-toggle')?.addEventListener('click', () => {
      this.showShip = !this.showShip;
      this.player.group.visible = this.showShip && !this.landedOn;
      const label = document.getElementById('settings-ship-label');
      if (label) label.textContent = this.showShip ? 'On' : 'Off';
    });

    document.getElementById('settings-gyro-toggle')?.addEventListener('click', () => {
      void this.toggleGyroControls();
    });

    document.getElementById('settings-constellations-toggle')?.addEventListener('click', () => {
      this.showConstellations = !this.showConstellations;
      if (this.showConstellations) {
        this.ensureConstellationsReady();
      } else if (this.constellations) {
        this.constellations.setVisible(false);
      }
      const label = document.getElementById('settings-constellations-label');
      if (label) label.textContent = this.showConstellations ? 'On' : 'Off';
    });

    document.getElementById('settings-throttle-toggle')?.addEventListener('click', () => {
      this.systemSlowdown = !this.systemSlowdown;
      const label = document.getElementById('settings-throttle-label');
      if (label) label.textContent = this.systemSlowdown ? 'On' : 'Off';
      this.updateSpeedSlider();
    });

    // Full-screen mobile flight zone
    const flightZone = document.getElementById('touch-flight-zone');
    if (flightZone) {
      flightZone.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        (flightZone as HTMLElement).setPointerCapture?.(event.pointerId);
        this.activeFlightTouchId = event.pointerId;
        this.setFlightTouchFromPoint(event.clientX, event.clientY);
        flightZone.classList.add('active');
      });
      flightZone.addEventListener('pointermove', (event) => {
        if (this.activeFlightTouchId === event.pointerId) {
          this.setFlightTouchFromPoint(event.clientX, event.clientY);
        }
      });
      const clearFlightTouch = (event?: PointerEvent) => {
        if (!event || this.activeFlightTouchId === event.pointerId) {
          this.activeFlightTouchId = null;
          this.touchYaw = 0;
          this.touchPitch = 0;
          flightZone.classList.remove('active');
        }
      };
      flightZone.addEventListener('pointerup', clearFlightTouch);
      flightZone.addEventListener('pointercancel', clearFlightTouch);
      flightZone.addEventListener('pointerleave', clearFlightTouch);
    }

    // Travel menu
    document.getElementById('explore-btn-travel')?.addEventListener('click', () => {
      if (this.isMissionActive()) return;
      this.toggleTravelMenu();
    });
    document.getElementById('travel-menu-close')?.addEventListener('click', () => {
      this.closeTravelMenu();
    });
    const travelSearch = document.getElementById('travel-search') as HTMLInputElement;
    travelSearch?.addEventListener('input', () => {
      this.filterTravelList(travelSearch.value);
    });
    document.getElementById('explore-btn-leave')?.addEventListener('click', () => {
      this.exitLandedMode();
    });
    document.getElementById('explore-btn-land')?.addEventListener('click', () => {
      if (this.nearbyLandTarget) {
        this.enterLandedMode(this.nearbyLandTarget);
      }
    });
    // Travel action bar: Fly To, Jump, Land
    document.getElementById('travel-action-fly')?.addEventListener('click', () => {
      if (!this.travelSelection) return;
      const sel = this.travelSelection;
      this.closeTravelMenu();
      if (this.landedOn) this.exitLandedMode();
      this.engageAutopilot(sel);
    });
    document.getElementById('travel-action-land')?.addEventListener('click', () => {
      if (this.travelSelection) {
        const sel = this.travelSelection;
        this.closeTravelMenu();
        this.enterLandedMode(sel);
      }
    });
    document.getElementById('travel-action-jump')?.addEventListener('click', () => {
      if (this.travelSelection) {
        const sel = this.travelSelection;
        this.closeTravelMenu();
        if (this.landedOn) this.exitLandedMode();
        if (sel.type === 'planet') {
          const body = ALL_BODIES.find(b => b.name === sel.name);
          if (body) this.jumpToPlanet(body);
        } else {
          // Jump near the moon's parent planet
          const body = ALL_BODIES.find(b => b.name === sel.parentPlanet);
          if (body) this.jumpToPlanet(body);
        }
      }
    });
    this.buildTravelList();

    this.updateTimeUI();
    this.updateMissionControlState();
  }

  private buildTravelList() {
    const list = document.getElementById('travel-list');
    if (!list) return;
    list.innerHTML = '';

    for (const body of ALL_BODIES) {
      // Planet item
      const item = document.createElement('button');
      item.className = 'travel-item';
      item.dataset.type = 'planet';
      item.dataset.name = body.name;
      item.innerHTML = `
        <span class="travel-item-dot" style="background:#${body.color.toString(16).padStart(6, '0')}"></span>
        <span class="travel-item-info">
          <span class="travel-item-name">${body.name}</span>
          <span class="travel-item-detail">${body.description.split('.')[0]}</span>
        </span>`;
      item.addEventListener('click', () => {
        this.selectTravelTarget({ type: 'planet', name: body.name });
      });
      list.appendChild(item);

      // Moons for this planet
      const moons = getMoonsByPlanet(body.name);
      for (const moon of moons) {
        const moonItem = document.createElement('button');
        moonItem.className = 'travel-item travel-item-moon';
        moonItem.dataset.type = 'moon';
        moonItem.dataset.name = moon.name;
        moonItem.dataset.parent = moon.parentPlanet;
        moonItem.innerHTML = `
          <span class="travel-item-dot" style="background:#${moon.color.toString(16).padStart(6, '0')}"></span>
          <span class="travel-item-info">
            <span class="travel-item-name">${moon.name}</span>
            <span class="travel-item-detail">Moon of ${moon.parentPlanet} · r = ${moon.radiusKm.toLocaleString()} km</span>
          </span>`;
        moonItem.addEventListener('click', () => {
          this.selectTravelTarget({ type: 'moon', name: moon.name, parentPlanet: moon.parentPlanet });
        });
        list.appendChild(moonItem);
      }
    }
  }

  private toggleTravelMenu(autopilotMode = false) {
    if (this.isMissionActive()) return;
    const menu = document.getElementById('travel-menu');
    if (!menu) return;
    const isVisible = menu.classList.contains('visible');
    if (isVisible) {
      this.closeTravelMenu();
    } else {
      // Close menu panel if open
      this.closeMenuPanel();
      menu.classList.add('visible');
      this.travelSelection = null;
      this.travelMenuAutopilotMode = autopilotMode;
      // Swap primary button styling based on mode
      const landBtn = document.getElementById('travel-action-land');
      const flyBtn = document.getElementById('travel-action-fly');
      if (landBtn && flyBtn) {
        if (autopilotMode) {
          flyBtn.className = 'travel-action-btn';
          landBtn.className = 'travel-action-btn travel-action-btn-dim';
        } else {
          landBtn.className = 'travel-action-btn';
          flyBtn.className = 'travel-action-btn travel-action-btn-dim';
        }
      }
      const actionBar = document.getElementById('travel-action-bar');
      if (actionBar) actionBar.style.display = 'none';
      // Hide planet/moon labels so they don't show through the menu
      const pl = document.getElementById('planet-labels');
      const ml = this.moonLabelContainer;
      if (pl) pl.style.display = 'none';
      if (ml) ml.style.display = 'none';
      const search = document.getElementById('travel-search') as HTMLInputElement;
      if (search) {
        search.value = '';
        this.filterTravelList('');
        if (!('ontouchstart' in window)) search.focus();
      }
    }
  }

  private closeTravelMenu() {
    const menu = document.getElementById('travel-menu');
    if (menu) menu.classList.remove('visible');
    this.travelSelection = null;
    // Restore planet/moon labels
    const pl = document.getElementById('planet-labels');
    const ml = this.moonLabelContainer;
    if (pl) pl.style.display = '';
    if (ml) ml.style.display = '';
  }

  private selectTravelTarget(target: NonNullable<LandedTarget>) {
    this.travelSelection = target;
    const actionBar = document.getElementById('travel-action-bar');
    const nameEl = document.getElementById('travel-action-name');
    if (actionBar) actionBar.style.display = '';
    if (nameEl) nameEl.textContent = target.name;
  }

  private isTravelMenuOpen(): boolean {
    return document.getElementById('travel-menu')?.classList.contains('visible') ?? false;
  }

  private filterTravelList(query: string) {
    const list = document.getElementById('travel-list');
    if (!list) return;
    const q = query.toLowerCase().trim();
    const items = list.querySelectorAll('.travel-item') as NodeListOf<HTMLElement>;

    if (!q) {
      for (const item of items) item.style.display = '';
      return;
    }

    // First pass: determine which planets match (either directly or via a matching moon)
    const matchingParents = new Set<string>();
    for (const item of items) {
      const name = (item.dataset.name ?? '').toLowerCase();
      const parent = item.dataset.parent ?? '';
      if (name.includes(q)) {
        if (item.dataset.type === 'moon') matchingParents.add(parent);
        else matchingParents.add(item.dataset.name ?? '');
      }
    }

    // Second pass: show/hide
    for (const item of items) {
      const name = (item.dataset.name ?? '').toLowerCase();
      if (name.includes(q)) {
        item.style.display = '';
      } else if (item.dataset.type === 'planet' && matchingParents.has(item.dataset.name ?? '')) {
        // Show parent planet if a moon matches
        item.style.display = '';
      } else if (item.dataset.type === 'moon' && matchingParents.has(item.dataset.parent ?? '')) {
        // Show sibling moons when planet matches
        item.style.display = '';
      } else {
        item.style.display = 'none';
      }
    }
  }

  private showResumePrompt(saved: ExploreState): Promise<boolean> {
    return new Promise((resolve) => {
      const prompt = document.getElementById('explore-resume-prompt');
      if (!prompt) {
        resolve(true);
        return;
      }
      const uiOverlay = document.getElementById('ui-overlay');

      const info = document.getElementById('resume-info');
      if (info) {
        const dist = Math.sqrt(saved.positionAU.x ** 2 + saved.positionAU.y ** 2 + saved.positionAU.z ** 2);
        info.textContent = `${dist.toFixed(2)} AU from Sun, ${saved.visitedPlanets.length} planets visited`;
      }

      uiOverlay?.classList.add('resume-active');
      prompt.classList.add('visible');

      const resumeBtn = document.getElementById('resume-btn-continue');
      const newBtn = document.getElementById('resume-btn-new');
      let settled = false;

      const cleanup = () => {
        prompt.classList.remove('visible');
        uiOverlay?.classList.remove('resume-active');
        resumeBtn?.removeEventListener('click', onResume);
        resumeBtn?.removeEventListener('pointerup', onResume);
        newBtn?.removeEventListener('click', onNew);
        newBtn?.removeEventListener('pointerup', onNew);
        if (this.cancelResumePrompt === cancel) {
          this.cancelResumePrompt = null;
        }
      };
      const finish = (shouldResume: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(shouldResume);
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };
      const onResume = () => { finish(true); };
      const onNew = () => { finish(false); };

      this.cancelResumePrompt = cancel;
      resumeBtn?.addEventListener('click', onResume);
      resumeBtn?.addEventListener('pointerup', onResume);
      newBtn?.addEventListener('click', onNew);
      newBtn?.addEventListener('pointerup', onNew);
    });
  }

  private async startVoyagerJourney(missionId: HistoricMissionId) {
    const journey = HISTORIC_JOURNEYS[missionId];
    await this.player.ensureProfileLoaded(journey.shipProfile);
    this.rememberPreMissionState();
    if (this.landedOn) this.exitLandedMode();
    this.activeVoyagerJourney = journey;
    this.voyagerPanelDismissed = false;
    this.showShip = true;
    this.player.group.visible = true;
    this.player.setProfile(journey.shipProfile);
    const shipLabel = document.getElementById('settings-ship-label');
    if (shipLabel) shipLabel.textContent = 'On';
    this.closeMenuPanel();
    this.collapseHistoricJourneyMenu();
    this.updateMissionControlState();
    this.showVoyagerMilestone(0);
    this.showNotification(journey.readyNotification);
  }

  private stopVoyagerJourney(restorePreviousState = true) {
    this.activeVoyagerJourney = null;
    this.voyagerMilestoneIndex = 0;
    this.voyagerPanelDismissed = false;
    this.scriptedTransfer = null;
    this.player.setProfile('default');
    this.setVoyagerPanelVisible(false);
    if (restorePreviousState) this.restorePreMissionState();
    else {
      this.preMissionState = null;
      this.preMissionMenuVisible = false;
    }
    this.updateMissionControlState();
  }

  private updateVoyagerPanel(
    journey: HistoricJourney,
    milestone: HistoricMilestone,
    stepIndex: number,
  ) {
    const setText = (id: string, text: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    setText('voyager-kicker', journey.label);
    setText('voyager-step', `${stepIndex + 1} / ${journey.milestones.length}`);
    setText('voyager-title', milestone.title);
    setText('voyager-date', milestone.dateLabel);
    setText('voyager-description', milestone.description);
    setText('voyager-note', milestone.note);

    this.updateVoyagerImage(
      milestone,
      document.getElementById('voyager-image') as HTMLImageElement | null,
      document.getElementById('voyager-image-link') as HTMLAnchorElement | null,
      document.getElementById('voyager-image-caption'),
      document.getElementById('voyager-image-credit'),
    );

    const prevBtn = document.getElementById('voyager-prev') as HTMLButtonElement | null;
    const nextBtn = document.getElementById('voyager-next') as HTMLButtonElement | null;
    if (prevBtn) prevBtn.disabled = stepIndex === 0;
    if (nextBtn) nextBtn.disabled = stepIndex === journey.milestones.length - 1;
  }

  private showVoyagerMilestone(index: number) {
    const journey = this.activeVoyagerJourney;
    if (!journey) return;
    const nextIndex = THREE.MathUtils.clamp(index, 0, journey.milestones.length - 1);
    this.voyagerMilestoneIndex = nextIndex;
    this.voyagerPanelDismissed = false;
    const milestone = journey.milestones[nextIndex];
    this.applyVoyagerMilestone(milestone);
    this.setVoyagerPanelVisible(true);
    this.updateVoyagerPanel(journey, milestone, nextIndex);
  }

  private updateVoyagerImage(
    milestone: HistoricMilestone,
    imageEl: HTMLImageElement | null,
    imageLinkEl: HTMLAnchorElement | null,
    imageCaptionEl: HTMLElement | null,
    imageCreditEl: HTMLElement | null,
  ) {
    if (!imageEl) return;

    const applyMeta = (
      alt: string,
      credit: string,
      sourceLabel: string,
      sourceUrl?: string,
    ) => {
      imageEl.alt = alt;
      if (imageCaptionEl) imageCaptionEl.textContent = alt;
      if (imageCreditEl) imageCreditEl.textContent = credit;
      if (imageLinkEl) {
        imageLinkEl.textContent = sourceLabel;
        if (sourceUrl) {
          imageLinkEl.href = sourceUrl;
          imageLinkEl.style.display = '';
        } else {
          imageLinkEl.removeAttribute('href');
          imageLinkEl.style.display = 'none';
        }
      }
    };

    imageEl.onerror = null;
    applyMeta(
      milestone.imageAlt,
      milestone.imageCredit,
      milestone.imageSourceLabel,
      milestone.imageSourceUrl,
    );
    imageEl.onerror = () => {
      imageEl.onerror = null;
      imageEl.src = milestone.fallbackImageUrl;
      applyMeta(
        milestone.fallbackImageAlt,
        milestone.fallbackImageCredit,
        milestone.fallbackImageSourceLabel,
        milestone.fallbackImageSourceUrl,
      );
    };
    imageEl.src = milestone.imageUrl;
  }

  private applyVoyagerMilestone(milestone: HistoricMilestone) {
    this.timeState.currentUtcMs = milestone.dateUtcMs;
    this.timeState.paused = true;
    this.rebuildPlanetPositions();
    this.updateTimeUI();

    const destination = this.getVoyagerDestination(milestone);
    if (!destination) return;

    this.player.speedMultiplier = 0.15;
    this.updateSpeedSlider();
    this.startScriptedTransfer({ ...destination, movingAfter: false });
  }

  private vectorFromCoords(
    coords: { x: number; y: number; z: number } | undefined,
    fallback: THREE.Vector3,
  ): THREE.Vector3 {
    if (!coords) return fallback.clone();
    return new THREE.Vector3(coords.x, coords.y, coords.z);
  }

  private getVoyagerDestination(milestone: HistoricMilestone) {
    if (milestone.customScenePosition || milestone.target === 'Interstellar' || milestone.target === 'Custom') {
      if (this.landedOn) this.exitLandedMode();
      return {
        targetPosition: this.vectorFromCoords(milestone.customScenePosition, new THREE.Vector3(118, 6, -18)),
        lookTarget: this.vectorFromCoords(milestone.customLookTarget, new THREE.Vector3(0, 0, 0)),
      };
    }

    const body = ALL_BODIES.find((planet) => planet.name === milestone.target);
    if (!body) return null;

    const destination = this.getJumpDestination(body, milestone.viewDistanceMultiplier ?? 1);
    if (!destination) return null;

    return {
      targetPosition: destination.position,
      lookTarget: destination.lookTarget,
    };
  }

  private startScriptedTransfer(options: {
    targetPosition: THREE.Vector3;
    lookTarget: THREE.Vector3;
    movingAfter: boolean;
  }) {
    const dx = options.lookTarget.x - options.targetPosition.x;
    const dy = options.lookTarget.y - options.targetPosition.y;
    const dz = options.lookTarget.z - options.targetPosition.z;
    const horizontal = Math.sqrt(dx * dx + dz * dz);
    this.scriptedTransfer = {
      elapsed: 0,
      duration: 1.15,
      startPos: new THREE.Vector3(this.player.posX, this.player.posY, this.player.posZ),
      endPos: options.targetPosition.clone(),
      startHeading: this.player.heading,
      endHeading: Math.atan2(dz, dx),
      startPitch: this.player.pitch,
      endPitch: Math.atan2(dy, Math.max(horizontal, 1e-8)),
      endMoving: options.movingAfter,
    };
    this.player.moving = true;
    this.updatePauseButtonLabel();
    this.userOrbiting = false;
  }

  private updateScriptedTransfer(dt: number): boolean {
    if (!this.scriptedTransfer) return false;

    const transfer = this.scriptedTransfer;
    transfer.elapsed = Math.min(transfer.elapsed + dt, transfer.duration);
    const t = transfer.elapsed / transfer.duration;
    const ease = t * t * (3 - 2 * t);

    this.player.posX = THREE.MathUtils.lerp(transfer.startPos.x, transfer.endPos.x, ease);
    this.player.posY = THREE.MathUtils.lerp(transfer.startPos.y, transfer.endPos.y, ease);
    this.player.posZ = THREE.MathUtils.lerp(transfer.startPos.z, transfer.endPos.z, ease);
    this.player.heading = THREE.MathUtils.lerp(transfer.startHeading, transfer.endHeading, ease);
    this.player.pitch = THREE.MathUtils.lerp(transfer.startPitch, transfer.endPitch, ease);

    if (t >= 1) {
      this.player.moving = transfer.endMoving;
      this.updatePauseButtonLabel();
      this.scriptedTransfer = null;
    }

    return true;
  }

  private pointTowardMercury() {
    const mercuryPos = this.planetWorldPositions.get('Mercury');
    if (mercuryPos) {
      this.player.headToward(mercuryPos.x, mercuryPos.z, mercuryPos.y);
      this.resetCruiseCamera();
    }
  }

  private resetCruiseCamera() {
    const camDist = 0.000094;
    const forward = this.player.getForwardDirection();
    this.camera.position.set(
      -forward.x * camDist,
      -forward.y * camDist + camDist * 0.45,
      -forward.z * camDist,
    );
    this.controls.target.set(0, 0, 0);
  }

  private getPlanetCollisionRadius(radiusAU: number, renderedScale: number): number {
    return radiusAU * Math.max(renderedScale, 1) + ExploreMode.SHIP_CLEARANCE_AU;
  }

  private getJumpDestination(planet: PlanetData, distanceMultiplier = 1) {
    const pos = this.planetWorldPositions.get(planet.name);
    if (!pos) return null;

    const viewDist = Math.max(
      planet.radiusAU * 8,
      this.getPlanetCollisionRadius(planet.radiusAU, this.planetScale) + planet.radiusAU * 2,
      0.001,
    ) * distanceMultiplier;
    const offsetDir = new THREE.Vector3(-pos.x, -pos.y, -pos.z);
    if (offsetDir.lengthSq() < 1e-8) {
      offsetDir.set(-1, 0.25, 0);
    }
    offsetDir.normalize();

    return {
      position: new THREE.Vector3(
        pos.x + offsetDir.x * viewDist,
        pos.y + offsetDir.y * viewDist,
        pos.z + offsetDir.z * viewDist,
      ),
      lookTarget: new THREE.Vector3(pos.x, pos.y, pos.z),
    };
  }

  private resolvePlanetCollisions() {
    if (!this.solarSystem) return;

    const offset = new THREE.Vector3();
    const outwardHeading = new THREE.Vector3();
    const forward = this.player.getForwardDirection();

    for (const planet of this.solarSystem.planets) {
      const worldPos = planet.group.userData.worldPosAU as { x: number; y: number; z: number } | undefined;
      if (!worldPos) continue;

      offset.set(
        this.player.posX - worldPos.x,
        this.player.posY - worldPos.y,
        this.player.posZ - worldPos.z,
      );

      let distance = offset.length();
      const collisionRadius = this.getPlanetCollisionRadius(planet.data.radiusAU, planet.group.scale.x);
      if (distance >= collisionRadius) continue;

      if (distance < 1e-8) {
        offset.copy(forward).multiplyScalar(-1);
        distance = offset.length();
      }
      if (distance < 1e-8) {
        offset.set(1, 0, 0);
        distance = 1;
      }

      offset.divideScalar(distance);
      this.player.posX = worldPos.x + offset.x * collisionRadius;
      this.player.posY = worldPos.y + offset.y * collisionRadius;
      this.player.posZ = worldPos.z + offset.z * collisionRadius;

      if (forward.dot(offset) < 0.15) {
        outwardHeading.copy(offset).multiplyScalar(collisionRadius * 2);
        this.player.headToward(
          this.player.posX + outwardHeading.x,
          this.player.posZ + outwardHeading.z,
          this.player.posY + outwardHeading.y,
        );
      }

    }
  }

  jumpToPlanet(planet: PlanetData, options: { notify?: boolean; distanceMultiplier?: number } = {}) {
    if (this.isMissionActive()) return;
    const destination = this.getJumpDestination(planet, options.distanceMultiplier ?? 1);
    if (!destination) return;
    this.player.posX = destination.position.x;
    this.player.posY = destination.position.y;
    this.player.posZ = destination.position.z;
    this.player.headToward(destination.lookTarget.x, destination.lookTarget.z, destination.lookTarget.y);

    // Don't touch cruise speedMultiplier — the system throttle automatically
    // slows the player near the planet. Just ensure cruise is at least 1c
    // so they can leave the system.
    if (this.player.speedMultiplier < PlayerShip.SPEED_DEFAULT) {
      this.player.speedMultiplier = PlayerShip.SPEED_DEFAULT;
    }
    // Cap system speed for safe planet approach
    if (this.player.systemSpeedMultiplier > PlayerShip.SYSTEM_SPEED_DEFAULT) {
      this.player.systemSpeedMultiplier = PlayerShip.SYSTEM_SPEED_DEFAULT;
    }
    this.updateSpeedSlider();

    if (options.notify !== false) {
      this.showNotification(`Jumped to ${planet.name}`);
    }
    this.resetCruiseCamera();
  }

  enterLandedMode(target: NonNullable<LandedTarget>) {
    if (this.isMissionActive()) return;
    this.landedOn = target;
    this.preLandSpeed = this.player.speedMultiplier;
    this.preLandAutopilot = this.autopilot;

    // Stop ship
    this.player.speedMultiplier = 0;
    this.player.moving = false;
    this.player.group.visible = false;

    // Disable autopilot silently (target preserved for restore)
    this.autopilot = false;
    this.updateAutopilotButton();

    // Move player to body position so floating origin centers on it.
    const pos = this.getLandedBodyWorldPosition();
    if (pos) {
      this.player.posX = pos.x;
      this.player.posY = pos.y;
      this.player.posZ = pos.z;
    }

    // Configure OrbitControls to orbit the body
    const radiusAU = this.getLandedBodyRadiusAU();
    const visualRadius = radiusAU * this.planetScale;

    // For moons the visual mesh is offset from origin due to planet group
    // scaling. Run a floating-origin + scaling pass so we can find the
    // moon's scene-space position and point the camera at it.
    let orbitCenter = new THREE.Vector3(0, 0, 0);
    if (target.type === 'moon' && this.solarSystem) {
      this.applyFloatingOrigin();
      this.updatePlanetScaling();
      this.updateMoonPositions();
      const parent = this.solarSystem.planets.find(p => p.data.name === target.parentPlanet);
      const moons = this.planetMoons.get(target.parentPlanet);
      const moonMesh = moons?.find(m => m.data.name === target.name);
      if (moonMesh && parent) {
        parent.group.updateMatrixWorld(true);
        orbitCenter = moonMesh.mesh.getWorldPosition(new THREE.Vector3());
      }
    }

    this.controls.target.copy(orbitCenter);
    this.controls.minDistance = visualRadius * 1.5;
    this.controls.maxDistance = Math.max(visualRadius * 30, 0.01);
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.5;
    this.userOrbiting = false;

    // Position camera for a nice initial view
    const camDist = Math.max(visualRadius * 4, 0.0005);
    this.camera.position.set(
      orbitCenter.x + camDist,
      orbitCenter.y + camDist * 0.5,
      orbitCenter.z + camDist,
    );
    this.camera.lookAt(orbitCenter);

    // UI: hide flight controls, show leave button
    // Close any open popovers before hiding
    document.getElementById('stats-popover')?.classList.remove('visible');
    document.getElementById('stats-chevron')?.classList.remove('expanded');
    document.getElementById('time-popover')?.classList.remove('visible');
    document.getElementById('time-chevron')?.classList.remove('expanded');
    // Hide speed controls inside bar but keep bar visible for time controls
    const speedSection = document.querySelector('.bar-speed-main') as HTMLElement | null;
    if (speedSection) speedSection.style.display = 'none';
    const hide = ['explore-keys-hint', 'touch-flight-zone', 'explore-btn-travel', 'explore-btn-land'];
    for (const id of hide) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    const leaveBtn = document.getElementById('explore-btn-leave');
    if (leaveBtn) leaveBtn.style.display = '';
    const leaveName = document.getElementById('leave-body-name');
    if (leaveName) leaveName.textContent = target.name;

    this.showNotification(`Landed on ${target.name}`);
  }

  exitLandedMode() {
    if (!this.landedOn) return;
    const bodyName = this.landedOn.name;

    // Get body's current world position
    const bodyPos = this.getLandedBodyWorldPosition();
    const radiusAU = this.getLandedBodyRadiusAU();

    if (bodyPos) {
      // The cruise camera sits camDist behind the player. By facing AWAY
      // from the body, the camera ends up between the player and the body,
      // giving a close-up view of the body as you depart.
      const camDist = 0.000094; // must match resetCruiseCamera
      let safeDist: number;
      if (this.landedOn.type === 'planet') {
        // Camera must clear collision radius
        const collisionR = this.getPlanetCollisionRadius(radiusAU, this.planetScale);
        safeDist = camDist + collisionR * 1.5;
      } else {
        // Moons: no collision handler, place so camera is close
        safeDist = camDist * 1.5;
      }

      // Direction away from Sun (outward from body)
      const awayDir = new THREE.Vector3(bodyPos.x, bodyPos.y, bodyPos.z);
      if (awayDir.lengthSq() < 1e-8) awayDir.set(1, 0.1, 0);
      awayDir.normalize();

      this.player.posX = bodyPos.x + awayDir.x * safeDist;
      this.player.posY = bodyPos.y + awayDir.y * safeDist;
      this.player.posZ = bodyPos.z + awayDir.z * safeDist;

      // Head AWAY from the body — camera (behind player) ends up close to body
      this.player.headToward(
        this.player.posX + awayDir.x,
        this.player.posZ + awayDir.z,
        this.player.posY + awayDir.y,
      );
    }

    // Restore speed and movement — set a gentle system speed for nearby flight
    this.player.speedMultiplier = Math.max(this.preLandSpeed, PlayerShip.SPEED_DEFAULT);
    this.player.systemSpeedMultiplier = 0.02; // ~6k km/s — slow near planet
    this.inSystemMode = true; // force system mode display since we're near the body
    this.player.moving = true;
    this.player.group.visible = this.showShip;
    this.updateSpeedSlider();

    // Reset OrbitControls
    this.controls.autoRotate = false;
    this.controls.minDistance = 0.00001;
    this.controls.maxDistance = 5;
    this.resetCruiseCamera();

    // Restore autopilot
    this.autopilot = this.preLandAutopilot;
    this.updateAutopilotButton();

    this.landedOn = null;

    // UI: restore flight controls, hide leave button
    const speedSection = document.querySelector('.bar-speed-main') as HTMLElement | null;
    if (speedSection) speedSection.style.display = '';
    const show: Array<[string, string]> = [
      ['explore-btn-travel', ''],
    ];
    for (const [id, display] of show) {
      const el = document.getElementById(id);
      if (el) el.style.display = display;
    }
    // Conditionally show touch/keyboard hints
    const isTouchDevice = 'ontouchstart' in window;
    const keysHint = document.getElementById('explore-keys-hint');
    if (keysHint) keysHint.style.display = isTouchDevice ? 'none' : '';
    const touchZone = document.getElementById('touch-flight-zone');
    if (touchZone) touchZone.style.display = isTouchDevice ? '' : 'none';

    const leaveBtn = document.getElementById('explore-btn-leave');
    if (leaveBtn) leaveBtn.style.display = 'none';

    this.showNotification(`Departing ${bodyName}`);
  }

  private updateLanded(dt: number) {
    if (!this.solarSystem) return;

    // Advance astronomical time — planets keep moving/rotating
    this.timeState = advanceExploreTime(this.timeState, dt);
    this.rebuildPlanetPositions(dt);

    // Track the landed body: update player position to body's world position
    const bodyPos = this.getLandedBodyWorldPosition();
    if (bodyPos) {
      this.player.posX = bodyPos.x;
      this.player.posY = bodyPos.y;
      this.player.posZ = bodyPos.z;
    }

    // Apply floating origin (scene offset by player = body position)
    this.applyFloatingOrigin();

    // For moons, the player is at the real AU position but the visual mesh
    // is offset due to planet group scaling. Find the moon mesh's actual
    // scene-space position and orbit the camera around that.
    if (this.landedOn?.type === 'moon' && this.solarSystem) {
      const landed = this.landedOn;
      const parent = this.solarSystem.planets.find(p => p.data.name === landed.parentPlanet);
      const moons = this.planetMoons.get(landed.parentPlanet);
      const moonMesh = moons?.find(m => m.data.name === landed.name);
      if (moonMesh && parent) {
        parent.group.updateMatrixWorld(true);
        const moonScenePos = moonMesh.mesh.getWorldPosition(new THREE.Vector3());
        this.controls.target.copy(moonScenePos);
      }
    } else {
      this.controls.target.set(0, 0, 0);
    }
    this.controls.update();

    // FPS tracking
    this.fpsFrames++;
    const fpsNow = performance.now();
    const fpsElapsed = (fpsNow - this.fpsLastTime) / 1000;
    if (fpsElapsed >= 0.5) {
      this.fpsDisplay = Math.round(this.fpsFrames / fpsElapsed);
      this.fpsFrames = 0;
      this.fpsLastTime = fpsNow;
    }

    this.uiRefreshAccumulator += dt;
    const shouldRefreshUi = this.uiRefreshAccumulator >= ExploreMode.UI_REFRESH_INTERVAL_S;
    if (shouldRefreshUi) {
      this.uiRefreshAccumulator %= ExploreMode.UI_REFRESH_INTERVAL_S;
    }

    // Update markers
    if (this.markers) {
      const scenePositions = new Map<string, { x: number; y: number; z: number }>();
      for (const planet of this.solarSystem.planets) {
        scenePositions.set(planet.data.name, {
          x: planet.group.position.x,
          y: planet.group.position.y,
          z: planet.group.position.z,
        });
      }
      this.markers.update(scenePositions, { x: 0, y: 0, z: 0 }, this.renderer);
    }

    // Update constellation labels while landed
    if (this.constellations && this.showConstellations) {
      this.constellations.updateLabels(
        this.camera,
        this.renderer.domElement.clientWidth,
        this.renderer.domElement.clientHeight,
      );
    }

    this.updateSunLabel();
    this.updatePlanetScaling();
    this.updateMoonPositions();
    this.updateSunShader(dt);
    this.updateOrbitLineVisibility();

    if (shouldRefreshUi) {
      this.updateStatsUI();
      this.updateTimeUI();
    }
  }

  manualSave() {
    this.saveManager.saveState(this.getState());
  }

  private getState(): ExploreState {
    return {
      positionAU: { x: this.player.posX, y: this.player.posY, z: this.player.posZ },
      headingRad: this.player.heading,
      pitchRad: this.player.pitch,
      // When landed, speed/autopilot are zeroed — save the pre-land originals
      // so they restore correctly on load.
      speed: this.landedOn ? this.preLandSpeed : this.player.speedMultiplier,
      moving: this.landedOn ? false : this.player.moving,
      visitedPlanets: Array.from(this.player.visitedPlanets),
      distanceTraveled: this.player.distanceTraveled,
      timeElapsed: this.player.timeElapsed,
      timestamp: Date.now(),
      autopilot: this.landedOn ? this.preLandAutopilot : this.autopilot,
      layoutMode: this.layoutMode,
      simDate: this.timeState.currentUtcMs,
      astroTimeUtcMs: this.timeState.currentUtcMs,
      astroTimeRate: this.timeState.rate,
      astroTimePaused: this.timeState.paused,
      planetScale: this.planetScale,
      showShip: this.showShip,
      showConstellations: this.showConstellations,
      landedOn: this.landedOn,
      systemSpeed: this.player.systemSpeedMultiplier,
      systemSlowdown: this.systemSlowdown,
      autopilotTarget: this.autopilotTarget,
    };
  }

  private restoreState(saved: ExploreState) {
    this.player.posX = saved.positionAU.x;
    this.player.posY = saved.positionAU.y;
    this.player.posZ = saved.positionAU.z;
    this.player.heading = saved.headingRad;
    this.player.pitch = saved.pitchRad ?? 0;
    this.player.speedMultiplier = saved.speed;
    this.player.moving = saved.landedOn ? false : (saved.moving ?? saved.speed > 0);
    this.player.distanceTraveled = saved.distanceTraveled;
    this.player.timeElapsed = saved.timeElapsed;
    this.player.visitedPlanets = new Set(saved.visitedPlanets);

    this.autopilot = saved.autopilot;
    this.layoutMode = 'realistic';
    this.timeState = {
      currentUtcMs: saved.astroTimeUtcMs ?? saved.simDate ?? Date.now(),
      rate: saved.astroTimeRate ?? 1,
      paused: saved.astroTimePaused ?? false,
    };
    this.planetScale = 1; // Always use true scale regardless of saved value
    this.player.systemSpeedMultiplier = saved.systemSpeed ?? PlayerShip.SYSTEM_SPEED_DEFAULT;
    this.systemSlowdown = saved.systemSlowdown ?? true;
    const throttleLabel = document.getElementById('settings-throttle-label');
    if (throttleLabel) throttleLabel.textContent = this.systemSlowdown ? 'On' : 'Off';
    this.showShip = saved.showShip;
    this.player.group.visible = this.showShip;
    this.showConstellations = saved.showConstellations ?? false;
    if (this.showConstellations) {
      this.ensureConstellationsReady();
    } else if (this.constellations) {
      this.constellations.setVisible(false);
    }
    const constLabel = document.getElementById('settings-constellations-label');
    if (constLabel) constLabel.textContent = this.showConstellations ? 'On' : 'Off';

    // Restore autopilot target (kept even when landed — resumes on exit)
    this.autopilotTarget = saved.autopilotTarget ?? null;
    this.updateAutopilotButton();
    const shipLabel = document.getElementById('settings-ship-label');
    if (shipLabel) shipLabel.textContent = this.showShip ? 'On' : 'Off';

    this.rebuildPlanetPositions();

    this.updateSpeedSlider();
    this.updatePauseButtonLabel();
    this.updateTimeUI();

    // Restore landed state if saved
    if (saved.landedOn) {
      this.enterLandedMode(saved.landedOn);
    } else {
      this.resetCruiseCamera();
    }
  }

  private getStarColor(colorIndex: number): THREE.Color {
    const clamped = THREE.MathUtils.clamp(colorIndex, -0.3, 1.8);
    const t = (clamped + 0.3) / 2.1;
    const cool = new THREE.Color(0.55, 0.70, 1.0);
    const neutral = new THREE.Color(1.0, 0.97, 0.92);
    const warm = new THREE.Color(1.0, 0.68, 0.38);
    return t < 0.5
      ? cool.clone().lerp(neutral, t * 2)
      : neutral.clone().lerp(warm, (t - 0.5) * 2);
  }

  private createExploreStarfield(): THREE.Points {
    // Filter out Sol (rendered as 3D mesh)
    const catalog = BRIGHT_STAR_CATALOG.filter((s) => s.magnitude > -10);
    const starCount = catalog.length;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);

    for (let i = 0; i < starCount; i++) {
      const star = catalog[i];
      const radius = 85;
      const ra = THREE.MathUtils.degToRad(star.raDeg);
      const dec = THREE.MathUtils.degToRad(star.decDeg);
      const cosDec = Math.cos(dec);
      const color = this.getStarColor(star.colorIndex);
      const brightness = THREE.MathUtils.clamp(1.2 - (star.magnitude + 1.44) / 8, 0.25, 1.2);

      positions[i * 3] = radius * cosDec * Math.cos(ra);
      positions[i * 3 + 1] = radius * Math.sin(dec);
      positions[i * 3 + 2] = radius * cosDec * Math.sin(ra);

      colors[i * 3] = color.r * brightness;
      colors[i * 3 + 1] = color.g * brightness;
      colors[i * 3 + 2] = color.b * brightness;

      // More spread so constellation stars (mag 1-3) stand out from dim ones
      sizes[i] = THREE.MathUtils.clamp(6.0 - star.magnitude * 1.1, 1.2, 6.5);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    // Custom shader for per-vertex star sizes
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        pixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexShader: `
        attribute float size;
        varying vec3 vColor;
        uniform float pixelRatio;
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = size * pixelRatio;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float alpha = 1.0 - smoothstep(0.2, 0.5, d);
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
    });

    return new THREE.Points(geo, mat);
  }

  private getTargetWorldPosition(target: NonNullable<LandedTarget>): { x: number; y: number; z: number } | null {
    if (target.type === 'planet') {
      return this.planetWorldPositions.get(target.name) ?? null;
    }
    // For moons, use precise position when available; fall back to parent planet
    return this.moonWorldPositions.get(target.name)
      ?? this.planetWorldPositions.get(target.parentPlanet)
      ?? null;
  }

  private applyAutopilot() {
    if (!this.autopilotTarget) return;
    const pos = this.getTargetWorldPosition(this.autopilotTarget);
    if (!pos) return;
    this.player.headToward(pos.x, pos.z, pos.y);
  }

  private engageAutopilot(target: NonNullable<LandedTarget>) {
    this.autopilotTarget = target;
    this.autopilot = true;
    this.player.moving = true;
    this.updatePauseButtonLabel();
    // Ensure reasonable cruise speed
    if (this.player.speedMultiplier < PlayerShip.SPEED_DEFAULT) {
      this.player.speedMultiplier = PlayerShip.SPEED_DEFAULT;
    }
    this.updateSpeedSlider();
    this.updateAutopilotButton();
    this.showNotification(`Autopilot: heading to ${target.name}`);
  }

  private disengageAutopilot() {
    this.autopilotTarget = null;
    this.autopilot = false;
    this.updateAutopilotButton();
  }

  private disableAutopilot() {
    if (!this.autopilot) return;
    this.disengageAutopilot();
    this.showNotification('Manual flight — steer freely');
  }

  private updateAutopilotButton() {
    const btn = document.getElementById('explore-btn-autopilot');
    if (!btn) return;
    btn.classList.toggle('active', this.autopilot);
    if (this.autopilotTarget) {
      btn.innerHTML = '&#x1F916; &rarr; ' + this.autopilotTarget.name;
    } else {
      btn.innerHTML = '&#x1F916; Pilot';
    }
  }

  private toggleAutopilot() {
    if (this.autopilot) {
      this.disengageAutopilot();
      this.showNotification('Autopilot disengaged');
    } else {
      this.toggleTravelMenu(true);
    }
  }

  private checkAutopilotArrival() {
    if (!this.autopilotTarget) return;
    const pos = this.getTargetWorldPosition(this.autopilotTarget);
    if (!pos) return;
    const dx = this.player.posX - pos.x;
    const dy = this.player.posY - pos.y;
    const dz = this.player.posZ - pos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    let threshold: number;
    if (this.autopilotTarget.type === 'planet') {
      const body = ALL_BODIES.find(b => b.name === this.autopilotTarget!.name);
      threshold = body ? body.systemRadiusAU * 0.3 : 0.003;
    } else {
      const moons = this.planetMoons.get(this.autopilotTarget.parentPlanet);
      const moonMesh = moons?.find(m => m.data.name === this.autopilotTarget!.name);
      threshold = moonMesh ? Math.max(moonMesh.data.radiusAU * 10, 0.0003) : 0.0003;
    }

    if (dist < threshold) {
      const name = this.autopilotTarget.name;
      this.disengageAutopilot();
      this.showNotification(`Arrived at ${name}`);
    }
  }

  rebuildPlanetPositions(_dt = 0) {
    if (!this.solarSystem) return;
    for (let i = 0; i < this.solarSystem.planets.length; i++) {
      const planet = this.solarSystem.planets[i];
      const body = ALL_BODIES[i];
      const state = computeBodyState(body, this.timeState.currentUtcMs);

      planet.group.quaternion.copy(state.orientationQuaternion);
      planet.mesh.rotation.y = 0;
      if (planet.cloudsMesh) {
        const cloudDrift = body.name === 'Earth'
          ? ((this.timeState.currentUtcMs / 3_600_000) * 0.02) % (Math.PI * 2)
          : 0;
        planet.cloudsMesh.rotation.y = cloudDrift;
      }
      if (planet.nightMaterial) {
        const localSunDir = state.sunDirection
          .clone()
          .applyQuaternion(planet.group.quaternion.clone().invert());
        planet.nightMaterial.uniforms.sunDirection.value.copy(localSunDir);
      }

      planet.group.userData.worldPosAU = {
        x: state.positionAU.x,
        y: state.positionAU.y,
        z: state.positionAU.z,
      };
      this.planetWorldPositions.set(body.name, {
        x: state.positionAU.x,
        y: state.positionAU.y,
        z: state.positionAU.z,
      });
    }
  }

  private stepTimeRate(direction: -1 | 1) {
    const currentMagnitude = Math.abs(this.timeState.rate);
    const presets = ExploreMode.TIME_RATE_PRESETS;
    let index = presets.findIndex(rate => Math.abs(rate - currentMagnitude) < 1e-6);
    if (index === -1) {
      index = presets.findIndex(rate => rate > currentMagnitude);
      if (index === -1) index = presets.length - 1;
    }
    index = THREE.MathUtils.clamp(index + direction, 0, presets.length - 1);
    this.timeState.rate = presets[index] * (this.timeState.rate < 0 ? -1 : 1);
    this.timeState.paused = false;
    this.updateTimeUI();
  }

  private updateTimeUI() {
    const nextTimeLabel = formatDateCompact(this.timeState.currentUtcMs);
    const nextTimeRateLabel = formatTimeRateLabel(this.timeState.rate, this.timeState.paused);
    const nextInputValue = formatUtcInputValue(this.timeState.currentUtcMs);

    if (this.timeValueEl && this.lastTimeLabel !== nextTimeLabel) {
      this.timeValueEl.textContent = nextTimeLabel;
      this.lastTimeLabel = nextTimeLabel;
    }
    if (this.timeRateEl && this.lastTimeRateLabel !== nextTimeRateLabel) {
      this.timeRateEl.textContent = nextTimeRateLabel;
      this.lastTimeRateLabel = nextTimeRateLabel;
    }
    if (this.timeInputEl && this.lastTimeInputValue !== nextInputValue && document.activeElement !== this.timeInputEl) {
      this.timeInputEl.value = nextInputValue;
      this.lastTimeInputValue = nextInputValue;
    }
    const pauseBtn = document.getElementById('explore-time-pause');
    if (pauseBtn) pauseBtn.textContent = this.timeState.paused ? 'Resume' : 'Pause';
    const gyroLabel = document.getElementById('settings-gyro-label');
    if (gyroLabel) gyroLabel.textContent = this.getGyroStatusLabel();
    const gyroToggle = document.getElementById('settings-gyro-toggle');
    if (gyroToggle) {
      gyroToggle.classList.toggle('active', this.gyroEnabled);
      gyroToggle.setAttribute('aria-pressed', this.gyroEnabled ? 'true' : 'false');
      const status = this.getGyroStatusLabel();
      gyroToggle.setAttribute('title',
        status === 'Denied'
          ? 'Motion sensor permission was denied'
          : status === 'N/A'
            ? 'Motion sensors are not available on this device'
            : this.gyroEnabled
              ? 'Gyro steering is active'
              : 'Enable gyro steering',
      );
    }
  }

  private setFlightTouchFromPoint(clientX: number, clientY: number) {
    const zone = document.getElementById('touch-flight-zone');
    if (!zone) return;
    const rect = zone.getBoundingClientRect();
    const rawX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const rawY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const applyDeadZone = (value: number) => {
      const deadZone = 0.12;
      if (Math.abs(value) < deadZone) return 0;
      return THREE.MathUtils.clamp(
        ((Math.abs(value) - deadZone) / (1 - deadZone)) * Math.sign(value),
        -1,
        1,
      );
    };

    this.touchYaw = applyDeadZone(rawX);
    this.touchPitch = applyDeadZone(rawY);
  }

  private async toggleGyroControls() {
    if (this.gyroEnabled) {
      this.gyroEnabled = false;
      this.gyroBaseline = null;
      this.gyroYaw = 0;
      this.gyroPitch = 0;
      window.removeEventListener('deviceorientation', this.handleDeviceOrientation);
      this.updateTimeUI();
      this.showNotification('Gyro steering off');
      return;
    }

    const orientationCtor = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (typeof orientationCtor === 'undefined') {
      this.gyroAvailability = 'unavailable';
      this.updateTimeUI();
      this.showNotification('Gyro steering is not available on this device');
      return;
    }

    if (typeof orientationCtor.requestPermission === 'function' && this.gyroAvailability !== 'granted') {
      let permission: 'granted' | 'denied';
      try {
        permission = await orientationCtor.requestPermission();
      } catch {
        permission = 'denied';
      }
      if (permission !== 'granted') {
        this.gyroAvailability = 'denied';
        this.gyroEnabled = false;
        this.gyroBaseline = null;
        this.gyroYaw = 0;
        this.gyroPitch = 0;
        this.updateTimeUI();
        this.showNotification('Gyro permission denied');
        return;
      }
    }

    this.gyroAvailability = 'granted';
    this.gyroEnabled = true;
    this.gyroBaseline = null;
    this.gyroYaw = 0;
    this.gyroPitch = 0;
    this.gyroScreenAngle = this.getGyroScreenAngle();
    window.addEventListener('deviceorientation', this.handleDeviceOrientation);
    this.updateTimeUI();
    this.showNotification('Gyro steering on — hold your phone at a comfortable angle to calibrate');
  }

  private handleDeviceOrientation(event: DeviceOrientationEvent) {
    if (!this.gyroEnabled) return;
    const rawGamma = event.gamma;
    const rawBeta = event.beta;
    if (!Number.isFinite(rawGamma) || !Number.isFinite(rawBeta)) return;
    const gamma = rawGamma as number;
    const beta = rawBeta as number;

    const angle = this.getGyroScreenAngle();
    const mapped = this.mapGyroAxes(beta, gamma, angle);
    if (!mapped) return;

    if (this.gyroBaseline === null || angle !== this.gyroScreenAngle) {
      this.gyroScreenAngle = angle;
      this.gyroBaseline = mapped;
      this.gyroYaw = 0;
      this.gyroPitch = 0;
      return;
    }

    this.gyroYaw = THREE.MathUtils.lerp(
      this.gyroYaw,
      this.normalizeGyroDelta(this.gyroBaseline.yawDeg - mapped.yawDeg),
      0.18,
    );
    this.gyroPitch = THREE.MathUtils.lerp(
      this.gyroPitch,
      this.normalizeGyroDelta(mapped.pitchDeg - this.gyroBaseline.pitchDeg),
      0.18,
    );
  }

  private getGyroStatusLabel() {
    if (this.gyroEnabled) return 'On';
    if (this.gyroAvailability === 'denied') return 'Denied';
    if (this.gyroAvailability === 'unavailable') return 'N/A';
    return 'Off';
  }

  private getGyroScreenAngle() {
    const orientation = screen.orientation;
    if (orientation && typeof orientation.angle === 'number') {
      return ((orientation.angle % 360) + 360) % 360;
    }
    const legacyOrientation = (window as Window & { orientation?: number }).orientation;
    return typeof legacyOrientation === 'number'
      ? ((legacyOrientation % 360) + 360) % 360
      : 0;
  }

  private mapGyroAxes(beta: number, gamma: number, angle: number) {
    if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return null;

    if (angle === 90) {
      return { yawDeg: beta, pitchDeg: -gamma };
    }
    if (angle === 180) {
      return { yawDeg: -gamma, pitchDeg: -beta };
    }
    if (angle === 270) {
      return { yawDeg: -beta, pitchDeg: gamma };
    }
    return { yawDeg: gamma, pitchDeg: beta };
  }

  private normalizeGyroDelta(deltaDeg: number) {
    const deadZone = 3;
    const fullTilt = 28;
    const absDelta = Math.abs(deltaDeg);
    if (absDelta <= deadZone) return 0;
    const normalized = (absDelta - deadZone) / (fullTilt - deadZone);
    return THREE.MathUtils.clamp(normalized * Math.sign(deltaDeg), -1, 1);
  }

  dispose() {
    this.deactivate();
    if (this.markers) {
      this.markers.dispose();
      this.markers = null;
    }
    if (this.moonLabelContainer) {
      this.moonLabelContainer.remove();
      this.moonLabelContainer = null;
      this.moonLabels.clear();
    }
    if (this.sunLabel) {
      this.sunLabel.remove();
      this.sunLabel = null;
    }
    // Clean up Three.js objects from scene
    if (this.solarSystem) {
      this.solarSystem.sun.removeFromParent();
      this.solarSystem.ambientLight.removeFromParent();
      this.solarSystem.asteroidBelt.removeFromParent();
      for (const p of this.solarSystem.planets) p.group.removeFromParent();
      for (const o of this.solarSystem.orbitLines) o.removeFromParent();
    }
    this.player.group.removeFromParent();
    if (this.starfield) this.starfield.removeFromParent();
    if (this.constellations) {
      this.constellations.dispose();
      this.constellations = null;
    }
  }
}
