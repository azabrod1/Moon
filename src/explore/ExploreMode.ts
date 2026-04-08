import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSolarSystem, type SolarSystemObjects, type LayoutMode } from './SolarSystem';
import { PlayerShip } from './PlayerShip';
import { PlanetMarkers } from './PlanetMarker';
import { SaveManager, createDefaultState, type ExploreState, type LandedTarget } from './SaveManager';
import { computeStats, formatAU } from './StatsPanel';
import { ALL_BODIES, type PlanetData } from './planets/planetData';
import { createMoonMeshes, type MoonMesh } from './PlanetFactory';
import {
  advanceExploreTime,
  computeBodyState,
  formatTimeRateLabel,
  formatUtcInputValue,
  formatUtcLabel,
  parseUtcInputValue,
  type ExploreTimeState,
} from './astronomy';
import { BRIGHT_STAR_CATALOG } from './data/brightStars';
import { getMoonsByPlanet } from './planets/moonData';

export class ExploreMode {
  private static readonly TIME_RATE_PRESETS = [1, 60, 1200, 3600, 21600, 86400, 604800, 2592000, 31557600];
  private static readonly SHIP_CLEARANCE_AU = (1_737.4 / 149_597_870.7) * 1.5;
  private static readonly UI_REFRESH_INTERVAL_S = 1 / 8;
  private static readonly EARTH_DETAIL_MIN_DISTANCE_AU = 0.03;
  private static readonly EARTH_DETAIL_MIN_ANGULAR_DIAMETER_RAD = 0.003;

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;

  private solarSystem: SolarSystemObjects | null = null;
  private player: PlayerShip;
  private markers: PlanetMarkers | null = null;
  private saveManager: SaveManager;
  private starfield: THREE.Points | null = null;

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

  // Autopilot: auto-steer toward next planet outward
  private autopilot = true;

  // Planet layout mode
  private layoutMode: LayoutMode = 'realistic';

  private timeState: ExploreTimeState = {
    currentUtcMs: Date.now(),
    rate: 1,
    paused: false,
  };

  // Planet visual scale multiplier (real scale = 1)
  private planetScale = 32;

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

  // Moon labels
  private moonLabels = new Map<string, HTMLDivElement>();
  private moonLabelContainer: HTMLDivElement | null = null;

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
  private speedSliderEl: HTMLInputElement | null = null;
  private speedValueEl: HTMLElement | null = null;
  private timeValueEl: HTMLElement | null = null;
  private timeRateEl: HTMLElement | null = null;
  private timeInputEl: HTMLInputElement | null = null;
  private lastTimeLabel = '';
  private lastTimeRateLabel = '';
  private lastTimeInputValue = '';
  private uiRefreshAccumulator = ExploreMode.UI_REFRESH_INTERVAL_S;

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

  async activate(): Promise<void> {
    this.active = true;

    // Show explore UI
    const exploreUI = document.getElementById('explore-ui');
    if (exploreUI) exploreUI.style.display = 'block';

    // Cache UI element references
    this.statsEl = document.getElementById('explore-stats-compact');
    this.progressEl = document.getElementById('explore-progress-fill');
    this.notificationEl = document.getElementById('explore-notification');
    this.speedSliderEl = document.getElementById('explore-speed-slider') as HTMLInputElement;
    this.speedValueEl = document.getElementById('explore-speed-value');
    this.timeValueEl = document.getElementById('explore-time-value');
    this.timeRateEl = document.getElementById('explore-time-rate');
    this.timeInputEl = document.getElementById('explore-time-input') as HTMLInputElement;

    // Create solar system if not yet created
    if (!this.solarSystem) {
      const loadingMsg = document.getElementById('explore-loading-msg');
      if (loadingMsg) loadingMsg.style.display = 'block';
      this.solarSystem = await createSolarSystem((msg) => {
        if (loadingMsg) loadingMsg.textContent = msg;
      }, this.useBloom, this.layoutMode, new Date(this.timeState.currentUtcMs));
      if (loadingMsg) loadingMsg.style.display = 'none';

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
            'position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:14;overflow:visible;';
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

    // Check for saved state — show resume prompt
    const savedState = this.saveManager.loadState();
    if (savedState) {
      const shouldResume = await this.showResumePrompt(savedState);
      if (shouldResume) {
        this.restoreState(savedState);
      } else {
        this.saveManager.clearState();
        this.restoreState(createDefaultState());
        this.pointTowardMercury();
      }
    } else {
      this.restoreState(createDefaultState());
      this.pointTowardMercury();
      this.showIntroText();
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
  }

  deactivate(): void {
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
  }

  update(dt: number): void {
    if (!this.active || !this.solarSystem) return;

    // Landed mode: camera orbits body, skip flight controls
    if (this.landedOn) {
      this.updateLanded(dt);
      return;
    }

    // Process keyboard input
    this.processInput();

    // Autopilot: steer toward next planet if no manual input
    if (this.autopilot && this.player.yawInput === 0 && this.player.pitchInput === 0) {
      this.applyAutopilot();
    }

    // Update player
    this.player.update(dt);
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

    // Update Sun label
    this.updateSunLabel();

    this.updatePlanetScaling();
    this.player.group.scale.setScalar(16);
    this.resolvePlanetCollisions();

    // Check orbit crossings and visits after scale/collision are applied so the
    // reachable interaction shell matches the visual shell.
    this.checkOrbitCrossings();
    this.checkPlanetVisits();
    this.checkProximityLand();

    this.updateMoonPositions();
    this.updateSunShader(dt);
    this.updateOrbitLineVisibility();

    // Update stats/time overlays on a lower cadence than the render loop to avoid
    // forcing layout/style work every frame.
    if (shouldRefreshUi) {
      this.updateStatsUI();
      this.updateTimeUI();
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

    // Starfield follows camera (always centered on player)
    if (this.starfield) {
      this.starfield.position.set(0, 0, 0);
    }
  }

  private updateCameraFollow() {
    // Player is always at scene origin due to floating origin
    this.controls.target.set(0, 0, 0);

    // Chase camera: smoothly lerp behind the ship unless user is orbiting
    if (this.userOrbiting) return;

    const camDist = 0.003;
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

  private getLandedBodyWorldPosition(): { x: number; y: number; z: number } | null {
    if (!this.landedOn) return null;
    if (this.landedOn.type === 'planet') {
      return this.planetWorldPositions.get(this.landedOn.name) ?? null;
    }
    // Moon: parent position + orbital offset
    const parentPos = this.planetWorldPositions.get(this.landedOn.parentPlanet);
    if (!parentPos) return null;
    const moons = this.planetMoons.get(this.landedOn.parentPlanet);
    if (!moons) return null;
    const moonMesh = moons.find(m => m.data.name === this.landedOn!.name);
    if (!moonMesh) return null;
    const moonTimeSeconds = this.timeState.currentUtcMs / 1000;
    const angle = (moonTimeSeconds / (moonMesh.data.orbitalPeriodDays * 86400)) * Math.PI * 2;
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

  private updatePlanetScaling() {
    if (!this.solarSystem) return;
    // Distance-based planet scaling:
    //   Close (<0.3 AU): full planetScale
    //   Mid (0.3–2.5 AU): smooth ramp to half planetScale
    //   Far (>2.5 AU): planetScale * 0.5
    for (const planet of this.solarSystem.planets) {
      const wp = planet.group.userData.worldPosAU as { x: number; y: number; z: number };
      const dx = this.player.posX - wp.x;
      const dy = this.player.posY - wp.y;
      const dz = this.player.posZ - wp.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const linear = 1 - Math.min(1, Math.max(0, (dist - 0.3) / 2.2));
      const t = linear * linear * (3 - 2 * linear);
      const farScale = Math.min(8, this.planetScale);
      const s = farScale + (this.planetScale - farScale) * t;
      planet.group.scale.setScalar(s);

      if (planet.atmosphere) {
        const glowMat = planet.atmosphere.material as THREE.ShaderMaterial;
        if (glowMat.uniforms?.alphaScale) {
          glowMat.uniforms.alphaScale.value = (0.15 + 0.3 * t);
        }
      }

      if (planet.data.name === 'Earth') {
        const renderedAngularDiameter = dist > 1e-8
          ? (planet.data.radiusAU * planet.group.scale.x * 2) / dist
          : Infinity;
        const keepEarthDetail =
          dist <= ExploreMode.EARTH_DETAIL_MIN_DISTANCE_AU ||
          renderedAngularDiameter >= ExploreMode.EARTH_DETAIL_MIN_ANGULAR_DIAMETER_RAD;
        if (planet.nightMesh) planet.nightMesh.visible = keepEarthDetail;
        if (planet.cloudsMesh) planet.cloudsMesh.visible = keepEarthDetail;
      }
    }
  }

  private updateMoonPositions() {
    if (!this.solarSystem) return;
    const moonTimeSeconds = this.timeState.currentUtcMs / 1000;
    for (const planet of this.solarSystem.planets) {
      const moons = this.planetMoons.get(planet.data.name);
      if (!moons || moons.length === 0) continue;

      const wp = planet.group.userData.worldPosAU as { x: number; y: number; z: number };
      const dx = this.player.posX - wp.x;
      const dy = this.player.posY - wp.y;
      const dz = this.player.posZ - wp.z;
      const distToPlayer = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const threshold = Math.max(planet.data.radiusAU * 120, 0.3);
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
          const angle = (moonTimeSeconds / (m.data.orbitalPeriodDays * 86400)) * Math.PI * 2;
          const r = m.data.orbitalRadiusAU;
          m.mesh.position.set(r * Math.cos(angle), 0, r * Math.sin(angle));

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
      // Accelerate — use additive at low speeds for responsiveness from zero
      if (this.player.speedMultiplier < 0.05) {
        this.player.speedMultiplier = Math.min(this.player.speedMultiplier + 0.002, PlayerShip.SPEED_MAX);
      } else {
        this.player.speedMultiplier = Math.min(this.player.speedMultiplier * 1.01, PlayerShip.SPEED_MAX);
      }
      this.updateSpeedSlider();
    }
    if (throttle < 0) {
      // Decelerate — multiplicative, clamp to zero
      this.player.speedMultiplier = Math.max(this.player.speedMultiplier * 0.99 - 0.001, 0);
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
      this.toggleTravelMenu();
      return;
    }

    // Suppress all other keys while landed
    if (this.landedOn) return;

    this.keys.add(e.key.toLowerCase());

    // Space toggles pause
    if (e.key === ' ') {
      e.preventDefault();
      this.player.moving = !this.player.moving;
      const btn = document.getElementById('explore-btn-pause');
      if (btn) btn.textContent = this.player.moving ? '\u23F8' : '\u25B6';
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

      // Check moons of nearby planets
      const moons = this.planetMoons.get(planet.data.name);
      if (!moons) continue;
      const moonThreshold = Math.max(planet.data.radiusAU * 120, 0.3);
      if (dist > moonThreshold) continue;
      for (const m of moons) {
        const moonWorldPos = m.mesh.getWorldPosition(new THREE.Vector3());
        // moonWorldPos is in scene space (offset by floating origin)
        // player is at origin in scene space
        const md = moonWorldPos.length();
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
    const el = document.getElementById('explore-intro');
    if (!el) return;
    el.classList.add('visible');
    const dismiss = () => {
      el.classList.remove('visible');
      el.removeEventListener('click', dismiss);
      window.removeEventListener('keydown', dismiss);
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

  private updateSpeedSlider() {
    if (this.speedSliderEl) {
      // Map speed multiplier to slider (logarithmic, with 0 at far left)
      if (this.player.speedMultiplier <= 0.01) {
        this.speedSliderEl.value = '0';
      } else {
        const minLog = 0.05; // minimum for log scale
        const logVal = Math.log(Math.max(this.player.speedMultiplier, minLog) / minLog) /
                       Math.log(PlayerShip.SPEED_MAX / minLog);
        this.speedSliderEl.value = String(logVal * 100);
      }
    }
    if (this.speedValueEl) {
      this.speedValueEl.textContent = this.player.speedMultiplier < 0.01
        ? '0c'
        : `${this.player.speedC.toFixed(1)}c`;
    }
  }

  private wireUpUI() {
    // Speed slider
    const speedSlider = document.getElementById('explore-speed-slider') as HTMLInputElement;
    if (speedSlider) {
      speedSlider.addEventListener('input', () => {
        const t = parseFloat(speedSlider.value) / 100;
        if (t < 0.01) {
          this.player.speedMultiplier = 0;
        } else {
          // Logarithmic mapping
          const minLog = 0.05;
          this.player.speedMultiplier = minLog * Math.pow(PlayerShip.SPEED_MAX / minLog, t);
        }
        this.updateSpeedSlider();
      });
    }
    document.getElementById('explore-speed-up')?.addEventListener('click', () => {
      if (this.player.speedMultiplier < 0.05) {
        this.player.speedMultiplier = 0.05;
      } else {
        this.player.speedMultiplier = Math.min(this.player.speedMultiplier * 1.35, PlayerShip.SPEED_MAX);
      }
      this.updateSpeedSlider();
    });
    document.getElementById('explore-speed-down')?.addEventListener('click', () => {
      if (this.player.speedMultiplier < 0.06) {
        this.player.speedMultiplier = 0;
      } else {
        this.player.speedMultiplier = Math.max(this.player.speedMultiplier * 0.72, 0);
      }
      this.updateSpeedSlider();
    });

    // Play/Pause
    document.getElementById('explore-btn-pause')?.addEventListener('click', () => {
      this.player.moving = !this.player.moving;
      const btn = document.getElementById('explore-btn-pause');
      if (btn) btn.textContent = this.player.moving ? '\u23F8' : '\u25B6';
    });

    // Save button
    document.getElementById('explore-btn-save')?.addEventListener('click', () => {
      this.saveManager.saveState(this.getState());
      this.showNotification('Game saved!');
    });

    // New Journey button
    document.getElementById('explore-btn-new')?.addEventListener('click', () => {
      if (this.landedOn) this.exitLandedMode();
      this.saveManager.clearState();
      this.restoreState(createDefaultState());
      this.pointTowardMercury();
      this.showNotification('New journey started!');
    });

    // Autopilot toggle
    document.getElementById('explore-btn-autopilot')?.addEventListener('click', () => {
      this.toggleAutopilot();
    });

    // Menu panel toggle (replaces separate settings + save/new buttons)
    document.getElementById('explore-btn-menu')?.addEventListener('click', () => {
      const panel = document.getElementById('explore-menu-panel');
      if (panel) panel.classList.toggle('visible');
    });

    // Stats panel expand/collapse
    const statsToggle = document.getElementById('stats-toggle');
    const statsPanel = document.getElementById('explore-stats-compact');
    if (statsToggle && statsPanel) {
      statsToggle.addEventListener('click', () => {
        statsPanel.classList.toggle('stats-expanded');
      });
    }

    // Time section expand/collapse
    const timeToggle = document.getElementById('stat-time-toggle');
    const timeSection = document.getElementById('stat-time-section');
    if (timeToggle && timeSection) {
      timeToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        timeSection.classList.toggle('stat-time-expanded');
      });
      // Prevent control button clicks from closing the panel
      const timeControls = timeSection.querySelector('.stat-time-controls');
      if (timeControls) {
        timeControls.addEventListener('click', (e) => e.stopPropagation());
      }
    }

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

    // Planet scale slider
    const scaleSlider = document.getElementById('settings-planet-scale') as HTMLInputElement;
    if (scaleSlider) {
      scaleSlider.addEventListener('input', () => {
        this.planetScale = parseInt(scaleSlider.value, 10);
        const label = document.getElementById('settings-scale-label');
        if (label) label.textContent = `${this.planetScale}×`;
        this.resetCruiseCamera();
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
    // Travel action bar: Land vs Jump
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

  private toggleTravelMenu() {
    const menu = document.getElementById('travel-menu');
    if (!menu) return;
    const isVisible = menu.classList.contains('visible');
    if (isVisible) {
      this.closeTravelMenu();
    } else {
      // Close menu panel if open
      document.getElementById('explore-menu-panel')?.classList.remove('visible');
      menu.classList.add('visible');
      this.travelSelection = null;
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
        search.focus();
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
      if (!prompt) { resolve(true); return; }
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

      const cleanup = () => {
        prompt.classList.remove('visible');
        uiOverlay?.classList.remove('resume-active');
        resumeBtn?.removeEventListener('click', onResume);
        resumeBtn?.removeEventListener('pointerup', onResume);
        newBtn?.removeEventListener('click', onNew);
        newBtn?.removeEventListener('pointerup', onNew);
      };
      const onResume = () => { cleanup(); resolve(true); };
      const onNew = () => { cleanup(); resolve(false); };

      resumeBtn?.addEventListener('click', onResume);
      resumeBtn?.addEventListener('pointerup', onResume);
      newBtn?.addEventListener('click', onNew);
      newBtn?.addEventListener('pointerup', onNew);
    });
  }

  private pointTowardMercury() {
    const mercuryPos = this.planetWorldPositions.get('Mercury');
    if (mercuryPos) {
      this.player.headToward(mercuryPos.x, mercuryPos.z, mercuryPos.y);
      this.resetCruiseCamera();
    }
  }

  private resetCruiseCamera() {
    const camDist = 0.003;
    const forward = this.player.getForwardDirection();
    this.camera.position.set(
      -forward.x * camDist,
      -forward.y * camDist + camDist * 0.45,
      -forward.z * camDist,
    );
    this.controls.target.set(0, 0, 0);
  }

  private getPlanetCollisionRadius(radiusAU: number, renderedScale: number): number {
    return radiusAU * Math.max(renderedScale, 1) + ExploreMode.SHIP_CLEARANCE_AU * this.planetScale;
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

      if (this.player.speedMultiplier > 0.5) {
        this.player.speedMultiplier *= 0.7;
      }
    }
  }

  jumpToPlanet(planet: PlanetData) {
    const pos = this.planetWorldPositions.get(planet.name);
    if (!pos) return;

    const viewDist = Math.max(
      planet.radiusAU * 8,
      this.getPlanetCollisionRadius(planet.radiusAU, this.planetScale) + planet.radiusAU * 2,
      0.001,
    );
    const offsetDir = new THREE.Vector3(-pos.x, -pos.y, -pos.z);
    if (offsetDir.lengthSq() < 1e-8) {
      offsetDir.set(-1, 0.25, 0);
    }
    offsetDir.normalize();
    this.player.posX = pos.x + offsetDir.x * viewDist;
    this.player.posY = pos.y + offsetDir.y * viewDist;
    this.player.posZ = pos.z + offsetDir.z * viewDist;
    this.player.headToward(pos.x, pos.z, pos.y);

    this.player.speedMultiplier = 0.1;
    this.updateSpeedSlider();

    this.showNotification(`Jumped to ${planet.name}`);
    this.resetCruiseCamera();
  }

  enterLandedMode(target: NonNullable<LandedTarget>) {
    this.landedOn = target;
    this.preLandSpeed = this.player.speedMultiplier;
    this.preLandAutopilot = this.autopilot;

    // Stop ship
    this.player.speedMultiplier = 0;
    this.player.moving = false;
    this.player.group.visible = false;

    // Disable autopilot silently
    this.autopilot = false;
    const apBtn = document.getElementById('explore-btn-autopilot');
    if (apBtn) apBtn.classList.toggle('active', false);

    // Move player to body position so floating origin centers on it
    const pos = this.getLandedBodyWorldPosition();
    if (pos) {
      this.player.posX = pos.x;
      this.player.posY = pos.y;
      this.player.posZ = pos.z;
    }

    // Configure OrbitControls to orbit the body
    const radiusAU = this.getLandedBodyRadiusAU();
    const visualRadius = radiusAU * this.planetScale;
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = visualRadius * 1.5;
    this.controls.maxDistance = Math.max(visualRadius * 30, 0.01);
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.5;
    this.userOrbiting = false;

    // Position camera for a nice initial view
    const camDist = Math.max(visualRadius * 4, 0.0005);
    this.camera.position.set(camDist, camDist * 0.5, camDist);
    this.camera.lookAt(0, 0, 0);

    // UI: hide flight controls, show leave button
    const hide = ['explore-speed-bar', 'explore-keys-hint', 'touch-flight-zone', 'explore-btn-travel', 'explore-btn-land'];
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
      // Compute clearance: safe distance from body
      const clearance = this.landedOn.type === 'planet'
        ? this.getPlanetCollisionRadius(radiusAU, this.planetScale) * 1.5
        : radiusAU * this.planetScale * 3;
      const safeDist = Math.max(clearance, 0.001);

      // Direction away from Sun (outward from body)
      const awayDir = new THREE.Vector3(bodyPos.x, bodyPos.y, bodyPos.z);
      if (awayDir.lengthSq() < 1e-8) awayDir.set(1, 0.1, 0);
      awayDir.normalize();

      this.player.posX = bodyPos.x + awayDir.x * safeDist;
      this.player.posY = bodyPos.y + awayDir.y * safeDist;
      this.player.posZ = bodyPos.z + awayDir.z * safeDist;

      // Head away from the body
      this.player.headToward(
        this.player.posX + awayDir.x,
        this.player.posZ + awayDir.z,
        this.player.posY + awayDir.y,
      );
    }

    // Restore speed and movement
    this.player.speedMultiplier = Math.max(this.preLandSpeed, 0.1);
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
    const apBtn = document.getElementById('explore-btn-autopilot');
    if (apBtn) apBtn.classList.toggle('active', this.autopilot);

    this.landedOn = null;

    // UI: restore flight controls, hide leave button
    const show: Array<[string, string]> = [
      ['explore-speed-bar', 'flex'],
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

    // OrbitControls orbits the body at origin
    this.controls.target.set(0, 0, 0);
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
      landedOn: this.landedOn,
    };
  }

  private restoreState(saved: ExploreState) {
    this.player.posX = saved.positionAU.x;
    this.player.posY = saved.positionAU.y;
    this.player.posZ = saved.positionAU.z;
    this.player.heading = saved.headingRad;
    this.player.pitch = saved.pitchRad ?? 0;
    this.player.speedMultiplier = saved.speed;
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
    this.planetScale = saved.planetScale;
    this.showShip = saved.showShip;
    this.player.group.visible = this.showShip;

    const apBtn = document.getElementById('explore-btn-autopilot');
    if (apBtn) apBtn.classList.toggle('active', this.autopilot);
    const scaleSlider = document.getElementById('settings-planet-scale') as HTMLInputElement;
    if (scaleSlider) scaleSlider.value = String(this.planetScale);
    const scaleLabel = document.getElementById('settings-scale-label');
    if (scaleLabel) scaleLabel.textContent = `${this.planetScale}×`;
    const shipLabel = document.getElementById('settings-ship-label');
    if (shipLabel) shipLabel.textContent = this.showShip ? 'On' : 'Off';

    this.rebuildPlanetPositions();

    this.updateSpeedSlider();
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
    const cool = new THREE.Color(0.66, 0.78, 1.0);
    const neutral = new THREE.Color(1.0, 0.98, 0.94);
    const warm = new THREE.Color(1.0, 0.76, 0.5);
    return t < 0.5
      ? cool.clone().lerp(neutral, t * 2)
      : neutral.clone().lerp(warm, (t - 0.5) * 2);
  }

  private createExploreStarfield(): THREE.Points {
    const starCount = BRIGHT_STAR_CATALOG.length;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);

    for (let i = 0; i < starCount; i++) {
      const star = BRIGHT_STAR_CATALOG[i];
      const radius = 85;
      const ra = THREE.MathUtils.degToRad(star.raDeg);
      const dec = THREE.MathUtils.degToRad(star.decDeg);
      const cosDec = Math.cos(dec);
      const color = this.getStarColor(star.colorIndex);
      const brightness = THREE.MathUtils.clamp(1.2 - (star.magnitude + 1.44) / 8, 0.25, 1.2);

      positions[i * 3] = radius * cosDec * Math.cos(ra);
      positions[i * 3 + 1] = radius * Math.sin(dec);
      positions[i * 3 + 2] = radius * cosDec * Math.sin(ra);

      // Realistic star color temperature distribution
      colors[i * 3] = color.r * brightness;
      colors[i * 3 + 1] = color.g * brightness;
      colors[i * 3 + 2] = color.b * brightness;

      // Variable sizes — most small, few bright
      sizes[i] = THREE.MathUtils.clamp(5.4 - star.magnitude, 1.2, 5.4);
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

  private applyAutopilot() {
    // Find next planet outward in orbital order from player's Sun distance
    const playerDist = this.player.getDistanceFromSun();
    for (const body of ALL_BODIES) {
      if (body.semiMajorAxisAU > playerDist) {
        const pos = this.planetWorldPositions.get(body.name);
        if (pos) {
          this.player.headToward(pos.x, pos.z, pos.y);
        }
        break;
      }
    }
  }

  private disableAutopilot() {
    if (!this.autopilot) return;
    this.autopilot = false;
    const btn = document.getElementById('explore-btn-autopilot');
    if (btn) btn.classList.toggle('active', false);
    this.showNotification('Manual flight — steer freely');
  }

  private toggleAutopilot() {
    if (this.autopilot) {
      this.disableAutopilot();
      // When explicitly toggling off via button/key, zero speed
      this.player.speedMultiplier = 0;
      this.updateSpeedSlider();
    } else {
      this.autopilot = true;
      const btn = document.getElementById('explore-btn-autopilot');
      if (btn) btn.classList.toggle('active', true);
      // Returning to autopilot: restore default speed if stopped
      if (this.player.speedMultiplier < 0.05) {
        this.player.speedMultiplier = PlayerShip.SPEED_DEFAULT;
        this.updateSpeedSlider();
      }
      this.showNotification('Pilot engaged — heading to next planet');
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
    const nextTimeLabel = formatUtcLabel(this.timeState.currentUtcMs);
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
  }
}
