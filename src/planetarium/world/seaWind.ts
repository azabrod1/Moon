/**
 * The wind over the sea, as the roughness the ocean is drawn at.
 *
 * A glint is a picture of the wind. The slope of a wind-roughened sea is close
 * to Gaussian with a mean square that grows with the wind (Cox and Munk, 1954:
 * 0.003 + 0.00512 U, U the wind in m/s), so the mirror lobe the sea reflects
 * the Sun through is narrow and bright where the wind has dropped and wide and
 * faint where it blows. A glassy patch at the specular point is a white streak
 * a hundred kilometres across; a trade-wind sea under the same Sun is a silvery
 * sheen the size of a continent; one ocean holds both side by side. One
 * roughness for the whole sea can draw neither: at a calm width it is a lamp on
 * a glossy globe, at a windy width a grey wash, and either way every contour is
 * a circle the sphere's own geometry draws.
 *
 * So the sea's roughness is read per fragment from a map of the wind over it,
 * built here once per session: a zonal profile of the mean wind by latitude —
 * the doldrums calm, the trades steady, the subtropical highs light, the
 * westerlies and the Southern Ocean strong — with longitudinal structure from a
 * seeded, longitude-periodic noise, and a sparse field of calm patches a few
 * hundred kilometres across, weighted toward the seas whose mean wind is low,
 * because that is where the real ones are. The surface shader turns the wind
 * into a GGX roughness through the same slope law (`windRoughness`); the mask
 * the roughness map carries still says where there is sea at all, so land and
 * a coast's fraction are untouched.
 *
 * What is authored and what is measured. The slope law is Cox-Munk's isotropic
 * fit, whose zero-wind floor is an extrapolation. The zonal means are
 * approximate values read off published scatterometer climatologies, good to
 * about a metre a second. The longitudinal structure and the patches are
 * synthetic: a sea state, not the weather of the simulated moment, and the
 * numbers that shape them are candidates chosen to be looked at rather than
 * measurements. A gridded climatology can replace the profile through the same
 * map format and the same read.
 *
 * `?seawind=0` (any build) draws the whole sea at OCEAN_ROUGHNESS again — the
 * kill switch, and the A/B against the one-width sea. The DEV `?glint=<r>` and
 * `__moon.glint({roughness})` force a uniform sea at that width for the same
 * comparison from the address bar.
 */
import * as THREE from 'three';
import { applyTextureDefaults } from './texturePolicy';

/** Cox-Munk's mean-square slope of a clean sea: this at no wind, and this much
 *  more per metre a second. The surface shader carries the same two numbers,
 *  and its test holds them to these. */
export const COX_MUNK_SLOPE_CALM = 0.003;
export const COX_MUNK_SLOPE_PER_MS = 0.00512;

/** The wind the map's full scale stands for, m/s: the map is a byte a texel,
 *  and past a gale the sheen has stopped changing. */
export const SEA_WIND_MAX_MS = 16;

/** The map's size: about 0.35° a texel, 40 km at the equator, which resolves a
 *  calm patch as a few texels and costs half a megabyte. */
export const SEA_WIND_MAP_WIDTH = 1024;
export const SEA_WIND_MAP_HEIGHT = 512;

/** The wind a calm patch settles toward, m/s: glassy, so the patch's lobe is
 *  narrow enough to clip to white at the specular point. */
export const CALM_PATCH_WIND_MS = 0.3;

/** How far the longitudinal structure moves the zonal mean, as fractions of
 *  it: a broad term of about 4,000 km and a finer one of about 1,300 km. */
export const WIND_BROAD_SPREAD = 0.25;
export const WIND_FINE_SPREAD = 0.15;

/** Where on the patch noise's [0, 1) a calm patch begins and where it is fully
 *  glassy — the noise's 75th and 93rd percentiles, so a few percent of a calm
 *  sea is glassy at any moment — and the zonal winds between which patches
 *  fade out: every sea at 4 m/s and under gets its share, none at 9 m/s and
 *  over. */
export const CALM_PATCH_ONSET = 0.72;
export const CALM_PATCH_FULL = 0.82;
export const CALM_PATCH_WIND_ALL_MS = 4;
export const CALM_PATCH_WIND_NONE_MS = 9;

/** The three noises' lattices, in cells around a parallel. */
const BROAD_CELLS = 9;
const FINE_CELLS = 30;
const PATCH_CELLS = 144;

/**
 * The GGX roughness a sea under this wind is drawn at: alpha as the root of
 * Cox-Munk's mean-square slope, roughness as alpha's root, because three
 * squares the roughness into alpha. Matching a heavy-tailed GGX lobe to a
 * Gaussian slope distribution is a convention; this one matches the peak
 * density, so the brightness at the centre of the glint is the sea's, and it
 * lands the roughness map's own 0.45 at a 7 m/s sea, the mean over the ocean.
 */
export function windRoughness(windMs: number): number {
  return Math.pow(COX_MUNK_SLOPE_CALM + COX_MUNK_SLOPE_PER_MS * Math.max(windMs, 0), 0.25);
}

/**
 * Approximate zonal means of the wind over the sea, m/s at 10 m, by latitude
 * (north positive), as read off scatterometer climatologies: the ITCZ's calm
 * near the equator, the trades either side, the light subtropical highs, the
 * westerlies, and the Southern Ocean as the windiest sea on Earth. Good to
 * about a metre a second; a gridded climatology would replace this table.
 */
export const ZONAL_WIND_MS: ReadonlyArray<readonly [latitudeDeg: number, windMs: number]> = [
  [90, 8.0], [70, 9.0], [55, 9.5], [45, 9.0], [35, 6.5], [25, 6.5], [15, 7.5], [8, 6.5], [3, 5.0],
  [0, 4.8],
  [-3, 5.2], [-8, 6.5], [-15, 7.5], [-25, 6.5], [-35, 8.0], [-45, 10.5], [-55, 11.5], [-65, 10.5],
  [-90, 8.0],
];

/** The zonal mean at a latitude, interpolated between the table's rows. */
export function zonalWindMs(latitudeDeg: number): number {
  const latitude = Math.max(-90, Math.min(90, latitudeDeg));
  for (let row = 0; row < ZONAL_WIND_MS.length - 1; row++) {
    const [latitudeHigh, windHigh] = ZONAL_WIND_MS[row];
    const [latitudeLow, windLow] = ZONAL_WIND_MS[row + 1];
    if (latitude <= latitudeHigh && latitude >= latitudeLow) {
      const along = (latitudeHigh - latitude) / (latitudeHigh - latitudeLow);
      return windHigh + (windLow - windHigh) * along;
    }
  }
  return ZONAL_WIND_MS[ZONAL_WIND_MS.length - 1][1];
}

/** A lattice corner's value in [0, 1): an integer hash, seeded, so the map is
 *  the same map every session and every build. */
function latticeHash(column: number, row: number, seed: number): number {
  let hash = Math.imul(column, 0x27d4eb2d) ^ Math.imul(row, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

/**
 * Value noise on the sphere's map: a lattice of `cellsAround` cells around a
 * parallel and half as many pole to pole, periodic in longitude and clamped at
 * the poles, bilinear between its corners with a quintic ease so a cell edge
 * is not a crease. In [0, 1). `u` is longitude as a turn, `v` latitude as the
 * map's row from the south pole.
 */
export function mapNoise(u: number, v: number, cellsAround: number, seed: number): number {
  const cellsPoleToPole = cellsAround / 2;
  const x = u * cellsAround;
  const y = v * cellsPoleToPole;
  const column = Math.floor(x);
  const row = Math.floor(y);
  const fx = x - column;
  const fy = y - row;
  const easeX = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const easeY = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const wrap = (index: number) => ((index % cellsAround) + cellsAround) % cellsAround;
  const clampRow = (index: number) => Math.max(0, Math.min(cellsPoleToPole, index));
  const corner00 = latticeHash(wrap(column), clampRow(row), seed);
  const corner10 = latticeHash(wrap(column + 1), clampRow(row), seed);
  const corner01 = latticeHash(wrap(column), clampRow(row + 1), seed);
  const corner11 = latticeHash(wrap(column + 1), clampRow(row + 1), seed);
  const lower = corner00 + (corner10 - corner00) * easeX;
  const upper = corner01 + (corner11 - corner01) * easeX;
  return lower + (upper - lower) * easeY;
}

/** GLSL's smoothstep, either way round. */
function smoothstep(edgeFrom: number, edgeTo: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edgeFrom) / (edgeTo - edgeFrom)));
  return t * t * (3 - 2 * t);
}

/** The wind over the sea at a point of the map, m/s, before the byte. */
export function seaWindAt(u: number, v: number): number {
  const latitudeDeg = (v - 0.5) * 180;
  const zonal = zonalWindMs(latitudeDeg);
  const broad = mapNoise(u, v, BROAD_CELLS, 1) * 2 - 1;
  const fine = mapNoise(u, v, FINE_CELLS, 2) * 2 - 1;
  const blown = zonal * (1 + WIND_BROAD_SPREAD * broad + WIND_FINE_SPREAD * fine);
  const patch = mapNoise(u, v, PATCH_CELLS, 3);
  const calmWeight = smoothstep(CALM_PATCH_ONSET, CALM_PATCH_FULL, patch)
    * smoothstep(CALM_PATCH_WIND_NONE_MS, CALM_PATCH_WIND_ALL_MS, zonal);
  const wind = blown + (CALM_PATCH_WIND_MS - blown) * calmWeight;
  return Math.max(0, Math.min(SEA_WIND_MAX_MS, wind));
}

export interface SeaWindMap {
  data: Uint8Array;
  width: number;
  height: number;
  /** The mean over every texel, land included, m/s. */
  meanWindMs: number;
  /** The share of texels under one metre a second: the glassy patches. */
  calmFraction: number;
}

/**
 * The map: one byte a texel, the wind as a fraction of SEA_WIND_MAX_MS. Row 0
 * is the map's bottom, the south pole — three uploads a DataTexture unflipped,
 * and the shader's v runs from 0 at the south pole to 1 at the north.
 */
export function buildSeaWindMap(width = SEA_WIND_MAP_WIDTH, height = SEA_WIND_MAP_HEIGHT): SeaWindMap {
  const data = new Uint8Array(width * height);
  let sum = 0;
  let calm = 0;
  for (let row = 0; row < height; row++) {
    const v = (row + 0.5) / height;
    for (let column = 0; column < width; column++) {
      const wind = seaWindAt((column + 0.5) / width, v);
      data[row * width + column] = Math.round((wind / SEA_WIND_MAX_MS) * 255);
      sum += wind;
      if (wind < 1) calm++;
    }
  }
  return { data, width, height, meanWindMs: sum / (width * height), calmFraction: calm / (width * height) };
}

let texture: THREE.DataTexture | null = null;

/**
 * The map as a texture, built once per session and bound by every augmented
 * material through one shared uniform (world/surfaceShading's
 * seaWindUniforms). One channel, repeat-wrapped around the date line and
 * clamped at the poles, mip-chained because the sea is looked at from a
 * whole-disc distance where a texel is well under a pixel.
 */
export function seaWindTexture(): THREE.DataTexture {
  if (!texture) {
    const map = buildSeaWindMap();
    const tex = new THREE.DataTexture(map.data, map.width, map.height, THREE.RedFormat, THREE.UnsignedByteType);
    // Data, not colour: an sRGB decode would bend the wind.
    applyTextureDefaults(tex, 'data');
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    texture = tex;
  }
  return texture;
}

/** The `?seawind=0` kill switch, on any build: the whole sea at one width, in
 *  the house style of `?fused=0` and `?ride=0`. */
export function parseSeaWindParam(search: string): boolean {
  return new URLSearchParams(search).get('seawind') !== '0';
}
