/**
 * SystemMap — the full-screen schematic view of the solar system, a
 * session-only sub-state of PlanetariumMode. Own THREE.Scene + a plain
 * PerspectiveCamera (no userData.lens, so projectToScreen degrades to
 * rectilinear) and own OrbitControls, rendered to the backbuffer instead of
 * the composer while open.
 *
 * The map never simulates: PlanetariumMode feeds it a snapshot each frame
 * (the sim clock + the ship's heliocentric AU pose) and it recomputes every
 * body straight from the ephemeris seam (sampleTrajectoryLinePoints ->
 * computeBodyPositionAU), so the schematic cannot disagree with the world.
 * Radii compress toward the Sun (mapProjection) with a gamma the scale toggle
 * animates; every distance the map draws is derived, never stored on the save.
 *
 * Packet A is the view only — orbits, dots, the ship marker, labels, the scale
 * animation, open/close, and the render transaction. Picking, the body card,
 * and the dive transition arrive with the commit core.
 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLANETARIUM_BODIES, SUN_DATA, type PlanetData } from '../planets/planetData';
import { sampleTrajectoryLinePoints, computeBodyPositionAU } from '../../astronomy/planetary';
import { bodyDisplayName } from '../surfaceView';
import { ORBIT_LINE_RESAMPLE_MAX_AGE_MS } from '../SolarSystem';
import { applyTextureDefaults } from '../world/texturePolicy';
import { projectToScreen, type ScreenProjection } from '../../shared/three/projectToScreen';
import { smoothstepUnclamped } from '../../shared/math/smoothstep';
import {
  fitDistanceAU,
  projectMapPoint,
  MAP_GAMMA_DEFAULT,
  MAP_GAMMA_TRUE,
  MAP_GAMMA_ANIM_MS,
  type MapVec3,
} from './mapProjection';

const ORBIT_SEGMENTS = 180;
const MAP_FOV_DEG = 50;
const BG_COLOR = 0x05070d;
// Screen sizes (px, full sprite extent) for the constant-size markers.
const SUN_PX = 34;
const PLANET_PX = 20;
const SHIP_PX = 26;
// Orbit line: full tint just ahead of the body fading to this floor behind it.
const ORBIT_BRIGHT_FLOOR = 0.1;
// A label whose anchor lands within this many screen px of an already-placed
// one hides this frame — the true-scale inner four otherwise stack.
const LABEL_MIN_SEP_PX = 26;
// Un-docked ship chevron breathes over this period (ms).
const SHIP_PULSE_MS = 2000;

interface OrbitEntry {
  planet: PlanetData;
  periodMs: number;
  /** Raw heliocentric samples (scene AU), flattened xyz, length (N+1)*3. */
  raw: Float32Array;
  /** Compressed map-space positions, packed into the Line2 buffer each rebuild. */
  map: Float32Array;
  colors: Float32Array;
  geometry: LineGeometry;
  material: LineMaterial;
  line: Line2;
  dot: THREE.Sprite;
  /** Vertex index the body last sat at — colors rebuild only on a crossing. */
  lastVertex: number;
  /** Largest projected |r| over the samples at the live gamma — the
   *  eccentricity-correct extent this orbit contributes (aphelion, not the
   *  semi-major axis, sets the drawn reach). Refreshed with recompressOrbits. */
  maxMapRadius: number;
  /** Catalog tint in the renderer's working (linear) colour space, so the fat
   *  line matches the sprite material.color instead of rendering hot. */
  colorR: number;
  colorG: number;
  colorB: number;
}

export class SystemMap {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;

  private sun: THREE.Sprite;
  private orbits: OrbitEntry[] = [];
  private shipMarker: THREE.Sprite;
  private shipChevronTex: THREE.Texture;
  private shipRingTex: THREE.Texture;

  private labelContainer: HTMLElement | null = null;
  private labels: HTMLDivElement[] = [];

  private open = false;
  private gamma = MAP_GAMMA_DEFAULT;
  private gammaFrom = MAP_GAMMA_DEFAULT;
  private gammaTo = MAP_GAMMA_DEFAULT;
  private gammaElapsedMs = 0;
  private gammaAnimating = false;
  private epochUtcMs = 0;
  private sampled = false;
  private extentAU = 1;
  private needsInitialFrame = false;

  // Scratch — no per-frame allocation in steady state.
  private tmpMap: MapVec3 = { x: 0, y: 0, z: 0 };
  private tmpMap2: MapVec3 = { x: 0, y: 0, z: 0 };
  private tmpProj: ScreenProjection = { x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0 };
  private tmpProj2: ScreenProjection = { x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0 };
  private tmpSize = new THREE.Vector2();
  private tmpViewport = new THREE.Vector4();
  private tmpView = new THREE.Vector3();

  // Un-docked ship pulse phase (wall ms).
  private pulseMs = 0;

  // Label anti-collision: screen positions already placed this frame (Sun +
  // the planets), scanned in priority order so an inner planet yields to the
  // Sun and outer planets yield to inner. Preallocated for Sun + 10 bodies.
  private placedX = new Float32Array(PLANETARIUM_BODIES.length + 1);
  private placedY = new Float32Array(PLANETARIUM_BODIES.length + 1);
  private placedCount = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.scene.background = new THREE.Color(BG_COLOR);

    const el = renderer.domElement;
    this.camera = new THREE.PerspectiveCamera(
      MAP_FOV_DEG,
      Math.max(el.clientWidth, 1) / Math.max(el.clientHeight, 1),
      1e-4,
      1000,
    );

    this.controls = new OrbitControls(this.camera, el);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.enabled = false;
    // Keep it a map: never fully edge-on, never underneath.
    this.controls.minPolarAngle = 0.08;
    this.controls.maxPolarAngle = (78 * Math.PI) / 180;

    this.sun = this.makeGlowSprite(SUN_DATA.color, 1.15);
    this.scene.add(this.sun);

    for (const planet of PLANETARIUM_BODIES) {
      this.orbits.push(this.makeOrbit(planet, el));
    }

    this.shipChevronTex = this.makeChevronTexture();
    this.shipRingTex = this.makeRingTexture();
    const shipMat = new THREE.SpriteMaterial({
      map: this.shipChevronTex,
      color: 0xffb88a, // ember
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.shipMarker = new THREE.Sprite(shipMat);
    this.shipMarker.renderOrder = 10;
    this.scene.add(this.shipMarker);
  }

  isOpen(): boolean {
    return this.open;
  }

  getGamma(): number {
    return this.gamma;
  }

  getCameraDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /** Enter the map: (re)sample the orbits at the current clock. The first
   *  update() frames the whole system (ship included, positioned there). The
   *  caller owns the world's controls.enabled restore. */
  openMap(utcMs: number): void {
    this.open = true;
    this.ensureLabelContainer();
    this.resample(utcMs);
    this.controls.enabled = true;
    this.needsInitialFrame = true;
  }

  /** Seat the camera at a 3/4 overhead framing the live extent (ship included). */
  private frameToExtent(): void {
    const dist = fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect);
    this.camera.position.set(0, dist * 0.82, dist * 0.57).setLength(dist);
    this.controls.target.set(0, 0, 0);
    this.applyBounds(dist);
    this.controls.update();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.controls.enabled = false;
    for (const label of this.labels) label.style.display = 'none';
  }

  /** Segmented scale control: animate gamma toward compressed / true scale. */
  setScale(trueScale: boolean): void {
    const target = trueScale ? MAP_GAMMA_TRUE : MAP_GAMMA_DEFAULT;
    if (Math.abs(target - this.gammaTo) < 1e-9 && !this.gammaAnimating) return;
    this.gammaFrom = this.gamma;
    this.gammaTo = target;
    this.gammaElapsedMs = 0;
    this.gammaAnimating = true;
  }

  isTrueScale(): boolean {
    return this.gammaTo >= MAP_GAMMA_TRUE - 1e-6;
  }

  /** Dev bridge: snap gamma without animating. */
  setGamma(g: number): void {
    this.gammaAnimating = false;
    this.gamma = g;
    this.gammaFrom = g;
    this.gammaTo = g;
    this.recompressOrbits();
  }

  /**
   * Per-frame refresh, called from PlanetariumMode after positions are final.
   * Recomputes body positions from the clock (never from mode scene state) and
   * the ship from its snapshot pose.
   */
  update(
    utcMs: number,
    shipX: number,
    shipY: number,
    shipZ: number,
    shipHeading: number,
    shipPitch: number,
    shipMoving: boolean,
    landed: boolean,
    dtMs: number,
  ): void {
    if (!this.open) return;

    // ── (1) Positions from the clock — place every body and the ship marker.
    // No projection here: the camera matrices are still last frame's, so
    // anything screen-space would drag a frame behind the controls move below.
    if (!this.sampled || Math.abs(utcMs - this.epochUtcMs) > ORBIT_LINE_RESAMPLE_MAX_AGE_MS) {
      this.resample(utcMs);
    }

    // Advance the scale animation; a live gamma re-projects the cached samples.
    if (this.gammaAnimating) {
      this.gammaElapsedMs = Math.min(this.gammaElapsedMs + dtMs, MAP_GAMMA_ANIM_MS);
      const t = this.gammaElapsedMs / MAP_GAMMA_ANIM_MS;
      this.gamma = this.gammaFrom + (this.gammaTo - this.gammaFrom) * smoothstepUnclamped(t);
      this.recompressOrbits();
      if (t >= 1) {
        this.gamma = this.gammaTo;
        this.gammaAnimating = false;
      }
    }

    this.updateBodies(utcMs);
    this.placeShip(shipX, shipY, shipZ, shipMoving, landed, dtMs);

    // ── (2) Camera: fit or re-clamp to the live extent (compression animating,
    // ship drifting), then flush the controls and matrices BEFORE any
    // projection. The renderer refreshes matrices only at render time, which
    // runs after this update, so a projection-dependent pass must force it.
    this.recomputeExtent();
    if (this.needsInitialFrame) {
      // First frame after open: bodies and ship are positioned, so the fit
      // includes a ship past Pluto.
      this.needsInitialFrame = false;
      this.frameToExtent();
    } else {
      this.applyBounds(this.getCameraDistance());
      this.controls.update();
    }
    this.camera.updateMatrixWorld();

    // ── (3) Projection-dependent work, on this frame's final camera pose.
    this.orientShip(shipX, shipY, shipZ, shipHeading, shipPitch, shipMoving, landed);
    this.scaleMarkers();
    this.renderLabels();
  }

  /** Render the map to the backbuffer, restoring the renderer state it touches. */
  render(): void {
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevScissor = renderer.getScissorTest();
    const prevAutoClear = renderer.autoClear;
    renderer.getViewport(this.tmpViewport);
    renderer.getSize(this.tmpSize);
    renderer.setRenderTarget(null);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.tmpSize.x, this.tmpSize.y);
    renderer.autoClear = true;
    // Restore in finally so a throw inside render() never strands the world
    // renderer on the map's target/viewport/autoClear state.
    try {
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setScissorTest(prevScissor);
      renderer.setViewport(this.tmpViewport);
      renderer.autoClear = prevAutoClear;
    }
  }

  /** Resize: match the camera aspect and every fat-line resolution to the canvas. */
  onResize(): void {
    const el = this.renderer.domElement;
    const w = Math.max(el.clientWidth, 1);
    const h = Math.max(el.clientHeight, 1);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const o of this.orbits) o.material.resolution.set(w, h);
  }

  // ---- internals -------------------------------------------------------

  private resample(utcMs: number): void {
    this.epochUtcMs = utcMs;
    this.sampled = true;
    for (const entry of this.orbits) {
      const pts = sampleTrajectoryLinePoints(entry.planet, utcMs, ORBIT_SEGMENTS);
      for (let i = 0; i <= ORBIT_SEGMENTS; i++) {
        const p = pts[i];
        entry.raw[i * 3] = p.x;
        entry.raw[i * 3 + 1] = p.y;
        entry.raw[i * 3 + 2] = p.z;
      }
      entry.lastVertex = -1;
    }
    this.recompressOrbits();
  }

  private recompressOrbits(): void {
    for (const entry of this.orbits) {
      let maxR = 0;
      for (let i = 0; i <= ORBIT_SEGMENTS; i++) {
        projectMapPoint(
          entry.raw[i * 3],
          entry.raw[i * 3 + 1],
          entry.raw[i * 3 + 2],
          this.gamma,
          this.tmpMap,
        );
        entry.map[i * 3] = this.tmpMap.x;
        entry.map[i * 3 + 1] = this.tmpMap.y;
        entry.map[i * 3 + 2] = this.tmpMap.z;
        // Projected radius = |compressed point| = r^gamma; the aphelion sample
        // sets this orbit's reach, so an eccentric orbit (Pluto) isn't clipped
        // by a semi-major-axis extent.
        const r = Math.hypot(this.tmpMap.x, this.tmpMap.y, this.tmpMap.z);
        if (r > maxR) maxR = r;
      }
      entry.maxMapRadius = maxR;
      this.writePositions(entry);
    }
  }

  // Line2 layout: LineGeometry packs the (N+1)-point polyline into an
  // interleaved instance buffer of N segments, each holding the pair
  // [start.xyz, end.xyz] at stride 6 (see LineSegmentsGeometry.setPositions).
  // setPositions/setColors reallocate that buffer and its attributes every
  // call; on the gamma animation and per-frame colour rebuilds that churns, so
  // after the one-time build we mutate the existing arrays in place.

  /** Pack entry.map (contiguous xyz per point) into the interleaved segment
   *  buffer: point k is the start of segment k and the end of segment k-1. */
  private writePositions(entry: OrbitEntry): void {
    const attr = entry.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute;
    const arr = attr.data.array as Float32Array;
    const map = entry.map;
    for (let seg = 0; seg < ORBIT_SEGMENTS; seg++) {
      const a = seg * 3;
      const b = a + 3;
      const o = seg * 6;
      arr[o] = map[a];
      arr[o + 1] = map[a + 1];
      arr[o + 2] = map[a + 2];
      arr[o + 3] = map[b];
      arr[o + 4] = map[b + 1];
      arr[o + 5] = map[b + 2];
    }
    // instanceStart and instanceEnd share this one interleaved buffer.
    attr.data.needsUpdate = true;
  }

  /** Pack entry.colors (contiguous rgb per point) into the interleaved segment
   *  colour buffer with the same start/end pairing as writePositions. */
  private writeColors(entry: OrbitEntry): void {
    const attr = entry.geometry.attributes.instanceColorStart as THREE.InterleavedBufferAttribute;
    const arr = attr.data.array as Float32Array;
    const colors = entry.colors;
    for (let seg = 0; seg < ORBIT_SEGMENTS; seg++) {
      const a = seg * 3;
      const b = a + 3;
      const o = seg * 6;
      arr[o] = colors[a];
      arr[o + 1] = colors[a + 1];
      arr[o + 2] = colors[a + 2];
      arr[o + 3] = colors[b];
      arr[o + 4] = colors[b + 1];
      arr[o + 5] = colors[b + 2];
    }
    attr.data.needsUpdate = true;
  }

  /** Position each planet dot on the exact ephemeris (never the sampled chord),
   *  compressed through the live gamma, and refresh the direction fade only
   *  when the body crosses a sampled vertex. */
  private updateBodies(utcMs: number): void {
    for (const entry of this.orbits) {
      // The truth seam: the same heliocentric AU the world draws, projected
      // through the map compression. computeBodyPositionAU returns a fresh
      // vector (the astronomy layer's own allocation, as the world uses it);
      // its components are copied straight into the map scratch, so the map
      // adds no per-frame allocation of its own.
      const helio = computeBodyPositionAU(entry.planet, utcMs);
      projectMapPoint(helio.x, helio.y, helio.z, this.gamma, this.tmpMap);
      entry.dot.position.set(this.tmpMap.x, this.tmpMap.y, this.tmpMap.z);
      // The fade still keys off the sampled loop — cheap and only rebuilt on a
      // vertex crossing.
      const frac = this.bodyFraction(entry, utcMs);
      const i0 = Math.floor(frac * ORBIT_SEGMENTS);
      if (i0 !== entry.lastVertex) {
        entry.lastVertex = i0;
        this.rebuildOrbitColors(entry, frac);
      }
    }
  }

  /** Fractional position [0,1) of the body along its sampled loop at `utcMs`. */
  private bodyFraction(entry: OrbitEntry, utcMs: number): number {
    // Sample i is at epoch + (i/N - 0.5)*period, so the body sits at
    // 0.5 + (utcMs - epoch)/period of the loop.
    let frac = 0.5 + (utcMs - this.epochUtcMs) / entry.periodMs;
    frac -= Math.floor(frac);
    return frac;
  }

  private rebuildOrbitColors(entry: OrbitEntry, bodyFrac: number): void {
    // Working (linear) channels, cached at build — matches the sprite material.
    const r = entry.colorR;
    const g = entry.colorG;
    const b = entry.colorB;
    for (let i = 0; i <= ORBIT_SEGMENTS; i++) {
      // Forward arc distance from the body to this vertex, [0,1): 0 = right
      // ahead of the body (full tint), ~1 = just behind (darkest).
      let d = i / ORBIT_SEGMENTS - bodyFrac;
      d -= Math.floor(d);
      const bright = ORBIT_BRIGHT_FLOOR + (1 - ORBIT_BRIGHT_FLOOR) * (1 - d);
      entry.colors[i * 3] = r * bright;
      entry.colors[i * 3 + 1] = g * bright;
      entry.colors[i * 3 + 2] = b * bright;
    }
    this.writeColors(entry);
  }

  /** Phase (1): place the ship marker in map space, pick docked/moving texture,
   *  and breathe the un-docked chevron. No projection — the camera hasn't been
   *  flushed for this frame yet; the heading rotation waits for orientShip. */
  private placeShip(
    x: number,
    y: number,
    z: number,
    moving: boolean,
    landed: boolean,
    dtMs: number,
  ): void {
    projectMapPoint(x, y, z, this.gamma, this.tmpMap);
    this.shipMarker.position.set(this.tmpMap.x, this.tmpMap.y, this.tmpMap.z);
    const docked = landed || !moving;
    const mat = this.shipMarker.material;
    const wantTex = docked ? this.shipRingTex : this.shipChevronTex;
    if (mat.map !== wantTex) {
      mat.map = wantTex;
      mat.needsUpdate = true;
    }
    // A subtle 2 s pulse marks the live ship while it coasts; the docked ring
    // holds steady so a parked ship reads settled.
    this.pulseMs += dtMs;
    if (docked) {
      mat.opacity = 1;
    } else {
      const s = Math.sin((this.pulseMs / SHIP_PULSE_MS) * Math.PI * 2);
      mat.opacity = 0.875 + 0.125 * s;
    }
  }

  /** Phase (3): rotate the chevron to the ship's on-screen velocity. Reads the
   *  camera, so it must run after the controls/matrix flush. Docked marker keeps
   *  the neutral rotation placeShip left it with. */
  private orientShip(
    x: number,
    y: number,
    z: number,
    heading: number,
    pitch: number,
    moving: boolean,
    landed: boolean,
  ): void {
    const mat = this.shipMarker.material;
    if (landed || !moving) {
      mat.rotation = 0;
      return;
    }
    // Project the ship and a point one step along its heading, both through the
    // map compression, and take the screen-space delta.
    const cp = Math.cos(pitch);
    const step = Math.max(0.002, Math.hypot(x, y, z) * 0.04);
    projectMapPoint(
      x + Math.cos(heading) * cp * step,
      y + Math.sin(pitch) * step,
      z + Math.sin(heading) * cp * step,
      this.gamma,
      this.tmpMap2,
    );
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    projectToScreen(this.shipMarker.position, this.camera, w, h, this.tmpProj);
    projectToScreen(this.tmpMap2, this.camera, w, h, this.tmpProj2);
    const dx = this.tmpProj2.x - this.tmpProj.x;
    const dy = this.tmpProj2.y - this.tmpProj.y;
    // Chevron texture points up; screen y is down. Angle from screen-up,
    // negated for the sprite's CCW rotation.
    mat.rotation = -Math.atan2(dx, -dy);
  }

  private recomputeExtent(): void {
    let max = 0;
    // Each orbit's drawn reach is its aphelion sample, not its semi-major axis
    // (maxMapRadius, refreshed with recompressOrbits), so an eccentric orbit
    // drawn at true scale never overflows the fit.
    for (const entry of this.orbits) {
      if (entry.maxMapRadius > max) max = entry.maxMapRadius;
    }
    // The ship is just another radius — a probe past Pluto widens the frame.
    const shipR = this.shipMarker.position.length();
    if (shipR > max) max = shipR;
    this.extentAU = Math.max(max, 1e-3);
  }

  private applyBounds(cameraDist: number): void {
    this.controls.minDistance = this.extentAU * 0.12;
    this.controls.maxDistance = fitDistanceAU(this.extentAU, MAP_FOV_DEG, this.camera.aspect) * 1.8;
    this.camera.near = Math.max(this.extentAU * 1e-3, 1e-4);
    this.camera.far = cameraDist + this.extentAU * 2 + 10;
    this.camera.updateProjectionMatrix();
  }

  /** Constant screen-size sprites: world scale = px * (world-per-px at the
   *  sprite's camera distance). One shared factor, then a distance per sprite. */
  private scaleMarkers(): void {
    const h = Math.max(this.renderer.domElement.clientHeight, 1);
    const worldPerPxAtUnit = (2 * Math.tan((MAP_FOV_DEG * Math.PI) / 180 / 2)) / h;
    this.applyMarkerScale(this.sun, SUN_PX, worldPerPxAtUnit);
    for (const entry of this.orbits) this.applyMarkerScale(entry.dot, PLANET_PX, worldPerPxAtUnit);
    this.applyMarkerScale(this.shipMarker, SHIP_PX, worldPerPxAtUnit);
  }

  private applyMarkerScale(sprite: THREE.Sprite, px: number, worldPerPxAtUnit: number): void {
    // Perspective screen size follows the camera-space depth (distance along the
    // view axis), not the Euclidean distance — the latter runs an off-axis dot
    // ~10% oversized. worldPerPxAtUnit is the world span of one px at unit depth.
    this.tmpView.copy(sprite.position).applyMatrix4(this.camera.matrixWorldInverse);
    const depth = Math.max(-this.tmpView.z, 1e-6);
    sprite.scale.setScalar(px * worldPerPxAtUnit * depth);
  }

  private renderLabels(): void {
    if (!this.labelContainer) return;
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    // Priority order: Sun (index 0) first, then the planets inner→outer (catalog
    // order). A label too close to one already placed this frame yields, so the
    // Sun and the inner planets win over their crowded neighbours at true scale.
    this.placedCount = 0;
    this.placeLabel(0, this.sun.position, w, h);
    for (let i = 0; i < this.orbits.length; i++) {
      this.placeLabel(i + 1, this.orbits[i].dot.position, w, h);
    }
  }

  private placeLabel(index: number, worldPos: THREE.Vector3, w: number, h: number): void {
    const label = this.labels[index];
    if (!label) return;
    projectToScreen(worldPos, this.camera, w, h, this.tmpProj);
    const onScreen =
      this.tmpProj.ndcZ < 1 &&
      this.tmpProj.x > -40 &&
      this.tmpProj.x < w + 40 &&
      this.tmpProj.y > -20 &&
      this.tmpProj.y < h + 20;
    if (!onScreen) {
      if (label.style.display !== 'none') label.style.display = 'none';
      return;
    }
    // Proximity cull: hide if the anchor lands within LABEL_MIN_SEP_PX of an
    // already-placed (higher-priority) label this frame.
    const x = this.tmpProj.x;
    const y = this.tmpProj.y;
    for (let i = 0; i < this.placedCount; i++) {
      const dx = x - this.placedX[i];
      const dy = y - this.placedY[i];
      if (dx * dx + dy * dy < LABEL_MIN_SEP_PX * LABEL_MIN_SEP_PX) {
        if (label.style.display !== 'none') label.style.display = 'none';
        return;
      }
    }
    this.placedX[this.placedCount] = x;
    this.placedY[this.placedCount] = y;
    this.placedCount++;
    if (label.style.display === 'none') label.style.display = '';
    label.style.transform = `translate(-50%, 0) translate(${x}px, ${y + 9}px)`;
  }

  private ensureLabelContainer(): void {
    if (this.labelContainer) return;
    this.labelContainer = document.getElementById('map-labels');
    if (!this.labelContainer) return;
    const names = ['Sun', ...PLANETARIUM_BODIES.map((b) => b.name)];
    for (const name of names) {
      const div = document.createElement('div');
      div.className = 'map-label';
      div.textContent = name === 'Sun' ? 'Sun' : bodyDisplayName(name);
      div.style.display = 'none';
      this.labelContainer.appendChild(div);
      this.labels.push(div);
    }
  }

  // ---- geometry / texture builders -------------------------------------

  private makeOrbit(planet: PlanetData, el: HTMLElement): OrbitEntry {
    const raw = new Float32Array((ORBIT_SEGMENTS + 1) * 3);
    const map = new Float32Array((ORBIT_SEGMENTS + 1) * 3);
    const colors = new Float32Array((ORBIT_SEGMENTS + 1) * 3);
    const geometry = new LineGeometry();
    geometry.setPositions(map);
    geometry.setColors(colors);
    const material = new LineMaterial({
      linewidth: 1.5,
      vertexColors: true,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    material.resolution.set(Math.max(el.clientWidth, 1), Math.max(el.clientHeight, 1));
    const line = new Line2(geometry, material);
    line.renderOrder = 1;
    line.frustumCulled = false;
    this.scene.add(line);
    const dot = this.makeGlowSprite(planet.color, 1);
    dot.renderOrder = 5;
    this.scene.add(dot);
    const periodMs = 365.25 * Math.pow(planet.semiMajorAxisAU, 1.5) * 86_400_000;
    // Catalog hex is sRGB; THREE.Color(hex) converts it into the renderer's
    // working (linear) space, so the vertex-coloured line matches the sprite's
    // managed material.color instead of rendering hot.
    const tint = new THREE.Color(planet.color);
    return {
      planet,
      periodMs,
      raw,
      map,
      colors,
      geometry,
      material,
      line,
      dot,
      lastVertex: -1,
      maxMapRadius: 0,
      colorR: tint.r,
      colorG: tint.g,
      colorB: tint.b,
    };
  }

  private makeGlowSprite(color: number, coreBoost: number): THREE.Sprite {
    const tex = this.makeGlowTexture(coreBoost);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    return new THREE.Sprite(mat);
  }

  private makeGlowTexture(coreBoost: number): THREE.Texture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    const core = Math.min(1, 0.55 * coreBoost);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(core, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.18)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    applyTextureDefaults(tex, 'color');
    return tex;
  }

  private makeChevronTexture(): THREE.Texture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(255,255,255,0.98)';
    ctx.beginPath();
    // Chevron pointing up.
    ctx.moveTo(size / 2, size * 0.16);
    ctx.lineTo(size * 0.82, size * 0.84);
    ctx.lineTo(size / 2, size * 0.66);
    ctx.lineTo(size * 0.18, size * 0.84);
    ctx.closePath();
    ctx.fill();
    const tex = new THREE.CanvasTexture(canvas);
    applyTextureDefaults(tex, 'color');
    return tex;
  }

  private makeRingTexture(): THREE.Texture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.32, 0, Math.PI * 2);
    ctx.stroke();
    const tex = new THREE.CanvasTexture(canvas);
    applyTextureDefaults(tex, 'color');
    return tex;
  }
}
