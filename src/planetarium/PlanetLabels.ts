/**
 * Planetarium planet labels: a billboard sprite + HTML distance label per body.
 * Sprite hides once the planet subtends enough pixels to see as a mesh.
 * Labels occlusion-cull against closer foreground planets so distant-body tags
 * don't float over the sunlit side of a nearer world.
 */
import * as THREE from 'three';
import { type PlanetData, PLANETARIUM_BODIES } from './planets/planetData';
import {
  projectSphereToScreen,
  type SphereScreenProjection,
} from '../shared/three/projectToScreen';
import {
  applyLensShaderUniforms,
  augmentFixedScreenSpriteForLens,
  createLensShaderUniforms,
} from '../shared/three/lensShader';
import {
  sunGlareMaskAt,
  sunGlareMaskForRect,
  type SunGlareMaskParams,
} from './world/sunGlareMask';
import {
  markerAlbedoProxy,
  markerMagnitude,
  markerVisual,
  PLANET_MARKER_PARAMS,
  type PlanetMarkerVisual,
} from './planetMarkers';

export interface PlanetLabel {
  sprite: THREE.Sprite;
  label: HTMLDivElement;
  distEl: HTMLSpanElement;
  planet: PlanetData;
  /** Cached albedo proxy of the marker tint (constant per body). */
  markerAlbedo: number;
  labelVisible: boolean;
  lastTransform: string;
  lastDistanceText: string;
  // Last measured label box (CSS px), used to fade against the Sun's glare by
  // the label rectangle rather than by its anchor point. Nominal until first
  // measured while visible.
  labelW: number;
  labelH: number;
  lastOpacity: string;
}

// Nominal label box before the DOM has been measured (roughly two 10px lines).
const NOMINAL_LABEL_W = 64;
const NOMINAL_LABEL_H = 24;
// The glare-fade band for HTML labels: full opacity below, fully hidden above.
// A monotone ramp — translucent text sitting in the glare is worse than none.
const LABEL_FADE_MASK_LO = 0.25;
const LABEL_FADE_MASK_HI = 0.65;

export interface ForegroundDisc {
  screenX: number;
  screenY: number;
  radiusPx: number;
  // Distance from camera (not player). Camera-based so the landed case
  // (player sits at body center) doesn't collapse the depth comparison.
  distFromCamera: number;
  name: string;
}

/**
 * Pixel radius of a body's rendered disc, given its scene radius (AU), the
 * camera distance, `tan(fov/2)`, and the canvas height. A sphere's silhouette
 * subtends asin(R/d), which projects to R/√(d²−R²) — NOT the linear R/d: the
 * two agree far away, but up close the linear form under-reads the disc (a
 * camera 1.2R from the centre sees a silhouette ~50% wider), and an occlusion
 * disc that small lets labels of moons hidden behind the planet leak onto its
 * rendered face. At or inside the surface the silhouette is the whole view:
 * the tangent floor keeps the result finite (and screen-covering).
 * Callers that pad (to clear atmosphere glow, or to lift a label off the limb)
 * scale the RESULT — padding the radius argument would shift the floor.
 */
export function discRadiusPx(
  radiusAU: number,
  distFromCamera: number,
  halfFovTan: number,
  canvasHeight: number,
): number {
  const tangentSq = distFromCamera * distFromCamera - radiusAU * radiusAU;
  const tangent = Math.sqrt(Math.max(tangentSq, radiusAU * radiusAU * 1e-12));
  return (radiusAU / (tangent * halfFovTan)) * (canvasHeight / 2);
}

export class PlanetLabels {
  labels: PlanetLabel[] = [];
  foregroundDiscs: ForegroundDisc[] = [];
  private labelContainer: HTMLDivElement;
  private camera: THREE.PerspectiveCamera;
  private lensUniforms = createLensShaderUniforms();
  private sphereProjScratch: SphereScreenProjection = {
    x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0,
    footprintX: 0, footprintY: 0, radiusPx: 0, diameterPx: 0,
    minX: 0, maxX: 0, minY: 0, maxY: 0,
  };
  private markerScratch: PlanetMarkerVisual = { sizeMul: 0, brightness: 0 };

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.camera = camera;

    this.labelContainer = document.createElement('div');
    this.labelContainer.id = 'planet-labels';
    this.labelContainer.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none; z-index: 9; overflow: hidden;
    `;
    document.body.appendChild(this.labelContainer);

    for (const body of PLANETARIUM_BODIES) {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d')!;

      // Beacon texture: a lightly-lifted hued core with the full tint in the
      // surrounding halo. Only a modest white lift keeps the center from being
      // a flat colour chip — enough that the point still reads as luminous, but
      // the planet's hue survives all the way to the middle. That matters when
      // the marker shrinks to a few pixels far away: a mostly-white core there
      // washes to an anonymous white star, so a distant Neptune can't be told
      // from the background. The tint is the catalog's photo-informed
      // markerColor, not the UI tint: additive blending renders a saturated
      // tint as neon, so the palette stays pale. Alphas/radii are unchanged —
      // this adds colour, not size.
      const tint = new THREE.Color(body.markerColor);
      const mixToWhite = (c: THREE.Color, w: number) =>
        `${Math.round(THREE.MathUtils.lerp(c.r, 1, w) * 255)}, ` +
        `${Math.round(THREE.MathUtils.lerp(c.g, 1, w) * 255)}, ` +
        `${Math.round(THREE.MathUtils.lerp(c.b, 1, w) * 255)}`;

      const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
      gradient.addColorStop(0, `rgba(${mixToWhite(tint, 0.5)}, 1.0)`);
      gradient.addColorStop(0.14, `rgba(${mixToWhite(tint, 0.25)}, 0.8)`);
      gradient.addColorStop(0.35, `rgba(${mixToWhite(tint, 0)}, 0.3)`);
      gradient.addColorStop(0.65, `rgba(${mixToWhite(tint, 0)}, 0.06)`);
      gradient.addColorStop(1, `rgba(${mixToWhite(tint, 0)}, 0)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 64, 64);

      // Lightly-hued crisp center so the beacon stays a point, not a smudge,
      // while still carrying its colour.
      ctx.beginPath();
      ctx.arc(32, 32, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${mixToWhite(tint, 0.55)}, 1.0)`;
      ctx.fill();

      const spriteTex = new THREE.CanvasTexture(canvas);
      // No depth test: the marker sits at its body's own center, where the
      // body's front surface is within a fraction of one depth-buffer step
      // (kilometre near plane, AU distances), so a depth-tested sprite
      // coin-flips against its own planet and strobes. Occlusion by nearer
      // bodies is analytic instead — the same foreground-disc test the HTML
      // labels use (renderLabels hides the sprite when its center is covered).
      const spriteMat = new THREE.SpriteMaterial({
        map: spriteTex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: false,
      });
      augmentFixedScreenSpriteForLens(spriteMat, this.lensUniforms);

      const sprite = new THREE.Sprite(spriteMat);
      sprite.name = `marker-${body.name}`;
      sprite.renderOrder = 10;
      // Placeholder until the first renderLabels pass sets the screen-pinned
      // scale (see the marker sizing block there).
      sprite.scale.setScalar(0.03);
      scene.add(sprite);

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
        markerAlbedo: markerAlbedoProxy(body.markerColor),
        labelVisible: false,
        lastTransform: '',
        lastDistanceText: '',
        labelW: NOMINAL_LABEL_W,
        labelH: NOMINAL_LABEL_H,
        lastOpacity: '',
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
    applyLensShaderUniforms(
      this.lensUniforms,
      this.camera,
      canvasWidth,
      canvasHeight,
      renderer.getPixelRatio(),
    );
    this.foregroundDiscs.length = 0;
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

      const proj = projectSphereToScreen(
        pos,
        entry.planet.radiusAU,
        this.camera,
        canvasWidth,
        canvasHeight,
        this.sphereProjScratch,
      );
      if (proj.ndcZ >= 1) continue;
      const screenX = proj.footprintX;
      const screenY = proj.footprintY;
      // The sampled output-space tangent limb stays correct at frame edges;
      // pad the measured footprint by 1.1x to cover atmosphere glow.
      const radiusPx = proj.radiusPx * 1.1;
      this.foregroundDiscs.push({ screenX, screenY, radiusPx, distFromCamera, name: entry.planet.name });
    }
  }

  /** Append an external foreground disc (e.g. a visible moon or the ship). */
  addForegroundDisc(disc: ForegroundDisc): void {
    this.foregroundDiscs.push(disc);
  }

  /**
   * Hide every marker sprite + HTML label at once. The surface view skips the
   * label pipeline entirely, so without this, sprites already visible when it
   * opens would stay frozen in the sky (the renderLabels loop is what owns
   * `sprite.visible`).
   */
  hideAll(): void {
    for (const entry of this.labels) {
      entry.sprite.visible = false;
      if (entry.labelVisible) {
        entry.label.style.display = 'none';
        entry.labelVisible = false;
      }
    }
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
    options: {
      showMarkers?: boolean;
      showLabels?: boolean;
      excludeName?: string;
      sunMask?: SunGlareMaskParams;
      /** Sun position in the same space as `planetPositions` — feeds the
       *  beacon policy's heliocentric-distance term. Falls back to the
       *  catalog semi-major axis when absent. */
      sunPos?: { x: number; y: number; z: number };
      /** Precise hull test for marker-vs-ship occlusion. The ship's
       *  foreground disc is a generous circle — right for keeping text off
       *  the hull, but wrong in both directions for a beacon: culling by the
       *  whole circle vanishes a planet visibly beside the hull, and
       *  ignoring the ship draws the beacon on top of it. While the ship
       *  disc exists, this callback decides instead: it raycasts the actual
       *  hull so the marker hides exactly when covered. With no ship disc
       *  (ship under the angular floor, a few px) no test runs — hiding a
       *  whole beacon glow behind a 3px ship would be the worse artifact. */
      markerShipTest?: (markerWorldPos: THREE.Vector3) => boolean;
    } = {},
  ) {
    const { showMarkers = true, showLabels = true, excludeName, sunMask, sunPos, markerShipTest } = options;
    const maskActive = !!sunMask && sunMask.active;
    const canvasWidth = renderer.domElement.clientWidth;
    const canvasHeight = renderer.domElement.clientHeight;
    const halfFovTan = Math.tan((this.camera.fov * Math.PI) / 360);

    // Marker sprites render at a fixed clip-space size (`sizeAttenuation:
    // false`), so their on-screen footprint grows as 1/tan(fov/2): zooming in
    // ballooned each beacon into a planet-sized translucent ball squatting
    // over the asteroid belt. Pin the quad to a constant on-screen size
    // instead — a fraction of the smaller viewport axis, clamped so phones
    // get a compact dot and desktops keep the stock look — like the HTML
    // labels beside them, which never grew with zoom.
    const markerQuadPx = THREE.MathUtils.clamp(0.032 * Math.min(canvasWidth, canvasHeight), 18, 30);
    const markerScale = (markerQuadPx * 2 * halfFovTan) / Math.max(canvasHeight, 1);
    const camX = this.camera.position.x;
    const camY = this.camera.position.y;
    const camZ = this.camera.position.z;
    const foregroundDiscs = this.foregroundDiscs;

    for (const entry of this.labels) {
      const pos = planetPositions.get(entry.planet.name);
      // Suppress the landed body's own label/sprite entirely — no need to
      // label the thing you're standing on, and its own disc would dominate
      // the view.
      if (!pos || entry.planet.name === excludeName) {
        entry.sprite.visible = false;
        if (entry.labelVisible) {
          entry.label.style.display = 'none';
          entry.labelVisible = false;
        }
        continue;
      }

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

      // Scene position (already offset by floating origin).
      entry.sprite.position.set(pos.x, pos.y, pos.z);
      if (entry.sprite.scale.x !== markerScale) entry.sprite.scale.setScalar(markerScale);

      // Hide marker once the planet subtends enough pixels to be visible as a mesh.
      const planetVisualSize = entry.planet.radiusAU * 2;
      const angularSize = planetVisualSize / Math.max(distFromPlayer, 0.0001);
      if (angularSize > 0.01) {
        entry.sprite.visible = false;
        if (entry.labelVisible) {
          entry.label.style.display = 'none';
          entry.labelVisible = false;
        }
        continue;
      }

      // One projection, reused by the marker occlusion/fade and the label
      // placement. Needed whenever a marker or a label could show.
      const proj = showLabels || showMarkers
        ? projectSphereToScreen(
            pos,
            entry.planet.radiusAU,
            this.camera,
            canvasWidth,
            canvasHeight,
            this.sphereProjScratch,
          )
        : null;

      // Marker occlusion is analytic (the sprite renders without a depth test —
      // see the material comment): hidden when its center sits inside a nearer
      // body's disc, or when the body is behind the camera. Runs even with
      // labels off — the sprite has no other occlusion.
      let markerOccluded = !proj || proj.ndcZ >= 1;
      if (proj && !markerOccluded) {
        for (const disc of foregroundDiscs) {
          if (disc.name === entry.planet.name) continue;
          // The ship's circle never hides a beacon on its own: a planet dead
          // ahead sits right above the ship, inside the circle but beside the
          // hull, and culling it there makes an approaching world vanish.
          // Inside the circle the precise hull raycast decides instead, so
          // the beacon hides exactly when hull pixels cover it and stays lit
          // beside them. Labels below still use the plain circle.
          if (disc.name === 'ship') {
            if (!markerShipTest) continue;
            // No screen gate here: the circle is sized for label culling and
            // no fixed multiple of it tracks every profile's true reach
            // (Juno's magnetometer boom tip sits at ~4.9 circle radii). The
            // callback does its own exact sight-line pre-reject against the
            // widest-hull sphere, so calling it per marker stays cheap.
            if (markerShipTest(entry.sprite.position)) {
              markerOccluded = true;
              break;
            }
            continue;
          }
          if (distFromCamera <= disc.distFromCamera) continue;
          const mdx = proj.x - disc.screenX;
          const mdy = proj.y - disc.screenY;
          if (mdx * mdx + mdy * mdy < disc.radiusPx * disc.radiusPx) {
            markerOccluded = true;
            break;
          }
        }
      }
      entry.sprite.visible = showMarkers && !markerOccluded;

      // Marker sprites also fade inside the Sun's glare like the other point
      // consumers. Materials are per-body, so per-sprite opacity is safe; a mask
      // of 0 restores full opacity (byte-identical to an un-masked build).
      if (showMarkers) {
        const spriteMat = entry.sprite.material as THREE.SpriteMaterial;
        const markerMask = maskActive && proj ? sunGlareMaskAt(sunMask, proj.x, proj.y) : 0;
        const spriteOpacity = 1 - 0.98 * markerMask;
        if (spriteMat.opacity !== spriteOpacity) spriteMat.opacity = spriteOpacity;
      }

      // Beacon policy: size and brightness track apparent brightness — Earth
      // seen from Neptune shrinks to a pale point, Venus stays prominent from
      // anywhere, nothing vanishes (planetMarkers.ts owns the curve). Camera
      // distance, not player distance: the marker is what the camera sees.
      // Channel split: photometric brightness writes .color while the Sun-glare
      // fade above owns .opacity, so the two compose (energy = brightness ×
      // glare visibility) without either overwriting the other. sizeMul is a
      // multiplier (≤1) on the viewport-pinned base scale (markerScale, above),
      // the sole owner of absolute on-screen size — so photometry can shrink a
      // fainter beacon but never balloon one past the pin.
      if (entry.sprite.visible) {
        const rSun = sunPos
          ? Math.hypot(pos.x - sunPos.x, pos.y - sunPos.y, pos.z - sunPos.z)
          : entry.planet.semiMajorAxisAU;
        const mag = markerMagnitude(entry.planet.radiusAU, distFromCamera, rSun, entry.markerAlbedo);
        const vis = markerVisual(mag, PLANET_MARKER_PARAMS, this.markerScratch);
        const absoluteScale = markerScale * vis.sizeMul;
        if (entry.sprite.scale.x !== absoluteScale) entry.sprite.scale.setScalar(absoluteScale);
        entry.sprite.material.color.setScalar(vis.brightness);
      }

      // Markers are GPU billboards; only the HTML label needs projection and
      // occlusion work, so skip the rest when labels are off (or unprojected).
      if (!showLabels || !proj) {
        if (entry.labelVisible) {
          entry.label.style.display = 'none';
          entry.labelVisible = false;
        }
        continue;
      }

      const screenX = proj.x;
      const screenY = proj.y;

      // Offset the label below the body center by at least 16 px, and by more
      // once the disc grows so the text never lands on the planet's face. A
      // no-op at the mesh-hide threshold above (disc only a few px there) —
      // it's the guard for the never-on-the-disc rule if that threshold moves.
      const labelOffsetY = Math.max(16, proj.radiusPx * 1.1 + 6);

      // Fade, then hide, a label whose box enters the Sun's glare. Measured from
      // the label rectangle (its box top-left sits at the transform anchor), not
      // the anchor point, so text hides only when it actually sits in the blaze.
      const labelTop = screenY + labelOffsetY;
      const glareMask = maskActive
        ? sunGlareMaskForRect(
            sunMask, screenX, labelTop, screenX + entry.labelW, labelTop + entry.labelH,
          )
        : 0;
      const labelFade = 1 - THREE.MathUtils.smoothstep(glareMask, LABEL_FADE_MASK_LO, LABEL_FADE_MASK_HI);
      const glareHidden = labelFade <= 0;

      // Occluded by a nearer foreground body? Test the LABEL's position
      // (below the marker), not the marker itself — the user wants the label
      // to hide only when it actually sits over a foreground planet, even if
      // the sprite above it is in clear sky.
      const labelY = screenY + labelOffsetY + 8;
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

      // Only show if in front of camera, not occluded, and not buried in glare
      if (!occluded && !glareHidden && proj.ndcZ < 1 && screenX > -50 && screenX < canvasWidth + 50 &&
          screenY > -50 && screenY < canvasHeight + 50) {
        const justRevealed = !entry.labelVisible;
        if (!entry.labelVisible) {
          entry.label.style.display = 'block';
          entry.labelVisible = true;
        }
        const transform = `translate(${screenX}px, ${screenY + labelOffsetY}px)`;
        if (transform !== entry.lastTransform) {
          entry.label.style.transform = transform;
          entry.lastTransform = transform;
        }

        const distanceText = distFromPlayer < 0.01
          ? `${(distFromPlayer * 149597870.7).toFixed(0)} km`
          : `${distFromPlayer.toFixed(2)} AU`;
        if (distanceText !== entry.lastDistanceText) {
          entry.distEl.textContent = distanceText;
          entry.lastDistanceText = distanceText;
        }

        // Partial glare fade. Empty string clears the inline opacity, so a label
        // outside the glare is byte-identical to an un-masked build.
        const opacityStr = labelFade >= 1 ? '' : labelFade.toFixed(3);
        if (opacityStr !== entry.lastOpacity) {
          entry.label.style.opacity = opacityStr;
          entry.lastOpacity = opacityStr;
        }

        // Cache the real box the frame it is first laid out, for next frame's
        // rectangle test (one layout read on reveal, not every frame).
        if (justRevealed && entry.label.offsetWidth > 0) {
          entry.labelW = entry.label.offsetWidth;
          entry.labelH = entry.label.offsetHeight;
        }
      } else if (entry.labelVisible) {
        entry.label.style.display = 'none';
        entry.labelVisible = false;
      }
    }
  }

  /**
   * Hide only the marker sprites, leaving the HTML labels alone. Used when the
   * markers are toggled off but labels stay on: sprites are constructed
   * visible, and with the per-frame pass told to keep them hidden this is what
   * actually clears the ones already drawn.
   */
  hideMarkers(): void {
    for (const entry of this.labels) {
      entry.sprite.visible = false;
    }
  }

  /** Toggle the distance line for every planet label and the Sun label, which
   * shares this container. The master labels setting still hides both lines. */
  setDistancesVisible(visible: boolean): void {
    this.labelContainer.classList.toggle('hide-distances', !visible);
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
