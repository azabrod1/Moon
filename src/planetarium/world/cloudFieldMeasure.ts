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
 *
 * Pure: a camera here is plain numbers in the deck mesh's own frame, in units
 * of the deck's radius, so the arithmetic is tested without a renderer and the
 * development bridge builds one from the live camera to read a pixel's number
 * beside the shader's.
 */
import { CLOUD_FIELD_GRID, CLOUD_FIELD_LEVEL_WIDTH, cloudFieldMajor, cloudPageAddress } from './cloudField';
import { lensUnwarpNdc, lensWarpNdc } from '../../shared/math/lensProjection';

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
 * quad). Null where the point is not drawn, or a neighbouring ray misses.
 */
export function fieldTexelMajorAt(cam: FieldCamera, d: Vec3, stepPx = 0.05): number | null {
  if (!fieldFacesCamera(cam, d)) return null;
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
