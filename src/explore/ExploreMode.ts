import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSolarSystem, type SolarSystemObjects } from './SolarSystem';
import { PlayerShip } from './PlayerShip';
import { PlanetMarkers } from './PlanetMarker';
import { SaveManager, createDefaultState, type ExploreState } from './SaveManager';
import { computeStats, formatAU, formatETA } from './StatsPanel';
import { ALL_BODIES, type PlanetData } from './planets/planetData';

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

  // Keyboard state
  private keys = new Set<string>();

  // Orbit crossing notifications
  private lastCrossedOrbit: string | null = null;
  private notificationTimeout: number | null = null;
  private uiWired = false;

  // UI elements
  private statsEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private notificationEl: HTMLElement | null = null;
  private speedSliderEl: HTMLInputElement | null = null;
  private speedValueEl: HTMLElement | null = null;

  active = false;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
  ) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
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
      });
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

    // Check for saved state
    if (this.saveManager.hasSavedState()) {
      const saved = this.saveManager.loadState();
      if (saved) {
        this.restoreState(saved);
      }
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
    this.player.group.visible = visible;
    if (this.starfield) this.starfield.visible = visible;
  }

  update(dt: number): void {
    if (!this.active || !this.solarSystem) return;

    // Process keyboard input
    this.processInput();

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
    // Steering
    let steer = 0;
    if (this.keys.has('arrowleft') || this.keys.has('a')) steer = -1;
    if (this.keys.has('arrowright') || this.keys.has('d')) steer = 1;
    this.player.steerInput = steer;

    // Speed adjustment with up/down
    if (this.keys.has('arrowup') || this.keys.has('w')) {
      this.player.speedMultiplier = Math.min(
        this.player.speedMultiplier * 1.01,
        PlayerShip.SPEED_MAX,
      );
      this.updateSpeedSlider();
    }
    if (this.keys.has('arrowdown') || this.keys.has('s')) {
      this.player.speedMultiplier = Math.max(
        this.player.speedMultiplier * 0.99,
        PlayerShip.SPEED_MIN,
      );
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
      }
    }
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
    this.setStatText('stat-speed', `${stats.speedC.toFixed(1)}c`);
    this.setStatText('stat-speed-kms', `${Math.round(stats.speedKmS).toLocaleString()} km/s`);
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
      // Map speed multiplier to slider (logarithmic)
      const logVal = Math.log(this.player.speedMultiplier / PlayerShip.SPEED_MIN) /
                     Math.log(PlayerShip.SPEED_MAX / PlayerShip.SPEED_MIN);
      this.speedSliderEl.value = String(logVal * 100);
    }
    if (this.speedValueEl) {
      this.speedValueEl.textContent = `${this.player.speedC.toFixed(1)}c`;
    }
  }

  private wireUpUI() {
    // Speed slider
    const speedSlider = document.getElementById('explore-speed-slider') as HTMLInputElement;
    if (speedSlider) {
      speedSlider.addEventListener('input', () => {
        const t = parseFloat(speedSlider.value) / 100;
        // Logarithmic mapping
        this.player.speedMultiplier = PlayerShip.SPEED_MIN *
          Math.pow(PlayerShip.SPEED_MAX / PlayerShip.SPEED_MIN, t);
        if (this.speedValueEl) {
          this.speedValueEl.textContent = `${this.player.speedC.toFixed(1)}c`;
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

    // Reset camera to look at the planet from behind the player
    const camDist = viewDist * 0.3;
    this.camera.position.set(-camDist, camDist * 0.5, camDist * 0.3);
    this.controls.target.set(0, 0, 0);
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
    this.updateSpeedSlider();
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

    const mat = new THREE.PointsMaterial({
      size: 1.5,
      vertexColors: true,
      transparent: true,
      opacity: 1.0,
      sizeAttenuation: false,
      depthWrite: false,
    });

    return new THREE.Points(geo, mat);
  }

  dispose() {
    this.deactivate();
    if (this.markers) {
      this.markers.dispose();
      this.markers = null;
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
