/**
 * Sector streaming: 16K-class surface detail for the hero bodies (Earth,
 * Moon, Mars) without a 16K texture. A body's map is split into 8×4 sectors
 * (sectorGrid); while the player is close, the sectors that face the camera
 * AND are large on screen each stream their own 2048² tile (plus crops of the
 * globe's relief / roughness maps) and draw as a sector mesh overlaid on the
 * globe. Everything else keeps drawing the globe's 4K map: a tile that is
 * still downloading changes nothing on screen, so there is never a hold, a
 * veil, or a half-loaded surface — the base map IS the fallback.
 *
 * The working set is bounded and stable: sectors are ranked by projected size
 * and centrality, and what bounds them is BYTES — a per-device budget, taken
 * out of one memory envelope with the globe maps the tier ladder streams, and
 * reserved from the known tile layouts the moment a load starts rather than
 * counted after its decode, so two loads in flight cannot overshoot it by a
 * tile each. A resident sector is only evicted for a candidate that out-ranks
 * it by a margin, and not until it has been resident a moment: a plain LRU
 * would churn 21 MiB uploads every frame at the wall, where more sectors face
 * the camera than the budget holds. The size that matters is the texels of
 * the map below on screen (device pixels per texel at the sector's nearest
 * point): a tile is wanted once that map is visibly magnified and released
 * once it no longer is, with hysteresis between, so a disc breathing around
 * the threshold never flaps a 21 MiB upload. A sector that is magnified but
 * off the frame or on the night side is never fetched, yet stays resident
 * while it is magnified — a pan or a sunrise brings it back for free.
 *
 * A tile is drawn only once it is resident on the GPU: the fetch decodes off
 * the main thread (textureBitmapLoader), the warm pump uploads it on its
 * budgeted frame, and the sector mesh is created on the pump's 'warmed'
 * outcome — nothing on the render path ever pays a texture upload. After the
 * upload the decoded bitmap is closed (tiles are cheap to re-fetch from the
 * service-worker cache); on WebGL context loss every sector is dropped and
 * streams back in.
 *
 * Sector meshes are children of the globe mesh, so they inherit its spin,
 * pole and the moon render-curve scale; their vertices coincide with the
 * globe's fine (256-segment) grid, which the streamer forces when a body's
 * first sector is admitted — the fetch then separates that rebuild from the
 * frame that pays the tile's upload. Their materials are built from the
 * globe's (sectorMaterial), share its per-frame shading uniforms, and mirror
 * its scalar state every frame; they own every texture they draw.
 *
 * A set is a PYRAMID of levels (SectorSetSpec.levels), and nothing here is
 * written for a particular one: a slot carries its level, the level carries
 * its grid, tile layout and source width, and every URL and UV transform
 * comes from that. Level 0 sits on the globe, level k on level k−1 with its
 * grid doubled; the parent of a slot is the arithmetic (⌊c/2⌋, ⌊r/2⌋), and
 * its segments halve as the grid doubles so every level lands on the same
 * vertex lattice. That halving is what bounds the depth: past
 * SECTOR_MAX_LEVEL a sector has too few segments left to sit on the lattice
 * at all, and a set that declares more is refused when the body registers.
 * Slots exist only for the levels a spec declares, so a body that ships one
 * level costs exactly one level's worth of work.
 *
 * One demand rule serves every level — a sector is wanted where the map BELOW
 * it is magnified — and the pyramid is what keeps the working set from
 * fighting itself. Scores are that magnification over the threshold at which
 * a tile is worth fetching: screen-space error, in device pixels of the map
 * the sector would replace. At one spot a child scores its parent's divided
 * by the level step, because the map under it is that much finer — so the
 * coarser level goes first wherever both are asked for, which is what the
 * pyramid wants: the parent covers four times the ground for the same bytes
 * and is the fallback under every child. A sector with a finer one live over
 * it is never given
 * up: it is that sector's instant fallback, and losing it would drop the
 * surface under a resident tile all the way to the globe (which is what a
 * child admitted while its parent was cooling down falls back to — a softness
 * step, never a hole). A sector every child of which is resident is not
 * admitted at all: nothing of it would show, and re-admitting it under
 * pressure is one half of a cycle that would evict a child to pay for it. It
 * becomes a candidate again the frame a child is lost. Among candidates the
 * coarser level goes first: it covers its children's ground at a quarter of
 * the bytes. When a budget shrinks under a full pyramid the give-back works
 * from the leaves inward — each child released frees its parent to go too —
 * so the byte bound holds within the one call at any depth.
 *
 * Pure apart from three's scene graph: the loader, the warm pump and the
 * screen measurement are injected, so the policy is unit-tested without a
 * renderer. PlanetariumMode owns the per-frame call and the device facts.
 */
import * as THREE from 'three';
import {
  SECTOR_GRID_16K,
  SECTOR_TILE,
  ancestorSector,
  applySectorTileTransform,
  dataCropLayout,
  sectorAngularRadius,
  sectorBoundingSphere,
  sectorCentreDirection,
  sectorMayFaceCamera,
  sectorNearestDirection,
  sectorSphereGeometry,
  type Sector,
  type SectorGrid,
  type TileLayout,
} from './sectorGrid';
import { createSectorMaterial, sectorRenderOrder, syncSectorMaterial } from './sectorMaterial';
import { loadStreamedTexture, type TextureLoad } from './textureBitmapLoader';
import { applyTextureDefaults, resolveTileUrl, type TextureTier } from './texturePolicy';
import { TIER_RANK } from '../PlanetFactory';
import { debugWarn } from '../../shared/debug';
import { queueTextureWarm, type WarmOutcome } from './textureWarmer';

/** The material slots a sector may carry a crop of, in a fixed order. */
export const CROP_SLOTS = ['bumpMap', 'normalMap', 'roughnessMap'] as const;
export type CropSlot = (typeof CROP_SLOTS)[number];

export interface SectorCropSpec {
  /** Tile-set key under textures/tiles/: the FILE STEM of the base map the
   *  crops were cut from (`earth-roughness.v2` for earth-roughness.v2.webp),
   *  so a base that ships under a new name takes its crops with it — see
   *  SECTOR_SETS. */
  key: string;
  /** The base map's tier folder the crops were cut from. */
  tier: TextureTier;
  /** Width of that base map — the crop layout (content + gutter) follows. */
  baseWidth: number;
  /** Sectors of longitude a crop spans (normal maps: 2, see sectorGrid). */
  spanU?: number;
}

/** One level of a body's tile pyramid: the colour tiles cut from one source,
 *  on one grid, in one pixel layout. Level 0 sits on the globe; level k sits
 *  on level k−1, its grid doubled and its sectors a quarter the size. */
export interface SectorLevel {
  /** Tier folder the level's colour tiles live under (texturePolicy
   *  .resolveTileUrl) — by convention the source's width class ('16k'). */
  tier: string;
  grid: SectorGrid;
  /** Pixel layout of one of this level's colour tiles. */
  layout: TileLayout;
  /** Width of the equirect source this level's tiles were cut from. It is
   *  what the level BELOW measures magnification against: a level-1 tile has
   *  something to add exactly when a level-0 texel is already magnified. */
  sourceWidth: number;
}

export interface SectorSetSpec {
  /** Tile-set key of the colour tiles: the file stem of the globe's own
   *  colour map (its boot file, or the tier the tiles were matched to). The
   *  key is the same at every level; the level's tier folder separates them. */
  colorKey: string;
  /** Crops for the relief / roughness slots the base material carries. A slot
   *  the base does not currently have is not loaded; if the base gains one
   *  later (Mars's relief arrives after boot) resident sectors reload. Crops
   *  belong to LEVEL 0: mesh uvs are global, so a finer sector samples its
   *  level-0 ancestor's crop through that ancestor's own transform — the same
   *  file, the same offset/repeat, no sub-rectangle. */
  crops: Partial<Record<CropSlot, SectorCropSpec>>;
  /** The pyramid, coarsest first. Slots exist only for the levels declared
   *  here, so a body with one level costs exactly what it costs today. */
  levels: SectorLevel[];
}

/** The 16K colour level every shipped set is cut at: 8 × 4 sectors of 2048²
 *  tiles with an 8-px gutter, from a 16256-wide equirect (8 × 2032 content). */
export const SECTOR_LEVEL_16K: SectorLevel = {
  tier: '16k',
  grid: SECTOR_GRID_16K,
  layout: SECTOR_TILE,
  sourceWidth: SECTOR_GRID_16K.cols * (SECTOR_TILE.width - 2 * SECTOR_TILE.gutterX),
};

/** The bodies that ship a sector set, by catalog name. Colour tiles are the
 *  16K sets; every crop is the base map it names, sector-cut with the same
 *  gutter (tools/gen-tiles.mjs writes both).
 *
 *  Every key is the file stem of the map it was cut from or matched to
 *  (sectorTiles.assets.test pins this). That is what keeps a globe and its
 *  tiles coherent through the service worker: the worker may serve a
 *  one-deploy-old body under any pathname it already holds for a boot, so a
 *  base map that changes ships under a new name (`.v2` -> `.v3`) — and with
 *  the stem in the tile paths, a set cut from the new map cannot be reached
 *  through the old paths, nor the old set through the new. A re-cut of a
 *  set whose base did not change (a layout change, a new gutter) bumps the
 *  base's name for the same reason. */
export const SECTOR_SETS: Record<string, SectorSetSpec> = {
  Earth: {
    colorKey: 'earth-day.v2',
    crops: {
      bumpMap: { key: 'earth-bump', tier: '2k', baseWidth: 2048 },
      roughnessMap: { key: 'earth-roughness.v2', tier: '4k', baseWidth: 4096 },
    },
    levels: [SECTOR_LEVEL_16K],
  },
  Mars: {
    colorKey: 'mars.v2',
    crops: { normalMap: { key: 'mars-normal.v2', tier: '2k', baseWidth: 1440, spanU: 2 } },
    levels: [SECTOR_LEVEL_16K],
  },
  Moon: {
    colorKey: 'moon',
    crops: { normalMap: { key: 'moon-normal', tier: '4k', baseWidth: 2880, spanU: 2 } },
    levels: [SECTOR_LEVEL_16K],
  },
};

/** A sector is wanted once one texel of the map BELOW it spans this many
 *  DEVICE pixels at the sector's nearest point — that map is then visibly
 *  magnified and a tile has detail to add — and released only once that
 *  falls under the second value, so a disc breathing around the threshold
 *  never flaps a 21 MiB upload. One rule per level: the map below a level-0
 *  sector is the globe's own, the map below a level-k sector is level k−1's
 *  source, so a finer level is asked for exactly where the level above it
 *  has run out of texels. Measured against the finest colour map the
 *  globe will hold on this device (SectorBodyHandle.topMapWidth), or the
 *  one it draws if that is wider: the Moon's 8K rung needs twice the
 *  magnification a 4K map does before a tile shows anything (a tile under
 *  that is 21 MiB of GPU memory for nothing visible), and measuring against
 *  the 2K boot map while the 8K is still in flight would admit sectors the
 *  8K's arrival then releases — a sharpen that un-sharpens. In device
 *  pixels, so a 3× phone wants tiles where a 1× monitor does not.
 *
 *  Desktop asks at 1.0: a base texel spanning one device pixel is the point
 *  where a finer map first shows, and the fetch after that is the only
 *  delay. Touch asks later, at 1.25: its 2–3× displays already reach that
 *  magnification at nearly twice the distance, and every earlier tile is a
 *  200 KB fetch and 21 MiB of shared memory on the device with the least
 *  of both. */
export const SECTOR_WANT_TEXEL_PX = 1.0;
export const SECTOR_RELEASE_TEXEL_PX = 0.65;
export const SECTOR_WANT_TEXEL_PX_TOUCH = 1.25;
export const SECTOR_RELEASE_TEXEL_PX_TOUCH = 0.8;
/** Map width assumed while a globe's map has no readable image (never in
 *  practice: a real map is an ImageBitmap or a painted canvas). */
const SECTOR_FALLBACK_MAP_WIDTH = 4096;
/** A sector whose most-lit point — the point of it nearest the sub-solar
 *  point — is still this far past the terminator (its dot with the sun
 *  direction, in the globe's frame) is never fetched: no part of it is lit,
 *  and the night fill draws nothing a tile could sharpen. Measured at the
 *  lit edge, not the centre: an equatorial sector reaches 31° from its
 *  centre, and a centre test that let 14° of lit terminator strip stay on
 *  the base map. The margin past zero is the few degrees of twilight the
 *  atmosphere renders beyond the terminator. */
export const SECTOR_NIGHT_DOT = -0.1;

/** What the sectors of every body together may hold on the GPU. This is the
 *  real bound: bytes, reserved from the known tile layouts at admission
 *  rather than counted after the decode, so two loads in flight cannot
 *  overshoot it by 45 MiB between them. An Earth sector set — its 2048²
 *  tile plus its copies of the bump and roughness crops — is ~23.1 MiB, so
 *  desktop holds eleven and touch six. Six is what a phone held before the
 *  budget was in bytes at all, and a phone's shared memory is the app's
 *  known weak spot: 128 MiB would hold five. */
export const SECTOR_BUDGET_BYTES_DESKTOP = 256 * 1024 * 1024;
export const SECTOR_BUDGET_BYTES_TOUCH = 144 * 1024 * 1024;
/** Ceiling on the sector budget PLUS the globe maps live at the same time
 *  (the tier ladder's applied colour maps, which the mode reports). The
 *  sector budget is whatever this leaves under the figure above, so a Moon
 *  8K and Earth's cloud deck take their share out of the tiles rather than
 *  stacking on top of them. */
export const SECTOR_ENVELOPE_BYTES_DESKTOP = 768 * 1024 * 1024;
export const SECTOR_ENVELOPE_BYTES_TOUCH = 320 * 1024 * 1024;

/** Resident sectors (meshes with a tile on the GPU) across all bodies —
 *  an emergency ceiling on draw calls only. The byte budget above is what
 *  decides the working set; this is generous enough that it never does. */
export const SECTOR_RESIDENT_CAP_DESKTOP = 16;
export const SECTOR_RESIDENT_CAP_TOUCH = 8;
/** Sector loads (colour + crops of one sector count as one) in flight. */
export const SECTOR_INFLIGHT_CAP_DESKTOP = 2;
export const SECTOR_INFLIGHT_CAP_TOUCH = 1;
/** Individual map fetches in flight: one sector is up to three of them, so
 *  the slot cap alone would put six requests on the wire at once. */
export const SECTOR_FETCH_POOL_DESKTOP = 6;
export const SECTOR_FETCH_POOL_TOUCH = 3;
/** How long a sector is safe from eviction after its tile LANDS. Without it
 *  a working set at the budget could hand the same slot back and forth
 *  between two candidates a hair apart, paying an upload each time. It runs
 *  from the upload because that is what it protects: a load still in the air
 *  has paid nothing, so a far stronger candidate may take its reservation
 *  and its fetch is aborted rather than finished for a tile that would be
 *  evicted on its first frame. */
export const SECTOR_EVICT_DWELL_MS = 1_000;

/** A candidate evicts the weakest resident only when it out-ranks it by this
 *  factor — the admission hysteresis that keeps the working set stable. The
 *  ranking is screen-space error over the want threshold, which is
 *  comparable across levels and bodies because every level measures the map
 *  IT would replace: a level-1 sector reads the pixels per texel of level
 *  0's source where a level-0 sector reads the globe's own map. Two sectors
 *  over the same ground therefore differ by the level step, coarse above
 *  fine, which is the order the pyramid wants. */
export const SECTOR_ADMIT_MARGIN = 1.25;

/** Cooldown after a failed sector load, doubling per consecutive failure. */
export const SECTOR_RETRY_MS = 8_000;
const SECTOR_RETRY_MAX_DOUBLINGS = 4;
/** A load older than this is given up on and its fetch aborted: two hung
 *  requests would otherwise hold the desktop in-flight allowance for the
 *  session. The same figure as the tier ladder's attempt timeout. */
export const SECTOR_ATTEMPT_TIMEOUT_MS = 60_000;

/** Segments per level-0 (45°) sector: 32 × 8 = the globe's 256-segment fine
 *  grid. A level halves it as the grid doubles, so every level's vertices
 *  land on that one lattice and no sector fights another for depth. */
export const SECTOR_SEGMENTS = 32;
/** Deepest level a set may declare, checked when the body registers. Two is
 *  as far as any source goes (a 65K-class colour map for Earth and Mars, one
 *  level for the Moon), and it is also where the geometry stays honest: each
 *  level halves the segment count, and below three segments three clamps the
 *  sphere and the sector's vertices would stop landing on the globe's
 *  lattice. */
export const SECTOR_MAX_LEVEL = 2;

/** How a sector reads on screen this frame, from the mode's projection. */
export interface SectorMeasure {
  /** Device pixels one unit of surface length covers at the sector's centre
   *  (in the globe's LOCAL units), foreshortened by the view angle — the
   *  base map's texel size on screen is this times the texel's length. */
  pxPerLocalUnit: number;
  /** 1 at the screen centre, falling to 0 at the frame edge. */
  centrality: number;
  /** The footprint lies entirely outside the frame: kept while big (it is
   *  one pan away), never fetched. */
  offscreen?: boolean;
}

/** A body registered for streaming: the globe mesh sectors attach to (its
 *  transform is theirs), the material they shade like, and the unscaled
 *  radius the sector geometry is built at. */
export interface SectorBodyHandle {
  name: string;
  spec: SectorSetSpec;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  radiusAU: number;
  /** Width of the finest colour map this device will hold for the globe
   *  (its tier ladder's top), the map magnification is measured against.
   *  Omitted for a body with no ladder: its boot map is its finest. */
  topMapWidth?: number;
  /** Rebuild the globe on its fine grid now (idempotent); sectors must not
   *  show over a coarse globe, whose chords they would float above. */
  ensureFineGeometry: () => void;
}

/** What the per-frame call may do for a body. */
export type SectorSuspend = 'none' | 'admissions' | 'all';

type SlotState = 'idle' | 'loading' | 'resident';
type MapName = 'map' | CropSlot;

interface SectorSlot {
  sector: Sector;
  /** Which level of the body's pyramid this slot belongs to (0 = coarsest). */
  level: number;
  /** The slot one level up that contains this one, and the four this one
   *  contains — resolved once at registration, so the pyramid rules cost a
   *  pointer walk rather than a lookup. */
  parent?: SectorSlot;
  children: SectorSlot[];
  centreDir: THREE.Vector3;
  angularRadius: number;
  bsCentre: THREE.Vector3;
  bsRadius: number;
  state: SlotState;
  gen: number;
  /** This frame's rank (0 = not wanted). */
  score: number;
  keep: boolean;
  wanted: boolean;
  /** Crop-slot signature of the set this sector draws (a resident) or last
   *  drew. A resident whose signature no longer matches the base's reloads
   *  IN PLACE: the old sector stays on the globe while the new set loads. */
  signature: string;
  /** Bytes the maps this slot draws hold, and the bytes its in-flight load
   *  has RESERVED for the maps it is fetching — both from the layouts, so
   *  the budget is committed before a byte is decoded. */
  bytes: number;
  reserved: number;
  /** When this slot last went live, for the eviction dwell. */
  liveSinceMs: number;
  /** In-flight load — a fresh admission, or a resident's in-place reload.
   *  `owned` holds every decoded texture from the moment it exists (queued
   *  for warming or landed), so a release can dispose it — which also
   *  dequeues it from the warm pump through its dispose hook. A reload
   *  reuses the maps the resident already draws (its colour tile above all:
   *  the same URL, and the one upload that costs); those stay in `maps`,
   *  never in `owned`, until the swap decides which of them survive. */
  loading?: SectorLoad;
  mesh?: THREE.Mesh;
  /** The maps the resident mesh draws, by material slot. */
  maps: Partial<Record<MapName, THREE.Texture>>;
  failStreak: number;
  retryAtMs: number;
}

interface SectorLoad {
  signature: string;
  startedAtMs: number;
  /** Ends the fetches when the load is abandoned for any reason. */
  abort: AbortController;
  pending: number;
  loaded: Partial<Record<MapName, THREE.Texture>>;
  owned: THREE.Texture[];
}

interface SectorBody {
  handle: SectorBodyHandle;
  slots: SectorSlot[];
  levels: SectorLevel[];
  /** Surface length of the texel each level's demand is measured against —
   *  level 0's is the globe's own map and moves with its tier ladder, the
   *  rest are the level above's source and never change. */
  texelLens: number[];
  /** This frame's crop signature and whether loads may start for this body
   *  (the reconcile pass runs after every body is measured). */
  signature: string;
  admitting: boolean;
  /** Diagnostic: the largest texel magnification measured this frame. */
  maxTexelPx: number;
}

export interface SectorStreamerOptions {
  touch: boolean;
  load?: TextureLoad;
  warm?: (tex: THREE.Texture, onOutcome: (o: WarmOutcome) => void) => void;
}

export interface SectorStats {
  resident: number;
  /** Fresh admissions in flight. */
  loading: number;
  /** Every load in flight — admissions and residents' in-place reloads —
   *  the figure the in-flight cap counts. */
  inflight: number;
  /** GPU memory the sector textures hold, estimated from their dimensions
   *  (RGBA8 plus a third for mips) — resident sets and what loads have
   *  decoded so far. Measured after the decode, so it lags the two figures
   *  below; ten colour tiles alone are ~213 MiB. */
  gpuBytes: number;
  /** What the budget actually counts: the bytes the resident sets hold and
   *  the bytes the loads in flight have reserved, both from the tile
   *  layouts. `residentBytes + reserved <= budget` holds whenever this is
   *  read: every path that admits, reloads or shrinks the budget leaves the
   *  working set inside it before it returns, a pyramid of levels included. */
  residentBytes: number;
  reserved: number;
  /** This device's sector budget right now — its ceiling, or what the total
   *  envelope leaves over the globe maps (globalBytes), whichever is less. */
  budget: number;
  envelope: number;
  globalBytes: number;
  bodies: Record<string, {
    resident: string[];
    loading: string[];
    /** Residents reloading in place (also listed under resident). */
    reloading: string[];
    /** Largest device-px-per-base-texel measured for the body this frame
     *  (0 while nothing faces the camera or the body is gated off). */
    maxTexelPx: number;
    gpuBytes: number;
    /** The same counts split by pyramid level, coarsest first. */
    byLevel: Array<{ resident: number; loading: number; gpuBytes: number }>;
  }>;
}

/** A slot's id in the stats: bare `c_r` at level 0 — the ids every probe
 *  script already reads — and namespaced `L1/c_r` below it, so no two levels
 *  of the same body can collide in one flat list. */
function slotId(slot: SectorSlot): string {
  const cell = `${slot.sector.c}_${slot.sector.r}`;
  return slot.level === 0 ? cell : `L${slot.level}/${cell}`;
}

/** GPU bytes an image of this layout holds: RGBA8 at its pixel size plus a
 *  third for its mip chain. Known before the fetch — which is what lets an
 *  admission reserve what it is about to hold. */
function layoutGpuBytes(layout: TileLayout): number {
  return Math.round(layout.width * layout.height * 4 * (4 / 3));
}

/** GPU bytes one sector of a set holds at `level`: its colour tile plus its
 *  own copy of every crop the base material carries (`has`). Sectors are
 *  self-contained — four children of one parent hold four copies of the same
 *  crop — and the budget counts every copy. */
export function sectorSetGpuBytes(
  spec: SectorSetSpec,
  level = 0,
  has: (slot: CropSlot) => boolean = () => true,
): number {
  let bytes = layoutGpuBytes(spec.levels[level].layout);
  for (const slot of CROP_SLOTS) {
    const crop = spec.crops[slot];
    if (!crop || !has(slot)) continue;
    bytes += layoutGpuBytes(dataCropLayout(spec.levels[0].grid, crop.baseWidth, crop.spanU ?? 1));
  }
  return bytes;
}

/** Estimated GPU bytes of a texture: RGBA8 at its image size, plus mips.
 *  Read from the image while it is still attached; a resident tile's bitmap
 *  is closed after its upload, so the figure is stashed on the texture at
 *  decode (userData.gpuBytes) and read from there afterwards. */
function textureGpuBytes(tex: THREE.Texture): number {
  const stashed = tex.userData?.gpuBytes;
  if (typeof stashed === 'number') return stashed;
  const img = tex.image as { width?: unknown; height?: unknown } | undefined;
  if (!img || typeof img.width !== 'number' || typeof img.height !== 'number') return 0;
  return Math.round(img.width * img.height * 4 * (4 / 3));
}

/** A real map in a material slot — not the procedural stand-in a failed
 *  boot fetch leaves there (a crop of the real map over a flat fallback would
 *  be a rectangle of relief on a smooth globe). */
function realMapIn(mat: THREE.MeshStandardMaterial, slot: CropSlot): boolean {
  const tex = mat[slot];
  return !!tex && tex.userData?.proceduralFallback !== true;
}

/** The globe draws a real photo map (boot tier or higher) — the only base a
 *  real tile may overlay. A body still on its procedural floor (a fallback
 *  after a failed fetch, a painted moon before its photo lands) would show a
 *  sector as a rectangle of a different world. */
function realAlbedoOn(mat: THREE.MeshStandardMaterial): boolean {
  const rank = mat.userData?.colorTierRank as number | undefined;
  return (rank ?? 0) >= TIER_RANK['2k'];
}

/** Which crop slots the base material carries right now — sectors loaded
 *  under a different signature reload so their maps stay the base's. */
function cropSignature(mat: THREE.MeshStandardMaterial, spec: SectorSetSpec): string {
  let sig = '';
  for (const slot of CROP_SLOTS) {
    if (spec.crops[slot] && realMapIn(mat, slot)) sig += slot[0];
  }
  return sig;
}

/** No crop slot the set names is showing a procedural stand-in. While one
 *  is (a boot fetch timed out; the real map lands late), the globe shades
 *  through the flat stand-in — roughness 0.5 everywhere — and a sector cut
 *  without that map would shade differently: a matte rectangle in the sun
 *  glint. A slot the base simply has no map in yet is fine (the sector then
 *  has none either, and reloads when the map arrives). */
function cropsReady(mat: THREE.MeshStandardMaterial, spec: SectorSetSpec): boolean {
  for (const slot of CROP_SLOTS) {
    if (!spec.crops[slot]) continue;
    const tex = mat[slot];
    if (tex && tex.userData?.proceduralFallback === true) return false;
  }
  return true;
}

/** Surface length of one texel of the globe's colour map, in the globe's
 *  local units (equatorial). Read from the texture itself — the boot tier is
 *  not literally 2048 wide for every body, and a tier swap changes the map
 *  under a registered material. */
function baseTexelLength(handle: SectorBodyHandle): number {
  const img = handle.material.map?.image as { width?: unknown } | undefined;
  const drawn = img && typeof img.width === 'number' && img.width > 0 ? img.width : 0;
  const width = Math.max(drawn, handle.topMapWidth ?? 0) || SECTOR_FALLBACK_MAP_WIDTH;
  return (2 * Math.PI * handle.radiusAU) / width;
}

/** A finer sector of this one is live (resident, or a load away from it).
 *  Such a sector draws over part of this one and falls back to it, so this
 *  one is not the streamer's to give up. */
function hasLiveChild(slot: SectorSlot): boolean {
  for (const child of slot.children) if (child.state !== 'idle') return true;
  return false;
}

/** Every finer sector of this one is already resident: nothing of it is
 *  visible, so admitting it would buy a frame of nothing and cost a victim.
 *  It becomes a candidate again the moment one of those children is lost —
 *  which is the frame it becomes the fallback under the rest. */
function covered(slot: SectorSlot): boolean {
  if (slot.children.length === 0) return false;
  for (const child of slot.children) if (child.state !== 'resident') return false;
  return true;
}

/** Close a tile's decoded bitmap once it is resident: the upload is paid, a
 *  context loss drops the sector rather than re-uploading, and 16 MiB of RAM
 *  per tile goes back. Idempotent — the loader's dispose hook closes too. */
function releaseBitmap(tex: THREE.Texture): void {
  const img = tex.image as { close?: () => void } | undefined;
  if (img && typeof img.close === 'function') img.close();
}

export class SectorStreamer {
  private readonly bodies = new Map<string, SectorBody>();
  private readonly load: TextureLoad;
  private readonly warm: (tex: THREE.Texture, onOutcome: (o: WarmOutcome) => void) => void;
  private readonly residentCap: number;
  private readonly inflightCap: number;
  private readonly fetchPool: number;
  private readonly ceilingBytes: number;
  private readonly envelopeBytes: number;
  private readonly wantTexelPx: number;
  private readonly releaseTexelPx: number;
  private globalBytes = 0;
  private warnedNoBudget = false;
  private generation = 0;
  private lastNowMs = 0;
  private batching = false;
  private readonly batch: SectorBody[] = [];
  private readonly camScratch = new THREE.Vector3();
  private readonly camDirScratch = new THREE.Vector3();
  private readonly pointScratch = new THREE.Vector3();
  private readonly sunPointScratch = new THREE.Vector3();

  constructor(opts: SectorStreamerOptions) {
    this.load = opts.load ?? loadStreamedTexture;
    this.warm = opts.warm ?? queueTextureWarm;
    this.residentCap = opts.touch ? SECTOR_RESIDENT_CAP_TOUCH : SECTOR_RESIDENT_CAP_DESKTOP;
    this.inflightCap = opts.touch ? SECTOR_INFLIGHT_CAP_TOUCH : SECTOR_INFLIGHT_CAP_DESKTOP;
    this.fetchPool = opts.touch ? SECTOR_FETCH_POOL_TOUCH : SECTOR_FETCH_POOL_DESKTOP;
    this.ceilingBytes = opts.touch ? SECTOR_BUDGET_BYTES_TOUCH : SECTOR_BUDGET_BYTES_DESKTOP;
    this.envelopeBytes = opts.touch ? SECTOR_ENVELOPE_BYTES_TOUCH : SECTOR_ENVELOPE_BYTES_DESKTOP;
    this.wantTexelPx = opts.touch ? SECTOR_WANT_TEXEL_PX_TOUCH : SECTOR_WANT_TEXEL_PX;
    this.releaseTexelPx = opts.touch ? SECTOR_RELEASE_TEXEL_PX_TOUCH : SECTOR_RELEASE_TEXEL_PX;
  }

  register(handle: SectorBodyHandle): void {
    const levels = handle.spec.levels;
    if (levels.length === 0) throw new Error(`${handle.name} declares no sector levels`);
    if (levels.length - 1 > SECTOR_MAX_LEVEL) {
      throw new Error(`${handle.name} declares ${levels.length} sector levels; ${SECTOR_MAX_LEVEL + 1} is the most a set may carry`);
    }
    this.unregister(handle.name);
    const slots: SectorSlot[] = [];
    // Coarsest level first, so the per-frame pass measures a parent before
    // the children whose visit it gates.
    const byKey = new Map<string, SectorSlot>();
    for (let level = 0; level < levels.length; level++) {
      const grid = levels[level].grid;
      for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) {
          const sector = { c, r };
          const bsCentre = new THREE.Vector3();
          const bs = sectorBoundingSphere(grid, sector, handle.radiusAU, bsCentre);
          const slot: SectorSlot = {
            sector,
            level,
            children: [],
            centreDir: sectorCentreDirection(grid, sector, new THREE.Vector3()),
            angularRadius: sectorAngularRadius(grid, sector),
            bsCentre,
            bsRadius: bs.radius,
            state: 'idle',
            gen: 0,
            score: 0,
            keep: false,
            wanted: false,
            signature: '',
            bytes: 0,
            reserved: 0,
            liveSinceMs: 0,
            maps: {},
            failStreak: 0,
            retryAtMs: 0,
          };
          if (level > 0) {
            const parent = byKey.get(`${level - 1}:${c >> 1}:${r >> 1}`);
            if (parent) {
              slot.parent = parent;
              parent.children.push(slot);
            }
          }
          byKey.set(`${level}:${c}:${r}`, slot);
          slots.push(slot);
        }
      }
    }
    const texelLens = levels.map((_, i) => (
      i === 0 ? 0 : (2 * Math.PI * handle.radiusAU) / levels[i - 1].sourceWidth
    ));
    this.bodies.set(handle.name, {
      handle, slots, levels, texelLens, signature: '', admitting: false, maxTexelPx: 0,
    });
  }

  unregister(name: string): void {
    const body = this.bodies.get(name);
    if (!body) return;
    for (const slot of body.slots) this.release(slot);
    this.bodies.delete(name);
    // A body measured earlier in an open frame must leave the batch with it:
    // reconciling it would admit sectors whose bytes nothing counts any more.
    const queued = this.batch.indexOf(body);
    if (queued >= 0) this.batch.splice(queued, 1);
  }

  has(name: string): boolean {
    return this.bodies.has(name);
  }

  /** The GPU bytes the globe maps hold right now (the tier ladder's applied
   *  colour maps, which only the mode can see). The sector budget is what
   *  the envelope leaves over them. */
  setGlobalMapBytes(bytes: number): void {
    const before = this.globalBytes;
    this.globalBytes = Math.max(0, bytes);
    // The budget is a public number and shrinking it is what makes the
    // working set too big: the sectors go back in the same call, so no
    // caller can ever read a stats() where what is held is over what is
    // allowed. Growing it takes nothing from anyone.
    if (this.globalBytes > before) this.trimToBudget();
    // Streaming that has quietly switched itself off looks like a soft
    // surface, not like a fault. Say it once, with the two figures that
    // explain it.
    if (this.budget() === 0 && !this.warnedNoBudget) {
      this.warnedNoBudget = true;
      debugWarn('Surface tiles off: the globe maps alone fill the memory envelope', {
        globeMapsMiB: Math.round(this.globalBytes / (1024 * 1024)),
        envelopeMiB: Math.round(this.envelopeBytes / (1024 * 1024)),
      });
    }
  }

  /** What the sectors may hold together: their own ceiling, or whatever the
   *  total envelope leaves over the globe maps, whichever is less. */
  budget(): number {
    return Math.max(0, Math.min(this.ceilingBytes, this.envelopeBytes - this.globalBytes));
  }

  /**
   * Open a frame in which several bodies are measured before any of them is
   * admitted or evicted. Between this and `endFrame`, `update` only measures;
   * the one reconcile then ranks every body's sectors against every other's
   * — Earth's fresh scores against the Moon's fresh scores, never against
   * last frame's. Without it each `update` reconciles on its own, which is
   * what a single-body caller wants.
   */
  beginFrame(): void {
    this.batching = true;
    this.batch.length = 0;
  }

  /** Close the frame `beginFrame` opened: reconcile every body measured in it. */
  endFrame(): void {
    if (!this.batching) return;
    this.batching = false;
    const measured = this.batch.splice(0);
    this.reconcile(measured, this.lastNowMs);
  }

  /**
   * One frame for one body. `camLocal` is the camera position in the globe
   * mesh's LOCAL frame (radius = handle.radiusAU there, whatever the mesh's
   * render scale); `measure` projects a bounding sphere given in that frame
   * and returns null when it cannot matter (off screen, or under the release
   * size by a conservative estimate). Bodies not called this frame keep
   * whatever they hold — call every registered body every frame.
   */
  update(
    name: string,
    camLocal: THREE.Vector3,
    measure: (bsCentreLocal: THREE.Vector3, bsRadiusLocal: number, surfaceDirLocal: THREE.Vector3) => SectorMeasure | null,
    nowMs: number,
    suspend: SectorSuspend = 'none',
    /** Direction to the Sun in the same local frame; omitted = no night gate. */
    sunLocal: THREE.Vector3 | null = null,
    /** pxPerLocalUnit at the globe's nearest surface point — an upper bound
     *  for every sector, so a globe whose closest texel is still under the
     *  release size releases everything without measuring a sector. */
    pxPerLocalUnitNearest = Number.POSITIVE_INFINITY,
  ): void {
    const body = this.bodies.get(name);
    if (!body) return;
    this.lastNowMs = nowMs;
    const { handle, slots } = body;

    // The texel each level's demand is read against: the globe's own map for
    // level 0, the level above's source below that.
    body.texelLens[0] = baseTexelLength(handle);
    body.maxTexelPx = 0;
    if (
      suspend === 'all'
      || !realAlbedoOn(handle.material)
      || !cropsReady(handle.material, handle.spec)
      // Level 0 reads the coarsest texel of the pyramid, so its bound bounds
      // every level below it too.
      || pxPerLocalUnitNearest * body.texelLens[0] < this.releaseTexelPx
    ) {
      for (const slot of slots) this.release(slot);
      body.admitting = false;
      return;
    }

    const signature = cropSignature(handle.material, handle.spec);
    this.camScratch.copy(camLocal);
    this.camDirScratch.copy(camLocal).normalize();
    for (const slot of slots) {
      let texelPx = 0;
      let score = 0;
      let fetchable = false;
      const grid = body.levels[slot.level].grid;
      // Slots below level 0 are visited only under a parent that is wanted or
      // kept this frame — a parent's own map is 4x coarser, so where it has
      // nothing to add its children have less, and the pass skips the whole
      // sub-tree rather than projecting it. Slots are in level order, so the
      // parent's verdict is already this frame's. That gate is what keeps the
      // pass cheap enough to run every frame: at a close pose, three bodies
      // cost 12 projections a frame at one level and 30 with a second — not
      // the four times the slot count — and the whole selection and
      // reconcile is tens of microseconds.
      const gated = slot.parent !== undefined && !slot.parent.wanted && !slot.parent.keep;
      if (!gated && sectorMayFaceCamera(slot.centreDir, slot.angularRadius, this.camScratch, handle.radiusAU)) {
        // Measured where the sector is most magnified — its point nearest the
        // sub-camera point — not at its centre, which a camera over a
        // neighbouring sector sees foreshortened.
        sectorNearestDirection(grid, slot.sector, this.camDirScratch, this.pointScratch);
        const m = measure(slot.bsCentre, slot.bsRadius, this.pointScratch);
        if (m) {
          texelPx = m.pxPerLocalUnit * body.texelLens[slot.level];
          // The diagnostic stays level 0's, in the one unit every probe reads.
          if (slot.level === 0 && texelPx > body.maxTexelPx) body.maxTexelPx = texelPx;
          const night = sunLocal !== null
            && sectorNearestDirection(grid, slot.sector, sunLocal, this.sunPointScratch).dot(sunLocal) < SECTOR_NIGHT_DOT;
          fetchable = !m.offscreen && !night;
          // Screen-space error over the threshold: 1 is exactly at the want
          // size, 4 is four times past it. Every level reads the map it
          // would itself replace, so one number ranks them all — and two
          // sectors over the same ground come out coarse first, by the
          // level step between their maps.
          if (fetchable) {
            score = (texelPx / this.wantTexelPx) * (0.5 + 0.5 * Math.max(0, Math.min(1, m.centrality)));
          }
        }
      }
      slot.score = score;
      slot.wanted = fetchable && texelPx > this.wantTexelPx;
      slot.keep = texelPx > this.releaseTexelPx;
      if (slot.loading && nowMs - slot.loading.startedAtMs > SECTOR_ATTEMPT_TIMEOUT_MS) this.failLoad(slot);
      if (slot.state !== 'idle' && !slot.keep) this.release(slot);
      // A load for a set the base no longer has is abandoned: a fresh
      // admission starts over (nothing of it was showing), a resident's
      // reload is dropped and the resident stays as it is.
      else if (slot.loading && slot.loading.signature !== signature) {
        if (slot.state === 'loading') this.release(slot);
        else this.abandonLoad(slot);
      }
    }

    // Mirror the globe's scalar state onto every live sector (eclipse tint,
    // relief scale) — cheap, and what keeps a sector from reading as a patch.
    for (const slot of slots) {
      if (slot.state === 'resident' && slot.mesh) {
        syncSectorMaterial(slot.mesh.material as THREE.MeshStandardMaterial, handle.material);
      }
    }

    body.signature = signature;
    body.admitting = suspend === 'none';
    if (this.batching) this.batch.push(body);
    else this.reconcile([body], nowMs);
  }

  /**
   * Start and stop loads for the bodies measured this frame. Split from the
   * measurement so that every body's scores are this frame's before any of
   * them competes for the working set.
   */
  private reconcile(bodies: SectorBody[], nowMs: number): void {
    // Residents drawn under another crop signature reload in place, ahead of
    // new admissions: the base gained (or lost) a relief map, and a sector
    // that shades differently from the globe around it is the worse defect.
    // Releasing them instead would blink each one sharp -> soft -> sharp.
    // Only where a fetch is allowed at all (on the frame, on the day side —
    // score > 0): a resident past the limb keeps its old set until a pan
    // brings it back, as an admission there would wait too.
    // A budget that shrank under the working set (a globe map arrived, the
    // envelope closed) gives sectors back until it holds again — the one
    // path where a sector goes without the view changing. It runs FIRST, on
    // the slots as they are: a sector released after it had been collected
    // to reload would be handed to a reload that budgeted for the couple of
    // crops it was missing and then fetched a whole fresh set.
    this.trimToBudget();

    const stale: Array<{ body: SectorBody; slot: SectorSlot }> = [];
    const candidates: Array<{ body: SectorBody; slot: SectorSlot }> = [];
    for (const body of bodies) {
      if (!body.admitting) continue;
      for (const slot of body.slots) {
        if (slot.state === 'resident' && !slot.loading && slot.score > 0
          && slot.signature !== body.signature && nowMs >= slot.retryAtMs) {
          stale.push({ body, slot });
        } else if (slot.wanted && slot.state === 'idle' && nowMs >= slot.retryAtMs && !covered(slot)) {
          candidates.push({ body, slot });
        }
      }
    }
    stale.sort((a, b) => b.slot.score - a.slot.score);
    for (const s of stale) {
      if (this.inflightCount() >= this.inflightCap) break;
      // Only a resident with nothing in the air still has a set to reload:
      // anything else lost the maps the reservation below is sized against.
      if (s.slot.state !== 'resident' || s.slot.loading) continue;
      // The maps a reload fetches are bytes the resident does not hold yet.
      if (!this.roomFor(this.reloadBytes(s.body, s.slot))) continue;
      if (!this.poolRoomFor(this.loadFetchCount(s.body, s.slot))) continue;
      this.startLoad(s.body, s.slot, s.body.signature);
    }

    // Strongest first, and the coarser level first among equals: a parent
    // covers its children's ground at a quarter of the bytes, so it is the
    // better first admission wherever both are asked for.
    candidates.sort((a, b) => b.slot.score - a.slot.score || a.slot.level - b.slot.level);
    for (const candidate of candidates) {
      if (this.inflightCount() >= this.inflightCap) break;
      // The pool is checked before the room is made: an admission must never
      // evict a resident for a load that then cannot start.
      if (!this.poolRoomFor(this.loadFetchCount(candidate.body, candidate.slot))) continue;
      // A candidate that cannot be paid for is passed over, not the end of
      // the pass: sets differ in size between levels and between bodies, so
      // a cheaper or smaller one behind it may still fit in the room there
      // is. `makeRoom` releases nothing unless the whole victim set is
      // proven, so a refusal here has cost nothing.
      if (!this.makeRoom(candidate.slot, this.slotSetBytes(candidate.body, candidate.slot), nowMs)) continue;
      this.admit(candidate.body, candidate.slot, candidate.body.signature);
    }
  }

  /** Room for `need` more bytes, freeing the weakest sectors for it if the
   *  candidate has earned them. Multi-victim: a 22 MiB tile may need more
   *  than one, and the candidate is measured against the STRONGEST of the
   *  ones it would take, not the weakest — taking a sector that ranks near
   *  it is what a margin exists to prevent. */
  private makeRoom(candidate: SectorSlot, need: number, nowMs: number): boolean {
    const budget = this.budget();
    let free = budget - this.heldBytes();
    let live = this.liveCount();
    if (free >= need && live < this.residentCap) return true;
    const victims = this.evictable(nowMs).sort((a, b) => a.score - b.score || b.level - a.level);
    const taking: SectorSlot[] = [];
    let strongest = 0;
    for (const victim of victims) {
      if (free >= need && live < this.residentCap) break;
      taking.push(victim);
      free += victim.bytes + victim.reserved;
      live -= 1;
      strongest = Math.max(strongest, victim.score);
    }
    if (free < need || live >= this.residentCap) return false;
    if (taking.length > 0 && strongest * SECTOR_ADMIT_MARGIN >= candidate.score) return false;
    for (const victim of taking) this.release(victim);
    return true;
  }

  /** Give up the weakest sectors until what is held fits the budget again.
   *  The frontier is recomputed after every release, which is what makes the
   *  bound hold within this one call for a pyramid: a parent is protected
   *  while a finer sector draws over it, so the first pass sees only leaves,
   *  and each child released turns its parent into one. Nothing is safe from
   *  this pass — the memory is already spent, and a dwell that held it would
   *  only spend more — so it converges: the deepest live sector is always
   *  evictable, and every release makes a slot idle for good. */
  private trimToBudget(): void {
    while (this.heldBytes() > this.budget()) {
      const victims = this.evictable(Number.POSITIVE_INFINITY);
      if (victims.length === 0) return;
      let weakest = victims[0];
      for (const v of victims) {
        if (v.score < weakest.score || (v.score === weakest.score && v.level > weakest.level)) weakest = v;
      }
      this.release(weakest);
    }
  }

  /** Live sectors that may be given up now: nothing finer is drawing over
   *  them, and a resident has been drawing long enough to have earned its
   *  upload. A fresh admission still fetching has paid for nothing yet, so it
   *  stays replaceable — taking it aborts a transfer instead of throwing a
   *  finished upload away. */
  private evictable(nowMs: number): SectorSlot[] {
    const out: SectorSlot[] = [];
    for (const body of this.bodies.values()) {
      for (const s of body.slots) {
        if (s.state === 'idle' || hasLiveChild(s)) continue;
        if (s.state === 'resident' && nowMs - s.liveSinceMs < SECTOR_EVICT_DWELL_MS) continue;
        out.push(s);
      }
    }
    return out;
  }

  /** Room for `need` more bytes without taking anything from anyone. */
  private roomFor(need: number): boolean {
    return this.heldBytes() + need <= this.budget();
  }

  /** Bytes held: what the resident sets draw plus what the loads in flight
   *  have reserved. The figure the budget bounds. */
  private heldBytes(): number {
    let bytes = 0;
    for (const body of this.bodies.values()) for (const s of body.slots) bytes += s.bytes + s.reserved;
    return bytes;
  }

  /** Bytes a fresh admission of this slot would hold. */
  private slotSetBytes(body: SectorBody, slot: SectorSlot): number {
    return sectorSetGpuBytes(body.handle.spec, slot.level, (s) => realMapIn(body.handle.material, s));
  }

  /** Bytes a resident's in-place reload would ADD: the maps of the new set it
   *  does not already draw. */
  private reloadBytes(body: SectorBody, slot: SectorSlot): number {
    let bytes = 0;
    for (const name of CROP_SLOTS) {
      if (!body.handle.spec.crops[name] || !realMapIn(body.handle.material, name) || slot.maps[name]) continue;
      bytes += this.mapBytes(body, slot, name);
    }
    return bytes;
  }

  /** Bytes one of a slot's maps holds, from the layout its image is cut on. */
  private mapBytes(body: SectorBody, slot: SectorSlot, name: MapName): number {
    if (name === 'map') return layoutGpuBytes(body.levels[slot.level].layout);
    const crop = body.handle.spec.crops[name];
    return crop ? layoutGpuBytes(dataCropLayout(body.levels[0].grid, crop.baseWidth, crop.spanU ?? 1)) : 0;
  }

  /** Map fetches a load for this slot would put on the wire: its colour tile
   *  and every crop of the current set it does not already hold (a reload
   *  keeps what it draws, so it is usually one). */
  private loadFetchCount(body: SectorBody, slot: SectorSlot): number {
    let n = slot.maps.map ? 0 : 1;
    for (const name of CROP_SLOTS) {
      if (!body.handle.spec.crops[name] || !realMapIn(body.handle.material, name) || slot.maps[name]) continue;
      n += 1;
    }
    return n;
  }

  /** Room in the fetch pool for every request a load would make. Taken by
   *  the whole set, not one token per slot: a sector shows nothing until all
   *  of its maps are resident, so a set half on the wire would hold its
   *  reservation and the pool behind a sector that could have finished. */
  private poolRoomFor(fetches: number): boolean {
    return this.fetchCount() + fetches <= this.fetchPool;
  }

  /** Drop everything (an arrival, context loss, mode teardown); bodies stay
   *  registered and stream back in on later frames — from the service-worker
   *  cache when they were resident before. */
  dropAll(): void {
    for (const body of this.bodies.values()) for (const slot of body.slots) this.release(slot);
    // Whatever frame was open is over: a batch left behind by a caller that
    // never reached its endFrame must not hold every later frame in
    // measure-only mode.
    this.batching = false;
    this.batch.length = 0;
  }

  dispose(): void {
    this.dropAll();
    this.bodies.clear();
  }

  stats(): SectorStats {
    const out: SectorStats = {
      resident: 0,
      loading: 0,
      inflight: 0,
      gpuBytes: 0,
      residentBytes: 0,
      reserved: 0,
      budget: this.budget(),
      envelope: this.envelopeBytes,
      globalBytes: this.globalBytes,
      bodies: {},
    };
    for (const [name, body] of this.bodies) {
      const resident: string[] = [];
      const loading: string[] = [];
      const reloading: string[] = [];
      const byLevel = body.levels.map(() => ({ resident: 0, loading: 0, gpuBytes: 0 }));
      let gpuBytes = 0;
      for (const s of body.slots) {
        const id = slotId(s);
        const level = byLevel[s.level];
        if (s.state === 'resident') {
          resident.push(id);
          level.resident += 1;
          if (s.loading) reloading.push(id);
        } else if (s.state === 'loading') {
          loading.push(id);
          level.loading += 1;
        }
        let slotBytes = 0;
        for (const tex of Object.values(s.maps)) slotBytes += textureGpuBytes(tex);
        for (const tex of s.loading?.owned ?? []) slotBytes += textureGpuBytes(tex);
        level.gpuBytes += slotBytes;
        gpuBytes += slotBytes;
        out.residentBytes += s.bytes;
        out.reserved += s.reserved;
      }
      out.resident += resident.length;
      out.loading += loading.length;
      out.inflight += loading.length + reloading.length;
      out.gpuBytes += gpuBytes;
      out.bodies[name] = { resident, loading, reloading, maxTexelPx: body.maxTexelPx, gpuBytes, byLevel };
    }
    return out;
  }

  private liveCount(): number {
    let n = 0;
    for (const body of this.bodies.values()) for (const s of body.slots) if (s.state !== 'idle') n++;
    return n;
  }

  /** Loads in flight: fresh admissions and in-place reloads alike. */
  private inflightCount(): number {
    let n = 0;
    for (const body of this.bodies.values()) for (const s of body.slots) if (s.loading) n++;
    return n;
  }

  /** Individual map fetches in flight — a sector is up to three of them. */
  private fetchCount(): number {
    let n = 0;
    for (const body of this.bodies.values()) for (const s of body.slots) n += s.loading?.pending ?? 0;
    return n;
  }

  private admit(body: SectorBody, slot: SectorSlot, signature: string): void {
    slot.state = 'loading';
    // The globe goes onto its fine grid now, not when the tile lands: the
    // fetch in between keeps the sphere rebuild off the frame that pays the
    // 16 MiB upload (idempotent; a no-op once the body is fine).
    body.handle.ensureFineGeometry();
    this.startLoad(body, slot, signature);
  }

  /** Fetch the set the base's current signature calls for into `slot` — a
   *  fresh admission (state 'loading') or a resident's in-place reload. Every
   *  callback checks the generation stamped here, so a release, a failure or
   *  an abandonment in between makes a late arrival dispose itself. */
  private startLoad(body: SectorBody, slot: SectorSlot, signature: string): void {
    // Only a slot that is committed to holding the set may fetch it. An idle
    // slot would reserve against maps it no longer has, hold the bytes in a
    // state no eviction can reclaim, and never reach the mesh: `admit` moves
    // the slot to 'loading' first, and a reload runs on a resident.
    if (slot.state === 'idle') throw new Error(`sector load started on an idle slot ${slotId(slot)}`);
    // Never two loads for one slot: the earlier one's fetches end here rather
    // than running on for a set nothing will take, and its reservation goes
    // back before this one is sized.
    if (slot.loading) this.abandonLoad(slot);
    const { handle } = body;
    const gen = ++this.generation;
    slot.gen = gen;
    const stillWanted = () => slot.gen === gen;

    // Every map carries the (grid, sector, layout) triple its own image was
    // cut on. The colour tile is this slot's level; the crops are level 0's,
    // sampled at the slot's level-0 ANCESTOR through that ancestor's own
    // transform — mesh uvs are global, so the transform depends on the image,
    // not on which mesh reads it, and a finer sector needs no crop of its own.
    const level = body.levels[slot.level];
    const base = body.levels[0];
    const baseSector = ancestorSector(slot.sector, slot.level);
    const maps: Array<{ name: MapName; url: string; kind: 'color' | 'data'; grid: SectorGrid; sector: Sector; layout: TileLayout }> = [
      {
        name: 'map',
        url: resolveTileUrl(handle.spec.colorKey, level.tier, slot.sector.c, slot.sector.r),
        kind: 'color',
        grid: level.grid,
        sector: slot.sector,
        layout: level.layout,
      },
    ];
    for (const cropSlot of CROP_SLOTS) {
      const crop = handle.spec.crops[cropSlot];
      if (!crop || !realMapIn(handle.material, cropSlot)) continue;
      maps.push({
        name: cropSlot,
        url: resolveTileUrl(crop.key, crop.tier, baseSector.c, baseSector.r),
        kind: 'data',
        grid: base.grid,
        sector: baseSector,
        layout: dataCropLayout(base.grid, crop.baseWidth, crop.spanU ?? 1),
      });
    }
    const loading: SectorLoad = {
      signature, startedAtMs: this.lastNowMs, abort: new AbortController(), pending: 0, loaded: {}, owned: [],
    };
    slot.loading = loading;
    // A reload keeps every map the resident already draws that the new set
    // still names; only the rest is fetched.
    const toFetch = maps.filter((m) => {
      const have = slot.maps[m.name];
      if (have) loading.loaded[m.name] = have;
      return !have;
    });
    // The bytes this load is about to hold are committed to it now, from the
    // layouts, and released when it lands, fails or is abandoned — counting
    // them after the decode would let two loads overshoot the budget by a
    // tile each in the seconds between.
    slot.reserved = 0;
    for (const m of toFetch) slot.reserved += this.mapBytes(body, slot, m.name);
    loading.pending = toFetch.length;
    if (loading.pending === 0) {
      // The base lost a map: the sector simply drops its crop of it.
      this.materialize(body, slot);
      return;
    }

    const fail = () => {
      if (stillWanted()) this.failLoad(slot);
    };

    for (const m of toFetch) {
      this.load(
        m.url,
        (tex) => {
          if (!stillWanted()) {
            tex.dispose();
            return;
          }
          applyTextureDefaults(tex, m.kind);
          applySectorTileTransform(tex, m.grid, m.sector, m.layout);
          tex.userData.gpuBytes = textureGpuBytes(tex);
          loading.owned.push(tex); // owned from here: a release disposes it even mid-queue
          this.warm(tex, (outcome) => {
            if (!stillWanted()) {
              tex.dispose();
              return;
            }
            if (outcome !== 'warmed') {
              // 'disposed' only reaches a still-wanted attempt if something
              // else disposed the texture; either way the attempt is over.
              fail();
              return;
            }
            releaseBitmap(tex);
            loading.loaded[m.name] = tex;
            loading.pending -= 1;
            if (loading.pending === 0) this.materialize(body, slot);
          });
        },
        () => fail(),
        stillWanted,
        loading.abort.signal,
      );
    }
  }

  /** The load in flight is over — an error, a warm that could not complete,
   *  the attempt timeout. A fresh admission goes back to idle; a resident
   *  whose reload failed keeps drawing its old set. Either retries after a
   *  cooldown that doubles per consecutive failure. */
  private failLoad(slot: SectorSlot): void {
    // The attempt is over BEFORE its textures are disposed: the warm pump's
    // dispose hook reports 'disposed' synchronously from inside
    // tex.dispose(), and that report must find nothing left to fail.
    if (slot.state === 'loading') slot.state = 'idle';
    slot.gen = ++this.generation;
    this.disposeLoaded(slot);
    slot.loading = undefined;
    slot.reserved = 0;
    slot.failStreak += 1;
    slot.retryAtMs =
      this.lastNowMs + SECTOR_RETRY_MS * 2 ** Math.min(slot.failStreak - 1, SECTOR_RETRY_MAX_DOUBLINGS);
  }

  /** Put the landed set on the globe. For a reload this is the swap: the new
   *  mesh goes in and the old comes out in the same call, so no frame shows
   *  the soft base between them, and only the old maps the new set does not
   *  reuse are disposed. */
  private materialize(body: SectorBody, slot: SectorSlot): void {
    const { handle } = body;
    const loading = slot.loading;
    const map = loading?.loaded.map;
    if (!loading || !map) return;
    const loaded = loading.loaded;
    // A reload's geometry is the outgoing mesh's: same sector, same globe.
    const previousMesh = slot.mesh;
    const geometry = previousMesh?.geometry ?? sectorSphereGeometry(
      handle.radiusAU, body.levels[slot.level].grid, slot.sector,
      Math.max(3, SECTOR_SEGMENTS >> slot.level),
    );
    const material = createSectorMaterial(handle.material, {
      map,
      bumpMap: loaded.bumpMap ?? null,
      normalMap: loaded.normalMap ?? null,
      roughnessMap: loaded.roughnessMap ?? null,
    }, slot.level);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${handle.name} sector ${slotId(slot)}`;
    mesh.renderOrder = sectorRenderOrder(slot.level);
    handle.mesh.add(mesh);
    const previousMaps = slot.maps;
    slot.mesh = mesh;
    slot.maps = { ...loaded };
    slot.signature = loading.signature;
    slot.loading = undefined;
    // The reservation becomes what the sector actually holds.
    slot.reserved = 0;
    slot.bytes = 0;
    for (const name of Object.keys(slot.maps) as MapName[]) slot.bytes += this.mapBytes(body, slot, name);
    // The dwell runs from the upload, and a reload does not restart it: the
    // sector has been on the globe since it first landed.
    if (!previousMesh) slot.liveSinceMs = this.lastNowMs;
    slot.state = 'resident';
    slot.failStreak = 0;
    if (previousMesh) this.removeMesh(previousMesh, true);
    const kept = new Set(Object.values(slot.maps));
    for (const tex of Object.values(previousMaps)) if (!kept.has(tex)) tex.dispose();
  }

  private removeMesh(mesh: THREE.Mesh, geometryReused = false): void {
    mesh.removeFromParent();
    if (!geometryReused) mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }

  /** Drop a resident's in-flight reload; the resident keeps drawing. */
  private abandonLoad(slot: SectorSlot): void {
    slot.gen = ++this.generation;
    this.disposeLoaded(slot);
    slot.loading = undefined;
    slot.reserved = 0;
  }

  /** End a load's fetches and dispose what it decoded so far. */
  private disposeLoaded(slot: SectorSlot): void {
    const loading = slot.loading;
    if (!loading) return;
    loading.abort.abort();
    // Detach first: a dispose hook may re-enter this slot mid-loop.
    const owned = loading.owned;
    loading.owned = [];
    loading.loaded = {};
    for (const tex of owned) tex.dispose();
  }

  /** Back to idle from any state: the mesh leaves the globe, and every
   *  texture the sector owned is disposed (a queued one leaves the warm pump
   *  through its dispose hook). A load in flight is superseded by generation;
   *  its late callbacks dispose what they carry. */
  private release(slot: SectorSlot): void {
    if (slot.state === 'idle') return;
    slot.gen = ++this.generation;
    this.disposeLoaded(slot);
    slot.loading = undefined;
    if (slot.mesh) {
      this.removeMesh(slot.mesh);
      slot.mesh = undefined;
    }
    for (const tex of Object.values(slot.maps)) tex.dispose();
    slot.maps = {};
    slot.bytes = 0;
    slot.reserved = 0;
    slot.state = 'idle';
  }
}
