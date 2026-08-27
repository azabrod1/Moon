/**
 * Sector grid math for streamed surface tiles — the equirect version of the
 * cube-face LOD NASA Eyes uses. A body's map is split into an 8×4 grid of 45°
 * sectors; each sector is its own mesh (a partial SphereGeometry) carrying
 * GLOBAL equirect UVs, and every map it draws — its 2048² colour tile and
 * crops of the globe's relief / roughness maps — is sampled through a
 * per-texture offset/repeat that maps the sector's global UV rectangle onto
 * that image's interior (inside its gutter).
 *
 * Tile {c}_{r} on disk (tools/gen-tiles.mjs) is the sub-rectangle
 * u ∈ [c/cols, (c+1)/cols], v ∈ [1−(r+1)/rows, 1−r/rows] of the same equirect
 * the base map is — column 0 at the western edge, row 0 at the north — so the
 * tile and the base map agree on every surface point by construction.
 *
 * Normal-map crops are cut TWO sectors wide (the sector centred, half a
 * neighbour each side): three derives the tangent frame from screen-space
 * derivatives of the transformed normal-map UV and normalises it by the
 * larger axis, so a crop whose transform scaled u by 8 and v by 4 would shade
 * relief with a different east–west/north–south balance than the globe under
 * it. A 90°×45° crop has a 4×4 transform — uniform — and the frame cancels
 * exactly. (Bump and roughness crops are unaffected: bump differences are
 * taken per screen pixel, roughness is a plain sample.)
 *
 * Geometry convention is three's SphereGeometry: a vertex at parametric
 * (u, v) sits at (−cos φ sin θ, cos θ, sin φ sin θ) with φ = 2πu, θ = πv, and
 * its uv is (u, 1 − v). A sector built with `segments` per side has vertices
 * that coincide with the full sphere's at `segments × cols` longitude segments
 * — the same grid the silhouette upgrade rebuilds the base sphere on — so an
 * overlaid sector never fights its base for depth (pinned by test).
 *
 * Everything here is pure: no camera, no renderer, no DOM.
 */
import * as THREE from 'three';

export interface SectorGrid {
  cols: number;
  rows: number;
}

/** The one grid every 16K sector set ships in: 8 × 4 sectors of 2048² tiles. */
export const SECTOR_GRID_16K: SectorGrid = { cols: 8, rows: 4 };

export interface Sector {
  c: number;
  r: number;
}

/** An image's pixel layout: `width × height` px with gutters of
 *  neighbouring texels (`gutterX` each side, `gutterY` top and bottom), so
 *  only the interior carries surface; the interior spans `spanU` sectors of
 *  longitude, starting `leadU` sectors before the sector's own western edge,
 *  and exactly the sector's 45° of latitude. Colour tiles: 2048² with an 8-px
 *  gutter (content 2032², one sector). Normal-map crops: two sectors wide,
 *  centred (leadU = 0.5), with the horizontal gutter doubled so the gutter
 *  FRACTION — and with it the UV scale — is the same on both axes. */
export interface TileLayout {
  width: number;
  height: number;
  gutterX: number;
  gutterY: number;
  spanU: number;
  leadU: number;
}

export const SECTOR_TILE: TileLayout = { width: 2048, height: 2048, gutterX: 8, gutterY: 8, spanU: 1, leadU: 0 };

/** Layout of a data-map crop for a base map `baseWidth` px wide on the grid,
 *  `spanU` sectors wide (centred on the sector when wider than one). */
export function dataCropLayout(
  grid: SectorGrid,
  baseWidth: number,
  spanU = 1,
  gutter = SECTOR_TILE.gutterY,
): TileLayout {
  const content = baseWidth / grid.cols;
  return {
    width: spanU * (content + 2 * gutter),
    height: content + 2 * gutter,
    gutterX: spanU * gutter,
    gutterY: gutter,
    spanU,
    leadU: (spanU - 1) / 2,
  };
}

/** Global equirect UV rectangle of a sector (u0 < u1, v0 < v1; v grows north). */
export function sectorUvRect(grid: SectorGrid, s: Sector): { u0: number; u1: number; v0: number; v1: number } {
  return {
    u0: s.c / grid.cols,
    u1: (s.c + 1) / grid.cols,
    v0: 1 - (s.r + 1) / grid.rows,
    v1: 1 - s.r / grid.rows,
  };
}

/** SphereGeometry's partial-sphere arguments for a sector. */
export function sectorSphereArgs(
  grid: SectorGrid,
  s: Sector,
): { phiStart: number; phiLength: number; thetaStart: number; thetaLength: number } {
  return {
    phiStart: (2 * Math.PI * s.c) / grid.cols,
    phiLength: (2 * Math.PI) / grid.cols,
    thetaStart: (Math.PI * s.r) / grid.rows,
    thetaLength: Math.PI / grid.rows,
  };
}

/**
 * A tile or crop texture's UV transform: three applies `uv * repeat + offset`,
 * and the image's global rectangle (the sector's, widened by the layout's
 * span) must land on its INTERIOR — the content inside the gutter. With
 * fW = contentWidth/width, fH = contentHeight/height, gW = gutter/width,
 * gH = gutter/height:
 *   u' = (u − (u0 − leadU/cols)) · (cols/spanU) · fW + gW
 *   v' = (v − v0) · rows · fH + gH        (rectangle from sectorUvRect).
 */
export function sectorTileTransform(
  grid: SectorGrid,
  s: Sector,
  layout: TileLayout = SECTOR_TILE,
): { offsetX: number; offsetY: number; repeatX: number; repeatY: number } {
  const fW = (layout.width - 2 * layout.gutterX) / layout.width;
  const fH = (layout.height - 2 * layout.gutterY) / layout.height;
  const gW = layout.gutterX / layout.width;
  const gH = layout.gutterY / layout.height;
  const colsPerImage = grid.cols / layout.spanU;
  return {
    offsetX: -((s.c - layout.leadU) / layout.spanU) * fW + gW,
    offsetY: -(grid.rows - 1 - s.r) * fH + gH,
    repeatX: colsPerImage * fW,
    repeatY: grid.rows * fH,
  };
}

/** Apply sectorTileTransform to a texture (ClampToEdge: a sector never wraps). */
export function applySectorTileTransform(
  tex: THREE.Texture,
  grid: SectorGrid,
  s: Sector,
  layout: TileLayout = SECTOR_TILE,
): void {
  const t = sectorTileTransform(grid, s, layout);
  tex.offset.set(t.offsetX, t.offsetY);
  tex.repeat.set(t.repeatX, t.repeatY);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.matrixAutoUpdate = true;
}

/** Unit body-frame direction of a parametric (u, v) point, three's convention. */
export function sphereDirection(u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  const phi = 2 * Math.PI * u;
  const theta = Math.PI * v;
  return out.set(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
}

/** Unit direction of the sector's centre in the body frame. */
export function sectorCentreDirection(grid: SectorGrid, s: Sector, out: THREE.Vector3): THREE.Vector3 {
  return sphereDirection((s.c + 0.5) / grid.cols, (s.r + 0.5) / grid.rows, out);
}

const cornerScratch = new THREE.Vector3();
const centreScratch = new THREE.Vector3();

/**
 * Angular radius of a sector: the largest angle from its centre to any of its
 * four corners, or to the pole it contains (a polar sector's farthest point is
 * a corner on its lower edge; the pole is included so the bound holds for the
 * whole cap). For the 8×4 grid this is 22.5°–31.4°.
 */
export function sectorAngularRadius(grid: SectorGrid, s: Sector): number {
  const centre = sectorCentreDirection(grid, s, centreScratch);
  const u0 = s.c / grid.cols;
  const u1 = (s.c + 1) / grid.cols;
  const v0 = s.r / grid.rows;
  const v1 = (s.r + 1) / grid.rows;
  let maxAngle = 0;
  const consider = (u: number, v: number) => {
    const a = centre.angleTo(sphereDirection(u, v, cornerScratch));
    if (a > maxAngle) maxAngle = a;
  };
  consider(u0, v0);
  consider(u1, v0);
  consider(u0, v1);
  consider(u1, v1);
  if (s.r === 0) consider(u0, 0); // north pole
  if (s.r === grid.rows - 1) consider(u0, 1); // south pole
  return maxAngle;
}

/**
 * Bounding sphere of the sector's surface patch on a body of radius `radius`
 * (body frame): every point within angle ρ of the centre point P lies within
 * the chord 2R·sin(ρ/2) of P. Conservative by construction — the streamer
 * feeds it to the same overestimating screen-size gate the LOD loop uses.
 */
export function sectorBoundingSphere(
  grid: SectorGrid,
  s: Sector,
  radius: number,
  outCentre: THREE.Vector3,
): { centre: THREE.Vector3; radius: number } {
  sectorCentreDirection(grid, s, outCentre).multiplyScalar(radius);
  const rho = sectorAngularRadius(grid, s);
  return { centre: outCentre, radius: 2 * radius * Math.sin(rho / 2) };
}

/**
 * Whether any of a sector can face a camera at body-frame position `cam`:
 * the visible cap from a camera at distance d has half-angle acos(R/d), and
 * the sector reaches ρ from its centre, so the sector is (partly) on the
 * near side when the angle between its centre and the camera direction is
 * under acos(R/d) + ρ. A camera at or inside the surface sees everything
 * around it — return true rather than divide by a degenerate distance.
 */
export function sectorMayFaceCamera(
  centreDir: THREE.Vector3,
  angularRadius: number,
  cam: THREE.Vector3,
  radius: number,
): boolean {
  const d = cam.length();
  if (!(d > radius)) return true;
  const horizon = Math.acos(radius / d);
  const angle = centreDir.angleTo(cam);
  return angle < horizon + angularRadius;
}

/**
 * A sector's mesh geometry: the partial sphere, `segments` per side, with the
 * uv attribute rewritten to GLOBAL equirect coordinates (SphereGeometry's own
 * uvs run 0–1 across the partial patch). Keeps three's half-texel pole shift
 * on the pole rows so a polar sector's apex samples like the full sphere's.
 */
export function sectorSphereGeometry(
  radius: number,
  grid: SectorGrid,
  s: Sector,
  segments: number,
): THREE.SphereGeometry {
  const args = sectorSphereArgs(grid, s);
  const geo = new THREE.SphereGeometry(
    radius, segments, segments, args.phiStart, args.phiLength, args.thetaStart, args.thetaLength,
  );
  const rect = sectorUvRect(grid, s);
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const uSpan = rect.u1 - rect.u0;
  const vSpan = rect.v1 - rect.v0;
  const isNorth = s.r === 0;
  const isSouth = s.r === grid.rows - 1;
  let i = 0;
  for (let iy = 0; iy <= segments; iy++) {
    const v = iy / segments;
    let uOffset = 0;
    if (iy === 0 && isNorth) uOffset = 0.5 / segments;
    else if (iy === segments && isSouth) uOffset = -0.5 / segments;
    for (let ix = 0; ix <= segments; ix++, i++) {
      const u = ix / segments;
      uv.setXY(i, rect.u0 + (u + uOffset) * uSpan, rect.v1 - v * vSpan);
    }
  }
  uv.needsUpdate = true;
  return geo;
}
