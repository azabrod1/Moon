/**
 * Planetarium planet labels: a billboard sprite + HTML distance label per body.
 * Sprite hides once the planet subtends enough pixels to see as a mesh.
 * Labels occlusion-cull against closer foreground planets so distant-body tags
 * don't float over the sunlit side of a nearer world.
 */
import * as THREE from 'three';
import { type PlanetData, PLANETARIUM_BODIES } from './planets/planetData';

export interface PlanetLabel {
  sprite: THREE.Sprite;
  label: HTMLDivElement;
  distEl: HTMLSpanElement;
  planet: PlanetData;
  labelVisible: boolean;
  lastTransform: string;
  lastDistanceText: string;
}

export interface ForegroundDisc {
  screenX: number;
  screenY: number;
  radiusPx: number;
  // Distance from camera (not player). Camera-based so the landed case
  // (player sits at body center) doesn't collapse the depth comparison.
  distFromCamera: number;
  name: string;
}

export class PlanetLabels {
  labels: PlanetLabel[] = [];
  foregroundDiscs: ForegroundDisc[] = [];
  private labelContainer: HTMLDivElement;
  private camera: THREE.PerspectiveCamera;
  private tempV = new THREE.Vector3();

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.camera = camera;

    // Create label container
    this.labelContainer = document.createElement('div');
    this.labelContainer.id = 'planet-labels';
    this.labelContainer.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none; z-index: 9; overflow: hidden;
    `;
    document.body.appendChild(this.labelContainer);

    for (const body of PLANETARIUM_BODIES) {
      // Create sprite
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d')!;

      // Draw a glowing circle
      const color = new THREE.Color(body.color);
      const r = Math.floor(color.r * 255);
      const g = Math.floor(color.g * 255);
      const b = Math.floor(color.b * 255);

      // Outer glow
      const gradient = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
      gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1.0)`);
      gradient.addColorStop(0.3, `rgba(${r}, ${g}, ${b}, 0.6)`);
      gradient.addColorStop(0.7, `rgba(${r}, ${g}, ${b}, 0.15)`);
      gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 64, 64);

      // Inner bright core
      ctx.beginPath();
      ctx.arc(32, 32, 6, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${Math.min(255, r + 80)}, ${Math.min(255, g + 80)}, ${Math.min(255, b + 80)}, 1.0)`;
      ctx.fill();

      const spriteTex = new THREE.CanvasTexture(canvas);
      const spriteMat = new THREE.SpriteMaterial({
        map: spriteTex,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: false,
      });

      const sprite = new THREE.Sprite(spriteMat);
      sprite.name = `marker-${body.name}`;
      sprite.renderOrder = 10;
      sprite.scale.setScalar(0.03);
      scene.add(sprite);

      // Create HTML label
      const label = document.createElement('div');
      label.className = 'planet-label';
      label.innerHTML = `
        <span class="planet-label-name">${body.name}</span>
        <span class="planet-label-dist"></span>
      `;
      this.labelContainer.appendChild(label);
      const distEl = label.querySelector('.planet-label-dist') as HTMLSpanElement;

      this.labels.push({
        sprite,
        label,
        distEl,
        planet: body,
        labelVisible: false,
        lastTransform: '',
        lastDistanceText: '',
      });
    }
  }

  /**
   * Populates `foregroundDiscs` with the planets that are rendered as meshes
   * this frame (angular size large enough to occlude labels). Callers may
   * then `addForegroundDisc()` additional occluders (moons, ship) before
   * invoking `renderLabels()` so those external occluders are considered.
   */
  collectForegroundDiscs(
    planetPositions: Map<string, { x: number; y: number; z: number }>,
    renderer: THREE.WebGLRenderer,
  ) {
    const canvasWidth = renderer.domElement.clientWidth;
    const canvasHeight = renderer.domElement.clientHeight;
    this.foregroundDiscs.length = 0;
    const projV = new THREE.Vector3();
    const halfFovTan = Math.tan((this.camera.fov * Math.PI) / 360);
    const camX = this.camera.position.x;
    const camY = this.camera.position.y;
    const camZ = this.camera.position.z;
    for (const entry of this.labels) {
      const pos = planetPositions.get(entry.planet.name);
      if (!pos) continue;
      const dx = pos.x - camX;
      const dy = pos.y - camY;
      const dz = pos.z - camZ;
      const distFromCamera = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const angularSize = (entry.planet.radiusAU * 2) / Math.max(distFromCamera, 0.0001);
      if (angularSize <= 0.01) continue;

      projV.set(pos.x, pos.y, pos.z);
      projV.project(this.camera);
      if (projV.z >= 1) continue;
      const screenX = (projV.x * 0.5 + 0.5) * canvasWidth;
      const screenY = (-projV.y * 0.5 + 0.5) * canvasHeight;
      // Project disc radius to pixels. Pad by 1.1x to cover atmosphere glow.
      const radiusPx = (entry.planet.radiusAU * 1.1 / (Math.max(distFromCamera, entry.planet.radiusAU) * halfFovTan)) * (canvasHeight / 2);
      this.foregroundDiscs.push({ screenX, screenY, radiusPx, distFromCamera, name: entry.planet.name });
    }
  }

  /** Append an external foreground disc (e.g. a visible moon or the ship). */
  addForegroundDisc(disc: ForegroundDisc): void {
    this.foregroundDiscs.push(disc);
  }

  /**
   * Places each planet's marker/label, occlusion-culled against the current
   * `foregroundDiscs`. Caller must have run `collectForegroundDiscs()` and
   * any `addForegroundDisc()` calls first.
   */
  renderLabels(
    planetPositions: Map<string, { x: number; y: number; z: number }>,
    playerPos: { x: number; y: number; z: number },
    renderer: THREE.WebGLRenderer,
  ) {
    const canvasWidth = renderer.domElement.clientWidth;
    const canvasHeight = renderer.domElement.clientHeight;
    const camX = this.camera.position.x;
    const camY = this.camera.position.y;
    const camZ = this.camera.position.z;
    const foregroundDiscs = this.foregroundDiscs;

    for (const entry of this.labels) {
      const pos = planetPositions.get(entry.planet.name);
      if (!pos) {
        entry.sprite.visible = false;
        if (entry.labelVisible) {
          entry.label.style.display = 'none';
          entry.labelVisible = false;
        }
        continue;
      }

      // Scene position (already offset by floating origin)
      entry.sprite.position.set(pos.x, pos.y, pos.z);

      // Distance from player (in AU) — used for label text and visibility
      const dx = pos.x - playerPos.x;
      const dy = pos.y - playerPos.y;
      const dz = pos.z - playerPos.z;
      const distFromPlayer = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Separate camera distance for occlusion (differs when landed: player is
      // at body center while camera orbits above).
      const cdx = pos.x - camX;
      const cdy = pos.y - camY;
      const cdz = pos.z - camZ;
      const distFromCamera = Math.sqrt(cdx * cdx + cdy * cdy + cdz * cdz);

      // Scale marker: larger when farther, minimum size
      // But switch to planet mesh when close enough
      const planetVisualSize = entry.planet.radiusAU * 2;

      // Hide marker when the planet itself is big enough to see
      // (when planet subtends > ~2 pixels)
      const angularSize = planetVisualSize / Math.max(distFromPlayer, 0.0001);
      if (angularSize > 0.01) {
        // Planet is visible on its own
        entry.sprite.visible = false;
        if (entry.labelVisible) {
          entry.label.style.display = 'none';
          entry.labelVisible = false;
        }
        continue;
      }

      entry.sprite.visible = true;

      // Project to screen for label positioning
      this.tempV.set(pos.x, pos.y, pos.z);
      this.tempV.project(this.camera);

      const screenX = (this.tempV.x * 0.5 + 0.5) * canvasWidth;
      const screenY = (-this.tempV.y * 0.5 + 0.5) * canvasHeight;

      // Occluded by a nearer foreground body? Test the LABEL's position
      // (below the marker), not the marker itself — the user wants the label
      // to hide only when it actually sits over a foreground planet, even if
      // the sprite above it is in clear sky.
      const labelY = screenY + 24;
      let occluded = false;
      for (const disc of foregroundDiscs) {
        if (disc.name === entry.planet.name) continue;
        if (distFromCamera <= disc.distFromCamera) continue;
        const ddx = screenX - disc.screenX;
        const ddy = labelY - disc.screenY;
        if (ddx * ddx + ddy * ddy < disc.radiusPx * disc.radiusPx) {
          occluded = true;
          break;
        }
      }

      // Only show if in front of camera and not occluded
      if (!occluded && this.tempV.z < 1 && screenX > -50 && screenX < canvasWidth + 50 &&
          screenY > -50 && screenY < canvasHeight + 50) {
        if (!entry.labelVisible) {
          entry.label.style.display = 'block';
          entry.labelVisible = true;
        }
        const transform = `translate(${screenX}px, ${screenY + 16}px)`;
        if (transform !== entry.lastTransform) {
          entry.label.style.transform = transform;
          entry.lastTransform = transform;
        }

        // Update distance text
        const distanceText = distFromPlayer < 0.01
          ? `${(distFromPlayer * 149597870.7).toFixed(0)} km`
          : `${distFromPlayer.toFixed(2)} AU`;
        if (distanceText !== entry.lastDistanceText) {
          entry.distEl.textContent = distanceText;
          entry.lastDistanceText = distanceText;
        }
      } else if (entry.labelVisible) {
        entry.label.style.display = 'none';
        entry.labelVisible = false;
      }
    }
  }

  /**
   * Convenience: collect foreground discs for planets, then place labels in a
   * single call. Callers that want to contribute additional occluders
   * (moons, ship) should invoke `collectForegroundDiscs` →
   * `addForegroundDisc` → `renderLabels` directly.
   */
  update(
    planetPositions: Map<string, { x: number; y: number; z: number }>,
    playerPos: { x: number; y: number; z: number },
    renderer: THREE.WebGLRenderer,
  ) {
    this.collectForegroundDiscs(planetPositions, renderer);
    this.renderLabels(planetPositions, playerPos, renderer);
  }

  /**
   * True if a screen-space point sits inside the disc of a closer foreground
   * body computed during the current frame. `distFromCamera` should be the
   * camera-space depth of the point (NOT player distance) to match how the
   * discs themselves were measured. Pass excludeName when the caller knows
   * its own body should never occlude itself.
   */
  isScreenPointOccluded(screenX: number, screenY: number, distFromCamera: number, excludeName?: string): boolean {
    for (const disc of this.foregroundDiscs) {
      if (excludeName && disc.name === excludeName) continue;
      if (distFromCamera <= disc.distFromCamera) continue;
      const ddx = screenX - disc.screenX;
      const ddy = screenY - disc.screenY;
      if (ddx * ddx + ddy * ddy < disc.radiusPx * disc.radiusPx) return true;
    }
    return false;
  }

  dispose() {
    for (const entry of this.labels) {
      entry.sprite.removeFromParent();
      const material = entry.sprite.material as THREE.SpriteMaterial;
      material.map?.dispose();
      material.dispose();
    }
    this.labelContainer.remove();
    this.labels = [];
  }
}
