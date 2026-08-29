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
 * it by a margin, and not until it has been on screen a moment: a plain LRU
 * would churn 21 MiB uploads every frame at the wall, where more sectors face
 * the camera than the budget holds. The size that matters is the texels of
 * the map below on screen (device pixels per texel at the sector's nearest
 * point): a tile is wanted once that map is visibly magnified and released
 * once it no longer is, with hysteresis between, so a disc breathing around
 * the threshold never flaps a 21 MiB upload. A sector that is magnified but
 * off the frame is never fetched, yet stays resident while it is magnified —
 * a pan brings it back for free. Light is the one thing residency does not
 * survive: a sector its family has stopped drawing anywhere holds a tile for
 * nothing, so it is released a margin past its own light edge (see the gate
 * below).
 *
 * A tile is drawn only once it is resident on the GPU: the fetch decodes off
 * the main thread (textureBitmapLoader), the warm pump uploads it on its
 * budgeted frame, and the sector mesh is created on the pump's 'warmed'
 * outcome — nothing on the render path ever pays a texture upload. After the
 * upload the decoded bitmap is closed (tiles are cheap to re-fetch from the
 * service-worker cache); on WebGL context loss every sector is dropped and
 * streams back in.
 *
 * Sector meshes are children of the mesh their family draws on, so they
 * inherit its spin, pole and the moon render-curve scale; their vertices
 * coincide with that mesh's fine (256-segment) grid, which the streamer
 * forces when a body's first sector is admitted — the fetch then separates
 * that rebuild from the frame that pays the tile's upload. Their materials
 * are built from that mesh's own, share its per-frame uniforms, and mirror
 * its scalar state every frame; they own every texture they draw.
 *
 * A body may register more than one FAMILY — one per lighting side. The day
 * family overlays the globe and shades like it; Earth's night family overlays
 * the night-lights shell and glows like it. They are separate handles, keyed
 * (name, side), competing for the one budget on one ranking; everything that
 * differs between them (which material a sector gets, what keeps it in step,
 * where its colour map's width is read, and which sun elevations it draws at)
 * is on the handle's SectorFamily, so nothing below asks which side it is
 * serving. What a family reports to the outside is merged back per BODY: one
 * Earth line in stats(), with the night family's slots namespaced inside it.
 *
 * The light gate is per family and is a two-sided mirror of one rule: a
 * sector is fetched only where the family draws something. Day measures the
 * sector's MOST LIT point (the point nearest the sub-solar one) and refuses it
 * once even that is past the terminator's twilight margin; night measures the
 * DARKEST point (the point nearest the anti-solar one) and refuses it until
 * that one is past the lit edge of the shell's own night mask — which is
 * exactly the condition for some pixel of the sector to draw at all. Both
 * families want the sectors in the terminator band, and that is right: the
 * shell blends them there. What separates them there is the SCORE, which each
 * family scales by the fraction of the sector it actually contributes: the
 * mean of its own weight at six points of the sector (its four corners, its
 * centre, and the extreme point its gate is measured at). Day's weight ramps
 * from the twilight margin to full sun, night's is the shell's own night mask
 * — so at the terminator a pair of tiles for the same ground is ranked by how
 * much of that ground each one lights, instead of both being paid for in full.
 * The gate reads once more for a RESIDENT, a margin later
 * (SECTOR_KEEP_LIGHT_MARGIN): a sector whose ground has turned past its own
 * family's edge draws nothing anywhere and is released, whichever side it is.
 *
 * A known trade-off at the terminator, measured over the US east coast at
 * 1.5 R: the night family takes four sectors of the desktop budget and the
 * day family makes four fewer admissions for it, two of them level-0 blocks
 * of the lit crescent that fall back to the globe's 4K map so the dark limb
 * can be sharp. Nothing is mis-ranked — each night sector out-scores what it
 * displaced, and where both families want the same ground the lit one wins —
 * the budget is simply binding. Keeping the crescent sharp as well needs the
 * globe's tier ladder and the tiles to draw on one ledger, which they do not
 * yet.
 *
 * A set is a PYRAMID of levels (SectorSetSpec.levels), and nothing here is
 * written for a particular one: a slot carries its level, the level carries
 * its own published tile set, grid and tile layout, and every URL, source
 * width and UV transform comes from that. Level 0 sits on the globe, level k
 * on level k−1 with its grid doubled; the parent of a slot is the arithmetic
 * (⌊c/2⌋, ⌊r/2⌋), and its segments halve as the grid doubles so every level
 * lands on the same vertex lattice. That halving is what bounds the depth: past
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
  finerGrid,
  sectorAngularRadius,
  sectorBoundingSphere,
  sectorCentreDirection,
  sectorMayFaceCamera,
  sectorNearestDirection,
  sectorSphereGeometry,
  sphereDirection,
  type Sector,
  type SectorGrid,
  type TileLayout,
} from './sectorGrid';
import { createSectorMaterial, sectorRenderOrder, syncSectorMaterial, type SectorMaps } from './sectorMaterial';
import { loadStreamedTexture, type TextureLoad } from './textureBitmapLoader';
import { applyTextureDefaults, resolveTileUrl, sectorSetHash, sectorSetLayout } from './texturePolicy';
import { TIER_RANK } from './textureLadder';
import { debugWarn } from '../../shared/debug';
import { queueTextureWarm, type WarmOutcome } from './textureWarmer';
import type { MemoryEnvelope, SectorStreamerLimits } from './gpuEnvelope';
import { layoutGpuBytes, textureGpuBytes } from './textureBytes';
import { smoothTraceEvent } from '../smoothnessTrace';

/** The material slots a sector may carry a crop of, in a fixed order. */
export const CROP_SLOTS = ['bumpMap', 'normalMap', 'roughnessMap'] as const;
export type CropSlot = (typeof CROP_SLOTS)[number];

/** One published tile set: what a tile URL is made of, plus the layout the
 *  tiles were cut at. Every field comes from the generated table, so a set
 *  cut at another width or span cannot be sampled with the old numbers. */
export interface SectorTileSet {
  /** Tile-set key under textures/tiles/: the FILE STEM of the map the set was
   *  cut from (`earth-roughness.v2` for earth-roughness.v2.webp), so a base
   *  that ships under a new name takes its tiles with it — see SECTOR_SETS. */
  key: string;
  /** Tier folder: a colour set's source resolution, a crop's the tier of the
   *  base map it was cut from. */
  tier: string;
  /** Hash of the whole set's bytes, from the generated table. */
  hash: string;
  /** Width of the equirect the set was cut from, as gen-tiles measured it: a
   *  crop's layout (content + gutter) follows from it, and a colour level's
   *  is the source width the level below reads its demand against. */
  baseWidth: number;
  /** Sectors of longitude one tile spans (normal maps: 2, see sectorGrid). */
  spanU: number;
}

/** One level of a body's tile pyramid: one published tile set, on one grid,
 *  in one pixel layout. Level 0 sits on the globe; level k sits on level
 *  k−1, its grid doubled and its sectors a quarter the size. A level is a
 *  set like any other — sets are keyed `<key>/<tier>`, so the levels of one
 *  key are separate rows of the generated table, each under its own hash. */
export interface SectorLevel {
  /** The colour tiles of this level, at the hash the table publishes. */
  set: SectorTileSet;
  grid: SectorGrid;
  /** Pixel layout of one of this level's colour tiles. */
  layout: TileLayout;
}

/** Width of the equirect a level's tiles were cut from: `cols` sectors of
 *  content, which is what cutting a map into a grid means. It is what the
 *  level BELOW measures magnification against — a level-1 tile has something
 *  to add exactly when a level-0 texel is already magnified. Read off the
 *  layout the tiles are actually sampled through rather than declared beside
 *  it, so the two cannot disagree; sectorTiles.assets.test.ts holds it
 *  against the width gen-tiles measured on the files. */
export function levelSourceWidth(level: SectorLevel): number {
  return (level.grid.cols * (level.layout.width - 2 * level.layout.gutterX)) / level.layout.spanU;
}

export interface SectorSetSpec {
  /** Crops for the relief / roughness slots the base material carries. A slot
   *  the base does not currently have is not loaded; if the base gains one
   *  later (Mars's relief arrives after boot) resident sectors reload. Crops
   *  belong to LEVEL 0: mesh uvs are global, so a finer sector samples its
   *  level-0 ancestor's crop through that ancestor's own transform — the same
   *  file, the same offset/repeat, no sub-rectangle. */
  crops: Partial<Record<CropSlot, SectorTileSet>>;
  /** The pyramid of colour tiles, coarsest first. Slots exist only for the
   *  levels declared here, so a body with one level costs exactly what it
   *  costs today. */
  levels: SectorLevel[];
}

/** A set as the app names it: key and tier, resolved against the table
 *  gen-tiles publishes for the hash its URLs carry and the layout its tiles
 *  were measured to have. */
export function tileSet(key: string, tier: string): SectorTileSet {
  return { key, tier, hash: sectorSetHash(key, tier), ...sectorSetLayout(key, tier) };
}

/** URL of one sector's tile in a set. */
function tileUrlOf(set: SectorTileSet, sector: Sector): string {
  return resolveTileUrl(set.key, set.tier, set.hash, sector.c, sector.r);
}

/** How a set is named everywhere it has to be talked about: the generated
 *  table's key, so a warning points straight at the row that is missing. */
function setName(set: SectorTileSet): string {
  return `${set.key}/${set.tier}`;
}

let tileFetchFailureNoticed = false;

/** Tiles fail open to the base map by design, which means a tile origin
 *  pointing at nothing, a set that was never published, or a host outage all
 *  look the same as a body that is simply far away — softer, with nothing in
 *  the console. Say it once per session, naming the set and the URL, through
 *  debugWarn so it reaches the `?debug=1` overlay on a device as well as the
 *  console on a desktop. Prod says it too: a wrong tile origin only exists in
 *  a build, so dev-only would print it exactly where it cannot happen. */
function noteTileFetchFailure(set: string, url: string, err: unknown): void {
  if (tileFetchFailureNoticed) return;
  tileFetchFailureNoticed = true;
  const reason = err instanceof Error ? err.message : String(err);
  debugWarn(`Sector tile set ${set} did not load, surfaces stay on the base map: ${url} (${reason})`);
}

/** Test seam: forget that the tile-failure notice was already printed. */
export function resetTileFetchNoticeForTests(): void {
  tileFetchFailureNoticed = false;
}

/** A key's 16K colour level, the level 0 of every shipped set: 8 × 4 sectors
 *  of 2048² tiles with an 8-px gutter, from a 16256-wide equirect (8 × 2032
 *  content). One per key, not one shared constant — each key's set is its own
 *  bytes and carries its own hash. */
export function sectorLevel16k(key: string): SectorLevel {
  return { set: tileSet(key, '16k'), grid: SECTOR_GRID_16K, layout: SECTOR_TILE };
}

/** A key's 32K colour level: the same 2048² tiles with the same 8-px gutter,
 *  on the doubled grid — 16 × 8 sectors of a 32512-wide equirect, a quarter of
 *  the ground per tile at twice the texels across it. The tier names the
 *  source width class, so a level is told from its siblings by tier alone. */
export function sectorLevel32k(key: string): SectorLevel {
  return { set: tileSet(key, '32k'), grid: finerGrid(SECTOR_GRID_16K), layout: SECTOR_TILE };
}

/** The bodies that ship a sector set, by catalog name. Colour tiles are the
 *  16K sets; every crop is the base map it names, sector-cut with the same
 *  gutter (tools/gen-tiles.mjs writes both).
 *
 *  Each set — every colour level and every crop — is named by the file stem
 *  of the map it was cut from or matched to, plus the hash of its own bytes
 *  that gen-tiles published it under (sectorTiles.assets.test pins both).
 *  The hash keeps a globe and its tiles coherent through any cache: a re-cut
 *  set lands in a folder nothing has ever asked for, so the only thing a
 *  cache can do with an old tile body is miss it. The stem carries the same
 *  guarantee one level up — a base map that changes ships under a new name
 *  (`.v2` -> `.v3`) and takes its tiles with it. */
export const SECTOR_SETS: Record<string, SectorSetSpec> = {
  Earth: {
    crops: {
      bumpMap: tileSet('earth-bump', '2k'),
      roughnessMap: tileSet('earth-roughness.v2', '4k'),
    },
    // Level 1 is the same NASA product at 500 m (the eight 21600² Blue Marble
    // tiles), so the child under a parent is a sharpen, not another world.
    levels: [sectorLevel16k('earth-day.v2'), sectorLevel32k('earth-day.v2')],
  },
  Mars: {
    crops: { normalMap: tileSet('mars-normal.v2', '2k') },
    levels: [sectorLevel16k('mars.v2')],
  },
  Moon: {
    crops: { normalMap: tileSet('moon-normal', '4k') },
    levels: [sectorLevel16k('moon')],
  },
};

/** The night-lights pyramids, by catalog name: a SECOND family for a body
 *  that draws its night side on a shell of its own, streamed onto that shell
 *  the way the sets above are streamed onto the globe. No crops — relief and
 *  gloss are daylight terms, and the night material has no slot for them — so
 *  a night sector costs its colour tile and nothing else. */
export const SECTOR_NIGHT_SETS: Record<string, SectorSetSpec> = {
  // NASA Black Marble 2016 at 500 m, the same eight-tile product the day
  // levels come from and the same two levels, so a night sector sharpens
  // exactly where a day one does. The shipped night map is 4K — 10 km per
  // pixel — which from the near band is a smear where a lit coastline should
  // be; these are 1.2 km and 600 m.
  Earth: {
    crops: {},
    levels: [sectorLevel16k('earth-night.v2'), sectorLevel32k('earth-night.v2')],
  },
};

/* The want and release thresholds (wantTexelPx / releaseTexelPx, handed in
 * with the rest of a device's numbers from world/gpuEnvelope) mean this:
 *
 *  A sector is wanted once one texel of the map BELOW it spans that many
 *  DEVICE pixels at the sector's nearest point — that map is then visibly
 *  magnified and a tile has detail to add — and released only once that
 *  falls under the second value, so a disc breathing around the threshold
 *  never flaps a 21 MiB upload. One rule per level: the map below a level-0
 *  sector is the globe's own, the map below a level-k sector is level k−1's
 *  source, so a finer level is asked for exactly where the level above it
 *  has run out of texels. Measured against the finest colour map the surface
 *  below can currently reach on its tier ladder (SectorBodyHandle.topMapWidth
 *  — a rung refused for want of memory, or given back under pressure, lowers
 *  it, never below the rung being drawn), or, for a family with no ladder
 *  behind it, against the width of the map that family is actually drawing
 *  (SectorFamily.drawnColorMapWidth): the Moon's 8K rung needs twice the
 *  magnification a 4K map does before a tile shows anything (a tile under
 *  that is 21 MiB of GPU memory for nothing visible), and measuring against
 *  the 2K boot map while the 8K is still in flight would admit sectors the
 *  8K's arrival then releases — a sharpen that un-sharpens. In device
 *  pixels, so a 3× phone wants tiles where a 1× monitor does not. */
/** Map width assumed while a globe's map has no readable image (never in
 *  practice: a real map is an ImageBitmap or a painted canvas). */
const SECTOR_FALLBACK_MAP_WIDTH = 4096;
/** A DAY sector whose most-lit point — the point of it nearest the sub-solar
 *  point — is still this far past the terminator (its dot with the sun
 *  direction, in the globe's frame) is never fetched: no part of it is lit,
 *  and the night fill draws nothing a tile could sharpen. Measured at the
 *  lit edge, not the centre: an equatorial sector reaches 31° from its
 *  centre, and a centre test that let 14° of lit terminator strip stay on
 *  the base map. The margin past zero is the few degrees of twilight the
 *  atmosphere renders beyond the terminator. The night family has an edge of
 *  its own, which is the shell's night mask (SectorFamily.lightEdge); the two
 *  are separate numbers that happen to be equal today. */
export const SECTOR_NIGHT_DOT = -0.1;

/** How far past its family's light edge a RESIDENT sector's extreme point
 *  travels before it is released. A sector its family has stopped drawing
 *  anywhere is a tile's worth of a shared budget for nothing on screen — a
 *  night sector whose ground has turned into the sunrise, a day sector that
 *  has turned past the terminator — and at the terminator that is exactly the
 *  size of the candidate the other family is being refused. Releasing at the
 *  edge itself would flap a 21 MiB upload as the edge crept back and forth
 *  across it, so the release runs this far past the gate. One margin serves
 *  both families: they measure opposite ends of the same rule. */
export const SECTOR_KEEP_LIGHT_MARGIN = 0.05;

/** Every PER-DEVICE number comes in through SectorStreamerOptions.limits —
 *  the byte ceiling the sectors may hold, the floor the globe maps may not
 *  take from them, the envelope they share with those maps, the resident /
 *  in-flight / fetch caps, and the two texel thresholds documented above.
 *  world/gpuEnvelope is the one place a device becomes those numbers; the
 *  streamer only spends them, and it spends one set of them across every
 *  family of every body it holds. */
/** How long a sector is safe from eviction once it is DRAWN. Without it a
 *  working set at the budget could hand the same slot back and forth between
 *  two candidates a hair apart, paying an upload each time. A load still in
 *  the air has paid nothing, so a far stronger candidate may take its
 *  reservation and its fetch is aborted rather than finished for a tile that
 *  would be evicted on its first frame — but from the first frame the tile
 *  is on screen it is protected. That first frame is what the clock runs
 *  from, not the upload: a tile can land while the surface is not being
 *  drawn at all (the system map owns the frame), and a dwell counted from
 *  there would already be spent by the time anyone saw the sector. */
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

/** Which lighting side a family's sectors draw on. */
export type SectorSide = 'day' | 'night';

/**
 * How one lighting side's sectors are built and kept in step with the surface
 * under them — the whole of what one family does differently from another.
 * The day family (below) overlays the globe with a standard material shaded
 * like it; Earth's night family overlays the night-lights shell with the
 * shell's own program.
 */
export interface SectorFamily {
  side: SectorSide;
  /** The sun cosine at which this family stops drawing: day fades out BELOW
   *  it, night fades in below it. The gate reads it at the sector's extreme
   *  point — the most lit one for day, the darkest for night. */
  lightEdge: number;
  /** Fraction of full strength this family draws at one sun cosine: 0 where
   *  it contributes nothing, 1 where it contributes everything. Averaged over
   *  a sector to scale its score, so a sector the family barely lights does
   *  not out-rank one it lights entirely. */
  weight(sunDot: number): number;
  /** The material one sector of this family draws with. */
  createMaterial(maps: SectorMaps, level: number): THREE.Material;
  /** Mirror whatever per-frame state the surface below carries onto one live
   *  sector material. Called once per frame per resident. */
  syncMaterial(mat: THREE.Material): void;
  /** Texels across the colour map the surface below is DRAWING right now, read
   *  from wherever that family keeps it (0 while it has no readable image).
   *  The reference a sector's demand is measured against ONLY where there is
   *  no ladder behind the family — with one, the ladder answers
   *  (SectorBodyHandle.topMapWidth) and the image is a stand-in. */
  drawnColorMapWidth(): number;
}

/** The default family: sectors on the globe, shading exactly like it, wanted
 *  wherever the globe is lit. Everything here is what the streamer did before
 *  a second family existed. */
export function daySectorFamily(base: THREE.MeshStandardMaterial): SectorFamily {
  return {
    side: 'day',
    lightEdge: SECTOR_NIGHT_DOT,
    // Ramped over the same twilight margin the gate allows, so the weight is
    // the sector's lit fraction with a soft terminator rather than a step.
    weight: (sunDot) => {
      const t = (sunDot - SECTOR_NIGHT_DOT) / (0 - SECTOR_NIGHT_DOT);
      const c = t < 0 ? 0 : t > 1 ? 1 : t;
      return c * c * (3 - 2 * c);
    },
    createMaterial: (maps, level) => createSectorMaterial(base, maps, level),
    syncMaterial: (mat) => syncSectorMaterial(mat as THREE.MeshStandardMaterial, base),
    drawnColorMapWidth: () => {
      const img = base.map?.image as { width?: unknown } | undefined;
      return img && typeof img.width === 'number' ? img.width : 0;
    },
  };
}

/** How a body's families are told apart everywhere one is named: the body's
 *  own name IS the day family, so every probe and call site that predates a
 *  second family still means what it meant. */
export function sectorFamilyKey(name: string, side: SectorSide): string {
  return side === 'day' ? name : `${name} ${side}`;
}

/** A body's sectors on ONE lighting side: the mesh they attach to (its
 *  transform is theirs), the material below them, the unscaled radius the
 *  sector geometry is built at — the shell's, not the globe's, for a family
 *  that draws on a shell — and how the family builds and keeps them. */
export interface SectorBodyHandle {
  name: string;
  spec: SectorSetSpec;
  mesh: THREE.Mesh;
  material: THREE.Material;
  /** Omitted is the day family over `material`, which must then be a
   *  MeshStandardMaterial. */
  family?: SectorFamily;
  radiusAU: number;
  /** Width of the finest colour map the surface THIS FAMILY draws on can
   *  currently reach on its own tier ladder (the globe's for a day family,
   *  the night shell's for Earth's night one), and never less than the
   *  nominal width of the rung it is drawing — what the map magnification is
   *  measured against. Read per frame, not stored: a rung refused for want of
   *  memory, released under pressure or failed to load moves the top down,
   *  and sectors measured against a map the surface will not hold arrive at
   *  twice the magnification they were meant to. Where this is given it is
   *  the ONLY reference: the drawn texture's image is a stand-in once the
   *  upload is paid and says nothing about the map. Omitted where there is no
   *  ladder: the boot map is then the finest, is never swapped, and the
   *  family's own drawnColorMapWidth is the truth. */
  topMapWidth?: () => number;
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
  /** Where the family's light weight is sampled to scale this sector's score:
   *  its four corners and its centre, in the body frame. Fixed for the life of
   *  the body, so a frame costs five dot products per measured sector. */
  sampleDirs: THREE.Vector3[];
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
  /** The frame this sector was first drawn on, and whether that frame has
   *  happened: a tile can materialise while the surface is not being drawn,
   *  so the dwell starts at the first `update` that measures the sector, not
   *  at the upload. An unpresented resident has not started its dwell and is
   *  never taken for a candidate. */
  liveSinceMs: number;
  presented: boolean;
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
  /** (name, side), the key this family is registered and updated under. */
  key: string;
  family: SectorFamily;
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
  /** This device's memory numbers (world/gpuEnvelope). */
  limits: SectorStreamerLimits;
  /** The envelope this streamer shares with the globe texture ladder — the
   *  same object the ladder's side spends, so neither allocator can read a
   *  budget the other has already committed. Required, with no default: a
   *  private envelope is arithmetically identical seen from inside the
   *  streamer, so a caller that forgot one would split the two ledgers with
   *  every figure here still looking sane. */
  envelope: MemoryEnvelope;
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
   *  decoded so far. MEASURED after the decode, so it lags the two figures
   *  below; ten colour tiles alone are ~213 MiB. */
  measuredGpuBytes: number;
  /** What the budget actually counts: the bytes the resident sets hold and
   *  the bytes the loads in flight have reserved, both BUDGETED from the tile
   *  layouts before a byte decodes. `budgetedBytes + reserved <= budget`
   *  holds whenever this is read: every path that admits, reloads or shrinks
   *  the budget leaves the working set inside it before it returns, a pyramid
   *  of levels included. */
  budgetedBytes: number;
  reserved: number;
  /** This device's sector budget right now — its ceiling, or what the total
   *  envelope leaves over the globe maps (globalBytes), whichever is less,
   *  and never below the floor. */
  budget: number;
  /** The bytes the globe maps may not take from the tiles (0 while no body
   *  is registered). */
  floor: number;
  envelope: number;
  globalBytes: number;
  /** By BODY, not by family: a body's day and night sectors are merged into
   *  one entry under its catalog name, so a reader that predates the second
   *  family still sees one Earth line with everything Earth holds in it. */
  bodies: Record<string, {
    resident: string[];
    loading: string[];
    /** Residents reloading in place (also listed under resident). */
    reloading: string[];
    /** Largest device-px-per-base-texel measured for the body this frame
     *  (0 while nothing faces the camera or the body is gated off). */
    maxTexelPx: number;
    measuredGpuBytes: number;
    /** The same counts split by pyramid level, coarsest first — per BODY like
     *  everything here, so a body with two families adds both into one level:
     *  only the ids in `resident` say which family a slot belongs to. */
    byLevel: Array<{ resident: number; loading: number; measuredGpuBytes: number }>;
    /** The same figures split by LIGHTING SIDE, which the merged view above
     *  cannot show. At the terminator a body's day and night families compete
     *  on one budget and one ranking, and the merged entry says only that the
     *  body holds ten sets — not that six of them are night. Only the sides a
     *  body actually has appear, so a one-family body still reads as one line.
     *  `budgetedBytes` is what the budget counts; `measuredGpuBytes` is read
     *  after the decode and lags it. */
    byFamily: Partial<Record<SectorSide, {
      resident: number;
      loading: number;
      measuredGpuBytes: number;
      budgetedBytes: number;
    }>>;
    /** Every slot the last selection WANTED, by id, with the screen-space
     *  error that ranked it — resident, loading and blocked alike. The lists
     *  above say what got in; this says what asked and how strongly, which is
     *  the only way to tell a level nothing demands from a level the budget
     *  is refusing. */
    scores: Record<string, number>;
  }>;
}

/** A slot's id in the stats: bare `c_r` at level 0 — the ids every probe
 *  script already reads — and namespaced `L1/c_r` below it, so no two levels
 *  of the same body can collide in one flat list. A body's non-day families
 *  are namespaced again (`night/c_r`, `night/L1/c_r`), because the stats merge
 *  them into one entry per body. */
function slotId(slot: SectorSlot, side: SectorSide = 'day'): string {
  const cell = `${slot.sector.c}_${slot.sector.r}`;
  const withLevel = slot.level === 0 ? cell : `L${slot.level}/${cell}`;
  return side === 'day' ? withLevel : `${side}/${withLevel}`;
}

/** Where a sector's share of the light is sampled: its four corners and its
 *  centre. Five points is what separates a sector the family lights entirely
 *  from one it lights along an edge, which is all the score needs; the gate's
 *  own extreme point is added to them per frame, so a sector that is fetchable
 *  can never average to a weight of zero. Two consequences worth knowing
 *  before reading a lightFraction: a top- or bottom-row sector has two of its
 *  four corners at the same pole (sphereDirection(u, 0) is the pole for every
 *  u), so a polar sector is sampled at three places and its pole twice; and
 *  the extreme point is by definition the most favourable one for its own
 *  family, so the mean can never fall below a sixth of it. */
function sectorLightSamples(grid: SectorGrid, s: Sector): THREE.Vector3[] {
  const u0 = s.c / grid.cols;
  const u1 = (s.c + 1) / grid.cols;
  const v0 = s.r / grid.rows;
  const v1 = (s.r + 1) / grid.rows;
  return [
    sphereDirection(u0, v0, new THREE.Vector3()),
    sphereDirection(u1, v0, new THREE.Vector3()),
    sphereDirection(u0, v1, new THREE.Vector3()),
    sphereDirection(u1, v1, new THREE.Vector3()),
    sectorCentreDirection(grid, s, new THREE.Vector3()),
  ];
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
    bytes += layoutGpuBytes(dataCropLayout(spec.levels[0].grid, crop.baseWidth, crop.spanU));
  }
  return bytes;
}

/** A real map in a material slot — not the procedural stand-in a failed
 *  boot fetch leaves there (a crop of the real map over a flat fallback would
 *  be a rectangle of relief on a smooth globe). */
function realMapIn(mat: THREE.Material, slot: CropSlot): boolean {
  // The crop slots are MeshStandardMaterial's; a family whose base has none
  // (the night shell is a ShaderMaterial) reads undefined here and declares
  // no crops, which is the same answer.
  const tex = (mat as Partial<THREE.MeshStandardMaterial>)[slot];
  return !!tex && tex.userData?.proceduralFallback !== true;
}

/** The globe draws a real photo map (boot tier or higher) — the only base a
 *  real tile may overlay. A body still on its procedural floor (a fallback
 *  after a failed fetch, a painted moon before its photo lands) would show a
 *  sector as a rectangle of a different world. */
function realAlbedoOn(mat: THREE.Material): boolean {
  const rank = mat.userData?.colorTierRank as number | undefined;
  return (rank ?? 0) >= TIER_RANK['2k'];
}

/** Which crop slots the base material carries right now — sectors loaded
 *  under a different signature reload so their maps stay the base's. */
function cropSignature(mat: THREE.Material, spec: SectorSetSpec): string {
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
function cropsReady(mat: THREE.Material, spec: SectorSetSpec): boolean {
  for (const slot of CROP_SLOTS) {
    if (!spec.crops[slot]) continue;
    const tex = (mat as Partial<THREE.MeshStandardMaterial>)[slot];
    if (tex && tex.userData?.proceduralFallback === true) return false;
  }
  return true;
}

/** Surface length of one texel of the colour map below this family, in the
 *  body's local units (equatorial).
 *
 *  A family with a tier ladder behind it answers for its own reference width,
 *  and that answer is the whole of it: the drawn texture's image is NOT the
 *  map it draws — an applied rung replaces its decoded source with a small
 *  stand-in once the upload is paid, so a surface holding 4096 texels reports
 *  a four-figure-smaller image and every tile over it would be admitted at
 *  that ratio of the magnification it was sized for. The image is read only
 *  where there is no ladder at all (SectorFamily.drawnColorMapWidth, which
 *  knows where its own map lives — the globe's `map` for the day family, the
 *  night shell's uniform for Earth's night one), whose boot map is its finest
 *  and is never swapped under it. */
function baseTexelLength(body: SectorBody): number {
  // One source or the other, never a fall-through between them: a ladder that
  // answered 0 would otherwise be silently re-measured against the drawn
  // stand-in, which is the very reading the ladder's answer exists to replace.
  const width = Math.max(0, body.handle.topMapWidth?.() ?? body.family.drawnColorMapWidth());
  return (2 * Math.PI * body.handle.radiusAU) / (width || SECTOR_FALLBACK_MAP_WIDTH);
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
  private readonly sectorFloorBytes: number;
  private readonly wantTexelPx: number;
  private readonly releaseTexelPx: number;
  /** The one envelope the tiles and the globe maps spend between them. */
  private readonly envelope: MemoryEnvelope;
  private warnedNoBudget = false;
  private generation = 0;
  private lastNowMs = 0;
  private batching = false;
  private readonly batch: SectorBody[] = [];
  private readonly camScratch = new THREE.Vector3();
  private readonly camDirScratch = new THREE.Vector3();
  private readonly pointScratch = new THREE.Vector3();
  private readonly sunPointScratch = new THREE.Vector3();
  private readonly antiSunScratch = new THREE.Vector3();

  constructor(opts: SectorStreamerOptions) {
    this.load = opts.load ?? loadStreamedTexture;
    this.warm = opts.warm ?? queueTextureWarm;
    this.residentCap = opts.limits.residentCap;
    this.inflightCap = opts.limits.inflightCap;
    this.fetchPool = opts.limits.fetchPool;
    this.sectorFloorBytes = opts.limits.sectorFloorBytes;
    this.wantTexelPx = opts.limits.wantTexelPx;
    this.releaseTexelPx = opts.limits.releaseTexelPx;
    // The envelope and the limits are one device row. The streamer takes its
    // floor and its caps from `limits` while every budget it computes reads
    // the envelope's own two figures, so a mismatched pair would spend two
    // rows at once and no byte figure anywhere would show it.
    if (opts.envelope.envelopeBytes !== opts.limits.envelopeBytes
      || opts.envelope.ceilingBytes !== opts.limits.ceilingBytes) {
      throw new Error(
        'sector streamer: envelope and limits are different device rows'
        + ` (envelope ${opts.envelope.envelopeBytes}/${opts.envelope.ceilingBytes},`
        + ` limits ${opts.limits.envelopeBytes}/${opts.limits.ceilingBytes})`,
      );
    }
    this.envelope = opts.envelope;
  }

  /** Register one family of one body. A body's families are keyed (name,
   *  side), so registering its night lights leaves its day sectors standing;
   *  re-registering the SAME family replaces it, which is what a rebuilt
   *  scene graph needs. */
  register(handle: SectorBodyHandle): void {
    const levels = handle.spec.levels;
    const family = handle.family ?? daySectorFamily(handle.material as THREE.MeshStandardMaterial);
    const key = sectorFamilyKey(handle.name, family.side);
    if (levels.length === 0) throw new Error(`${key} declares no sector levels`);
    if (levels.length - 1 > SECTOR_MAX_LEVEL) {
      throw new Error(`${key} declares ${levels.length} sector levels; ${SECTOR_MAX_LEVEL + 1} is the most a set may carry`);
    }
    this.unregister(key);
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
            sampleDirs: sectorLightSamples(grid, sector),
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
            presented: false,
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
      i === 0 ? 0 : (2 * Math.PI * handle.radiusAU) / levelSourceWidth(levels[i - 1])
    ));
    this.bodies.set(key, {
      handle, key, family, slots, levels, texelLens, signature: '', admitting: false, maxTexelPx: 0,
    });
    this.syncFloor();
  }

  /** Drop one family, by the key it was registered under (a body's own name
   *  for its day sectors — see sectorFamilyKey). */
  unregister(key: string): void {
    const body = this.bodies.get(key);
    if (!body) return;
    for (const slot of body.slots) this.release(slot);
    this.bodies.delete(key);
    this.syncFloor();
    // A body measured earlier in an open frame must leave the batch with it:
    // reconciling it would admit sectors whose bytes nothing counts any more.
    const queued = this.batch.indexOf(body);
    if (queued >= 0) this.batch.splice(queued, 1);
  }

  has(key: string): boolean {
    return this.bodies.has(key);
  }

  /** The GPU bytes the globe maps hold right now (the tier ladder's applied
   *  colour maps, which only the mode can see). The sector budget is what
   *  the envelope leaves over them, down to the floor. */
  setGlobalMapBytes(bytes: number): void {
    const before = this.envelope.ladderBytes;
    this.envelope.setLadderBytes(bytes);
    // The budget is a public number and shrinking it is what makes the
    // working set too big: the sectors go back in the same call, so no
    // caller can ever read a stats() where what is held is over what is
    // allowed. Growing it takes nothing from anyone.
    if (this.envelope.ladderBytes > before) this.trimToBudget();
    // Streaming that has quietly switched itself off looks like a soft
    // surface, not like a fault. Say it once, with the figures that explain
    // it. A budget under one whole set is the same silence as a budget of
    // zero: nothing can be admitted with it, and a fraction of a set is not
    // a smaller tile.
    const smallest = this.smallestSetBytes();
    if (smallest > 0 && this.budget() < smallest && !this.warnedNoBudget) {
      this.warnedNoBudget = true;
      debugWarn('Surface tiles off: the budget is below one sector set', {
        globeMapsMiB: Math.round(this.envelope.ladderBytes / (1024 * 1024)),
        budgetMiB: Math.round(this.budget() / (1024 * 1024)),
        setMiB: Math.round(smallest / (1024 * 1024)),
        envelopeMiB: Math.round(this.envelope.envelopeBytes / (1024 * 1024)),
      });
    }
  }

  /** The floor this session actually owes the tiles: nothing at all while no
   *  body that could want one is registered (`?sectors=0` builds no streamer
   *  at all, but a mode may also run before or after registration), so the
   *  ladder is never asked to reserve memory for tiles nobody can load. */
  floorBytes(): number {
    return this.envelope.floorBytes;
  }

  /** Tell the envelope what the tiles are owed now. Called wherever the set of
   *  registered bodies changes: the ladder's ceiling is the envelope less this
   *  figure, so a stale one would let a map take room a tile has been promised
   *  — or reserve room for tiles nobody can load. */
  private syncFloor(): void {
    this.envelope.setFloorBytes(this.bodies.size > 0 ? this.sectorFloorBytes : 0);
  }

  /** What the sectors may hold together: their own ceiling, or whatever the
   *  total envelope leaves over the globe maps, whichever is less — and never
   *  below the floor. */
  budget(): number {
    return this.envelope.sectorBudget();
  }

  /** The cheapest whole set any registered body could admit — the figure a
   *  budget has to reach to be worth anything. */
  private smallestSetBytes(): number {
    let smallest = 0;
    for (const body of this.bodies.values()) {
      const bytes = sectorSetGpuBytes(body.handle.spec, 0, (slot) => realMapIn(body.handle.material, slot));
      if (bytes > 0 && (smallest === 0 || bytes < smallest)) smallest = bytes;
    }
    return smallest;
  }

  /**
   * The upkeep a frame owes the streamer even when it measures nothing. The
   * measurement pass belongs to the world render and stops with it (the
   * system map owns the frame, the body is not drawn), but two things behind
   * it do not stop: the tier ladder keeps applying globe maps, and the
   * fetches in flight keep ageing. Without this the sectors would hold their
   * old share of an envelope that has since shrunk — for as long as the map
   * stays open — and a request that hung would keep its slot in the in-flight
   * allowance for the rest of the session.
   *
   * Nothing is measured or admitted here: the working set only ever gets
   * smaller. Call it every frame; `update` does the rest on the frames the
   * surface is actually drawn.
   */
  maintain(globalMapBytes: number, nowMs: number): void {
    this.lastNowMs = nowMs;
    this.setGlobalMapBytes(globalMapBytes);
    for (const body of this.bodies.values()) {
      for (const slot of body.slots) {
        if (slot.loading && nowMs - slot.loading.startedAtMs > SECTOR_ATTEMPT_TIMEOUT_MS) this.failLoad(slot);
      }
    }
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
    key: string,
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
    const body = this.bodies.get(key);
    if (!body) return;
    this.lastNowMs = nowMs;
    const { handle, slots, family } = body;

    // The texel each level's demand is read against: the map below this
    // family for level 0, the level above's source below that.
    body.texelLens[0] = baseTexelLength(body);
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
    // The family's gate is read at the sector's extreme point: the point
    // nearest the sub-solar one for day, nearest the anti-solar one for night.
    const towardExtreme = sunLocal === null ? null
      : family.side === 'day' ? sunLocal : this.antiSunScratch.copy(sunLocal).negate();
    for (const slot of slots) {
      let texelPx = 0;
      let score = 0;
      let fetchable = false;
      // Whether a resident may stay for the light, as opposed to the size —
      // true wherever there is no sun to measure against.
      let litToKeep = true;
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
          // Unlit for this family: no pixel of the sector draws anything a
          // tile could sharpen. Day is refused past the terminator's twilight
          // margin, night until the shell's night mask opens — the same test
          // read from the two ends of the sector.
          let lightFraction = 1;
          if (sunLocal !== null && towardExtreme !== null) {
            const extremeDot = sectorNearestDirection(grid, slot.sector, towardExtreme, this.sunPointScratch)
              .dot(sunLocal);
            const unlit = family.side === 'day'
              ? extremeDot < family.lightEdge
              : extremeDot >= family.lightEdge;
            // The same test a margin later decides whether a RESIDENT stays:
            // once the ground under it has turned past its family's edge the
            // sector draws nothing at all, and the bytes are the other
            // family's to use.
            litToKeep = family.side === 'day'
              ? extremeDot >= family.lightEdge - SECTOR_KEEP_LIGHT_MARGIN
              : extremeDot < family.lightEdge + SECTOR_KEEP_LIGHT_MARGIN;
            if (unlit) fetchable = false;
            else {
              let sum = family.weight(extremeDot);
              for (const d of slot.sampleDirs) sum += family.weight(d.dot(sunLocal));
              lightFraction = sum / (slot.sampleDirs.length + 1);
              fetchable = !m.offscreen;
            }
          } else {
            fetchable = !m.offscreen;
          }
          // Screen-space error over the threshold: 1 is exactly at the want
          // size, 4 is four times past it. Every level reads the map it
          // would itself replace, so one number ranks them all — and two
          // sectors over the same ground come out coarse first, by the
          // level step between their maps. Scaled by how much of the sector
          // this family actually lights, so a pair of families over the
          // terminator is ranked by what each one draws there.
          if (fetchable) {
            score = (texelPx / this.wantTexelPx)
              * (0.5 + 0.5 * Math.max(0, Math.min(1, m.centrality)))
              * lightFraction;
          }
        }
      }
      slot.score = score;
      slot.wanted = fetchable && texelPx > this.wantTexelPx;
      slot.keep = texelPx > this.releaseTexelPx && litToKeep;
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
    // This is also the frame a fresh sector is first drawn on, which is where
    // its eviction dwell starts: reaching it means the surface is being
    // rendered, which the frame its tile uploaded on need not have been.
    for (const slot of slots) {
      if (slot.state === 'resident' && slot.mesh) {
        family.syncMaterial(slot.mesh.material as THREE.Material);
        if (!slot.presented) {
          slot.presented = true;
          slot.liveSinceMs = nowMs;
        }
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
   *  it is what a margin exists to prevent.
   *
   *  The frontier moves as the plan grows. A sector a finer one is drawing
   *  over is not the streamer's to give up, but planning that finer one away
   *  exposes it, and it is then as takeable as any leaf: each slot carries
   *  the count of its live children still standing, and joins the frontier
   *  when the last of them is planned away. A frontier taken once instead
   *  would leave a candidate that needs both a child and the parent under it
   *  seeing only the child, concluding there is no room, and starving for as
   *  long as the pose held. Nothing is released until the whole set is proven
   *  and the margin is cleared, and then in the order it was planned —
   *  children before parents, so no sector ever loses its fallback while it
   *  is still drawing. */
  private makeRoom(candidate: SectorSlot, need: number, nowMs: number): boolean {
    let free = this.budget() - this.heldBytes();
    let live = this.liveCount();
    if (free >= need && live < this.residentCap) return true;
    // Every live sector this pass may take, split by whether a finer one is
    // still drawing over it. A resident inside its dwell is in neither list:
    // it has an upload to protect, and nothing here can plan it away.
    const standing = new Map<SectorSlot, number>();
    const frontier: SectorSlot[] = [];
    const covering: SectorSlot[] = [];
    for (const body of this.bodies.values()) {
      for (const s of body.slots) {
        if (s.state === 'idle') continue;
        let children = 0;
        for (const child of s.children) if (child.state !== 'idle') children += 1;
        standing.set(s, children);
        if (s.state === 'resident' && (!s.presented || nowMs - s.liveSinceMs < SECTOR_EVICT_DWELL_MS)) continue;
        (children === 0 ? frontier : covering).push(s);
      }
    }
    const taking: SectorSlot[] = [];
    let strongest = 0;
    while (free < need || live >= this.residentCap) {
      // The weakest of the frontier, deepest first among equals: the level
      // that covers the least ground for its bytes goes first.
      let pick = -1;
      for (let i = 0; i < frontier.length; i++) {
        const s = frontier[i];
        if (pick < 0 || s.score < frontier[pick].score
          || (s.score === frontier[pick].score && s.level > frontier[pick].level)) pick = i;
      }
      if (pick < 0) return false;
      const victim = frontier.splice(pick, 1)[0];
      taking.push(victim);
      free += victim.bytes + victim.reserved;
      live -= 1;
      strongest = Math.max(strongest, victim.score);
      // The sector above it is one child closer to being exposed.
      const parent = victim.parent;
      const left = parent ? standing.get(parent) : undefined;
      if (parent && left !== undefined) {
        standing.set(parent, left - 1);
        const waiting = left - 1 === 0 ? covering.indexOf(parent) : -1;
        if (waiting >= 0) frontier.push(covering.splice(waiting, 1)[0]);
      }
    }
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
      const victims = this.evictable();
      if (victims.length === 0) return;
      let weakest = victims[0];
      for (const v of victims) {
        if (v.score < weakest.score || (v.score === weakest.score && v.level > weakest.level)) weakest = v;
      }
      this.release(weakest);
    }
  }

  /** Live sectors the give-back pass may take: everything a finer one is not
   *  drawing over. The dwell does not protect anything here — the memory is
   *  already spent, and holding it would only spend more — so a pyramid
   *  unwinds leaf by leaf within the one call. */
  private evictable(): SectorSlot[] {
    const out: SectorSlot[] = [];
    for (const body of this.bodies.values()) {
      for (const s of body.slots) {
        if (s.state === 'idle' || hasLiveChild(s)) continue;
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
    return crop ? layoutGpuBytes(dataCropLayout(body.levels[0].grid, crop.baseWidth, crop.spanU)) : 0;
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
    this.syncFloor();
  }

  stats(): SectorStats {
    const out: SectorStats = {
      resident: 0,
      loading: 0,
      inflight: 0,
      measuredGpuBytes: 0,
      budgetedBytes: 0,
      reserved: 0,
      budget: this.budget(),
      floor: this.floorBytes(),
      envelope: this.envelope.envelopeBytes,
      globalBytes: this.envelope.ladderBytes,
      bodies: {},
    };
    for (const body of this.bodies.values()) {
      // Families merge into one entry per BODY: a reader asking what Earth
      // holds gets everything Earth holds, day and night, and the ids inside
      // say which family each slot belongs to.
      const entry = out.bodies[body.handle.name] ??= {
        resident: [], loading: [], reloading: [], maxTexelPx: 0, measuredGpuBytes: 0, byLevel: [],
        byFamily: {}, scores: {},
      };
      const { resident, loading, reloading, byLevel, scores } = entry;
      while (byLevel.length < body.levels.length) byLevel.push({ resident: 0, loading: 0, measuredGpuBytes: 0 });
      // One family per (name, side), so this entry is this family's alone —
      // written through the merged one so a reader sees both views of the
      // same slots rather than two totals that could drift apart.
      const family = entry.byFamily[body.family.side] ??= {
        resident: 0, loading: 0, measuredGpuBytes: 0, budgetedBytes: 0,
      };
      let measuredGpuBytes = 0;
      for (const s of body.slots) {
        const id = slotId(s, body.family.side);
        if (s.score > 0) scores[id] = s.score;
        const level = byLevel[s.level];
        if (s.state === 'resident') {
          resident.push(id);
          level.resident += 1;
          family.resident += 1;
          if (s.loading) reloading.push(id);
        } else if (s.state === 'loading') {
          loading.push(id);
          level.loading += 1;
          family.loading += 1;
        }
        let slotBytes = 0;
        for (const tex of Object.values(s.maps)) slotBytes += textureGpuBytes(tex);
        for (const tex of s.loading?.owned ?? []) slotBytes += textureGpuBytes(tex);
        level.measuredGpuBytes += slotBytes;
        family.measuredGpuBytes += slotBytes;
        measuredGpuBytes += slotBytes;
        family.budgetedBytes += s.bytes;
        out.budgetedBytes += s.bytes;
        out.reserved += s.reserved;
      }
      entry.maxTexelPx = Math.max(entry.maxTexelPx, body.maxTexelPx);
      entry.measuredGpuBytes += measuredGpuBytes;
      out.measuredGpuBytes += measuredGpuBytes;
    }
    for (const entry of Object.values(out.bodies)) {
      out.resident += entry.resident.length;
      out.loading += entry.loading.length;
      out.inflight += entry.loading.length + entry.reloading.length;
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
    if (slot.state === 'idle') throw new Error(`sector load started on an idle slot ${slotId(slot, body.family.side)}`);
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
    const maps: Array<{ name: MapName; set: string; url: string; kind: 'color' | 'data'; grid: SectorGrid; sector: Sector; layout: TileLayout }> = [
      {
        name: 'map',
        set: setName(level.set),
        url: tileUrlOf(level.set, slot.sector),
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
        set: setName(crop),
        url: tileUrlOf(crop, baseSector),
        kind: 'data',
        grid: base.grid,
        sector: baseSector,
        layout: dataCropLayout(base.grid, crop.baseWidth, crop.spanU),
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
        (err) => {
          if (stillWanted()) noteTileFetchFailure(m.set, m.url, err);
          fail();
        },
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
    const material = body.family.createMaterial({
      map,
      bumpMap: loaded.bumpMap ?? null,
      normalMap: loaded.normalMap ?? null,
      roughnessMap: loaded.roughnessMap ?? null,
    }, slot.level);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${handle.name} sector ${slotId(slot, body.family.side)}`;
    if (import.meta.env.DEV) smoothTraceEvent('tile', mesh.name);
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
    // The dwell runs from the first frame this sector is drawn on, which is
    // not necessarily this one: the upload is paid by the warm pump, which
    // runs whether or not the surface is being rendered. A reload does not
    // restart it — the sector has been on the globe since it first landed.
    if (!previousMesh) slot.presented = false;
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
    if (import.meta.env.DEV) smoothTraceEvent('release', `sector ${slotId(slot)}`);
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
    slot.presented = false;
    slot.state = 'idle';
  }
}
