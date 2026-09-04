/**
 * How finely a body's surface is being DRAWN: display pixels per texel of the
 * colour map actually on it, measured where the camera magnifies it most.
 *
 * One quantity, two instruments, and they answer different questions:
 *
 *   - In the shader, per fragment: `fwidth(uv) * textureSize(map, 0)`
 *     (surfaceShading's `smoothTexelWeight`). That reads the real GPU
 *     allocation of whatever map THIS material draws, so a streamed sector
 *     reports its own tile against its own UV and a released rung reports the
 *     coarser map the frame it lands. It is the authority wherever a fragment
 *     is being shaded.
 *   - Here, per body, on the CPU: for the probes that label a sheet, for the
 *     eased per-material envelope that keeps a fade from stepping, and for
 *     deriving a screen fraction that means a stated texel density. A
 *     per-fragment quantity cannot be read back, and a body-level scalar cannot
 *     be per-tile — so both exist and neither replaces the other.
 *
 * The CPU side measures at the SUB-CAMERA point, the most magnified point of a
 * sphere, through `projectedStepScale` — the same lens-correct instrument the
 * sector streamer measures its tiles with, and for the same reason: a cosine
 * between the normal and the line of sight reports the SMALLER screen scale, so
 * it foreshortens a limb patch to nothing while its texels are still drawn
 * several pixels wide along the limb.
 *
 * Both instruments are in device pixels, but not in the SAME device pixels: the
 * planetarium draws through a stereographic lens pass, so an in-shader
 * derivative is taken in overscan render-target pixels while the projection
 * here lands on displayed ones. The two differ by the local lens Jacobian —
 * bounded by `lensMaxFrameScale` and under 25% across the frame at the design
 * FOV. That is tuning-level for a soft fade band and it is why the band is soft;
 * it would not be good enough for anything that has to line up on a pixel.
 *
 * The map width is the width of the map being DRAWN, which is not the width
 * `ladderMapReferenceWidth` answers (that one is the finest tier the ladder can
 * still REACH, floored at the drawn rung — the number tiles are sized against,
 * deliberately ahead of the surface). A body sitting on its boot map with an
 * admitted 8K rung above it draws 2048 and references 8192, and using the
 * reference width here would report a surface four times sharper than the one
 * on screen.
 */
import * as THREE from 'three';
import { RAD2DEG } from '../../shared/math/angles';
import { projectedStepScale, type ProjectedStepScale } from '../../shared/three/projectToScreen';
import { ladderDrawnMapWidth, materialColorMap, type TextureUpgrade } from './textureLadder';

/**
 * How wide the hand-over is between a map that is being magnified and one the
 * mip chain has taken over, in map texels per screen pixel. Below the first
 * number a texel is stretched over more than a pixel and its interpolation is
 * what the eye is looking at; past the second the map is minified and there is
 * nothing left to smooth — or to synthesize.
 *
 * ONE band, read by both instruments: the cloud deck's smooth magnification
 * filter, the CPU measurement here, and the close-range detail synthesis all
 * hand over at the same place, so a surface never smooths at one density and
 * gains detail at another.
 */
export const SURFACE_TEXEL_FADE: readonly [number, number] = [0.7, 1.3];

/**
 * Width of the colour map this material is DRAWING, in texels — 0 where it
 * cannot be known.
 *
 * A ladder handle owns the answer for its own material and that answer is the
 * whole of it: an applied rung swaps its decoded source for a small stand-in
 * once the upload is paid, so the image behind a 4096-texel map reports a few
 * hundred pixels while the GPU holds the map. The image is read only where
 * there is no ladder at all — a boot-only photo map and a painted procedural
 * canvas are each their body's finest and are never swapped under it.
 */
export function drawnColorMapWidth(
  material: THREE.Material,
  ups: readonly TextureUpgrade[] = [],
): number {
  for (const up of ups) {
    if (up.material === material) return ladderDrawnMapWidth(up);
  }
  const map = materialColorMap(material);
  // A released source with no ladder behind it to answer for it: the image is
  // a stand-in and its width is not the map's. Better no measurement than one
  // off by the height of a ladder.
  if (!map || map.userData?.sourceReleased === true) return 0;
  const width = (map.image as { width?: number } | undefined)?.width;
  return typeof width === 'number' && width > 0 ? width : 0;
}

/**
 * Surface length of one texel of an equirect colour map `mapWidth` texels wide,
 * in whatever units the radius is given in — measured at the equator, where the
 * map is undistorted. The sector streamer measures its tiles against the same
 * definition.
 */
export function equirectTexelLength(radius: number, mapWidth: number): number {
  if (!(radius > 0) || !(mapWidth > 0)) return 0;
  return (2 * Math.PI * radius) / mapWidth;
}

/** Texels of that map per screen pixel, from a measured screen scale in pixels
 *  per unit of the same length the radius is in. Above 1 the map is minified. */
export function texelsPerPixel(pxPerUnit: number, radius: number, mapWidth: number): number {
  const texel = equirectTexelLength(radius, mapWidth);
  if (!(texel > 0) || !(pxPerUnit > 0)) return Number.POSITIVE_INFINITY;
  return 1 / (pxPerUnit * texel);
}

/** The same measurement the other way up: screen pixels one map texel covers. */
export function pixelsPerTexel(pxPerUnit: number, radius: number, mapWidth: number): number {
  return pxPerUnit * equirectTexelLength(radius, mapWidth);
}

/**
 * How much of a close-range term this density wants: 1 while the map is
 * magnified past the band, 0 once the mip chain is doing the filtering. The
 * CPU half of the shader's `smoothTexelWeight`, off the same band, so a body's
 * eased envelope and its fragments agree about where the fade lives.
 */
export function surfaceMagnifiedWeight(texels: number): number {
  if (!Number.isFinite(texels)) return 0;
  const [lo, hi] = SURFACE_TEXEL_FADE;
  const t = Math.min(1, Math.max(0, (texels - lo) / (hi - lo)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * How much of a body's own radius one measuring step spans. Small enough that
 * the projection is straight across it (a texel of even the finest map is
 * smaller) and large enough to stay well clear of f32 noise in the projection.
 */
const DENSITY_STEP_RADII = 1e-4;

/**
 * Safety factor on the screen-diameter pre-filter below.
 *
 * The exact relation at the sub-camera point is
 * `pixelsPerTexel = diameterPx · (pi / mapWidth) · sqrt((d + R) / (d - R))`,
 * and that last factor is 1 at infinity but grows without bound as the camera
 * approaches the surface — so no threshold on screen diameter alone can prove a
 * body is NOT magnified. Three things have to fit under the 8: that factor, the
 * lens's own frame scale (up to 1.25), and the device pixel ratio, because the
 * estimate this is read against is in CSS pixels while the band is in device
 * ones. Worst case at the threshold is 3 × 1.25 × ~1.3 ≈ 4.9, so 8 holds with
 * room; the sweep below runs at a ratio of 2.
 */
const DENSITY_PREFILTER_SAFETY = 8;

/**
 * Screen diameter under which a body drawing `mapWidth` is not worth measuring:
 * nothing of it can be magnified past the band. Meant to be read against the
 * LOD walk's conservative diameter OVERestimate, which is what makes the skip
 * unable to miss a body that really is magnified.
 */
export function densityRelevantDiameterPx(mapWidth: number): number {
  if (!(mapWidth > 0)) return Number.POSITIVE_INFINITY;
  return mapWidth / (Math.PI * SURFACE_TEXEL_FADE[1] * DENSITY_PREFILTER_SAFETY);
}

/** What one body's surface is drawing, at the point the camera magnifies most. */
export interface SurfaceDensity {
  /** Width in texels of the colour map the surface is drawing. */
  mapWidth: number;
  /** Display pixels one texel of it covers at the sub-camera point. */
  pixelsPerTexel: number;
  /** The same number inverted — texels per pixel, the band's own units. */
  texelsPerPixel: number;
  /** The band's verdict on that density: 1 magnified, 0 minified. */
  magnified: number;
  /** Device pixels per unit of world length at the sub-camera point. */
  pxPerUnit: number;
  /** Latitude of the sub-camera point on the body, in degrees, or null where
   *  the caller did not say which way the body's pole points. WHERE a density
   *  was measured, which is what tells a pose over a pole from a pose over the
   *  equator — and a polar view is where a surface term with a chart of its own
   *  either holds up or draws a pinwheel. */
  subCameraLatDeg: number | null;
  /** The same point as a unit direction in the BODY's own frame, which is the
   *  frame the close-range term's charts are laid out in. A pose with all three
   *  components equal is on a body-frame diagonal, where three charts are drawn
   *  instead of one and the term's fetch count is at its worst — the fill-rate
   *  case a smoothness run has to be aimed at rather than hope for. */
  subCameraBodyDir: [number, number, number] | null;
}

/** A body's own axes as unit vectors in world axes — the frame its maps and
 *  the close-range field's charts are laid out in. */
export interface SurfaceBodyBasis {
  x: THREE.Vector3;
  y: THREE.Vector3;
  z: THREE.Vector3;
}

const densityPoint = new THREE.Vector3();
const densityNormal = new THREE.Vector3();
const densityEast = new THREE.Vector3();
const densityNorth = new THREE.Vector3();
const densityStepScale: ProjectedStepScale = { maxPx: 0, minPx: 0, x: 0, y: 0 };

/**
 * Measure one body's drawn texel density at its sub-camera surface point.
 *
 * `centre` and `radius` are the body's WORLD centre and RENDERED radius (a moon
 * draws at its catalog radius times its mesh scale, and the density on screen
 * is the drawn disc's, not the catalog one's). `dpr` converts the projection's
 * CSS pixels to the device pixels the shader's own derivative is taken in.
 * `basis` is the body's own axes in world axes, and only labels the reading
 * with where on the body it was taken.
 *
 * Returns null when there is no honest scale to report — the sub-camera point
 * at or behind the camera plane, or no map width to measure against.
 */
export function measureSurfaceDensity(
  centre: THREE.Vector3,
  radius: number,
  mapWidth: number,
  camera: THREE.PerspectiveCamera,
  widthPx: number,
  heightPx: number,
  dpr: number,
  basis?: SurfaceBodyBasis | null,
  out?: SurfaceDensity,
): SurfaceDensity | null {
  if (!(radius > 0) || !(mapWidth > 0)) return null;
  // The sub-camera point: where the surface faces the camera squarely and is
  // nearest it, which is where a sphere's texels are drawn largest.
  densityNormal.copy(camera.position).sub(centre);
  const dist = densityNormal.length();
  if (!(dist > radius)) return null;
  densityNormal.multiplyScalar(1 / dist);
  densityPoint.copy(centre).addScaledVector(densityNormal, radius);
  // Any perpendicular pair of the same length gives the same largest singular
  // value, so the pair is chosen only to be well conditioned.
  densityEast.set(densityNormal.z, 0, -densityNormal.x);
  if (densityEast.lengthSq() < 1e-18) densityEast.set(1, 0, 0);
  else densityEast.normalize();
  densityNorth.crossVectors(densityNormal, densityEast);
  const step = radius * DENSITY_STEP_RADII;
  densityEast.multiplyScalar(step);
  densityNorth.multiplyScalar(step);
  const scale = projectedStepScale(
    densityPoint, densityEast, densityNorth, camera, widthPx, heightPx, densityStepScale,
  );
  if (!scale) return null;
  const pxPerUnit = (scale.maxPx * dpr) / step;
  const texels = texelsPerPixel(pxPerUnit, radius, mapWidth);
  const result = out ?? {
    mapWidth: 0, pixelsPerTexel: 0, texelsPerPixel: 0, magnified: 0, pxPerUnit: 0,
    subCameraLatDeg: null, subCameraBodyDir: null,
  };
  result.mapWidth = mapWidth;
  result.pxPerUnit = pxPerUnit;
  result.texelsPerPixel = texels;
  result.pixelsPerTexel = Number.isFinite(texels) && texels > 0 ? 1 / texels : 0;
  result.magnified = surfaceMagnifiedWeight(texels);
  // densityNormal is the surface normal at the point measured, so its
  // components along the body's own axes are that point in the body's frame,
  // and its angle to the pole is that point's latitude.
  if (basis) {
    const y = Math.min(1, Math.max(-1, densityNormal.dot(basis.y)));
    // Written into the record's own array rather than a fresh one: this runs
    // for every measurable body every frame.
    const dir = result.subCameraBodyDir ?? [0, 0, 0];
    dir[0] = densityNormal.dot(basis.x);
    dir[1] = y;
    dir[2] = densityNormal.dot(basis.z);
    result.subCameraBodyDir = dir;
    result.subCameraLatDeg = Math.asin(y) * RAD2DEG;
  } else {
    result.subCameraBodyDir = null;
    result.subCameraLatDeg = null;
  }
  return result;
}
