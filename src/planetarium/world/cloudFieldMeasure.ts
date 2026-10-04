/**
 * The cloud field's measure on the CPU: how many page texels a pixel spans at
 * a point of the deck, on the same grid the shader's guard reads — the scene
 * target's own projection (rectilinear, at the overscan FOV, before the lens
 * warp) at the TILE ratio. The shader takes its derivatives on the scene target
 * at the scene ratio and multiplies by scene / tile (`uCloudFieldPixelScale`),
 * so the two are one number by construction and a Dynamic rung changes
 * neither; `cloudFieldMeasure.test.ts` holds the residency's release rule to
 * the shader's guard over random poses, rungs and lens strengths.
 *
 * What the residency KEEPS a page by (`cloudPageKeepTexelsAll`) is the
 * smallest major among two sets of points: a 9 x 9 grid on the page that face
 * the camera and land inside the displayed frame widened by a margin, and a
 * grid of rays through the displayed frame itself, each counted for the page
 * it lands on. The page grid alone misses a page that is large on screen and
 * only partly in frame — at low orbit a page is many frames wide and its
 * samples can all lie off screen while its middle fills the view — and the
 * ray grid alone misses a page that pokes into the frame between rays. The
 * margin keeps a sliver near the frame's edge from reading as out of frame.
 * What it WANTS a page by is the same smallest major among the points the
 * frame actually displays, so nothing is fetched for the margin alone.
 *
 * Two forms of the one measure. The functions are the REFERENCE: plain,
 * allocating, the footprint differenced between neighbouring rays — what the
 * tests and the development bridge read. `CloudFieldMeasure` is the form the
 * residency runs every frame: the same points read the same way at a frame's
 * price, culled, in closed form and allocation-free, held to the reference
 * page by page and to the release rule pose by pose.
 *
 * Pure: a camera here is plain numbers in the deck mesh's own frame, in units
 * of the deck's radius, so the arithmetic is tested without a renderer and the
 * development bridge builds one from the live camera to read a pixel's number
 * beside the shader's.
 */
import {
  CLOUD_FIELD_GRID, CLOUD_FIELD_LEVEL_WIDTH, CLOUD_FIELD_RELEASE_TEXELS, cloudFieldMajor, cloudPageAddress,
  cloudPageIndexOf,
} from './cloudField';
import { lensRadial, lensUnwarpNdc, lensWarpNdc } from '../../shared/math/lensProjection';

type Vec3 = readonly [number, number, number];

/** A camera as the scene target sees it, in the deck mesh's frame. */
export interface FieldCamera {
  /** Position, in deck radii from the deck's centre. */
  pos: Vec3;
  /** The view basis: the camera looks along −back, up is screen-up. */
  right: Vec3;
  up: Vec3;
  back: Vec3;
  /** The RENDER camera's vertical field of view (the overscan), degrees. */
  renderFovDeg: number;
  /** The displayed (design) field of view, degrees, and the lens strength in
   *  force — only for which pixels are displayed, never for the grid. */
  designFovDeg: number;
  lensStrength: number;
  aspect: number;
  /** The scene target's height in pixels at the ratio being measured in: the
   *  canvas's CSS height times the tile ratio for the residency's number. */
  heightPx: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A point whose latitude's cosine is under this is AT a pole. */
const POLE_EPSILON = 1e-9;

/** Pixel (x right, y down, origin top-left) of a deck-frame point, with its
 *  depth along the view axis; null behind the camera. */
export function fieldProjectPx(cam: FieldCamera, p: Vec3): { x: number; y: number; ndcX: number; ndcY: number } | null {
  const v: Vec3 = [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]];
  const z = -dot(v, cam.back);
  if (!(z > 1e-9)) return null;
  const t = Math.tan((cam.renderFovDeg * Math.PI) / 360);
  const ndcX = dot(v, cam.right) / (z * t * cam.aspect);
  const ndcY = dot(v, cam.up) / (z * t);
  const h = cam.heightPx;
  const w = h * cam.aspect;
  return { x: (ndcX + 1) * 0.5 * w, y: (1 - ndcY) * 0.5 * h, ndcX, ndcY };
}

/** The deck point (unit direction) under pixel (x, y), or null for sky. */
export function fieldUnproject(cam: FieldCamera, x: number, y: number): [number, number, number] | null {
  const h = cam.heightPx;
  const w = h * cam.aspect;
  const t = Math.tan((cam.renderFovDeg * Math.PI) / 360);
  const nx = (x / w) * 2 - 1;
  const ny = 1 - (y / h) * 2;
  const rx = nx * t * cam.aspect;
  const ry = ny * t;
  const d: [number, number, number] = [
    cam.right[0] * rx + cam.up[0] * ry - cam.back[0],
    cam.right[1] * rx + cam.up[1] * ry - cam.back[1],
    cam.right[2] * rx + cam.up[2] * ry - cam.back[2],
  ];
  const len = Math.hypot(d[0], d[1], d[2]);
  d[0] /= len; d[1] /= len; d[2] /= len;
  // |pos + s d| = 1, nearest root.
  const b = dot(cam.pos, d);
  const c = dot(cam.pos, cam.pos) - 1;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = -b - Math.sqrt(disc);
  if (!(s > 0)) return null;
  return [cam.pos[0] + s * d[0], cam.pos[1] + s * d[1], cam.pos[2] + s * d[2]];
}

/** Whether a deck point faces the camera (the deck draws front faces only). */
export function fieldFacesCamera(cam: FieldCamera, d: Vec3): boolean {
  return dot(d, cam.pos) > 1;
}

/** Whether a rectilinear NDC position is displayed: warped through the lens
 *  to the output frame, inside it (widened by `margin` in output NDC). */
export function fieldDisplayed(cam: FieldCamera, ndcX: number, ndcY: number, margin = 0): boolean {
  const o = lensWarpNdc(ndcX, ndcY, cam.designFovDeg, cam.renderFovDeg, cam.aspect, cam.lensStrength, { x: 0, y: 0 });
  return Math.abs(o.x) <= 1 + margin && Math.abs(o.y) <= 1 + margin;
}

/** The map uv's derivative along a direction's change: `sphereEquirectUvGrad`
 *  (cloudDeck.ts) in TypeScript, and the shader's own. */
function uvGrad(d: Vec3, dd: Vec3): [number, number] {
  const cosLat = Math.max(Math.hypot(d[0], d[2]), 1e-4);
  return [
    ((d[2] * dd[0] - d[0] * dd[2]) / (cosLat * cosLat)) / (2 * Math.PI),
    dd[1] / cosLat / Math.PI,
  ];
}

/**
 * Page texels per pixel on the footprint's major axis at a deck point, on the
 * camera's grid: the shader's `cloudFieldMajor` before the pixel scale, with
 * the screen derivatives of the direction taken as central differences of the
 * ray's hit across `stepPx` (the shader's are one-pixel differences across its
 * quad). Null where the point is not drawn, or a neighbouring ray misses, and
 * AT a pole, where the map's u has no derivative: the u texels crowd together
 * as the pole nears, so the major grows without bound toward it, while the
 * formula, evaluated exactly there, divides a vanishing numerator by the held
 * cosine and reads a footprint of nothing.
 */
export function fieldTexelMajorAt(cam: FieldCamera, d: Vec3, stepPx = 0.05): number | null {
  if (!fieldFacesCamera(cam, d)) return null;
  if (Math.hypot(d[0], d[2]) < POLE_EPSILON) return null;
  const p = fieldProjectPx(cam, d);
  if (!p) return null;
  const xp = fieldUnproject(cam, p.x + stepPx, p.y);
  const xm = fieldUnproject(cam, p.x - stepPx, p.y);
  const yp = fieldUnproject(cam, p.x, p.y + stepPx);
  const ym = fieldUnproject(cam, p.x, p.y - stepPx);
  if (!xp || !xm || !yp || !ym) return null;
  const k = 2 * stepPx;
  const ddx: Vec3 = [(xp[0] - xm[0]) / k, (xp[1] - xm[1]) / k, (xp[2] - xm[2]) / k];
  const ddy: Vec3 = [(yp[0] - ym[0]) / k, (yp[1] - ym[1]) / k, (yp[2] - ym[2]) / k];
  const gx = uvGrad(d, ddx);
  const gy = uvGrad(d, ddy);
  // Map uv to texels of the 32k level: the grid times the content per page.
  const tu = CLOUD_FIELD_LEVEL_WIDTH;
  const tv = (CLOUD_FIELD_LEVEL_WIDTH * CLOUD_FIELD_GRID[1]) / CLOUD_FIELD_GRID[0];
  return cloudFieldMajor([gx[0] * tu, gx[1] * tv], [gy[0] * tu, gy[1] * tv]);
}

/** The deck-frame direction at a page's fractional position (s, t), s from its
 *  western edge and t from its SOUTHERN edge, table row 0 the northernmost. */
export function fieldPagePoint(col: number, row: number, s: number, t: number): [number, number, number] {
  const [gx, gy] = CLOUD_FIELD_GRID;
  const u = (col + s) / gx;
  const v = (gy - 1 - row + t) / gy;
  const phi = u * 2 * Math.PI;
  const lat = (v - 0.5) * Math.PI;
  return [-Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat)];
}

/** How far outside the displayed frame a page's samples still count for
 *  keeping it, in output NDC. */
export const CLOUD_FIELD_KEEP_MARGIN = 0.25;

/** Points a side of the page grid the keep measure reads. Five a side (5.6°
 *  apart) let a low-orbit grazing view hide a part of a page at 7.5 texels a
 *  pixel between samples that read 12.3 (the property test, 5,000 poses); nine
 *  a side (2.8°) left the closest such point at 11.8. */
export const CLOUD_FIELD_KEEP_GRID = 9;

/**
 * A page's number for KEEPING it from its own points: the smallest major, in
 * the camera's pixels, among an n x n grid of its points that face the camera and fall inside the
 * displayed frame widened by `margin`. Infinity where none does — nothing of
 * the page is near the frame.
 */
export function cloudPageKeepTexels(
  cam: FieldCamera, col: number, row: number, n = CLOUD_FIELD_KEEP_GRID, margin = CLOUD_FIELD_KEEP_MARGIN,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const d = fieldPagePoint(col, row, i / (n - 1), j / (n - 1));
      if (!fieldFacesCamera(cam, d)) continue;
      const p = fieldProjectPx(cam, d);
      if (!p || !fieldDisplayed(cam, p.ndcX, p.ndcY, margin)) continue;
      const t = fieldTexelMajorAt(cam, d);
      if (t !== null && t < best) best = t;
    }
  }
  return best;
}

/** Rays through the displayed frame for the keep measure: columns and rows,
 *  the frame's edges and corners included. */
export const CLOUD_FIELD_KEEP_RAYS: readonly [number, number] = [9, 7];

/**
 * Every page's KEEP number at once, indexed `row * 16 + col`: the smaller of
 * its page-grid number (`cloudPageKeepTexels`) and the smallest major among the
 * displayed-frame rays that land on it. Infinity for a page nothing of which is
 * near the frame.
 */
export function cloudPageKeepTexelsAll(
  cam: FieldCamera, n = CLOUD_FIELD_KEEP_GRID, margin = CLOUD_FIELD_KEEP_MARGIN, rays = CLOUD_FIELD_KEEP_RAYS,
): Float64Array {
  const [gx, gy] = CLOUD_FIELD_GRID;
  const out = new Float64Array(gx * gy).fill(Number.POSITIVE_INFINITY);
  for (let row = 0; row < gy; row++) {
    for (let col = 0; col < gx; col++) out[row * gx + col] = cloudPageKeepTexels(cam, col, row, n, margin);
  }
  const w = cam.heightPx * cam.aspect;
  const h = cam.heightPx;
  const ndc = { x: 0, y: 0 };
  for (let j = 0; j < rays[1]; j++) {
    for (let i = 0; i < rays[0]; i++) {
      const ox = (i / (rays[0] - 1)) * 2 - 1;
      const oy = (j / (rays[1] - 1)) * 2 - 1;
      lensUnwarpNdc(ox, oy, cam.designFovDeg, cam.renderFovDeg, cam.aspect, cam.lensStrength, ndc);
      const d = fieldUnproject(cam, (ndc.x + 1) * 0.5 * w, (1 - ndc.y) * 0.5 * h);
      if (!d) continue;
      const t = fieldTexelMajorAt(cam, d);
      if (t === null) continue;
      const a = cloudPageAddress(d);
      const k = a.row * gx + a.col;
      if (t < out[k]) out[k] = t;
    }
  }
  return out;
}

/** What the residency reads of every page each frame, indexed `row * 16 +
 *  col`. */
export interface CloudPageDemand {
  /** Page texels a tile-ratio pixel spans on the footprint's major axis, the
   *  smallest among the page's points the frame DISPLAYS: what a page is
   *  wanted by. +Infinity for a page with none. */
  readonly wantTexels: Float64Array;
  /** The same among its points in the frame widened by the keep margin (the
   *  keep measure, `cloudPageKeepTexelsAll`'s number): what a page is kept by,
   *  and released past the release line. +Infinity for a page with none. */
  readonly keepTexels: Float64Array;
  /** The best centrality among the displayed points: 1 at the frame's
   *  centre, 0 at its edge and beyond. */
  readonly centrality: Float32Array;
  /** The most lit of the points in the widened frame: its dot with the Sun's
   *  direction (both in the deck's frame); −Infinity for a page with none. */
  readonly sunDot: Float32Array;
}

const [GRID_X, GRID_Y] = CLOUD_FIELD_GRID;
const PAGES = GRID_X * GRID_Y;
/** Intervals across a page of the keep grid; its points are shared with the
 *  neighbouring pages along every edge, so the whole globe's points form one
 *  lattice. */
const STEPS = CLOUD_FIELD_KEEP_GRID - 1;
/** The lattice: columns round the globe (the date line's column is column 0),
 *  rows from the south pole to the north. */
const LATTICE_U = GRID_X * STEPS;
const LATTICE_V = GRID_Y * STEPS + 1;
/** Arc of the deck (unit radius) a texel of the 32k level spans at most: its
 *  north-south side, which the east-west one never exceeds. */
const ARC_PER_TEXEL = (2 * Math.PI) / CLOUD_FIELD_LEVEL_WIDTH;
/** Texels of the 32k level a unit change of direction moves u and v at a
 *  latitude (its cosine, held off zero): `sphereEquirectUvGrad`'s two rows,
 *  times the level's texels across u and down v. */
const texelsPerU = (cosLat: number): number => CLOUD_FIELD_LEVEL_WIDTH / (2 * Math.PI * cosLat * cosLat);
const texelsPerV = (cosLat: number): number => (CLOUD_FIELD_LEVEL_WIDTH * GRID_Y) / GRID_X / (Math.PI * cosLat);

/**
 * The keep measure (`cloudPageKeepTexelsAll`'s numbers, the same points read
 * the same way) and the want measure beside it, at a price a frame can pay:
 * the residency runs it every frame. A number at or under the release line is
 * exact; past it, it may be the page's floor instead, which is all a decision
 * needs there.
 *
 * - A page is read only once it passes a cull of its own: it must reach the
 *   cap the camera can see (its centre within the horizon's angle plus its
 *   own angular radius) and its bounding sphere must reach the rectilinear
 *   frustum that holds the widened displayed frame. A page that fails either
 *   has no point that faces the camera inside the frame, so the cull changes
 *   no number.
 * - A page that passes is bounded from below first (`majorFloor`): a far
 *   page, or one seen edge-on near the limb, can be past the release line at
 *   every point it has, and is then answered with the floor, unread. That is
 *   most of the globe in a wide view from far out, where every page faces.
 * - The keep grid's points are one lattice over the globe (a page's edge
 *   points are its neighbour's), each read at most once a frame.
 * - The footprint at a point is the screen-to-deck Jacobian in closed form:
 *   a pixel's step moves the ray by `k` times a camera axis, and the hit on
 *   the unit sphere moves along that step's projection onto the tangent plane
 *   along the ray, `dP = z k (a − v (P·a) / (P·v))` for a camera axis `a`,
 *   `v = P − C` and `z` the depth — exact, where the reference differences
 *   neighbouring rays. Its major axis in texels is `cloudFieldMajor`'s.
 * - The lens's forward map is taken in its algebraic form, tan(θ/2) =
 *   tan θ / (1 + sec θ), so a point costs one square root where `lensWarpNdc`
 *   takes an arc tangent and a tangent; the displayed-frame rays and the
 *   rectilinear bound of the widened frame are kept until the lens changes.
 *
 * Nothing is allocated after construction: every per-point and per-page
 * number lives in the instance's typed arrays, the camera is the caller's own
 * struct, filled in place each frame, and the frame's path calls no builtin
 * that boxes a double (a typed array's `fill`, `Math.hypot`).
 */
export class CloudFieldMeasure implements CloudPageDemand {
  readonly wantTexels = new Float64Array(PAGES);
  readonly keepTexels = new Float64Array(PAGES);
  readonly centrality = new Float32Array(PAGES);
  readonly sunDot = new Float32Array(PAGES);
  /** What the last call did: pages read point by point, pages whose floor
   *  put them past the release line unread, and lattice points read. */
  pagesRead = 0;
  pagesBounded = 0;
  pointsRead = 0;

  // The lattice's directions, and the factors that turn a direction's change
  // there into texels of u and of v (from the latitude's cosine, held off
  // zero as the reference's uv derivative holds it), fixed.
  private readonly lx = new Float64Array(LATTICE_U * LATTICE_V);
  private readonly ly = new Float64Array(LATTICE_U * LATTICE_V);
  private readonly lz = new Float64Array(LATTICE_U * LATTICE_V);
  private readonly lku = new Float64Array(LATTICE_U * LATTICE_V);
  private readonly lkv = new Float64Array(LATTICE_U * LATTICE_V);
  // Each page's centre, the cosine and sine of its angular radius, and its
  // bounding sphere's radius (the chord), fixed.
  private readonly cx = new Float64Array(PAGES);
  private readonly cy = new Float64Array(PAGES);
  private readonly cz = new Float64Array(PAGES);
  private readonly cosRho = new Float64Array(PAGES);
  private readonly sinRho = new Float64Array(PAGES);
  private readonly chord = new Float64Array(PAGES);
  // This frame's reading of each lattice point: the frame it was read in, its
  // major (+Infinity when it is not in the widened frame), its Sun dot and its
  // squared radius in displayed NDC.
  private readonly stamp = new Uint32Array(LATTICE_U * LATTICE_V);
  private readonly pointTexels = new Float64Array(LATTICE_U * LATTICE_V);
  private readonly pointSun = new Float64Array(LATTICE_U * LATTICE_V);
  private readonly pointRadius2 = new Float64Array(LATTICE_U * LATTICE_V);
  private readonly pointShown = new Uint8Array(LATTICE_U * LATTICE_V);
  private frame = 0;
  // The rays through the displayed frame, in the camera's own axes (the
  // rectilinear NDC times the half tangents), with each ray's centrality.
  private readonly rayX = new Float64Array(CLOUD_FIELD_KEEP_RAYS[0] * CLOUD_FIELD_KEEP_RAYS[1]);
  private readonly rayY = new Float64Array(CLOUD_FIELD_KEEP_RAYS[0] * CLOUD_FIELD_KEEP_RAYS[1]);
  private readonly rayCentrality = new Float64Array(CLOUD_FIELD_KEEP_RAYS[0] * CLOUD_FIELD_KEEP_RAYS[1]);
  // The lens those were built for, and the widened frame's rectilinear half
  // extents (+Infinity where the lens cannot say: past the overscan's limit).
  private lensDesign = Number.NaN;
  private lensRender = Number.NaN;
  private lensAspect = Number.NaN;
  private lensStrength = Number.NaN;
  private boundX = 0;
  private boundY = 0;
  private rEdge = 1;
  private readonly ndc = { x: 0, y: 0 };
  // This frame's camera, unpacked.
  private px = 0; private py = 0; private pz = 0;
  private rx = 0; private ry = 0; private rz = 0;
  private ux = 0; private uy = 0; private uz = 0;
  private bx = 0; private by = 0; private bz = 0;
  private sx = 0; private sy = 0; private sz = 0;
  private cr = 0; private cu = 0;
  private tanHalf = 1;
  private aspect = 1;
  private strength = 0;
  /** Radians of ray a pixel step turns at the axis: 2 tan(fov/2) / height. */
  private pixelStep = 0;

  constructor() {
    for (let v = 0; v < LATTICE_V; v++) {
      const lat = (v / (LATTICE_V - 1) - 0.5) * Math.PI;
      for (let u = 0; u < LATTICE_U; u++) {
        const phi = (u / LATTICE_U) * 2 * Math.PI;
        const q = v * LATTICE_U + u;
        this.lx[q] = -Math.cos(phi) * Math.cos(lat);
        this.ly[q] = Math.sin(lat);
        this.lz[q] = Math.sin(phi) * Math.cos(lat);
        const cosLat = Math.max(Math.hypot(this.lx[q], this.lz[q]), 1e-4);
        this.lku[q] = texelsPerU(cosLat);
        this.lkv[q] = texelsPerV(cosLat);
      }
    }
    for (let row = 0; row < GRID_Y; row++) {
      for (let col = 0; col < GRID_X; col++) {
        const p = row * GRID_X + col;
        const c = fieldPagePoint(col, row, 0.5, 0.5);
        this.cx[p] = c[0]; this.cy[p] = c[1]; this.cz[p] = c[2];
        // The farthest point of a latitude-longitude box from its centre is a
        // corner, or the pole a polar page reaches.
        let rho = 0;
        const reach = (s: number, t: number) => {
          const d = fieldPagePoint(col, row, s, t);
          rho = Math.max(rho, Math.acos(Math.min(1, d[0] * c[0] + d[1] * c[1] + d[2] * c[2])));
        };
        reach(0, 0); reach(1, 0); reach(0, 1); reach(1, 1);
        if (row === 0) rho = Math.max(rho, Math.acos(Math.min(1, c[1])));
        if (row === GRID_Y - 1) rho = Math.max(rho, Math.acos(Math.min(1, -c[1])));
        rho += 1e-9;
        this.cosRho[p] = Math.cos(rho);
        this.sinRho[p] = Math.sin(rho);
        this.chord[p] = 2 * Math.sin(rho / 2) + 1e-9;
      }
    }
  }

  /**
   * Every page's numbers for this camera and Sun (the Sun a unit direction in
   * the deck's frame), into `wantTexels`, `keepTexels`, `centrality` and
   * `sunDot`.
   */
  measure(cam: FieldCamera, sun: Vec3): void {
    // By hand: a typed array's fill boxes a double argument on every call.
    for (let p = 0; p < PAGES; p++) {
      this.wantTexels[p] = Number.POSITIVE_INFINITY;
      this.keepTexels[p] = Number.POSITIVE_INFINITY;
      this.centrality[p] = 0;
      this.sunDot[p] = Number.NEGATIVE_INFINITY;
    }
    this.pagesRead = 0;
    this.pagesBounded = 0;
    this.pointsRead = 0;
    const px = cam.pos[0], py = cam.pos[1], pz = cam.pos[2];
    const d2 = px * px + py * py + pz * pz;
    // From inside the deck no front face is drawn.
    if (!(d2 > 1)) return;
    this.px = px; this.py = py; this.pz = pz;
    this.rx = cam.right[0]; this.ry = cam.right[1]; this.rz = cam.right[2];
    this.ux = cam.up[0]; this.uy = cam.up[1]; this.uz = cam.up[2];
    this.bx = cam.back[0]; this.by = cam.back[1]; this.bz = cam.back[2];
    this.sx = sun[0]; this.sy = sun[1]; this.sz = sun[2];
    // The camera's own offset along its two screen axes, so a point's dot
    // with them comes from its view vector's.
    this.cr = px * this.rx + py * this.ry + pz * this.rz;
    this.cu = px * this.ux + py * this.uy + pz * this.uz;
    this.tanHalf = Math.tan((cam.renderFovDeg * Math.PI) / 360);
    this.aspect = cam.aspect;
    this.pixelStep = (2 * this.tanHalf) / cam.heightPx;
    if (cam.designFovDeg !== this.lensDesign || cam.renderFovDeg !== this.lensRender
      || cam.aspect !== this.lensAspect || cam.lensStrength !== this.lensStrength) {
      this.rebuildLens(cam);
    }
    this.frame = (this.frame + 1) >>> 0;
    if (this.frame === 0) { this.stamp.fill(0); this.frame = 1; }

    // The cull's planes: the four sides of the rectilinear frustum that holds
    // the widened frame, as unit normals pointing out, and the camera plane.
    const ta = this.boundX * this.tanHalf * this.aspect;
    const tb = this.boundY * this.tanHalf;
    const sides = Number.isFinite(ta) && Number.isFinite(tb);
    const na = 1 / Math.sqrt(1 + ta * ta);
    const nb = 1 / Math.sqrt(1 + tb * tb);
    const d = Math.sqrt(d2);
    const cosH = 1 / d;
    const sinH = Math.sqrt(1 - cosH * cosH);
    for (let p = 0; p < PAGES; p++) {
      const cx = this.cx[p], cy = this.cy[p], cz = this.cz[p];
      // The cap: the page's centre within the horizon's angle plus its radius.
      const cDotC = cx * px + cy * py + cz * pz;
      if (cDotC < d * (cosH * this.cosRho[p] - sinH * this.sinRho[p])) continue;
      const vx = cx - px, vy = cy - py, vz = cz - pz;
      const r = this.chord[p];
      const along = vx * this.bx + vy * this.by + vz * this.bz;
      if (along > r) continue;
      if (sides) {
        const right = vx * this.rx + vy * this.ry + vz * this.rz;
        const up = vx * this.ux + vy * this.uy + vz * this.uz;
        if ((right + ta * along) * na > r || (-right + ta * along) * na > r) continue;
        if ((up + tb * along) * nb > r || (-up + tb * along) * nb > r) continue;
      }
      const floor = this.majorFloor(p, Math.sqrt(vx * vx + vy * vy + vz * vz), along, cDotC, d);
      if (floor > CLOUD_FIELD_RELEASE_TEXELS) {
        this.wantTexels[p] = floor;
        this.keepTexels[p] = floor;
        this.pagesBounded += 1;
        continue;
      }
      this.readPage(p);
    }
    this.readRays();
  }

  /**
   * A floor under the major at every point of a page, from its bounding
   * sphere alone (`dist` from the camera to its centre, `along` that offset on
   * the camera's back axis, `cDotC` its centre's dot with the camera
   * position, `d` the camera's distance). A pixel step turns the ray through
   * an angle between `k z cos θ / ρ` and `k z / ρ` (z the depth, ρ the range,
   * θ off the axis), and a turn moves the hit between `ρ` and `ρ / cos i`
   * times as far (i the incidence); a texel is at most Δ = 2π / 32512 of arc
   * either way. So the footprint's major is at least `k z / Δ · max(1, cos θ /
   * cos i)`, and each factor is bounded over the page on its own: the
   * nearest depth the sphere reaches, the widest angle it subtends off the
   * axis, and the most face-on incidence, at the page's nearest approach to
   * the point under the camera. Past the release line no point of the page
   * can be drawn with weight, so the floor stands in for the reading there.
   */
  private majorFloor(p: number, dist: number, along: number, cDotC: number, d: number): number {
    const r = this.chord[p];
    const zMin = -along - r;
    if (!(zMin > 0) || !(dist > r)) return 0;
    const cosC = -along / dist;
    const sinC = Math.sqrt(Math.max(0, 1 - cosC * cosC));
    const sinB = r / dist;
    const cosTheta = Math.max(0, cosC * Math.sqrt(1 - sinB * sinB) - sinC * sinB);
    const cosA = cDotC / d;
    const cosNear = cosA >= this.cosRho[p] ? 1
      : cosA * this.cosRho[p] + Math.sqrt(Math.max(0, 1 - cosA * cosA)) * this.sinRho[p];
    const w = d * cosNear;
    if (!(w > 1)) return 0;
    const cosI = (w - 1) / Math.sqrt(1 + d * d - 2 * w);
    return this.pixelStep * zMin * Math.max(1, cosTheta / cosI) / ARC_PER_TEXEL;
  }

  /** The page's lattice points, read where this frame has not read them, and
   *  their smallest majors (displayed, and in the widened frame), best
   *  centrality and most lit Sun dot taken. */
  private readPage(p: number): void {
    this.pagesRead += 1;
    const col = p % GRID_X;
    const row = (p - col) / GRID_X;
    const u0 = col * STEPS;
    const v0 = (GRID_Y - 1 - row) * STEPS;
    let keep = Number.POSITIVE_INFINITY;
    let want = Number.POSITIVE_INFINITY;
    let r2 = Number.POSITIVE_INFINITY;
    let sun = Number.NEGATIVE_INFINITY;
    for (let j = 0; j <= STEPS; j++) {
      const rowBase = (v0 + j) * LATTICE_U;
      for (let i = 0; i <= STEPS; i++) {
        let u = u0 + i;
        if (u === LATTICE_U) u = 0;
        const q = rowBase + u;
        if (this.stamp[q] !== this.frame) this.readPoint(q);
        const pt = this.pointTexels[q];
        if (pt === Number.POSITIVE_INFINITY) continue;
        if (pt < keep) keep = pt;
        if (this.pointShown[q] === 1 && pt < want) want = pt;
        if (this.pointRadius2[q] < r2) r2 = this.pointRadius2[q];
        if (this.pointSun[q] > sun) sun = this.pointSun[q];
      }
    }
    this.wantTexels[p] = want;
    this.keepTexels[p] = keep;
    this.centrality[p] = r2 < 1 ? 1 - Math.sqrt(r2) : 0;
    this.sunDot[p] = sun;
  }

  /** One lattice point: in the widened frame or not, and if it is, its major,
   *  Sun dot and displayed radius. */
  private readPoint(q: number): void {
    this.stamp[q] = this.frame;
    this.pointsRead += 1;
    this.pointTexels[q] = Number.POSITIVE_INFINITY;
    // The poles' rows are one point each, which has no major (fieldTexelMajorAt).
    if (q < LATTICE_U || q >= (LATTICE_V - 1) * LATTICE_U) return;
    const x = this.lx[q], y = this.ly[q], z = this.lz[q];
    const pc = x * this.px + y * this.py + z * this.pz;
    // Facing the camera: the deck draws front faces only.
    if (!(pc > 1)) return;
    const vx = x - this.px, vy = y - this.py, vz = z - this.pz;
    const depth = -(vx * this.bx + vy * this.by + vz * this.bz);
    if (!(depth > 1e-9)) return;
    const vr = vx * this.rx + vy * this.ry + vz * this.rz;
    const vu = vx * this.ux + vy * this.uy + vz * this.uz;
    const ndcX = vr / (depth * this.tanHalf * this.aspect);
    const ndcY = vu / (depth * this.tanHalf);
    if (Math.abs(ndcX) > this.boundX || Math.abs(ndcY) > this.boundY) return;
    // The lens's forward map: R(θ, s) / rEdge over tan θ, with tan(θ/2) =
    // tan θ / (1 + sec θ).
    let ox = ndcX;
    let oy = ndcY;
    if (this.strength > 0) {
      const dx = ndcX * this.aspect * this.tanHalf;
      const dy = ndcY * this.tanHalf;
      const tan2 = dx * dx + dy * dy;
      const scale = ((1 - this.strength) + (2 * this.strength) / (1 + Math.sqrt(1 + tan2))) / this.rEdge;
      ox = (dx * scale) / this.aspect;
      oy = dy * scale;
    }
    const limit = 1 + CLOUD_FIELD_KEEP_MARGIN;
    if (Math.abs(ox) > limit || Math.abs(oy) > limit) return;
    this.pointTexels[q] = this.texelsAt(
      x, z, vx, vy, vz, depth, pc, vr + this.cr, vu + this.cu, this.lku[q], this.lkv[q]);
    this.pointSun[q] = x * this.sx + y * this.sy + z * this.sz;
    this.pointRadius2[q] = ox * ox + oy * oy;
    this.pointShown[q] = Math.abs(ox) <= 1 && Math.abs(oy) <= 1 ? 1 : 0;
  }

  /**
   * Page texels a pixel spans on the footprint's major axis at deck point P
   * (x and z its equatorial components, `v = P − C`, `depth` along the view
   * axis, `pc = P·C`, `pr` and `pu` its dots with the screen's axes, `kU` and
   * `kV` the texels a unit change of direction moves u and v there): the
   * Jacobian of the ray's hit in closed form, into the map's uv through
   * `sphereEquirectUvGrad`'s rule, into texels, its largest singular value.
   * Both columns carry the factor `depth · k`, taken out and put back last.
   */
  private texelsAt(
    x: number, z: number, vx: number, vy: number, vz: number,
    depth: number, pc: number, pr: number, pu: number, kU: number, kV: number,
  ): number {
    // P·v = 1 − P·C, negative wherever P faces the camera.
    const inv = 1 / (1 - pc);
    const ar = pr * inv;
    const au = pu * inv;
    // One pixel right, and one pixel up (the sign of a column is no matter).
    const ax = this.rx - vx * ar, ay = this.ry - vy * ar, az = this.rz - vz * ar;
    const bx = this.ux - vx * au, by = this.uy - vy * au, bz = this.uz - vz * au;
    const a0 = (z * ax - x * az) * kU, a1 = ay * kV;
    const b0 = (z * bx - x * bz) * kU, b1 = by * kV;
    // cloudFieldMajor, inline.
    const aa = a0 * a0 + a1 * a1;
    const bb = b0 * b0 + b1 * b1;
    const ab = a0 * b0 + a1 * b1;
    const half = (aa - bb) * 0.5;
    return Math.sqrt(Math.max((aa + bb) * 0.5 + Math.sqrt(half * half + ab * ab), 0)) * depth * this.pixelStep;
  }

  /** The rays through the displayed frame, each counted for the page it
   *  lands on: its major, its centrality and its Sun dot. */
  private readRays(): void {
    const px = this.px, py = this.py, pz = this.pz;
    const c = px * px + py * py + pz * pz - 1;
    for (let n = 0; n < this.rayX.length; n++) {
      const rx = this.rayX[n], ry = this.rayY[n];
      // The ray right·rx + up·ry − back, whose depth is its parameter.
      const dx = this.rx * rx + this.ux * ry - this.bx;
      const dy = this.ry * rx + this.uy * ry - this.by;
      const dz = this.rz * rx + this.uz * ry - this.bz;
      const a = dx * dx + dy * dy + dz * dz;
      const b = px * dx + py * dy + pz * dz;
      const disc = b * b - a * c;
      if (disc < 0) continue;
      const s = (-b - Math.sqrt(disc)) / a;
      if (!(s > 0)) continue;
      const x = px + s * dx, y = py + s * dy, z = pz + s * dz;
      const pc = x * px + y * py + z * pz;
      const cosLat = Math.sqrt(x * x + z * z);
      if (!(pc > 1) || cosLat < POLE_EPSILON) continue;
      const held = Math.max(cosLat, 1e-4);
      const t = this.texelsAt(x, z, x - px, y - py, z - pz, s, pc,
        x * this.rx + y * this.ry + z * this.rz, x * this.ux + y * this.uy + z * this.uz,
        texelsPerU(held), texelsPerV(held));
      const p = cloudPageIndexOf(x, y, z);
      // A ray through the displayed frame lands on a displayed point.
      if (t < this.wantTexels[p]) this.wantTexels[p] = t;
      if (t < this.keepTexels[p]) this.keepTexels[p] = t;
      if (this.rayCentrality[n] > this.centrality[p]) this.centrality[p] = this.rayCentrality[n];
      const sun = x * this.sx + y * this.sy + z * this.sz;
      if (sun > this.sunDot[p]) this.sunDot[p] = sun;
    }
  }

  /** The rays and the widened frame's rectilinear bound, for a new lens. */
  private rebuildLens(cam: FieldCamera): void {
    this.lensDesign = cam.designFovDeg;
    this.lensRender = cam.renderFovDeg;
    this.lensAspect = cam.aspect;
    this.lensStrength = cam.lensStrength;
    this.strength = cam.lensStrength;
    this.rEdge = cam.lensStrength > 0 ? lensRadial((cam.designFovDeg * Math.PI) / 360, cam.lensStrength) : 1;
    // The widened frame's corner, unwarped, bounds it in both axes: the lens
    // only ever stretches the rectilinear frame outward with the radius. Where
    // the corner lies past what the overscan can unwarp, the bound is open.
    const limit = 1 + CLOUD_FIELD_KEEP_MARGIN;
    const ndc = this.ndc;
    lensUnwarpNdc(limit, limit, cam.designFovDeg, cam.renderFovDeg, cam.aspect, cam.lensStrength, ndc);
    const bx = ndc.x, by = ndc.y;
    lensWarpNdc(bx, by, cam.designFovDeg, cam.renderFovDeg, cam.aspect, cam.lensStrength, ndc);
    const exact = Math.abs(ndc.x - limit) < 1e-6 && Math.abs(ndc.y - limit) < 1e-6;
    this.boundX = exact ? bx * (1 + 1e-9) : Number.POSITIVE_INFINITY;
    this.boundY = exact ? by * (1 + 1e-9) : Number.POSITIVE_INFINITY;
    const [nx, ny] = CLOUD_FIELD_KEEP_RAYS;
    const t = Math.tan((cam.renderFovDeg * Math.PI) / 360);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const ox = (i / (nx - 1)) * 2 - 1;
        const oy = (j / (ny - 1)) * 2 - 1;
        lensUnwarpNdc(ox, oy, cam.designFovDeg, cam.renderFovDeg, cam.aspect, cam.lensStrength, ndc);
        const n = j * nx + i;
        this.rayX[n] = ndc.x * t * cam.aspect;
        this.rayY[n] = ndc.y * t;
        this.rayCentrality[n] = Math.max(0, 1 - Math.hypot(ox, oy));
      }
    }
  }
}
