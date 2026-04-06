import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSolarSystem, getPlanetOrbitalPosition, type SolarSystemObjects, type LayoutMode } from './SolarSystem';
import { PlayerShip } from './PlayerShip';
import { PlanetMarkers } from './PlanetMarker';
import { SaveManager, createDefaultState, type ExploreState } from './SaveManager';
import { computeStats, formatAU, formatETA } from './StatsPanel';
import { ALL_BODIES, type PlanetData } from './planets/planetData';
import { createMoonMeshes, type MoonMesh } from './PlanetFactory';

export class ExploreMode {
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

  // Elapsed time for moon orbital animation
  private moonTime = 0;

  // Keyboard state
  private keys = new Set<string>();

  // Orbit crossing notifications
  private lastCrossedOrbit: string | null = null;
  private notificationTimeout: number | null = null;
  private uiWired = false;

  // Autopilot: auto-steer toward next planet outward
  private autopilot = true;

  // Planet layout mode
  private layoutMode: LayoutMode = 'aligned';

  // Simulation date for realistic mode
  private simDate: Date = new Date();

  // Planet visual scale multiplier (real scale = 1, default 5x for visibility)
  private planetScale = 16;

  // Show player ship mesh for size comparison
  private showShip = true;

  // Touch steer state
  private touchSteer = 0; // -1 left, 0 none, 1 right
  // Touch throttle state: 1 = accelerate, -1 = decelerate, 0 = none
  private touchThrottle = 0;

  // Moon labels
  private moonLabels = new Map<string, HTMLDivElement>();
  private moonLabelContainer: HTMLDivElement | null = null;

  // UI elements
  private statsEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private notificationEl: HTMLElement | null = null;
  private speedSliderEl: HTMLInputElement | null = null;
  private speedValueEl: HTMLElement | null = null;

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

    // Key handlers
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
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

    // Create solar system if not yet created
    if (!this.solarSystem) {
      const loadingMsg = document.getElementById('explore-loading-msg');
      if (loadingMsg) loadingMsg.style.display = 'block';
      this.solarSystem = await createSolarSystem((msg) => {
        if (loadingMsg) loadingMsg.textContent = msg;
      }, this.useBloom, this.layoutMode, this.simDate);
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
    const hasSaved = this.saveManager.hasSavedState();
    if (hasSaved) {
      const shouldResume = await this.showResumePrompt();
      if (shouldResume) {
        const saved = this.saveManager.loadState();
        if (saved) this.restoreState(saved);
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
    this.updateCameraFollow();

    // Start auto-save
    this.saveManager.startAutoSave(() => this.getState());

    // Wire up keyboard
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);

    // Wire up UI controls (once only)
    if (!this.uiWired) {
      this.wireUpUI();
      this.uiWired = true;
    }

    // Show all solar system objects
    this.setObjectsVisible(true);
  }

  deactivate(): void {
    this.active = false;

    // Save before leaving
    this.saveManager.saveState(this.getState());
    this.saveManager.stopAutoSave();

    // Remove keyboard handlers
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);

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

    // Process keyboard input
    this.processInput();

    // Autopilot: steer toward next planet if no manual input
    if (this.autopilot && this.player.steerInput === 0) {
      this.applyAutopilot();
    }

    // Update player
    this.player.update(dt);

    // Apply floating origin: offset everything by player position
    this.applyFloatingOrigin();

    // Update camera follow
    this.updateCameraFollow();
    this.controls.update();

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

    // Check orbit crossings
    this.checkOrbitCrossings();

    // Check planet visits
    this.checkPlanetVisits();

    // Distance-based planet scaling:
    //   Close (<0.5 AU): full planetScale
    //   Mid (0.5–3 AU): ramps down to 0.5x
    //   Far (>3 AU): 0.5x (smaller + dimmer so distant planets don't dominate)
    for (const planet of this.solarSystem.planets) {
      const wp = planet.group.userData.worldPosAU as { x: number; y: number; z: number };
      const dx = this.player.posX - wp.x;
      const dz = this.player.posZ - wp.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      // t: 1 when close, 0 when far
      const t = 1 - Math.min(1, Math.max(0, (dist - 0.5) / 2.5));
      // Scale: planetScale when close, 0.5 when far
      const s = 0.5 + (this.planetScale - 0.5) * t;
      planet.group.scale.setScalar(s);

      // Dim far-away planet atmosphere glows
      if (planet.atmosphere) {
        const glowMat = planet.atmosphere.material as THREE.ShaderMaterial;
        if (glowMat.uniforms?.alphaScale) {
          // Full glow when close, half when far
          glowMat.uniforms.alphaScale.value = (0.15 + 0.3 * t);
        }
      }
    }
    this.player.group.scale.setScalar(this.planetScale);

    // Update planet rotations, clouds, and night lights
    for (const planet of this.solarSystem.planets) {
      if (planet.mesh) {
        planet.mesh.rotation.y += dt * (10 / planet.data.rotationPeriodHours);
      }
      // Rotate Earth's clouds slightly faster
      if (planet.cloudsMesh) {
        planet.cloudsMesh.rotation.y += dt * (12 / planet.data.rotationPeriodHours);
      }
      // Update Earth night lights sun direction
      if (planet.nightMaterial) {
        const sunWorldPos = this.solarSystem.sun.position;
        const planetPos = planet.group.position;
        const sunDir = new THREE.Vector3(
          sunWorldPos.x - planetPos.x,
          sunWorldPos.y - planetPos.y,
          sunWorldPos.z - planetPos.z,
        ).normalize();
        planet.nightMaterial.uniforms.sunDirection.value.copy(sunDir);
      }
    }

    // Update moons: visibility, scale, and orbital position at real distances
    this.moonTime += dt;
    for (const planet of this.solarSystem.planets) {
      const moons = this.planetMoons.get(planet.data.name);
      if (!moons || moons.length === 0) continue;

      // Distance from player to planet
      const wp = planet.group.userData.worldPosAU as { x: number; y: number; z: number };
      const dx = this.player.posX - wp.x;
      const dz = this.player.posZ - wp.z;
      const distToPlayer = Math.sqrt(dx * dx + dz * dz);

      // Show moons when close enough to the planet
      const threshold = Math.max(planet.data.radiusAU * 120, 0.3);
      const visible = distToPlayer < threshold;

      const parentR = planet.data.radiusAU;

      const canvasW = this.renderer.domElement.clientWidth;
      const canvasH = this.renderer.domElement.clientHeight;
      const tempV = new THREE.Vector3();

      for (const m of moons) {
        const label = this.moonLabels.get(m.data.name);
        m.mesh.visible = visible;
        if (visible) {
          const angle = (this.moonTime / (m.data.orbitalPeriodDays * 86400)) * Math.PI * 2;

          // Real orbital radius — no compression
          const r = m.data.orbitalRadiusAU;
          m.mesh.position.set(
            r * Math.cos(angle),
            0,
            r * Math.sin(angle),
          );

          // Ensure tiny moons are at least a visible dot: minimum 5% of parent radius
          const realRatio = m.data.radiusAU / parentR;
          const minRatio = 0.05;
          if (realRatio < minRatio) {
            m.mesh.scale.setScalar(minRatio / realRatio);
          } else {
            m.mesh.scale.setScalar(1);
          }

          // Update moon label position — clamp to screen edges
          if (label) {
            m.mesh.getWorldPosition(tempV);
            tempV.project(this.camera);
            if (tempV.z < 1) {
              let sx = (tempV.x * 0.5 + 0.5) * canvasW;
              let sy = (-tempV.y * 0.5 + 0.5) * canvasH;
              const margin = 30;
              const onScreen = sx >= margin && sx <= canvasW - margin &&
                               sy >= margin && sy <= canvasH - margin;
              // Clamp to screen edges
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
        } else if (label) {
          label.style.display = 'none';
        }
      }
    }

    // Update sun shader time
    const sunMat = this.solarSystem.sun.userData.sunMaterial as THREE.ShaderMaterial | undefined;
    if (sunMat) {
      sunMat.uniforms.time.value += dt;
    }

    // Update orbit line visibility (fade based on distance)
    for (let i = 0; i < this.solarSystem.orbitLines.length; i++) {
      const orbit = this.solarSystem.orbitLines[i];
      const body = ALL_BODIES[i];
      const distToOrbit = Math.abs(this.player.getDistanceFromSun() - body.semiMajorAxisAU);
      const fadeRange = Math.max(body.semiMajorAxisAU * 0.3, 1.0);
      const opacity = Math.max(0.05, Math.min(0.4, 1 - distToOrbit / fadeRange));
      (orbit.material as THREE.LineBasicMaterial).opacity = opacity;
    }

    // Update UI stats
    this.updateStatsUI();
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
    // Camera orbits around the player using OrbitControls
    this.controls.target.set(0, 0, 0);
  }

  private processInput() {
    // Steering (keyboard + touch)
    let steer = 0;
    if (this.keys.has('arrowleft') || this.keys.has('a')) steer = -1;
    if (this.keys.has('arrowright') || this.keys.has('d')) steer = 1;
    if (this.touchSteer !== 0) steer = this.touchSteer;
    this.player.steerInput = steer;

    // Throttle (keyboard + touch)
    let throttle = 0;
    if (this.keys.has('arrowup') || this.keys.has('w')) throttle = 1;
    if (this.keys.has('arrowdown') || this.keys.has('s')) throttle = -1;
    if (this.touchThrottle !== 0) throttle = this.touchThrottle;

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
    // Don't capture if typing in an input
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
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
    for (const [name, pos] of this.planetWorldPositions) {
      const dx = this.player.posX - pos.x;
      const dy = this.player.posY - pos.y;
      const dz = this.player.posZ - pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const body = ALL_BODIES.find(b => b.name === name);
      if (!body) continue;

      // "Visit" if within 10× planet radius
      const visitDist = body.radiusAU * 10;
      if (dist < visitDist && !this.player.visitedPlanets.has(name)) {
        this.player.visitedPlanets.add(name);
        this.showNotification(`Arrived at ${name}! ${body.description}`);
        // Mark chip as visited
        const chip = document.getElementById(`jump-${name.toLowerCase()}`);
        if (chip) chip.classList.add('visited');
      }
    }
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
      this.player.heading,
      this.player.distanceTraveled,
      this.player.timeElapsed,
      this.planetWorldPositions,
    );

    // Update stats panel
    this.setStatText('stat-distance', `${formatAU(stats.distanceFromSunAU)} AU`);
    this.setStatText('stat-light-time', stats.lightTravelTime);
    this.setStatText('stat-intensity', `${stats.solarIntensityPct.toFixed(1)}%`);
    this.setStatText('stat-speed', `${stats.speedC.toFixed(1)}c / ${Math.round(stats.speedKmS).toLocaleString()} km/s`);
    this.setStatText('stat-nearest',
      stats.nearestPlanet ? `${stats.nearestPlanet.name} ${formatAU(stats.nearestPlanet.distanceAU)}` : '--');
    this.setStatText('stat-next',
      stats.nextPlanetAhead
        ? `${stats.nextPlanetAhead.name} ${formatETA(stats.nextPlanetAhead.etaSeconds)}`
        : '--');
    this.setStatText('stat-temp', `${Math.round(stats.blackbodyTempK)} K`);
    this.setStatText('stat-traveled', `${formatAU(stats.distanceTraveled)} AU`);
    this.setStatText('stat-time', stats.timeElapsed);
    this.setStatText('stat-visited', `${this.player.visitedPlanets.size}/${ALL_BODIES.length}`);

    // Update progress bar (0 to ~40 AU = Pluto)
    if (this.progressEl) {
      const pct = Math.min(100, (this.player.getDistanceFromSun() / 42) * 100);
      this.progressEl.style.width = `${pct}%`;
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
        if (this.speedValueEl) {
          this.speedValueEl.textContent = this.player.speedMultiplier < 0.01
            ? '0c'
            : `${this.player.speedC.toFixed(1)}c`;
        }
      });
    }

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
      this.saveManager.clearState();
      this.restoreState(createDefaultState());
      this.showNotification('New journey started!');
    });

    // Jump to planet buttons
    for (const body of ALL_BODIES) {
      const btn = document.getElementById(`jump-${body.name.toLowerCase()}`);
      btn?.addEventListener('click', () => this.jumpToPlanet(body));
    }

    // Autopilot toggle
    document.getElementById('explore-btn-autopilot')?.addEventListener('click', () => {
      this.toggleAutopilot();
    });

    // Settings panel toggle
    document.getElementById('explore-btn-settings')?.addEventListener('click', () => {
      const panel = document.getElementById('explore-settings-panel');
      if (panel) panel.classList.toggle('visible');
    });

    // Planet layout toggle
    document.getElementById('settings-layout-toggle')?.addEventListener('click', () => {
      this.toggleLayout();
    });

    // Date input for realistic mode
    const dateInput = document.getElementById('settings-date-input') as HTMLInputElement;
    if (dateInput) {
      dateInput.value = this.simDate.toISOString().slice(0, 10);
      dateInput.addEventListener('input', () => {
        const d = new Date(dateInput.value + 'T12:00:00Z');
        if (!isNaN(d.getTime())) {
          this.simDate = d;
          this.rebuildPlanetPositions();
        }
      });
    }

    // Planet scale slider
    const scaleSlider = document.getElementById('settings-planet-scale') as HTMLInputElement;
    if (scaleSlider) {
      scaleSlider.addEventListener('input', () => {
        this.planetScale = parseInt(scaleSlider.value, 10);
        const label = document.getElementById('settings-scale-label');
        if (label) label.textContent = `${this.planetScale}x`;
        this.resetCruiseCamera();
      });
    }

    // Show ship toggle
    document.getElementById('settings-ship-toggle')?.addEventListener('click', () => {
      this.showShip = !this.showShip;
      this.player.group.visible = this.showShip;
      const label = document.getElementById('settings-ship-label');
      if (label) label.textContent = this.showShip ? 'On' : 'Off';
    });

    // Touch steer zones
    const touchLeft = document.getElementById('touch-steer-left');
    const touchRight = document.getElementById('touch-steer-right');
    if (touchLeft) {
      touchLeft.addEventListener('touchstart', (e) => { e.preventDefault(); this.touchSteer = -1; touchLeft.classList.add('active'); }, { passive: false });
      touchLeft.addEventListener('touchend', () => { this.touchSteer = 0; touchLeft.classList.remove('active'); });
      touchLeft.addEventListener('touchcancel', () => { this.touchSteer = 0; touchLeft.classList.remove('active'); });
    }
    if (touchRight) {
      touchRight.addEventListener('touchstart', (e) => { e.preventDefault(); this.touchSteer = 1; touchRight.classList.add('active'); }, { passive: false });
      touchRight.addEventListener('touchend', () => { this.touchSteer = 0; touchRight.classList.remove('active'); });
      touchRight.addEventListener('touchcancel', () => { this.touchSteer = 0; touchRight.classList.remove('active'); });
    }

    // Touch throttle buttons
    const touchAccel = document.getElementById('touch-accel');
    const touchDecel = document.getElementById('touch-decel');
    if (touchAccel) {
      touchAccel.addEventListener('touchstart', (e) => { e.preventDefault(); this.touchThrottle = 1; touchAccel.classList.add('active'); }, { passive: false });
      touchAccel.addEventListener('touchend', () => { this.touchThrottle = 0; touchAccel.classList.remove('active'); });
      touchAccel.addEventListener('touchcancel', () => { this.touchThrottle = 0; touchAccel.classList.remove('active'); });
    }
    if (touchDecel) {
      touchDecel.addEventListener('touchstart', (e) => { e.preventDefault(); this.touchThrottle = -1; touchDecel.classList.add('active'); }, { passive: false });
      touchDecel.addEventListener('touchend', () => { this.touchThrottle = 0; touchDecel.classList.remove('active'); });
      touchDecel.addEventListener('touchcancel', () => { this.touchThrottle = 0; touchDecel.classList.remove('active'); });
    }
  }

  private showResumePrompt(): Promise<boolean> {
    return new Promise((resolve) => {
      const prompt = document.getElementById('explore-resume-prompt');
      if (!prompt) { resolve(true); return; }
      const uiOverlay = document.getElementById('ui-overlay');

      const saved = this.saveManager.loadState();
      if (saved) {
        const info = document.getElementById('resume-info');
        if (info) {
          const dist = Math.sqrt(saved.positionAU.x ** 2 + saved.positionAU.y ** 2 + saved.positionAU.z ** 2);
          info.textContent = `${dist.toFixed(2)} AU from Sun, ${saved.visitedPlanets.length} planets visited`;
        }
      }

      uiOverlay?.classList.add('resume-active');
      prompt.classList.add('visible');

      const resumeBtn = document.getElementById('resume-btn-continue');
      const newBtn = document.getElementById('resume-btn-new');

      const cleanup = () => {
        prompt.classList.remove('visible');
        uiOverlay?.classList.remove('resume-active');
        resumeBtn?.removeEventListener('click', onResume);
        newBtn?.removeEventListener('click', onNew);
      };
      const onResume = () => { cleanup(); resolve(true); };
      const onNew = () => { cleanup(); resolve(false); };

      resumeBtn?.addEventListener('click', onResume);
      newBtn?.addEventListener('click', onNew);
    });
  }

  private pointTowardMercury() {
    const mercuryPos = this.planetWorldPositions.get('Mercury');
    if (mercuryPos) {
      this.player.headToward(mercuryPos.x, mercuryPos.z);
      this.resetCruiseCamera();
    }
  }

  private resetCruiseCamera() {
    // Scale camera distance with planetScale so ship stays same apparent size
    const camDist = 0.0002 * this.planetScale;
    const behindX = -Math.cos(this.player.heading) * camDist;
    const behindZ = -Math.sin(this.player.heading) * camDist;
    this.camera.position.set(behindX, camDist * 0.45, behindZ);
    this.controls.target.set(0, 0, 0);
  }

  jumpToPlanet(planet: PlanetData) {
    const pos = this.planetWorldPositions.get(planet.name);
    if (!pos) return;

    // Position player near the planet: offset enough to see it nicely
    // Use max of 5× radius or a minimum useful distance
    const viewDist = Math.max(planet.radiusAU * 8, 0.001);
    this.player.posX = pos.x - viewDist;
    this.player.posY = pos.y;
    this.player.posZ = pos.z;
    this.player.headToward(pos.x, pos.z);

    // Slow down for viewing
    this.player.speedMultiplier = 0.1;
    this.updateSpeedSlider();

    this.showNotification(`Jumped to ${planet.name}`);

    // Reset camera to cruise position (behind player, looking toward planet)
    this.resetCruiseCamera();
  }

  manualSave() {
    this.saveManager.saveState(this.getState());
  }

  private getState(): ExploreState {
    return {
      positionAU: { x: this.player.posX, y: this.player.posY, z: this.player.posZ },
      headingRad: this.player.heading,
      speed: this.player.speedMultiplier,
      visitedPlanets: Array.from(this.player.visitedPlanets),
      distanceTraveled: this.player.distanceTraveled,
      timeElapsed: this.player.timeElapsed,
      timestamp: Date.now(),
      autopilot: this.autopilot,
      layoutMode: this.layoutMode,
      simDate: this.simDate.getTime(),
      planetScale: this.planetScale,
      showShip: this.showShip,
    };
  }

  private restoreState(saved: ExploreState) {
    this.player.posX = saved.positionAU.x;
    this.player.posY = saved.positionAU.y;
    this.player.posZ = saved.positionAU.z;
    this.player.heading = saved.headingRad;
    this.player.speedMultiplier = saved.speed;
    this.player.distanceTraveled = saved.distanceTraveled;
    this.player.timeElapsed = saved.timeElapsed;
    this.player.visitedPlanets = new Set(saved.visitedPlanets);

    // Restore settings
    this.autopilot = saved.autopilot;
    this.layoutMode = saved.layoutMode as LayoutMode;
    this.simDate = new Date(saved.simDate);
    this.planetScale = saved.planetScale;
    this.showShip = saved.showShip;
    this.player.group.visible = this.showShip;

    // Update UI to reflect state
    const apBtn = document.getElementById('explore-btn-autopilot');
    if (apBtn) apBtn.classList.toggle('active', this.autopilot);
    const layoutLabel = document.getElementById('settings-layout-label');
    if (layoutLabel) layoutLabel.textContent = this.layoutMode === 'aligned' ? 'Lined up' : 'Realistic';
    const dateRow = document.getElementById('settings-date-row');
    if (dateRow) dateRow.style.display = this.layoutMode === 'realistic' ? 'flex' : 'none';
    const dateInput = document.getElementById('settings-date-input') as HTMLInputElement;
    if (dateInput) dateInput.value = this.simDate.toISOString().slice(0, 10);
    const scaleSlider = document.getElementById('settings-planet-scale') as HTMLInputElement;
    if (scaleSlider) scaleSlider.value = String(this.planetScale);
    const scaleLabel = document.getElementById('settings-scale-label');
    if (scaleLabel) scaleLabel.textContent = `${this.planetScale}x`;
    const shipLabel = document.getElementById('settings-ship-label');
    if (shipLabel) shipLabel.textContent = this.showShip ? 'On' : 'Off';

    // Rebuild planet positions if alignment changed
    this.rebuildPlanetPositions();

    this.updateSpeedSlider();

    // Restore visited chip styles
    for (const name of saved.visitedPlanets) {
      const chip = document.getElementById(`jump-${name.toLowerCase()}`);
      if (chip) chip.classList.add('visited');
    }

    this.resetCruiseCamera();
  }

  private createExploreStarfield(): THREE.Points {
    const starCount = 15000;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);

    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 60 + Math.random() * 30;

      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);

      // Realistic star color temperature distribution
      const rand = Math.random();
      if (rand < 0.6) {
        // White/warm white (most common)
        const t = 0.85 + Math.random() * 0.15;
        colors[i * 3] = t;
        colors[i * 3 + 1] = t * (0.92 + Math.random() * 0.08);
        colors[i * 3 + 2] = t * (0.85 + Math.random() * 0.15);
      } else if (rand < 0.8) {
        // Cool blue-white
        colors[i * 3] = 0.8 + Math.random() * 0.1;
        colors[i * 3 + 1] = 0.85 + Math.random() * 0.1;
        colors[i * 3 + 2] = 0.95 + Math.random() * 0.05;
      } else if (rand < 0.92) {
        // Warm yellow/orange
        colors[i * 3] = 0.95 + Math.random() * 0.05;
        colors[i * 3 + 1] = 0.75 + Math.random() * 0.15;
        colors[i * 3 + 2] = 0.5 + Math.random() * 0.2;
      } else {
        // Red-ish
        colors[i * 3] = 0.9 + Math.random() * 0.1;
        colors[i * 3 + 1] = 0.5 + Math.random() * 0.2;
        colors[i * 3 + 2] = 0.3 + Math.random() * 0.2;
      }

      // Variable sizes — most small, few bright
      const sizeRand = Math.random();
      sizes[i] = sizeRand < 0.9 ? 1.0 + Math.random() * 1.0 : 2.0 + Math.random() * 2.5;
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
          this.player.headToward(pos.x, pos.z);
        }
        break;
      }
    }
  }

  private toggleAutopilot() {
    this.autopilot = !this.autopilot;
    const btn = document.getElementById('explore-btn-autopilot');
    if (btn) btn.classList.toggle('active', this.autopilot);

    if (!this.autopilot) {
      // Manual mode: start at speed 0
      this.player.speedMultiplier = 0;
      this.updateSpeedSlider();
      this.showNotification('Manual — W/S or ▲▼ to thrust, A/D to steer');
    } else {
      // Returning to autopilot: restore default speed if stopped
      if (this.player.speedMultiplier < 0.05) {
        this.player.speedMultiplier = PlayerShip.SPEED_DEFAULT;
        this.updateSpeedSlider();
      }
      this.showNotification('Autopilot ON');
    }
  }

  rebuildPlanetPositions() {
    if (!this.solarSystem) return;
    for (let i = 0; i < this.solarSystem.planets.length; i++) {
      const planet = this.solarSystem.planets[i];
      const body = ALL_BODIES[i];
      const pos = getPlanetOrbitalPosition(body, i + 1, this.layoutMode, this.simDate);
      planet.group.userData.worldPosAU = { x: pos.x, y: pos.y, z: pos.z };
      this.planetWorldPositions.set(body.name, { x: pos.x, y: pos.y, z: pos.z });
    }
  }

  private toggleLayout() {
    this.layoutMode = this.layoutMode === 'aligned' ? 'realistic' : 'aligned';
    this.rebuildPlanetPositions();
    const label = document.getElementById('settings-layout-label');
    if (label) label.textContent = this.layoutMode === 'aligned' ? 'Lined up' : 'Realistic';
    const dateRow = document.getElementById('settings-date-row');
    if (dateRow) dateRow.style.display = this.layoutMode === 'realistic' ? 'flex' : 'none';
    this.showNotification(this.layoutMode === 'aligned' ? 'Planets lined up' : 'Realistic orbits');
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
