/**
 * Builds the Planetarium scene graph: Sun, all planets, orbit lines, asteroid belt.
 * `layoutMode` is 'aligned' (evenly spread for a compact overview) or 'realistic'
 * (ephemeris positions at a given date). Units are AU on the ecliptic.
 *
 * Orbit lines are Line2 fat lines (pixel-authored width, butt caps, feathered
 * edges — see createOrbitLineMaterial) pre-distorted for the lens pass, with a
 * per-frame opacity law (orbitLineOpacity) driven by PlanetariumMode.
 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { PLANETARIUM_BODIES, ASTEROID_BELT, type PlanetData } from './planets/planetData';
import { createPlanetMesh, createPlanetariumSun, type PlanetMesh } from './PlanetFactory';
import {
  computeBodyPositionAU,
  eclipticToEquatorial,
  sampleOrbitLinePoints,
  sampleTrajectoryLinePoints,
} from '../astronomy/planetary';
import { KM_PER_AU } from '../astronomy/constants';
import type { KeplerElements } from '../astronomy/standish';
import { augmentPointsMaterialWithSunGlareMask } from './world/sunGlareMask';
import { ORBIT_LINE_STENCIL_REF, applyOrbitLineStencilGate } from './world/orbitLineStencil';
import {
  augmentFixedScreenLineForLens,
  createLensShaderUniforms,
  type LensShaderUniforms,
} from '../shared/three/lensShader';
import { smoothstepUnclamped } from '../shared/math/smoothstep';

export type PlanetariumLayout = 'aligned' | 'realistic';
export const CREATE_SOLAR_SYSTEM_TOTAL_UNITS =
  1 + PLANETARIUM_BODIES.length + PLANETARIUM_BODIES.length + 1;

export interface SolarSystemLoadProgress {
  completedUnits: number;
  totalUnits: number;
}

export interface SolarSystemObjects {
  sun: THREE.Group;
  planets: PlanetMesh[];
  orbitLines: Line2[];
  /** Sim epoch the orbit lines were last sampled at (lazy drift rebuild). */
  orbitLinesEpochUtcMs: number;
  /** One shared uniform block for every orbit line's lens pre-distortion —
   * refreshed once per frame by PlanetariumMode.updateOrbitLineVisibility. */
  orbitLensUniforms: LensShaderUniforms;
  asteroidBelt: THREE.Points;
  sunLight: THREE.PointLight;
}

// Decorative spread in the ecliptic plane, baked into the scene's J2000
// equatorial frame so aligned planets sit on their transformed orbit circles.
function createAlignedPlanetPosition(planet: PlanetData, seed: number): { x: number; y: number; z: number } {
  const radius = planet.semiMajorAxisAU;
  const spread = ((seed * 7.13) % 1 - 0.5) * (Math.PI / 6);
  const position = eclipticToEquatorial(
    new THREE.Vector3(radius * Math.cos(spread), 0, -radius * Math.sin(spread)),
  );
  return { x: position.x, y: position.y, z: position.z };
}

export function getPlanetOrbitalPosition(
  planet: PlanetData,
  seed: number,
  layoutMode: PlanetariumLayout,
  date?: Date,
): { x: number; y: number; z: number } {
  if (layoutMode === 'aligned') {
    return createAlignedPlanetPosition(planet, seed);
  }

  const position = computeBodyPositionAU(planet, (date ?? new Date()).getTime());
  return { x: position.x, y: position.y, z: position.z };
}

/** Aligned-mode ring: an epoch-free ecliptic circle at the catalog radius. */
function alignedCircleElements(planet: PlanetData): KeplerElements {
  return {
    semiMajorAxisAU: planet.semiMajorAxisAU,
    eccentricity: 0,
    inclinationDeg: 0,
    lonPerihelionDeg: 0,
    ascendingNodeDeg: 0,
    meanAnomalyDeg: 0,
  };
}

/** Aligned-mode circle segment count (planets sit exactly on the circles). */
export const ORBIT_LINE_SEGMENTS = 256;

/**
 * How far the clock may drift from the epoch the orbit polylines were sampled
 * at before they must be re-sampled. A real-trajectory strip passes through
 * its body only near the epoch: past half a period a body re-treads a loop
 * that has precessed a little, and year-over-year perturbation wiggle creeps
 * in. 60 days keeps every body within ~a third of its own radius of the drawn
 * line for a few-ms resample a handful of times per simulated year. One
 * definition site — the cruise orbit lines and the system map both read it.
 */
export const ORBIT_LINE_RESAMPLE_MAX_AGE_MS = 60 * 86_400_000;

/**
 * Realistic-mode segment count, sized so the polyline's chord sagitta stays
 * under ~a quarter of the body's own radius — the planet has to sit ON its
 * line even at landed zoom: N ≈ 2π·√(a / (8·R/4)), rounded up to a multiple
 * of 256. The old global 256 left every planet 1–13 body radii off its line
 * mid-chord (Pluto: ~200 — tiny body, enormous orbit; it clamps at 8192 for
 * ~0.37 R there).
 */
export function orbitLineSegmentCount(planet: PlanetData): number {
  const aKm = planet.semiMajorAxisAU * KM_PER_AU;
  const ideal = Math.ceil(2 * Math.PI * Math.sqrt(aKm / (2 * planet.radiusKm)));
  return Math.min(8192, Math.max(1024, Math.ceil(ideal / 256) * 256));
}

/**
 * One body's orbit-line vertices at a sim epoch. Realistic mode samples the
 * body's actual rendered trajectory (computeBodyPositionAU — see
 * sampleTrajectoryLinePoints for why elements aren't enough); aligned mode
 * draws epoch-free circles at the catalog radius.
 */
function sampleLinePoints(
  planet: PlanetData,
  layoutMode: PlanetariumLayout,
  utcMs: number,
): THREE.Vector3[] {
  if (layoutMode === 'aligned') {
    return sampleOrbitLinePoints(alignedCircleElements(planet), ORBIT_LINE_SEGMENTS);
  }
  return sampleTrajectoryLinePoints(planet, utcMs, orbitLineSegmentCount(planet));
}

/**
 * Re-sample every orbit line's geometry at the given sim epoch and re-stamp
 * orbitLinesEpochUtcMs. Writes each polyline in place via setOrbitLinePoints —
 * replacing the Line objects would break the orbitLines[i] ↔
 * PLANETARIUM_BODIES[i] coupling — including fresh bounds (an updated buffer
 * never invalidates the cached sphere, which would leave frustum culling
 * stale). The staleness *policy* (when to call this) lives with the caller,
 * PlanetariumMode.rebuildOrbitLinesIfStale.
 */
export function resampleOrbitLines(
  objects: Pick<SolarSystemObjects, 'orbitLines' | 'orbitLinesEpochUtcMs'>,
  layoutMode: PlanetariumLayout,
  utcMs: number,
): void {
  for (let i = 0; i < objects.orbitLines.length; i++) {
    const points = sampleLinePoints(PLANETARIUM_BODIES[i], layoutMode, utcMs);
    setOrbitLinePoints(objects.orbitLines[i], points);
  }
  objects.orbitLinesEpochUtcMs = utcMs;
}

/**
 * Screen-space orbit-line width in CSS px (LineSegments2 refreshes
 * `material.resolution` from the renderer viewport on every draw, so the value
 * is DPR-invariant; the lens augment keeps it constant in final output space).
 * The fragment feather softens the outer ~1 device px of each side, so the
 * solid core reads slightly narrower than this number.
 */
export const ORBIT_LINE_WIDTH_PX = 2.25;

/** Opacity when neither term speaks for a line: far from the player's
 * neighbourhood with the camera too close to read the orbit as a ring.
 * Tuned with the width: below ~2 px the lens resample's brightness ripple
 * reads as dashes, and at 0.05 the ripple was proportionally huge. */
export const ORBIT_LINE_OPACITY_FLOOR = 0.14;
/** Neighbourhood saturation — the player is on/near this orbit. */
export const ORBIT_LINE_OPACITY_CAP = 0.55;
/** Map-read level once the camera is pulled far enough to see the whole ring.
 * Sits at the cap deliberately: at whole-system zoom the arcs peak at
 * 110–150/255 luma — confident chart lines — and the lens resample's
 * residual few-code ripple falls below visible contrast, where the old dim
 * lines let it read as banding. */
export const ORBIT_LINE_OVERVIEW_OPACITY = 0.55;

/**
 * Per-frame orbit-line opacity. Two independent claims on visibility, max-
 * combined: `proximity` keeps the player's own neighbourhood bright (the
 * pre-existing law: full within ~a third of the orbit radius, gone beyond it),
 * and `overview` restores the lines as chart furniture whenever the camera —
 * not the player, so a pulled-back or Sun-framed view counts — stands far
 * enough outside an orbit to see it whole (ramps over camera distance 1→2
 * orbit radii). Without the overview term a whole-system view pins every line
 * to the floor, because the player is parked on one planet while the camera
 * does the sightseeing.
 */
export function orbitLineOpacity(
  playerSunDistAU: number,
  cameraSunDistAU: number,
  semiMajorAxisAU: number,
): number {
  if (
    !Number.isFinite(playerSunDistAU) ||
    !Number.isFinite(cameraSunDistAU) ||
    !Number.isFinite(semiMajorAxisAU) ||
    semiMajorAxisAU <= 0
  ) {
    return ORBIT_LINE_OPACITY_FLOOR;
  }
  const fadeRangeAU = Math.max(semiMajorAxisAU * 0.3, 1);
  const proximity = 1 - Math.abs(playerSunDistAU - semiMajorAxisAU) / fadeRangeAU;
  const overviewT = Math.min(1, Math.max(0, cameraSunDistAU / semiMajorAxisAU - 1));
  const overview = ORBIT_LINE_OVERVIEW_OPACITY * smoothstepUnclamped(overviewT);
  return Math.min(
    ORBIT_LINE_OPACITY_CAP,
    Math.max(ORBIT_LINE_OPACITY_FLOOR, Math.max(proximity, overview)),
  );
}

/** Orbit lines are scene furniture: draw them beneath every default-order
 * transparent (belt dots, atmosphere shells, exhaust) instead of letting the
 * bounding-sphere z-sort flip the layering as the camera moves. Drawing
 * first is also what lets their stencil stamp gate the décor drawn after. */
const ORBIT_LINE_RENDER_ORDER = -1;

function replaceExactlyOnce(source: string, anchor: string, replacement: string): string {
  const first = source.indexOf(anchor);
  if (first === -1 || source.indexOf(anchor, first + 1) !== -1) {
    throw new Error(`orbit-line shader anchor not found exactly once: "${anchor}"`);
  }
  return source.replace(anchor, replacement);
}

/**
 * LineMaterial tuned for a low-opacity transparent polyline. Two stock
 * fragment-shader behaviours are wrong for that use and get patched out
 * (`replaceExactlyOnce` fails the build loudly if a three upgrade moves the
 * anchors):
 *
 * - Round endcaps survive past each segment end and double-blend over the
 *   neighbour segment's quad — at orbit tessellation that is a bright bead at
 *   every joint. Butt caps instead; the resulting outer-bend notch is
 *   `w·tan(θ/2)` ≈ 0.02 px at the coarsest ring (256 segments), invisible.
 * - Body side edges are hard rasterized edges (the stock feather exists only
 *   on the alpha-to-coverage path, which needs MSAA the composer target does
 *   not have, and it *assigns* over the opacity). Feather the outer device
 *   pixel of each side via `vUv.x` — the cross-line axis — multiplying into
 *   `alpha` so the per-frame opacity fade survives. The derivative is taken
 *   before the cap discard (tile GPUs dislike derivatives after non-uniform
 *   discards).
 *
 * The lens augment then pre-distorts the screen-space width so it stays
 * constant in final output space (CLAUDE.md lens contract; same helper as the
 * ShadowVisuals guides). The patched fragment source already yields a distinct
 * program-cache entry, but the explicit cache key keeps us deliberately apart
 * from the helper's shared `fixed-screen-line-lens-v2` key.
 */
export function createOrbitLineMaterial(
  color: number,
  opacity: number,
  lensUniforms: LensShaderUniforms,
): LineMaterial {
  const material = new LineMaterial({
    color,
    linewidth: ORBIT_LINE_WIDTH_PX,
    transparent: true,
    opacity,
    // No depth write: overlapping rings must blend, not z-chop each other
    // into patches (a depth-writing attempt did exactly that where Uranus's
    // and Neptune's rings pile up on the horizon). Planets still occlude the
    // lines through the depth TEST.
    depthWrite: false,
    worldUnits: false,
  });
  // The visible core stamps the stencil buffer instead: décor point fields
  // (starfield, asteroid belt) draw later and stencil-test NotEqual 1, so a
  // star or belt dot can never composite over a line and bead it — no alpha
  // can do this (a dot behind a dim line shows through at 1-alpha, and a
  // belt dot is usually NEARER than an outer ring, so depth can never reject
  // it), and depth quantization ties at tiny landed/close-pass near planes
  // make depth-writing unreliable here anyway. Fragments hidden behind a
  // planet fail the depth test and stamp nothing, so décor still shows where
  // the line itself is occluded. Bodies (moon dots) deliberately don't test.
  material.stencilWrite = true;
  material.stencilRef = ORBIT_LINE_STENCIL_REF;
  material.stencilZPass = THREE.ReplaceStencilOp;
  let fragment = material.fragmentShader;
  fragment = replaceExactlyOnce(
    fragment,
    'float alpha = opacity;',
    /* glsl */ `float alpha = opacity;

			#ifndef WORLD_UNITS
				// True screen-space gradient, not fwidth: fwidth is |ddx|+|ddy|,
				// which overstates the gradient by up to sqrt(2) depending on the
				// segment's screen slope, so an fwidth-sized feather breathes
				// along a curving arc and bands it at the raster staircase period.
				float lineEdgeWidth = length( vec2( dFdx( vUv.x ), dFdy( vUv.x ) ) );
			#endif`,
  );
  fragment = replaceExactlyOnce(fragment, 'if ( len2 > 1.0 ) discard;', 'discard;');
  fragment = replaceExactlyOnce(
    fragment,
    'gl_FragColor = vec4( diffuseColor.rgb, alpha );',
    /* glsl */ `#ifndef WORLD_UNITS
				// Linear coverage ramp that reaches exactly zero AT the quad
				// edge: a trapezoid profile whose ramps are one pixel wide sums
				// to the same per-column flux wherever the line centre falls
				// between pixel centres, so the sub-pixel phase drift along a
				// shallow arc produces no brightness banding. A smoothstep, or
				// any ramp that ends short of the edge, leaves a residual
				// coverage step whose beat is visible as evenly spaced bands on
				// far-out orbit arcs.
				float lineEdgeCoverage = clamp( ( 1.0 - abs( vUv.x ) ) / max( lineEdgeWidth, 1e-5 ), 0.0, 1.0 );
				// The core stamps the décor stencil, and discarded fragments
				// stamp nothing. The threshold must sit near zero — any step
				// truncated from the ramp re-creates the banding — so the
				// stamped band spans essentially the whole quad; the décor it
				// additionally culls is ~22% more edge pixels, and star/belt
				// stud counts measurably drop with the smoother edge.
				if ( lineEdgeCoverage < 0.05 ) discard;
				alpha *= lineEdgeCoverage;
			#endif

			gl_FragColor = vec4( diffuseColor.rgb, alpha );`,
  );
  material.fragmentShader = fragment;
  augmentFixedScreenLineForLens(material, lensUniforms);
  material.customProgramCacheKey = () => 'orbit-line-lens-buttcap-v2';
  return material;
}

/**
 * (Re)fill a Line2's polyline. Same segment count writes the pair-format
 * positions into the existing instanced buffer (LineGeometry.setPositions
 * would allocate a fresh GPU buffer per call — the periodic drift resample
 * must not churn); a different count (aligned ↔ realistic switch) swaps in a
 * fresh geometry and disposes the old one so its GPU buffers release
 * deterministically. Bounding box before sphere: the sphere centres on the
 * cached box.
 */
function setOrbitLinePoints(line: Line2, points: THREE.Vector3[]): void {
  const geometry = line.geometry;
  const start = geometry.getAttribute('instanceStart') as
    | THREE.InterleavedBufferAttribute
    | undefined;
  const end = geometry.getAttribute('instanceEnd') as
    | THREE.InterleavedBufferAttribute
    | undefined;
  const pairFloats = (points.length - 1) * 6;
  if (
    start !== undefined &&
    end !== undefined &&
    start.data === end.data &&
    start.data.stride === 6 &&
    start.offset === 0 &&
    end.offset === 3 &&
    start.data.array.length === pairFloats
  ) {
    const array = start.data.array as Float32Array;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const o = i * 6;
      array[o] = a.x;
      array[o + 1] = a.y;
      array[o + 2] = a.z;
      array[o + 3] = b.x;
      array[o + 4] = b.y;
      array[o + 5] = b.z;
    }
    start.data.needsUpdate = true;
    geometry.instanceCount = start.count;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return;
  }

  const flat = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    flat[i * 3] = points[i].x;
    flat[i * 3 + 1] = points[i].y;
    flat[i * 3 + 2] = points[i].z;
  }
  const fresh = new LineGeometry();
  fresh.setPositions(flat);
  (fresh.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute).data.setUsage(
    THREE.DynamicDrawUsage,
  );
  geometry.dispose();
  line.geometry = fresh;
}

function createOrbitLine(
  points: THREE.Vector3[],
  color: number,
  opacity: number,
  lensUniforms: LensShaderUniforms,
): Line2 {
  const line = new Line2(new LineGeometry(), createOrbitLineMaterial(color, opacity, lensUniforms));
  setOrbitLinePoints(line, points);
  line.renderOrder = ORBIT_LINE_RENDER_ORDER;
  return line;
}

const ASTEROID_BELT_SEED = 0x41535452;

/** Deterministic decorative scatter so captures and regression tests are stable. */
function asteroidBeltRng(): () => number {
  let state = ASTEROID_BELT_SEED;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function createAsteroidBelt(): THREE.Points {
  const count = 3000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const random = asteroidBeltRng();

  // Generate in the intermediate ecliptic frame, then bake into the scene's
  // J2000 equatorial frame. Height is ecliptic north, not scene-world +Y.
  for (let i = 0; i < count; i++) {
    const radius = ASTEROID_BELT.innerAU + random() * (ASTEROID_BELT.outerAU - ASTEROID_BELT.innerAU);
    const angle = random() * Math.PI * 2;
    const height = (random() - 0.5) * 0.05;
    const position = eclipticToEquatorial(
      new THREE.Vector3(radius * Math.cos(angle), height, -radius * Math.sin(angle)),
    );

    positions[i * 3] = position.x;
    positions[i * 3 + 1] = position.y;
    positions[i * 3 + 2] = position.z;

    const brightness = 0.4 + random() * 0.3;
    colors[i * 3] = brightness;
    colors[i * 3 + 1] = brightness * 0.9;
    colors[i * 3 + 2] = brightness * 0.7;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 0.003,
    vertexColors: true,
    transparent: true,
    opacity: 0.6,
    sizeAttenuation: true,
    depthWrite: false,
  });

  const belt = new THREE.Points(geometry, material);
  // Fade belt dots that sit behind the Sun's glare. The uniform refs are driven
  // per frame by the controller; inactive until then, so the belt is unchanged.
  belt.userData.sunGlareMaskUniforms = augmentPointsMaterialWithSunGlareMask(material);
  // Belt dots are usually NEARER than the outer rings, so without this gate
  // they pass the depth test and stud every ring behind them (Alex's tan
  // bumps: 1.6 studs per 1000 line px, +52 luma each).
  applyOrbitLineStencilGate(material);
  return belt;
}

export async function createSolarSystem(
  onProgress?: (progress: SolarSystemLoadProgress) => void,
  useBloom = true,
  layoutMode: PlanetariumLayout = 'realistic',
  date?: Date,
): Promise<SolarSystemObjects> {
  const totalUnits = CREATE_SOLAR_SYSTEM_TOTAL_UNITS;
  let completedUnits = 0;
  const reportProgress = () => onProgress?.({ completedUnits, totalUnits });

  reportProgress();
  const sun = createPlanetariumSun(useBloom);
  const sunLight = sun.children.find(child => child instanceof THREE.PointLight) as THREE.PointLight;
  completedUnits += 1;
  reportProgress();

  const planets = await Promise.all(PLANETARIUM_BODIES.map(async (body, index) => {
    const planetMesh = await createPlanetMesh(body);
    const position = getPlanetOrbitalPosition(body, index + 1, layoutMode, date);
    planetMesh.group.position.set(position.x, position.y, position.z);
    completedUnits += 1;
    reportProgress();
    return planetMesh;
  }));

  // Lines, planets, and the restored clock share one epoch at startup.
  const orbitLinesEpochUtcMs = (date ?? new Date()).getTime();
  const orbitLensUniforms = createLensShaderUniforms();
  const orbitLines: Line2[] = [];
  for (let i = 0; i < PLANETARIUM_BODIES.length; i++) {
    const body = PLANETARIUM_BODIES[i];
    const orbitPoints = sampleLinePoints(body, layoutMode, orbitLinesEpochUtcMs);
    const line = createOrbitLine(orbitPoints, body.color, 0.2, orbitLensUniforms);
    line.name = `orbit-${body.name}`;
    orbitLines.push(line);
    completedUnits += 1;
    reportProgress();
  }

  const asteroidBelt = createAsteroidBelt();
  completedUnits += 1;
  reportProgress();

  return {
    sun,
    planets,
    orbitLines,
    orbitLinesEpochUtcMs,
    orbitLensUniforms,
    asteroidBelt,
    sunLight,
  };
}
