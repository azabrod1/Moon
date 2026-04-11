import * as THREE from 'three';
import { type PlanetData, ALL_BODIES } from './planets/planetData';

// A marker is a billboard sprite that's always visible on screen
// showing the planet's position, name, and distance

export interface MarkerInstance {
  sprite: THREE.Sprite;
  label: HTMLDivElement;
  distEl: HTMLSpanElement;
  planet: PlanetData;
  labelVisible: boolean;
  lastTransform: string;
  lastDistanceText: string;
}

export class PlanetMarkers {
  markers: MarkerInstance[] = [];
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

    for (const body of ALL_BODIES) {
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

      this.markers.push({
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

  update(
    planetPositions: Map<string, { x: number; y: number; z: number }>,
    playerPos: { x: number; y: number; z: number },
    renderer: THREE.WebGLRenderer,
  ) {
    const canvasWidth = renderer.domElement.clientWidth;
    const canvasHeight = renderer.domElement.clientHeight;

    for (const marker of this.markers) {
      const pos = planetPositions.get(marker.planet.name);
      if (!pos) {
        marker.sprite.visible = false;
        if (marker.labelVisible) {
          marker.label.style.display = 'none';
          marker.labelVisible = false;
        }
        continue;
      }

      // Scene position (already offset by floating origin)
      marker.sprite.position.set(pos.x, pos.y, pos.z);

      // Distance from player (in AU)
      const dx = pos.x - playerPos.x;
      const dy = pos.y - playerPos.y;
      const dz = pos.z - playerPos.z;
      const distFromPlayer = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Scale marker: larger when farther, minimum size
      // But switch to planet mesh when close enough
      const planetVisualSize = marker.planet.radiusAU * 2;

      // Hide marker when the planet itself is big enough to see
      // (when planet subtends > ~2 pixels)
      const angularSize = planetVisualSize / Math.max(distFromPlayer, 0.0001);
      if (angularSize > 0.01) {
        // Planet is visible on its own
        marker.sprite.visible = false;
        if (marker.labelVisible) {
          marker.label.style.display = 'none';
          marker.labelVisible = false;
        }
        continue;
      }

      marker.sprite.visible = true;

      // Project to screen for label positioning
      this.tempV.set(pos.x, pos.y, pos.z);
      this.tempV.project(this.camera);

      const screenX = (this.tempV.x * 0.5 + 0.5) * canvasWidth;
      const screenY = (-this.tempV.y * 0.5 + 0.5) * canvasHeight;

      // Only show if in front of camera
      if (this.tempV.z < 1 && screenX > -50 && screenX < canvasWidth + 50 &&
          screenY > -50 && screenY < canvasHeight + 50) {
        if (!marker.labelVisible) {
          marker.label.style.display = 'block';
          marker.labelVisible = true;
        }
        const transform = `translate(${screenX}px, ${screenY + 16}px)`;
        if (transform !== marker.lastTransform) {
          marker.label.style.transform = transform;
          marker.lastTransform = transform;
        }

        // Update distance text
        const distanceText = distFromPlayer < 0.01
          ? `${(distFromPlayer * 149597870.7).toFixed(0)} km`
          : `${distFromPlayer.toFixed(2)} AU`;
        if (distanceText !== marker.lastDistanceText) {
          marker.distEl.textContent = distanceText;
          marker.lastDistanceText = distanceText;
        }
      } else if (marker.labelVisible) {
        marker.label.style.display = 'none';
        marker.labelVisible = false;
      }
    }
  }

  dispose() {
    for (const marker of this.markers) {
      marker.sprite.removeFromParent();
      const material = marker.sprite.material as THREE.SpriteMaterial;
      material.map?.dispose();
      material.dispose();
    }
    this.labelContainer.remove();
    this.markers = [];
  }
}
