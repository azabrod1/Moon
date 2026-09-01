/**
 * The globe texture ladder: the maps a body climbs as it grows on screen, and
 * everything that prices, admits, gives back and re-fetches them. Four
 * subsystems, in this order:
 *
 * 1. The ladder. A TextureUpgrade per material holds the 2K/4K/8K rungs, the
 *    goals that earn them, and at most one in-flight attempt — never a
 *    lifecycle state, so nothing can strand a body on its boot map.
 * 2. The GPU byte ledger and the admission gate over it. What a rung costs is
 *    known before anything is fetched, and again from the decoded candidate
 *    before it is applied; `bindTierAdmission` installs the test the device's
 *    memory profile makes. Its default admits everything, so an unbound
 *    ladder has no ceiling at all.
 * 3. The release state machine (banner: "Giving a rung back"). Under memory
 *    pressure a body hands a rung back — a swap DOWN, which fetches the
 *    smaller map first and only then lets the larger one go, so no frame ever
 *    draws a globe with no map.
 * 4. The restore queue. A lost GL context takes the maps whose decoded
 *    sources were closed after their uploads; each is queued against the
 *    texture it was for, nearest body first, and fetched back one at a time.
 *
 * Every rung, climbing or being handed back, is queued for its GPU upload
 * BEFORE it reaches a material and assigned from the warm queue's callback: a
 * big map is uploaded in bands over several frames, and a material carrying
 * one before the last band lands draws unwritten storage. So the transient
 * that costs memory is the one where both maps are resident at once, and it
 * is in the ledger from the decode either way (pendingUpgradeBytes,
 * pendingReleaseBytes) — never the one where a body has no map.
 *
 * Then the arrival warm goals (banner: "Arrival warm goals") — the rung a
 * committed arrival is holding its veil for — and last the relief ladder
 * (banner: "The relief ladder"), which is a NormalUpgrade of the same shape
 * with one step, no cover and no arrival semantics.
 *
 * PlanetFactory builds the meshes these handles are bound to and fetches
 * their boot maps — the ladder's bottom rung — from the same file catalog
 * below. The sector streamer (world/sectorStreamer.ts) is the other allocator
 * on the same device envelope; the two meet at exactly two numbers, this
 * ladder's held bytes and ladderMapReferenceWidth, and nowhere else.
 */
import * as THREE from 'three';
import { smoothTraceEvent } from '../smoothnessTrace';
import { debugWarn } from '../../shared/debug';
import { applyTextureDefaults, clampTier, deviceTextureProfile, resolveTextureUrl, TIER_MAP_WIDTH, type TextureTier } from './texturePolicy';
import { queueTextureWarm } from './textureWarmer';
import { loadStreamedTexture, type TextureLoad } from './textureBitmapLoader';
import { equirectMapGpuBytes, retainedSourceBytes, textureGpuBytes } from './textureBytes';

// A colour-tier fetch goes through this indirection so the completion,
// staleness and failure paths that decide what reaches the GPU can be
// exercised without a GL context or a network — the same injected-seam pattern
// the texture warmer uses for its upload call. Nothing in the app rebinds it.
// The default is the shared probe-guarded bitmap path (textureBitmapLoader):
// transport failures reach the handle's cooldown as always, decode failures
// spend one HTMLImageElement fallback first.
let loadUpgradeTexture: TextureLoad = loadStreamedTexture;

/** Swap the tier fetch for a stub. Returns the previous one, to restore. */
export function setUpgradeTextureLoader(load: TextureLoad): TextureLoad {
  const previous = loadUpgradeTexture;
  loadUpgradeTexture = load;
  return previous;
}

// Texture filenames — bundled locally in public/textures/ (Solar System Scope
// CC BY 4.0 + NASA; Pluto is New Horizons / USGS, and the higher Moon tiers are
// NASA SVS — see TEXTURE_UPGRADE_TIERS). The filename stays resolution-
// agnostic; world/texturePolicy maps it through the active tier to a URL.
// Every entry is fetched at boot (planet bases + Earth details blocking, the
// moon system + normals durably behind the veil), which is why index.html
// preloads exactly this set — bootTexturePreloads.test.ts pins the two lists
// to each other, so a new entry here fails the build until the preload
// (or an explicit exemption there) follows.
export const PLANET_TEXTURE_FILES: Record<string, string> = {
  mercury: 'mercury.webp',
  venus: 'venus.webp',
  // `.v2` marks a map whose content was re-based under this key: the service
  // worker serves the previous deploy's body for a pathname it already holds
  // for one boot, and the sector tiles cut from the new map (new pathnames)
  // would then overlay the old globe as rectangles of a different product.
  // A re-based map therefore ships under a new pathname, never the old one.
  earthDay: 'earth-day.v2.webp',
  earthNight: 'earth-night.v2.webp',
  earthClouds: 'earth-clouds.webp',
  earthCloudsNormal: 'earth-clouds-normal.webp',
  earthBump: 'earth-bump.webp',
  earthRoughness: 'earth-roughness.v2.webp',
  mars: 'mars.v2.webp',
  marsNormal: 'mars-normal.v2.webp',
  jupiter: 'jupiter.webp',
  saturn: 'saturn.webp',
  uranus: 'uranus.webp',
  neptune: 'neptune.webp',
  pluto: 'pluto.webp',
  moon: 'moon.webp',
  moonNormal: 'moon-normal.webp',
  io: 'io.webp',
  europa: 'europa.webp',
  ganymede: 'ganymede.webp',
  callisto: 'callisto.webp',
  triton: 'triton.webp',
  // Spacecraft mosaics for the moons that drew as procedural noise balls
  // until now (Cassini for the Saturnians, New Horizons for Charon, Voyager 2
  // for the two Uranians). Miranda's and Ariel's sources are southern
  // hemispheres only, and the unimaged half is filled from the imaged one in
  // the map itself — nothing here draws a data edge.
  titan: 'titan.webp',
  enceladus: 'enceladus.webp',
  mimas: 'mimas.webp',
  dione: 'dione.webp',
  tethys: 'tethys.webp',
  rhea: 'rhea.webp',
  iapetus: 'iapetus.webp',
  miranda: 'miranda.webp',
  ariel: 'ariel.webp',
  charon: 'charon.webp',
};

/**
 * Goal-based colour-map upgrade for a body that grows large on screen. Bodies
 * boot on their flat map (fast first paint); when the player gets close — or
 * zooms the Observatory telescope onto them — the handle walks its step list
 * toward the highest tier both the assets on disk and the device can hold.
 * Only the keys listed in TEXTURE_UPGRADE_TIERS carry a handle.
 *
 * The handle stores goals and at most one in-flight attempt, never a lifecycle
 * state: every question a caller asks ("is there work left?", "does this need
 * a cover?") is derived from those. Nothing can strand a body in a terminal
 * state and pin it to its boot map for the rest of the session.
 */
export interface TextureUpgrade {
  key: string; // PLANET_TEXTURE_FILES key
  /** The material this ladder sharpens. Its colour map is read and written
   *  through materialColorMap, so a shader shell (Earth's night lights) climbs
   *  the ladder exactly like a standard material's `map`. */
  material: THREE.Material;
  /** Steps available for this key, ascending — the goal is the last one. */
  tiers: readonly TextureTier[];
  /** This device's ceiling, resolved once at creation (the caps are captured
   *  before any handle exists). A 4096-cap device with an 8K goal therefore
   *  settles at 4K instead of re-arming forever for a tier it can't hold. */
  effectiveMaxTier: TextureTier;
  /** Highest tier this handle has fetched and offered, or null while the body
   *  is still on the map it booted with. The material's colorTierRank stays
   *  the truth about what is on screen; this tracks the handle's progress. */
  appliedTier: TextureTier | null;
  /** The one fetch in flight, if any. */
  attempt?: { tier: TextureTier; generation: number; startedAtMs: number };
  /** Wall-clock instant (performance.now) before which no new attempt starts.
   *  Never the simulation clock, which jumps centuries per second. */
  retryAtMs?: number;
  /** The tier whose last fetch/decode failed, and how many times in a row.
   *  The failing tier's cooldown doubles per consecutive failure (capped) so
   *  a device that can never decode it — an 8K bitmap is a ~128 MB transient
   *  — isn't re-downloading the map every 8 s for as long as the body fills
   *  the screen. The rung-at-a-time climb in resolveUpgradeTier means a
   *  failing top tier can only ever strand the ladder one rung short, never
   *  on the boot map. Cleared once a tier at or above the failed one
   *  applies. */
  lastFailure?: { tier: TextureTier; streak: number };
  /** A committed arrival's warm-up target — see armArrivalWarmGoal. Set only
   *  through arm/disarm so the one-shot-per-tier semantics hold. */
  warmGoal?: TextureTier;
  /** The swap down in flight, if any: the tier being fetched to replace the
   *  rung with, and the identity a late arrival is checked against. Distinct
   *  from `attempt` — a body may be handing a map back while nothing is
   *  climbing, and never the other way round. `abort` ends the transfer when
   *  the swap is abandoned: a swap given up on has no reader left, and a
   *  stalled link is exactly where one abandoned transfer per timeout would
   *  otherwise accumulate for the session. */
  release?: {
    toTier: TextureTier;
    generation: number;
    startedAtMs: number;
    restore?: boolean;
    abort?: AbortController;
  };
  /** GPU bytes the map a swap DOWN has decoded but not yet assigned will
   *  hold. Between the decode and the assignment both maps are on the device,
   *  so both are in the ledger — otherwise the transient is spent behind the
   *  back of the admission test and the tiles are never trimmed for it. */
  pendingReleaseBytes?: number;
  /** GPU bytes the rungs a CLIMB has decoded but not yet assigned hold. The
   *  climb's transient is the swap down's inverted: the finer map is resident
   *  while the body still draws the coarser one, for as long as the upload
   *  takes. A sum rather than one figure, because a hung attempt superseded
   *  after its timeout leaves a second decoded map on the device beside it,
   *  and both are real bytes to whoever is asking. */
  pendingUpgradeBytes?: number;
  /** Wall-clock instant the last rung was given back. For a few seconds after
   *  one, this handle earns nothing: every borderline case then resolves
   *  toward keeping what is there rather than paying the download twice. */
  releasedAtMs?: number;
  /** Wall-clock instant before which no further swap down is attempted for
   *  this handle, and how many have failed in a row. A body whose lower map
   *  cannot be fetched — offline, evicted from the cache — is the farthest
   *  candidate every frame, so without this the planner would ask it again
   *  every frame for the rest of the session. */
  releaseRetryAtMs?: number;
  releaseFailures?: number;
  /** How many swaps down in a row were abandoned for taking too long. Counted
   *  apart from the failures because a hung fetch and a refused one need
   *  different cooldowns — the hang has already cost the full timeout — while
   *  both mean the same thing to the player: the maps are not coming back. */
  releaseTimeouts?: number;
  /** Wall-clock instant the body's screen fraction last fell under the
   *  release band, or undefined while it is at or above it. Tracked on every
   *  frame and reset on every crossing back up, so the dwell measures how
   *  long the body has really been small — not how long the memory has been
   *  tight. */
  belowBandSinceMs?: number;
}

/** True once this handle has fetched everything the device can hold — the
 *  per-frame trigger loop skips a body once every handle reports this and its
 *  silhouette is fine, so a fully-upgraded body costs no projection. */
export function upgradeComplete(up: TextureUpgrade): boolean {
  return up.appliedTier === up.effectiveMaxTier;
}

// Higher-resolution colour tiers on disk, per texture key, ascending. Every
// step must be the SAME albedo product as the map below it (colour-matched if
// its grading differs) so the on-approach swap reads as a pure sharpen — no
// brightness/contrast pop — and never double-counts relief against a normal
// map. Mars is the same source at 2x, and Jupiter's 4K is the same Solar
// System Scope product as its boot map (needed no match). The Moon's 4K and 8K
// are both the SVS CGI Moon Kit LROC WAC albedo, colour-matched to the shipped
// grade via tools/colormatch.mjs — and its relief comes from a separate SVS
// ldem_16 LOLA normal map, so the albedo carries no baked shading to fight.
// Earth's 4K clouds are the SSS cloud product (CC BY 4.0) the 2K boot map is
// downsampled from. Mercury, Venus and Saturn are the same Solar System Scope
// products as their boot maps (gated: RMS 3.6 / 1.6 / 1.6 against the shipped
// 2K); Venus and Saturn are low-frequency, so their 4K steps cost ~130 KB each
// and mainly remove texel blockiness at the wall. Uranus / Neptune stay 2K
// (no real detail to add); Io/Europa/Ganymede/Triton already ship 4K as
// their base map. Pluto is a real New Horizons LORRI mosaic (USGS, 300 m) registered to
// the IAU prime meridian and tinted through a brightness->albedo ramp (the
// source is grayscale); its never-imaged south is an honest dark cap, and its
// under-imaged far hemisphere is left as the real low-res data — soft, but
// honest (synthetic relief/detail was tried and dropped: it read as fake
// craters at grazing light). Both its tiers bake from one source, so 4K is a
// pure sharpen. The cloud deck climbs to 8K because the ground under it is
// streamed at 16K and a 4K deck is then the soft layer on top; the 8K deck is
// the SSS product itself (the 4K is its downsample: RMS 7 against it, equal
// means). Earth's day map has ONE rung and it is 8K: the globe boots on the
// 4096 map, which is where every other body's first rung arrives, so the only
// step left is the same graded Blue Marble one resample coarser than its 16K
// sector tiles. There is no 8K product from a different vendor in it — the
// same-product rule holds — because it is cut from the source the 4K and the
// tiles are cut from, through the same ocean grade.
export const TEXTURE_UPGRADE_TIERS: Record<string, readonly TextureTier[]> = {
  mercury: ['4k'],
  venus: ['4k'],
  mars: ['4k'],
  jupiter: ['4k'],
  saturn: ['4k'],
  pluto: ['4k'],
  moon: ['4k', '8k'],
  earthClouds: ['4k', '8k'],
  earthDay: ['8k'],
  // Black Marble 2016 at 500 m. The 2K night map the app booted on for years
  // is 20 km per pixel — from the near band that is a smear where a lit
  // coastline should be — which the 4K rung answers for 42.7 MiB. The 8K rung
  // ships GPU-compressed only: uncompressed it would hold 170.7 MiB of the
  // 768 MiB sector envelope on every desktop that has flown past the night
  // side, where the compressed container holds 42.7.
  earthNight: ['4k', '8k'],
};

// A device profile may cap a key below its ladder's top, over the GL clamp:
// an 8K RGBA map is 171 MiB resident with its mips, which is a question of
// total residency rather than of whether one map fits. The caps and their
// reasoning are the profile's (world/gpuEnvelope).

// A rung that ships GPU-compressed (KTX2/UASTC, mip chain baked by
// tools/gen-ktx2.mjs) instead of as a plain webp. An sRGB webp upload is
// charged a full-image colour conversion inside one texImage2D call — 2.9 to
// 4.0 ms for a 4K map on an Apple GPU under Chromium, a missed refresh at
// 120 Hz and more on a device with less to spend, and the largest unsliceable
// main-thread bill in the app at 8K, measured as THE dropped frame right
// after a Moon teleport. It cannot be spread over frames either: the driver
// charges the conversion per call over the whole source, so uploading in row
// bands costs six times the one-shot. A container's blocks are already
// encoded, so the upload is a memcpy that takes about a millisecond for a 4K
// map, bands cleanly, and stays compressed in VRAM: 10.7 MiB for a 4K rung
// instead of 42.7, 42.7 for an 8K instead of 170.7.
//
// Which rungs get one is decided on the wire, because UASTC is a fixed 8 bits
// a texel whatever the picture holds: a container is several times its webp,
// and many times it for a low-frequency map. Every 8K rung is worth that —
// nothing else answers a 170.7 MiB upload. At 4K a container may cost at most
// four times its webp twin, which only Mercury and Mars clear on the general
// rule; the rest keep their webp rung and pay the upload, because a tour of
// six planets pulling tens of megabytes where it pulled a few is a bill on
// mobile data that a smoother upload does not settle. The three maps the boot
// warm uploads are the exception, and the rows below say why: their bytes are
// not per-tour. gen-ktx2.mjs's job table carries the measurement behind each
// decision. Either way the bytes are paid only when a session earns the tier,
// and cached by the service worker thereafter. The override is consulted only
// while a KTX2 loader is bound, so tests and a session whose transcoder failed
// to load never ask for a container they cannot read.
//
// `webp` says whether a classic map of the same resolution also ships, which
// is what an unbound loader falls back to. Where it does not, the rung is
// ABSENT rather than merely expensive: the ladder's top drops to the rung
// below (or the boot map) instead of fetching a URL that 404s, and the
// memory arithmetic never charges an uncompressed map for one that does not
// exist in that form. Every 4K rung keeps its twin — those webps already ship
// and a device with no transcoder must still be able to climb — as do the two
// 8K maps that predate this pipeline. The two 8K rungs added since ship as one
// file, because a second copy of a 33MP map on disk is 4 MB nothing with a
// working transcoder fetches.
export interface CompressedRung {
  /** Filename under the tier's folder — resolveTextureUrl adds the rest. */
  file: string;
  /** A classic map of the same resolution ships beside it. */
  webp: boolean;
}
export const TIER_FILE_OVERRIDES: Record<string, Partial<Record<TextureTier, CompressedRung>>> = {
  mercury: { '4k': { file: 'mercury.ktx2', webp: true } },
  mars: { '4k': { file: 'mars.v2.ktx2', webp: true } },
  // The Moon, the cloud deck and Earth's night lights are the exception to the
  // 4K cap, and their 4K containers cost 4.8x, 4.9x and 5.3x their twins. The
  // cap exists because a container is an extra download over a webp that has
  // to keep shipping, and a tour pays that per body it visits. These three are
  // not toured: the idle after boot warms all three on every session, so a
  // device fetches each ONCE — the worker holds it under a pathname that
  // changes only when the map does — and every session after that pays
  // nothing on the wire. What the container buys is the frame that warm costs.
  // An uncompressed 4K upload is one unsliceable 2.9-to-4.0 ms conversion,
  // which overruns a 120 Hz refresh; the container's memcpy is about a
  // millisecond and does not. Night's 5.3x is 1.2 MB once, and the encoder has
  // nothing left to give (gen-ktx2.mjs's job table).
  moon: {
    '4k': { file: 'moon.ktx2', webp: true },
    '8k': { file: 'moon.ktx2', webp: true },
  },
  earthClouds: {
    '4k': { file: 'earth-clouds.ktx2', webp: true },
    '8k': { file: 'earth-clouds.ktx2', webp: true },
  },
  earthDay: { '8k': { file: 'earth-day.v2.ktx2', webp: false } },
  earthNight: {
    '4k': { file: 'earth-night.v2.ktx2', webp: true },
    '8k': { file: 'earth-night.v2.ktx2', webp: false },
  },
};

type Ktx2TierLoad = (
  url: string,
  onLoad: (tex: THREE.Texture) => void,
  onError: (err: unknown) => void,
) => void;
let ktx2TierLoader: Ktx2TierLoad | null = null;
let ktx2CompressedTarget = false;

/** Bind (or clear, with null) the KTX2 tier fetch. The mode binds a lazy
 *  KTX2Loader wrapper at init and clears it at dispose; while unbound every
 *  entry in TIER_FILE_OVERRIDES is inert.
 *
 *  `compressedTarget` is whether this GPU has a compressed format the
 *  transcoder can target (ASTC, BC7, ETC2 and the rest). It decides what a
 *  .ktx2 rung is CHARGED before it is fetched, and the filename cannot: with
 *  no compressed target the transcoder falls back to RGBA32 and hands back a
 *  texture four times the size the container's blocks suggest — the exact
 *  allocation the charge exists to refuse. */
export function bindKtx2TierLoader(fn: Ktx2TierLoad | null, compressedTarget = false): void {
  ktx2TierLoader = fn;
  ktx2CompressedTarget = fn ? compressedTarget : false;
}

/** The file a tier fetch actually asks for — the compressed override when its
 *  loader is bound, the key's shared classic file otherwise. */
export function resolveTierFile(key: string, tier: TextureTier): string {
  const override = ktx2TierLoader ? TIER_FILE_OVERRIDES[key]?.[tier] : undefined;
  return override?.file ?? PLANET_TEXTURE_FILES[key];
}

/** Whether a tier has a file this session can actually fetch. False only for
 *  a rung that ships as a compressed container alone while no KTX2 loader is
 *  bound: there is no map of that resolution on disk to fall back to, so the
 *  rung is not part of this session's ladder at all. */
export function tierAvailable(key: string, tier: TextureTier): boolean {
  const rung = TIER_FILE_OVERRIDES[key]?.[tier];
  return !rung || rung.webp || ktx2TierLoader !== null;
}

/** Real width of a body's BOOT map where it is wider than the boot tier's
 *  nominal 2048. Earth's globe ships its 4096 day map as the first-paint one,
 *  so the tier name says 2K and the surface is drawing 4K. The sector tiles
 *  measure their magnification against this floor: read as 2048 the day tiles
 *  would be wanted at half the distance they are sized for, which is a 21 MiB
 *  upload apiece for texels the globe already has. */
const BOOT_MAP_WIDTH: Record<string, number> = { earthDay: 4096 };

// Colour-map precedence: procedural floor 0, then one rank per tier. Ranks are
// what make every apply order-independent — a late boot-map arrival can't
// downgrade a higher tier that already won.
export const TIER_RANK: Record<TextureTier, number> = { '2k': 2, '4k': 4, '8k': 8 };

/**
 * GPU bytes the tier this handle has APPLIED holds — 0 while the body is
 * still on the boot map every device carries anyway. Summed over the bodies,
 * this is the ladder's live weight, which the sector streamer's memory
 * envelope has to share with: a Moon on its 8K rung leaves its tiles what it
 * actually leaves.
 */
export function appliedTierGpuBytes(up: TextureUpgrade): number {
  if (!up.appliedTier) return 0;
  const nominal = TIER_MAP_WIDTH[up.appliedTier];
  // Wherever this material keeps its colour map: a shader shell (Earth's
  // night lights) keeps it in a uniform, and its rung weighs the same.
  const map = materialColorMap(up.material);
  // A handle whose material has no map at all is charged its tier's nominal
  // size: the rung is what it says it is until a texture says otherwise.
  return map ? textureGpuBytes(map, nominal) : equirectMapGpuBytes(nominal);
}

/**
 * Bytes an applied rung holds on the device: its GPU allocation plus the
 * decoded image still in RAM behind it, if any. A webp rung keeps its
 * ImageBitmap so three can re-upload it after a context loss — 33 MiB for a
 * 4K map, 134 for an 8K one, none of it visible in a texture-memory figure —
 * so the ladder closes that source once the upload is paid (see
 * releaseUpgradeSource) and this reads 0 for it from then on. What is still
 * held is counted, because the envelope is one device's memory rather than
 * one subsystem's.
 */
export function appliedTierHeldBytes(up: TextureUpgrade): number {
  // A swap whose map has decoded but not yet been assigned holds both at
  // once, and the transient is real device memory whoever is asking — in
  // either direction: a rung climbing is resident from its decode until its
  // upload is paid, a rung being given back from its decode until it lands.
  const pending = (up.pendingReleaseBytes ?? 0) + (up.pendingUpgradeBytes ?? 0);
  if (!up.appliedTier) return pending; // the boot map is not the ladder's weight
  return appliedTierGpuBytes(up) + retainedSourceBytes(materialColorMap(up.material)) + pending;
}

/**
 * GPU bytes a RELIEF rung holds — appliedTierHeldBytes' data-map sibling. Zero
 * until the rung is on the material, because the boot relief every device
 * fetches regardless is not the ladder's optional weight; the tier the approach
 * earned is, and it is spent out of the same envelope the tiles come from.
 */
export function appliedNormalHeldBytes(up: NormalUpgrade | undefined): number {
  if (!up) return 0;
  // A rung decoded and waiting for its upload is on the device before the
  // material takes it, exactly as on the colour ladder.
  const pending = up.pendingBytes ?? 0;
  if (up.state !== 'done') return pending;
  const map = up.material.normalMap;
  return textureGpuBytes(map, TIER_MAP_WIDTH[up.tier]) + retainedSourceBytes(map) + pending;
}

/**
 * What the memory ledger says about a rung that wants to load.
 *
 * - `admit` — it fits beside everything else the ladder holds.
 * - `blocked` — it does not fit now, but rungs the ladder could give back
 *   would make room. The caller waits rather than gives up.
 * - `refuse` — it does not fit even with the ladder empty. Nothing can make
 *   room, so a goal aimed at it disarms rather than pumping forever.
 */
export type TierAdmission = 'admit' | 'blocked' | 'refuse';

/** Asked before a rung is fetched, and again for the decoded candidate with
 *  the bytes it really holds. Unbound (tests, and any consumer with no memory
 *  ledger) every rung is admitted, which is what the ladder did before there
 *  was one. */
export type TierAdmitter = (up: TextureUpgrade, tier: TextureTier, bytes: number) => TierAdmission;

let admitTier: TierAdmitter = () => 'admit';

/** Bind (or clear, with null) the ladder's admission test. The mode binds the
 *  envelope ledger at init and clears it at dispose. */
export function bindTierAdmission(fn: TierAdmitter | null): void {
  admitTier = fn ?? (() => 'admit');
}

/** The admission verdict on a tier, at its pre-fetch estimate. */
export function tierAdmission(up: TextureUpgrade, tier: TextureTier): TierAdmission {
  return admitTier(up, tier, tierUploadBytes(up.key, tier));
}

/**
 * The finest tier this handle can currently reach: what it already holds, or
 * the next rungs up while they are both loadable and admitted. Live rather
 * than remembered — a rung refused for want of memory, released under
 * pressure or failed to load lowers it the moment it happens, and the sector
 * streamer measures its tiles' magnification against this. Sectors sized
 * against a map the globe will not hold arrive at twice the magnification
 * they were meant for, or not at all.
 *
 * null while the body is on its boot map with nothing reachable above it —
 * the drawn map is then the finest thing there is.
 */
export function reachableTopTier(up: TextureUpgrade): TextureTier | null {
  let best: TextureTier | null = null;
  for (const tier of up.tiers) { // ascending
    if (TIER_RANK[tier] > TIER_RANK[up.effectiveMaxTier]) break;
    if (up.appliedTier && TIER_RANK[tier] <= TIER_RANK[up.appliedTier]) {
      best = tier; // it is holding this one
      continue;
    }
    // A tier whose last fetch failed leaves the ladder one rung short until a
    // later attempt succeeds; until then it is not a top the tiles may be
    // measured against.
    if (up.lastFailure && TIER_RANK[tier] >= TIER_RANK[up.lastFailure.tier]) break;
    if (admitTier(up, tier, tierUploadBytes(up.key, tier)) !== 'admit') break;
    best = tier;
  }
  return best;
}

/**
 * Width of the colour map the surface tiles measure their magnification
 * against: the finest tier the ladder can reach, never below the nominal
 * width of the rung the body is DRAWING.
 *
 * Nominal, never the drawn texture's own image width, because that image is
 * not the map: an applied rung replaces its decoded source with a small
 * stand-in once the upload is paid, so the image behind a 4K map reports a
 * few hundred pixels while the GPU holds 4096. And the floor matters because
 * a ladder with nothing reachable above it reports no top at all — a body
 * released to its boot map while memory is tight is drawing 2048 and would
 * otherwise be measured against whatever was left in the image slot. Tiles
 * sized against a map the globe does not hold arrive at many times the
 * magnification they were meant for, and are never released again.
 */
export function ladderMapReferenceWidth(up: TextureUpgrade): number {
  const top = reachableTopTier(up);
  const drawn = Math.max(TIER_MAP_WIDTH[up.appliedTier ?? BOOT_TIER], BOOT_MAP_WIDTH[up.key] ?? 0);
  return Math.max(drawn, top ? TIER_MAP_WIDTH[top] : 0);
}

/**
 * GPU bytes a tier WILL hold once it is fetched — the estimate the admission
 * test spends before a byte is downloaded. Charged at one byte a texel only
 * when the file is a compressed container AND this GPU has a format the
 * transcoder can target: with no such format three transcodes to RGBA32 and
 * the same container costs four times as much, which is the allocation the
 * test exists to refuse. The real texture is measured again before it is
 * applied, so an estimate that was generous is corrected before it costs
 * anything.
 */
export function tierUploadBytes(key: string, tier: TextureTier): number {
  const compressed = resolveTierFile(key, tier).endsWith('.ktx2') && ktx2CompressedTarget;
  return equirectMapGpuBytes(TIER_MAP_WIDTH[tier], compressed);
}

// A hung fetch must not own a handle for the session: past this age a fresh
// approach may supersede the in-flight attempt. TextureLoader cannot abort, so
// the superseded download disposes itself on arrival (generation mismatch).
const UPGRADE_ATTEMPT_TIMEOUT_MS = 60_000;
// Cooldown after a failed or discarded attempt. A discarded attempt's is
// fixed: the triggers only evaluate while a body fills the screen, so the
// retry rate is already bounded by the player staying in front of it. A
// FAILED tier's doubles per consecutive failure (capped below) — see
// TextureUpgrade.lastFailure.
const UPGRADE_RETRY_MS = 8_000;
// Ceiling on the failure backoff doublings: 8s → 16s → 32s → 64s → 128s.
const UPGRADE_RETRY_MAX_DOUBLINGS = 4;

// Attempt identity. Every fetch closes over its own value and compares before
// touching the handle, so a late callback whose attempt was abandoned disposes
// its texture instead of applying it.
let upgradeGeneration = 0;

export function makeTextureUpgrade(
  key: string | undefined,
  material: THREE.Material,
): TextureUpgrade | undefined {
  if (!key) return undefined;
  // Resolved once, with the ladder's ceiling, because both are facts about
  // this session: the KTX2 loader is bound before any body is built and
  // cleared only at dispose, so a rung filtered out here is one this session
  // has no file for at all.
  const tiers = TEXTURE_UPGRADE_TIERS[key]?.filter((tier) => tierAvailable(key, tier));
  if (!tiers || tiers.length === 0) return undefined;
  let top = tiers[tiers.length - 1];
  const cap = deviceTextureProfile().tierCaps[key];
  if (cap && TIER_RANK[cap] < TIER_RANK[top]) top = cap;
  return {
    key,
    material,
    tiers,
    effectiveMaxTier: clampTier(top),
    appliedTier: null,
  };
}

/** The lowest step this device can honour — the one an arrival veil covers.
 *  null when the device can hold none of the steps. */
export function firstUpgradeTier(up: TextureUpgrade): TextureTier | null {
  const first = up.tiers[0];
  return first && TIER_RANK[first] <= TIER_RANK[up.effectiveMaxTier] ? first : null;
}

/** The step `requested` earns for this device and handle — null when nothing
 *  is left to fetch. From the boot map the ladder is climbed ONE RUNG AT A
 *  TIME even when the screen fraction earns the top directly: the first rung
 *  is a quarter of the bytes, so the body sharpens seconds sooner, a flyby
 *  that leaves before the rung applies never pays for the top tier, and a
 *  phone whose 8K decode dies under memory pressure still holds the 4K it
 *  fetched on the way up. Once a rung has applied, the highest remaining
 *  earned step is taken directly. */
export function resolveUpgradeTier(up: TextureUpgrade, requested: TextureTier): TextureTier | null {
  const ceiling = Math.min(TIER_RANK[requested], TIER_RANK[up.effectiveMaxTier]);
  const floor = up.appliedTier ? TIER_RANK[up.appliedTier] : 0;
  let first: TextureTier | null = null;
  let best: TextureTier | null = null;
  for (const tier of up.tiers) {
    const rank = TIER_RANK[tier];
    if (rank > floor && rank <= ceiling) {
      first ??= tier; // ascending: the first match is the lowest
      best = tier; // ...and the last match is the highest
    }
  }
  return floor === 0 ? first : best;
}

/**
 * Screen fraction (body diameter ÷ viewport height) at which each tier earns
 * its download. 0.15 for the first step: boot-map texels start to soften there,
 * with lead time to fetch before the body grows. 0.22 for 8K because of one
 * view in particular — standing on Earth with the Observatory telescope on the
 * Moon, the view the 8K map exists for. Its default framing is a 2.2° FOV,
 * which puts the Moon at 0.25 of the viewport height, so a gate above that
 * would leave the flagship view on the 4K map until the player thought to zoom
 * further in.
 */
export const UPGRADE_TRIGGER_FRACTION: Partial<Record<TextureTier, number>> = { '4k': 0.15, '8k': 0.22 };

/**
 * Per-key overrides of the gates above. The cloud deck's 8K exists for the
 * close approach, not the telescope: a 4K texel of the deck spans one device
 * pixel only once Earth's disc stands about 1.2 viewport heights tall (0.6 on
 * a 2x display), so the Moon's 0.22 gate would pull 4.7 MB and 171 MiB of GPU
 * memory for every boot-view Earth. 0.5 is that 2x figure with fetch lead,
 * which is also where the 16K ground sectors start arriving.
 *
 * Earth's globe takes the same number for the same arithmetic: its day map
 * boots 4096 wide on the same sphere the deck wraps, so its texels reach one
 * device pixel at the same disc size the deck's do. A rung raised above its
 * tier's own gate is also how a key declares the rung approach work rather
 * than arrival work — see arrivalUpgradeTier.
 */
const UPGRADE_TRIGGER_FRACTION_BY_KEY: Record<string, Partial<Record<TextureTier, number>>> = {
  earthClouds: { '8k': 0.5 },
  earthDay: { '8k': 0.5 },
};

/** The screen fraction at which `tier` earns its download for `key`. */
export function upgradeTriggerFraction(key: string, tier: TextureTier): number | undefined {
  return UPGRADE_TRIGGER_FRACTION_BY_KEY[key]?.[tier] ?? UPGRADE_TRIGGER_FRACTION[tier];
}

/**
 * The highest step a body's screen fraction has earned — null when it has
 * earned none. Handing that step straight to upgradeTextureOnApproach is what
 * keeps a body first seen already filling the screen from paying for a rung it
 * would replace seconds later; the staged walk up the ladder happens only when
 * the approach crosses the lower fraction first.
 */
export function earnedUpgradeTier(up: TextureUpgrade, fraction: number): TextureTier | null {
  let earned: TextureTier | null = null;
  for (const tier of up.tiers) {
    const at = upgradeTriggerFraction(up.key, tier);
    if (at !== undefined && fraction > at) earned = tier; // ascending: keep the highest
  }
  return earned;
}

/** The one predicate behind every "should this fetch?" question — the on-screen
 *  trigger, the landing prefetch and the veil-cover test all ask it. True when
 *  a step remains, nothing useful is in flight, and any cooldown has passed. */
export function canAttempt(up: TextureUpgrade, nowMs: number): boolean {
  if (!resolveUpgradeTier(up, up.effectiveMaxTier)) return false;
  if (up.attempt && nowMs - up.attempt.startedAtMs < UPGRADE_ATTEMPT_TIMEOUT_MS) return false;
  // A swap down is in flight, or has just landed. Climbing again now would
  // undo the memory the release was for and pay both uploads.
  if (up.release) return false;
  if (up.releasedAtMs !== undefined && nowMs - up.releasedAtMs < RELEASE_REEARN_GRACE_MS) return false;
  return up.retryAtMs === undefined || nowMs >= up.retryAtMs;
}

/**
 * Is this handle's first step the work an arrival cover exists to hide? True
 * while the body is still on its boot map and either nothing is in flight or
 * what is in flight is that first step.
 *
 * Anything higher is never cover work. The on-screen trigger can start a fetch
 * for the ceiling directly, and holding a landing behind a map that size buys
 * nothing: the player is revealed onto the same boot map either way. A body
 * that already has its first step is in the same position.
 *
 * A cooldown deliberately does not suppress this — an arrival is the ideal
 * moment to retry a failed first step, so the caller clears it for exactly the
 * handles this returns true for.
 */
export function needsUpgradeCover(up: TextureUpgrade): boolean {
  const first = arrivalUpgradeTier(up);
  if (!first || up.appliedTier !== null) return false;
  return !up.attempt || up.attempt.tier === first;
}

/**
 * The step an ARRIVAL pre-fetches and a cover may wait on — the handle's
 * first, but only while that rung is what an arrival is revealed into.
 *
 * A key that holds its first rung back past the tier's own trigger gate has
 * said the rung is approach work: the body is revealed onto a map still right
 * for the distance, and the rung earns itself later, from the on-screen
 * trigger or a committed arrival's warm goal. Earth's globe is the case —
 * one rung, 8K, gated where the near approach begins — and holding a landing
 * behind 25 MB of container, or spending those bytes on a boot the session
 * may never fly to Earth on, buys a map the reveal cannot show.
 */
export function arrivalUpgradeTier(up: TextureUpgrade): TextureTier | null {
  const first = firstUpgradeTier(up);
  if (!first) return null;
  const gate = upgradeTriggerFraction(up.key, first);
  const standard = UPGRADE_TRIGGER_FRACTION[first];
  return gate !== undefined && standard !== undefined && gate > standard ? null : first;
}

/** Rank guard for the colour maps (procedural floor = 0, 2K = 2, 4K = 4):
 *  strictly higher wins, so a late 2K arrival can never downgrade a 4K that
 *  already won the race, and a real map always beats the procedural floor. */
export function shouldApplyColorTier(currentRank: number, arrivingRank: number): boolean {
  return arrivingRank > currentRank;
}

/** The rank a material starts at, given the texture its construction received.
 *  PlanetFactory's loadTexture hands back either the real map or a procedural
 *  fallback, and the guard above can only protect the real one if the two are
 *  told apart — an unstamped material reads as the floor, so a fallback and a
 *  real 2K would otherwise both look replaceable by anything. A material built
 *  with no map at all is the floor too: the first arrival is the best thing it
 *  has. */
export function initialColorTierRank(tex: { userData?: Record<string, unknown> } | null | undefined): number {
  if (!tex) return 0;
  return tex.userData?.proceduralFallback === true ? 0 : 2;
}

// Apply a freshly loaded colour map only if it out-ranks what's already on the
// material (TIER_RANK, procedural floor 0). Makes the boot stream, its late
// arrival after a timeout, every tier upgrade, and the lazy painter
// order-independent: a late boot-map arrival can't downgrade an 8K that
// already won. Disposes whatever it replaces (or itself). Exported for the
// tests that pin that ordering.
/**
 * A material's colour map, wherever it keeps one. A standard material keeps it
 * in `map`; a shader material keeps it in a uniform and names that uniform in
 * `userData.colorMapUniform` — Earth's night lights are a shader shell, and
 * they climb the same tier ladder as the globe under them. One accessor pair
 * is what lets one rank guard, one upgrade handle and one byte estimate serve
 * both instead of the ladder knowing which kind of material it is holding.
 */
export function materialColorMap(mat: THREE.Material): THREE.Texture | null {
  const uniform = mat.userData.colorMapUniform as string | undefined;
  if (uniform) {
    return ((mat as THREE.ShaderMaterial).uniforms[uniform]?.value as THREE.Texture | null) ?? null;
  }
  return (mat as THREE.MeshStandardMaterial).map ?? null;
}

function setMaterialColorMap(mat: THREE.Material, tex: THREE.Texture): void {
  // Every colour-map swap the ladder makes passes here, so this is where the
  // frame trace learns a rung landed on this frame.
  if (import.meta.env.DEV) smoothTraceEvent('rung', `colour ${tex.name || 'tier'}`);
  const uniform = mat.userData.colorMapUniform as string | undefined;
  if (uniform) {
    (mat as THREE.ShaderMaterial).uniforms[uniform].value = tex;
    return;
  }
  const std = mat as THREE.MeshStandardMaterial;
  const prev = std.map;
  std.map = tex;
  // Colour-as-bump bodies (non-gas planets with no normal map) alias the same
  // texture as bumpMap; move the alias onto the upgraded map so the dispose
  // by the caller can't leave bumpMap pointing at freed GPU memory.
  if (std.bumpMap === prev) std.bumpMap = tex;
  std.color.setRGB(1, 1, 1);
}

export function applyColorTierTexture(mat: THREE.Material, tex: THREE.Texture, rank: number): boolean {
  const current = (mat.userData.colorTierRank as number | undefined) ?? 0;
  if (!shouldApplyColorTier(current, rank)) {
    tex.dispose();
    return false;
  }
  const prev = materialColorMap(mat);
  setMaterialColorMap(mat, tex);
  mat.userData.colorTierRank = rank;
  mat.needsUpdate = true;
  disposeReplacedColorMap(mat, prev);
  return true;
}

/** Free the map a swap replaced. Called only after the new one is assigned,
 *  so no frame samples a freed texture. A GPU procedural floor's texture is
 *  backed by a render target; dispose the whole RT (framebuffer + texture),
 *  not just the texture, or it leaks. */
function disposeReplacedColorMap(mat: THREE.Material, prev: THREE.Texture | null): void {
  if (!prev || prev === materialColorMap(mat)) return;
  const owner = prev.userData?.ownerRenderTarget as THREE.WebGLRenderTarget | undefined;
  if (owner) {
    owner.dispose(); // disposes the RT (fires its tracked-removal listener)
    // Drop the now-dangling procedural ref so nothing points at the freed RT.
    if (mat.userData.proceduralColorRT === owner) mat.userData.proceduralColorRT = undefined;
  } else {
    prev.dispose();
  }
}

/**
 * Fetch one step of a body's colour ladder and swap it in. `requested` is the
 * tier the caller's evidence justifies; the highest step at or below it that
 * this device and this handle still need is what actually gets fetched. Loads
 * directly rather than via PlanetFactory's loadTexture so a failed fetch
 * leaves the current map in place instead of resolving a grey fallback. Cheap
 * to call every frame — canAttempt is the whole guard, and it no-ops on a GPU
 * that can't hold the step, so it never thrashes there.
 */
export function upgradeTextureOnApproach(
  up: TextureUpgrade,
  requested: TextureTier,
  nowMs = performance.now(),
): void {
  if (!canAttempt(up, nowMs)) return;
  const tier = resolveUpgradeTier(up, requested);
  if (!tier) return;
  // What the ladder already holds decides whether this rung may be fetched at
  // all. A refusal is arithmetic, not a failure: no cooldown, no attempt, no
  // record — the body keeps the map it has and the same question is asked
  // again next frame, by which time a release may have made room.
  const admission = admitTier(up, tier, tierUploadBytes(up.key, tier));
  if (admission !== 'admit') {
    if (admission === 'refuse') up.warmGoal = undefined;
    return;
  }
  const generation = ++upgradeGeneration;
  up.attempt = { tier, generation, startedAtMs: nowMs };
  up.retryAtMs = undefined;
  // The attempt this callback belongs to was abandoned (discarded, or timed
  // out and superseded) if the handle no longer carries its generation.
  const abandoned = () => up.attempt?.generation !== generation;
  // Capture the KTX2 binding with the file choice, so an unbind between the
  // resolve and the fetch can't strand a .ktx2 URL on the image loader.
  const ktx2 = ktx2TierLoader;
  const file = resolveTierFile(up.key, tier);
  const url = resolveTextureUrl(file, tier);
  const load: TextureLoad = file.endsWith('.ktx2') && ktx2
    ? (u, onLoad, onError) => ktx2(u, onLoad, onError)
    : loadUpgradeTexture;
  // Deliberately a plain load, not the durable seam: this is an optional
  // sharpen wanted only while the body fills the view. A failure leaves
  // whatever is already on the material — the boot map, or the procedural
  // fallback if the base fetch is still out on its own ladder. The retry it
  // gets is demand-driven rather than durable: a cooldown, then another
  // attempt only if the body still earns the tier on a later frame. A base map
  // is chased for the whole session because nothing else can stand in for it.
  load(
    url,
    (tex) => {
      if (abandoned()) {
        tex.dispose();
        return;
      }
      applyTextureDefaults(tex, 'color');
      // Decode before the rank swap: the material keeps its current map until
      // the new one is cheap to draw, so a mid-session upgrade never freezes
      // the frame on a synchronous decode — and the warm queue then uploads it
      // off any gesture frame. The triggers only fire for a body filling the
      // view, so warming here can't upload hidden bodies.
      const img = tex.image as { decode?: () => Promise<void> } | undefined;
      const applyUpgrade = () => {
        // An abandoned attempt drops its bytes here. A merely uncovered one
        // still applies: the download is already paid for, so disposing it
        // would cost the same unsliceable upload again later plus a second
        // trip over the network — while applying it costs one upload on a
        // quiet warm-pump frame.
        if (abandoned()) {
          tex.dispose();
          return;
        }
        // The estimate that admitted this fetch was nominal; the texture in
        // hand is the real figure. A map that turns out not to fit is dropped
        // here, before it is ever assigned — the body keeps the rung it has,
        // which is a real map either way.
        const bytes = textureGpuBytes(tex, TIER_MAP_WIDTH[tier]);
        const room = admitTier(up, tier, bytes);
        if (room !== 'admit') {
          up.attempt = undefined;
          if (room === 'refuse') up.warmGoal = undefined;
          tex.dispose();
          return;
        }
        // Warm first, assign second. A map big enough to be uploaded in bands
        // has its GL storage allocated the moment the pump reaches it and its
        // pixels written over the frames after — so a material carrying it
        // before the last band lands draws whatever the driver decodes from
        // unwritten storage, which is a body wearing solid magenta or black
        // for a tenth of a second in the middle of an approach. The warm
        // queue's callback is the instant drawing the map is free, and the
        // rank guard makes a late assignment order-independent, so nothing is
        // owed to the order the fetches happen to finish in.
        //
        // Which inverts the swap's memory transient: the new map is resident
        // while the old one is still on the material, so its bytes go into
        // the ledger here and come out when the swap lands. The release path
        // charges the mirror image of this, and the envelope must not be able
        // to overshoot by a rung through either.
        up.pendingUpgradeBytes = (up.pendingUpgradeBytes ?? 0) + bytes;
        queueTextureWarm(tex, (outcome) => {
          const owed = (up.pendingUpgradeBytes ?? 0) - bytes;
          up.pendingUpgradeBytes = owed > 0 ? owed : undefined;
          // A texture disposed while it waited has no map to give, and an
          // attempt superseded meanwhile drops its bytes here. Disposing an
          // already-disposed texture is how the teardown case frees a map
          // that never reached a material.
          if (outcome === 'disposed' || abandoned()) {
            tex.dispose();
            return;
          }
          up.attempt = undefined;
          up.appliedTier = tier;
          if (up.lastFailure && TIER_RANK[tier] >= TIER_RANK[up.lastFailure.tier]) {
            up.lastFailure = undefined;
          }
          up.belowBandSinceMs = undefined;
          // 'failed' is assigned too: the upload threw, so three pays it on
          // the render path exactly as it would with no warm queue at all —
          // a stall, never a wrong picture, and never a half-filled map
          // (a refused or failed slice hands the map back whole).
          if (applyColorTierTexture(up.material, tex, TIER_RANK[tier]) && outcome === 'warmed') {
            releaseUpgradeSource(tex);
          }
          up.material.userData.photoLoaded = true; // keep the lazy painter off it
        });
      };
      if (img && typeof img.decode === 'function') img.decode().then(applyUpgrade, applyUpgrade);
      else applyUpgrade();
    },
    (err) => {
      if (abandoned()) return;
      up.attempt = undefined;
      const streak = up.lastFailure?.tier === tier ? up.lastFailure.streak + 1 : 1;
      up.lastFailure = { tier, streak };
      up.retryAtMs =
        performance.now() +
        UPGRADE_RETRY_MS * 2 ** Math.min(streak - 1, UPGRADE_RETRY_MAX_DOUBLINGS);
      debugWarn('Texture upgrade failed', {
        key: up.key,
        tier,
        attempt: streak,
        reason: err instanceof Error ? err.message : String(err),
      });
    },
    // The bitmap path consults this between fetch and decode, so a
    // superseded attempt's bytes are dropped before a full-size bitmap is
    // ever created — the same never-decode-abandoned-bytes guarantee the
    // image path always had.
    () => !abandoned(),
  );
}

/**
 * Release a claim on an in-flight attempt. TextureLoader cannot abort, so the
 * download completes either way and the flavor decides what becomes of it:
 *
 * - `keep` — nothing is dropped. The caller (an arrival cover whose bounded
 *   hold expired) merely stops waiting; the completion applies on a later
 *   quiet frame. Dropping it instead would buy nothing: the upload still has
 *   to be paid the moment the player looks, and the bytes would have to be
 *   fetched a second time to pay it.
 * - `discard` — the attempt is abandoned (its completion disposes itself) and
 *   a cooldown keeps the handle calm until a later approach asks again. For
 *   fetches whose reason is gone: a superseded arrival, a departed body, a
 *   disposed mode.
 */
export function cancelTextureUpgrade(
  up: TextureUpgrade,
  flavor: 'keep' | 'discard',
  nowMs = performance.now(),
): void {
  if (!up.attempt || flavor === 'keep') return;
  up.attempt = undefined;
  up.retryAtMs = nowMs + UPGRADE_RETRY_MS;
}

// --- Giving a rung back ------------------------------------------------------
//
// The ladder is one-way by nature: every rung is fetched because a body grew
// large, and nothing shrinks it again. On a device where the globe maps and
// the surface tiles share one memory envelope that makes the ladder a
// ratchet — six approaches and the tiles have nothing left to spend for the
// rest of the session, at the very magnifications a tile is what the surface
// needs. So a rung a body has stopped earning can be handed back.
//
// Three rules keep that from becoming churn. It happens only under memory
// pressure (a rung somewhere is being refused, or the maps have grown past
// what the tiles' floor leaves them). It happens only well below where the
// rung was earned — a third of the trigger fraction, which is a band that
// cannot invert however large the body was when it first earned the tier.
// And it happens only after the body has stayed there for a dwell.

/** How far below its earn trigger a body must fall before the rung it earned
 *  is releasable: a third of the fraction that bought it. Anchored to the
 *  TRIGGER and never to the fraction observed when the rung was earned —
 *  every committed arrival earns its rungs at fraction 1, so a band derived
 *  from the observation would sit ABOVE the trigger and flap forever at the
 *  framing the tier exists for. */
export const RELEASE_BAND_DIVISOR = 3;

/** The screen fraction under which `tier` stops earning its place for `key`. */
export function releaseBandFraction(key: string, tier: TextureTier): number {
  const trigger = upgradeTriggerFraction(key, tier);
  return trigger === undefined ? 0 : trigger / RELEASE_BAND_DIVISOR;
}

// How long a body must stay under the band before its rung goes back. A 4K
// swap is a second of fetch and one upload; an 8K one is the largest
// unsliceable main-thread bill in the app, so it is the last to leave and the
// most expensive to re-earn — unless it arrived GPU-compressed, which
// re-uploads in milliseconds and is as cheap to take back as a 4K.
const RELEASE_DWELL_MS: Record<TextureTier, number> = { '2k': 8_000, '4k': 8_000, '8k': 30_000 };
const RELEASE_DWELL_COMPRESSED_MS = 8_000;

/** The dwell a rung of this tier owes before it may be given back. */
export function releaseDwellMs(tier: TextureTier, compressed: boolean): number {
  return compressed ? RELEASE_DWELL_COMPRESSED_MS : RELEASE_DWELL_MS[tier];
}

/** Nothing is re-earned for this long after a release, so a body sitting on
 *  the boundary cannot fetch, release and re-fetch the same map. */
export const RELEASE_REEARN_GRACE_MS = 5_000;

/** A swap down that has not landed in this long is abandoned: the map that is
 *  already there stays, and the planner is free to try another body. */
export const RELEASE_ATTEMPT_TIMEOUT_MS = 20_000;

/** Cooldown after a swap down that could not be fetched, doubling per
 *  consecutive failure to the same cap as the climb's. */
const RELEASE_RETRY_MS = 8_000;
const RELEASE_RETRY_MAX_DOUBLINGS = 4;

/** Cooldown after a swap down abandoned for taking too long, doubling per
 *  consecutive timeout up to five minutes. It starts at the timeout itself
 *  because the fetch has already had that long and not landed: without a
 *  cooldown the dwell is still served the moment the swap is abandoned, so
 *  the same body starts a fresh fetch on the very next frame and a stalled
 *  link costs one abandoned transfer every twenty seconds for the session. */
const RELEASE_TIMEOUT_RETRY_MS = RELEASE_ATTEMPT_TIMEOUT_MS;
const RELEASE_TIMEOUT_RETRY_MAX_MS = 300_000;

/** True once a swap down has been in the air too long to wait for. The map
 *  the body is drawing stays either way; abandoning only frees the planner to
 *  ask another body. */
export function releaseExpired(up: TextureUpgrade, nowMs: number): boolean {
  return up.release !== undefined && nowMs - up.release.startedAtMs > RELEASE_ATTEMPT_TIMEOUT_MS;
}

/** Give up on a swap down that never landed: end its transfer, count the
 *  timeout, and hold this handle off until the cooldown. A hang is as good a
 *  reason to stop asking as a refusal — the difference is only that it costs
 *  the full timeout to learn. */
export function expireTierRelease(up: TextureUpgrade, nowMs = performance.now()): void {
  if (!up.release) return;
  cancelTierRelease(up);
  const streak = (up.releaseTimeouts ?? 0) + 1;
  up.releaseTimeouts = streak;
  up.releaseRetryAtMs = nowMs
    + Math.min(RELEASE_TIMEOUT_RETRY_MS * 2 ** (streak - 1), RELEASE_TIMEOUT_RETRY_MAX_MS);
}

/** Keep this handle's "how long has it been small" clock. Called every frame
 *  for every laddered body — including the ones nothing is drawing, whose
 *  fraction is 0 — so the dwell measures the body's distance rather than the
 *  moment memory got tight. */
export function trackReleaseBand(up: TextureUpgrade, fraction: number, nowMs: number): void {
  if (!up.appliedTier) {
    up.belowBandSinceMs = undefined;
    return;
  }
  if (fraction < releaseBandFraction(up.key, up.appliedTier)) up.belowBandSinceMs ??= nowMs;
  else up.belowBandSinceMs = undefined;
}

/** True when this handle has a rung to give back and has been under its band
 *  for the dwell. Says nothing about whether it SHOULD — pressure, distance
 *  order and every protection are the planner's business. */
export function releaseDue(up: TextureUpgrade, nowMs: number): boolean {
  if (!up.appliedTier || up.release || up.attempt) return false;
  if (up.releaseRetryAtMs !== undefined && nowMs < up.releaseRetryAtMs) return false;
  if (up.belowBandSinceMs === undefined) return false;
  const compressed = (materialColorMap(up.material) as THREE.Texture & { isCompressedTexture?: boolean } | null)
    ?.isCompressedTexture === true;
  return nowMs - up.belowBandSinceMs >= releaseDwellMs(up.appliedTier, compressed);
}

/** The tier a release drops to: one rung down the ladder, or the boot map
 *  every device carries anyway — which is not a member of `tiers`, so the
 *  handle's appliedTier goes back to null and the climb starts from the
 *  bottom rung again. */
export function releaseTargetTier(up: TextureUpgrade): TextureTier | null {
  if (!up.appliedTier) return null;
  let below: TextureTier | null = null;
  for (const tier of up.tiers) {
    if (TIER_RANK[tier] < TIER_RANK[up.appliedTier]) below = tier; // ascending
  }
  return below ?? BOOT_TIER;
}

/** The tier a body's first-paint map is fetched at. */
const BOOT_TIER: TextureTier = '2k';

/**
 * Put a LOWER map on a material on purpose — the swap down `applyColorTierTexture`
 * refuses by construction, since its rank guard exists to stop a late arrival
 * undoing a finer map that already won.
 *
 * Same order as the way up: assign, re-point the colour-as-bump alias, then
 * dispose what was there. So there is no frame with no map, and none sampling
 * a freed one. `photoLoaded` stays true — the body still has a real
 * photograph on it, and the lazy painter must not start painting over it.
 */
export function releaseColorTier(mat: THREE.Material, tex: THREE.Texture, rank: number): void {
  const prev = materialColorMap(mat);
  setMaterialColorMap(mat, tex);
  mat.userData.colorTierRank = rank;
  mat.needsUpdate = true;
  disposeReplacedColorMap(mat, prev);
}

/**
 * Fetch the map below this handle's rung and swap it in when it decodes.
 *
 * The lower map is re-fetched rather than kept: holding every body's previous
 * tier for the life of the session costs more memory than the release ever
 * gives back, and the fetch comes from the service-worker cache for any body
 * the session has already been near. The body draws its high map throughout —
 * the swap happens on a map that is decoded AND uploaded, or not at all — so a
 * release is invisible except as a softening, and never re-opens the arrival
 * cover: the material keeps a real map and `photoLoaded` through every step.
 *
 * `restore` re-fetches the SAME tier instead of the one below: the rung's
 * decoded source is closed once its upload is paid, so a lost GL context has
 * nothing to re-upload from and the map is fetched again.
 */
export function startTierRelease(
  up: TextureUpgrade,
  nowMs = performance.now(),
  opts: {
    restore?: boolean;
    onSettled?: (released: boolean) => void;
    /** Called the moment the low map's bytes enter (and leave) the ledger, so
     *  a caller that shares the envelope with another manager can hand it the
     *  new figure before anything is drawn or admitted against it. */
    onLedgerChange?: () => void;
  } = {},
): boolean {
  if (!up.appliedTier || up.release || up.attempt) return false;
  const toTier = opts.restore ? up.appliedTier : releaseTargetTier(up);
  if (!toTier) return false;
  const generation = ++upgradeGeneration;
  const abort = typeof AbortController === 'function' ? new AbortController() : undefined;
  up.release = { toTier, generation, startedAtMs: nowMs, restore: opts.restore, abort };
  const abandoned = () => up.release?.generation !== generation;
  const ktx2 = ktx2TierLoader;
  const file = resolveTierFile(up.key, toTier);
  const url = resolveTextureUrl(file, toTier);
  const load: TextureLoad = file.endsWith('.ktx2') && ktx2
    ? (u, onLoad, onError) => ktx2(u, onLoad, onError)
    : loadUpgradeTexture;
  const settle = (released: boolean) => {
    up.release = undefined;
    opts.onSettled?.(released);
  };
  load(
    url,
    (tex) => {
      if (abandoned()) {
        tex.dispose();
        return;
      }
      applyTextureDefaults(tex, 'color');
      const swap = () => {
        if (abandoned()) {
          tex.dispose();
          return;
        }
        // Decoded, and waiting for its upload: from here until the swap lands
        // the device holds the map being given back AND the one replacing it,
        // so the transient goes into the ledger first and comes out with the
        // high map. Whoever shares the envelope trims for it synchronously,
        // rather than discovering the peak a frame after it has passed.
        up.pendingReleaseBytes = textureGpuBytes(tex, TIER_MAP_WIDTH[toTier]);
        opts.onLedgerChange?.();
        // The same order as the climb, and for the same reason: a map whose
        // bands are still being uploaded draws as unwritten storage, so the
        // body keeps its high map until the low one is complete. A swap down
        // is meant to be invisible except as a softening.
        queueTextureWarm(tex, (outcome) => {
          if (outcome === 'disposed' || abandoned()) {
            // Whatever abandoned this swap took its charge out of the ledger
            // already (cancelTierRelease), so a later swap's charge is not
            // cleared by this callback. A map disposed under a live swap has
            // nothing to give: the high map stays and the swap ends.
            if (!abandoned()) {
              up.pendingReleaseBytes = undefined;
              opts.onLedgerChange?.();
              settle(false);
            }
            tex.dispose();
            return;
          }
          releaseColorTier(up.material, tex, TIER_RANK[toTier]);
          up.pendingReleaseBytes = undefined;
          if (outcome === 'warmed') releaseUpgradeSource(tex);
          up.releaseFailures = undefined;
          up.releaseTimeouts = undefined;
          up.releaseRetryAtMs = undefined;
          if (!opts.restore) {
            up.appliedTier = up.tiers.includes(toTier) ? toTier : null;
            // A goal aimed above the rung just given back would climb straight
            // back up; the arrival it was armed for is over.
            up.warmGoal = undefined;
            up.releasedAtMs = performance.now();
            up.belowBandSinceMs = undefined;
          }
          settle(true);
        });
      };
      const img = tex.image as { decode?: () => Promise<void> } | undefined;
      if (img && typeof img.decode === 'function') img.decode().then(swap, swap);
      else swap();
    },
    (err) => {
      if (abandoned()) return;
      // The map that is there stays. Nothing is half-released, the planner
      // may try another body, and this one waits out a cooldown rather than
      // being asked again on the very next frame — it is still the farthest
      // candidate, and a network that is gone stays gone for a while.
      const streak = (up.releaseFailures ?? 0) + 1;
      up.releaseFailures = streak;
      up.releaseRetryAtMs = performance.now()
        + RELEASE_RETRY_MS * 2 ** Math.min(streak - 1, RELEASE_RETRY_MAX_DOUBLINGS);
      settle(false);
      debugWarn('Texture release failed', {
        key: up.key,
        tier: toTier,
        reason: err instanceof Error ? err.message : String(err),
      });
    },
    () => !abandoned(),
    abort?.signal,
  );
  return true;
}

/** A rung waiting to fetch back the map a lost GL context took, and the
 *  stand-in texture it is waiting to replace. The texture is carried so an
 *  entry whose material has moved on — an upgrade landed, a release swapped a
 *  map in — is recognised as answered rather than re-fetched. */
export interface RestoreRefetchEntry {
  up: TextureUpgrade;
  tex: THREE.Texture;
}

/**
 * The restore queue a context loss leaves behind: every rung whose decoded
 * source was closed after its upload, in the order they will be fetched back.
 *
 * The GPU copy is gone and the small stand-in left in its place is all three
 * has to re-upload from, so each of these maps has to be fetched again — from
 * the service-worker cache, for anything this session has already seen — and
 * swapped in at the tier it already had.
 *
 * Queued rather than started, and nearest body first. A context is lost on a
 * phone BECAUSE the system reclaimed memory, so answering it by decoding every
 * globe map at once asks for the loss again; and the body the player is
 * looking at is the one whose softness they can see. Each entry carries the
 * texture it is for, so one whose map has been replaced by any other route is
 * dropped rather than re-fetched (takeRestoreRefetch).
 *
 * A handle still on its boot map has nothing to fetch back, and a map whose
 * source is still in RAM can be re-uploaded from what is already there.
 */
export function buildRestoreQueue(
  entries: readonly { up: TextureUpgrade; tex: THREE.Texture | null; distance: number }[],
): RestoreRefetchEntry[] {
  return entries
    .filter((e): e is { up: TextureUpgrade; tex: THREE.Texture; distance: number } => (
      !!e.up.appliedTier && !!e.tex && e.tex.userData?.sourceReleased === true
    ))
    .sort((a, b) => a.distance - b.distance)
    .map((e) => ({ up: e.up, tex: e.tex }));
}

/**
 * Take the next stand-in that may fetch its real map back, dropping the
 * entries that no longer need one.
 *
 * One at a time and only what the ledger admits: a context is lost because
 * the system reclaimed memory, so the answer to it must not be every globe
 * map decoding at once. A handle that is busy, and a rung the ledger cannot
 * fit today, both stay queued — an upgrade that fails mid-restore, or a
 * squeeze that passes, must not leave a body on a stand-in for the session.
 * A rung that can never fit again is taken from the queue with `restore`
 * false: it is handed back instead, which fetches a smaller real map in place
 * of the stand-in.
 */
export function takeRestoreRefetch(
  queue: RestoreRefetchEntry[],
): { up: TextureUpgrade; restore: boolean } | null {
  for (let i = 0; i < queue.length; i++) {
    const { up, tex } = queue[i];
    if (!up.appliedTier || materialColorMap(up.material) !== tex) {
      queue.splice(i, 1);
      i--;
      continue;
    }
    if (up.attempt || up.release) continue;
    const room = tierAdmission(up, up.appliedTier);
    if (room === 'blocked') continue;
    queue.splice(i, 1);
    return { up, restore: room === 'admit' };
  }
  return null;
}

/** Abandon a swap in flight (a timeout, a teleport away, mode disposal). The
 *  transfer is aborted rather than left to complete for nobody — the only
 *  reader it had is this handle, and it has stopped waiting. A KTX2 rung
 *  cannot be aborted (its loader takes no signal); it disposes itself on
 *  arrival instead. */
export function cancelTierRelease(up: TextureUpgrade): void {
  const release = up.release;
  up.release = undefined;
  up.pendingReleaseBytes = undefined;
  release?.abort?.abort();
}

/** Longest side a released rung's stand-in image keeps. The width of the map
 *  every device boots on, less one 2:1 rung: a restored context re-uploads
 *  this, so what the player sees for the second the real map takes to come
 *  back is a boot-map-class globe rather than a smear. 2 MiB per rung
 *  (1024x512 RGBA) against the 33 MiB of a 4K decode and the 134 of an 8K —
 *  the accepted price of that second, and small enough that the ladder's
 *  whole set of stand-ins is a rounding error against the envelope. */
export const RESTORE_STANDIN_WIDTH = 1024;

/**
 * Close a rung's decoded source once its upload is paid.
 *
 * A texture keeps the image it was decoded from for the life of the texture,
 * because three re-uploads from it if the GL context is lost — 33 MiB of RAM
 * behind a 4K map, 134 behind an 8K one, on top of the GPU copy and invisible
 * to any measure of texture memory. On the devices this matters on that RAM
 * is the same pool as the GPU's.
 *
 * So the full image is replaced by a stand-in of itself and closed. What is
 * left can still be uploaded, so a context restore paints a soft globe rather
 * than throwing on a detached bitmap, and the mode re-fetches the real map
 * (from the service-worker cache) behind it. Fails open in every direction: a
 * browser with no `createImageBitmap`, one that rejects the resize, and one
 * that accepts the options and hands back a full-size copy anyway all keep
 * the original image — and the ledger goes on counting it, because the claim
 * this function exists to make is an accounting one and a resize nobody
 * checked is not evidence.
 */
export function releaseUpgradeSource(tex: THREE.Texture): void {
  const img = tex.image as (ImageBitmap & { close?: () => void }) | undefined;
  if (!img || typeof img.close !== 'function' || !(img.width > RESTORE_STANDIN_WIDTH)) return;
  if (typeof createImageBitmap !== 'function') return;
  const width = RESTORE_STANDIN_WIDTH;
  const height = Math.max(1, Math.round(img.height * (width / img.width)));
  let disposed = false;
  const onDispose = () => { disposed = true; };
  tex.addEventListener('dispose', onDispose);
  createImageBitmap(img, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'low',
    imageOrientation: 'none', // the flip is already baked into the source
    premultiplyAlpha: 'none',
  }).then(
    (small) => {
      tex.removeEventListener('dispose', onDispose);
      if (disposed) {
        small.close();
        return;
      }
      if (small.width !== width) {
        // A copy at the original size is not a stand-in: it costs what the
        // source cost, and swapping it in would report the source released
        // while the same bytes are still held.
        small.close();
        return;
      }
      // What it holds on the GPU stops being readable from the image the
      // moment the stand-in takes its place; stash the figure first.
      tex.userData.gpuBytes = textureGpuBytes(tex);
      tex.image = small; // does not touch the source version: no re-upload
      tex.userData.sourceReleased = true;
      tex.addEventListener('dispose', () => small.close());
      img.close();
    },
    () => { tex.removeEventListener('dispose', onDispose); },
  );
}

// --- Arrival warm goals ------------------------------------------------------
//
// The on-screen triggers are reactive: each rung's fetch starts only when the
// live disc crosses its screen fraction, which for a teleport approach means
// mid-glide — every tier lands as a fetch+decode+unsliceable-upload spike in
// front of a moving camera (the measured "touch of stuttering" on a first
// Moon approach; worst on WebKit, where the upload bill is largest). But a
// committed jump KNOWS its destination, and its hands-off glide is certain to
// cross every trigger within seconds — so a warm goal lets the ladder climb
// from jump commit instead: fetch+decode overlap the arrival veil and the
// early glide, and the uploads drain under the veil's unbounded pump or on
// the gentlest frames of the approach.
//
// Veil-neutral by construction: a goal only ever starts the same attempts the
// triggers would, and an arrival cover's wait-list (PlanetariumMode's
// coverWaitList) admits nothing but the landed pair's FIRST-tier attempts —
// so a cruise jump's veil lifts exactly as it did before warm goals existed.
//
// One-shot per tier, never a background loop: a tier that has EVER failed is
// left to the demand-driven trigger (which retries only while the body fills
// the view), so an armed goal on a device that can't decode 8K cannot keep
// re-downloading it after the player has flown away. Goals are disarmed by
// the teleport-away sweep and mode disposal.

/**
 * Arm a handle for a committed arrival: the goal is the top tier any
 * on-screen trigger could pull (fraction 1 — the body filling the viewport,
 * which a completed approach reaches). Returns false — and leaves the handle
 * unarmed — when no fetchable step remains for this device.
 */
export function armArrivalWarmGoal(up: TextureUpgrade): boolean {
  const goal = earnedUpgradeTier(up, 1);
  const next = goal ? resolveUpgradeTier(up, goal) : null;
  if (!goal || !next || tierAdmission(up, next) === 'refuse') {
    up.warmGoal = undefined;
    return false;
  }
  up.warmGoal = goal;
  return true;
}

export function disarmArrivalWarmGoal(up: TextureUpgrade): void {
  up.warmGoal = undefined;
}

/**
 * Whether a committed arrival's warm goals have outlived the arrival.
 *
 * The time-box exists for ONE case: a goal the ladder could not fit, which
 * stays armed while a release might still make room for it. That is a wait on
 * memory, and it has to end with the arrival it belongs to, or a fly-past
 * leaves a goal pumping for a body over the horizon.
 *
 * With nothing squeezing the ladder there is no such wait, and a goal is the
 * ordinary staged climb: over a slow link a cold arrival's 2K -> 4K -> 8K
 * routinely runs past any arrival grace, and cutting it short hands the
 * remaining rungs back to the on-screen triggers — which is the mid-approach
 * upload spike in front of a moving camera that the goals exist to remove.
 * So the box is not applied where it answers nothing.
 */
export function arrivalWarmGoalsExpired(
  pressure: boolean,
  travel: { doneAtMs: number | null } | null,
  nowMs: number,
  graceMs: number,
): boolean {
  if (!pressure) return false;
  if (!travel) return true; // nothing is arriving; the goals belong to no trip
  return travel.doneAtMs !== null && nowMs - travel.doneAtMs >= graceMs;
}

/**
 * One frame of goal-driven climbing: start the next rung when the handle is
 * free, exactly as an on-screen trigger would. Returns false once the goal
 * has disarmed itself — reached, unreachable, or handed back to the trigger
 * by a failure — so callers can prune their armed list.
 */
export function pumpArrivalWarmGoal(up: TextureUpgrade, nowMs: number): boolean {
  const goal = up.warmGoal;
  if (!goal) return false;
  const next = resolveUpgradeTier(up, goal);
  if (!next) {
    up.warmGoal = undefined;
    return false;
  }
  if (up.lastFailure && TIER_RANK[up.lastFailure.tier] >= TIER_RANK[next]) {
    up.warmGoal = undefined;
    return false;
  }
  // A rung that cannot fit even with the ladder empty is refused for good, so
  // the goal disarms rather than pumping a fetch that can never start. A rung
  // merely blocked by what the ladder holds right now keeps its goal: a
  // release may free the room while the arrival is still under way, and the
  // caller drops the goal when the arrival is over either way.
  if (tierAdmission(up, next) === 'refuse') {
    up.warmGoal = undefined;
    return false;
  }
  if (canAttempt(up, nowMs)) upgradeTextureOnApproach(up, next, nowMs);
  return true;
}

// --- The relief ladder -------------------------------------------------------

// Higher-resolution RELIEF tiers on disk, per normal-map key. The Moon's
// close-approach relief (2880x1440, ~8.8 MB) used to ship as the boot map —
// a third of all boot traffic for detail no spawn-distance Moon can show —
// so boot now fetches the 1440x720 map and this tier streams in on approach,
// exactly like the colour ladders above.
export const NORMAL_UPGRADE_TIERS: Record<string, TextureTier> = {
  moonNormal: '4k',
  // Earth's cloud relief has no rung, and the reason is bytes rather than
  // taste: a cloud field's normal map is nearly incompressible, so the 4K one
  // is 15.6 MB lossless and 10.3 MB near-lossless — more than twice the 4.7 MB
  // 8K COLOUR rung that doubles the resolution of the picture rather than of a
  // guess at its height. It ships at its boot resolution only, and the band a
  // rung would have added is the band the procedural detail noise covers for
  // no bytes at all (world/cloudDetailNoise). Adding one later is this line
  // plus the file — the handle below arms itself the moment it exists.
};

/** One body's streamed relief upgrade: the data-map sibling of TextureUpgrade,
 *  narrower because a relief ladder has exactly one step and no cover/arrival
 *  semantics — the boot relief is already on the mesh, so this is purely an
 *  on-approach sharpen. */
export interface NormalUpgrade {
  key: string; // PLANET_TEXTURE_FILES key
  tier: TextureTier;
  material: THREE.MeshStandardMaterial;
  state: 'idle' | 'inflight' | 'done';
  /** Wall-clock cooldown after a failure, same shape as TextureUpgrade's. */
  retryAtMs?: number;
  /** Identity of the current attempt — the relief ladder's version of the
   *  colour attempt's generation. Bumped when an attempt starts and when one
   *  is abandoned (hung-request timeout, mode disposal), so a zombie
   *  callback disposes its texture instead of writing to the material. */
  generation: number;
  /** performance.now() at which the in-flight attempt started; a request
   *  that never calls back is abandoned past UPGRADE_ATTEMPT_TIMEOUT_MS
   *  (TextureLoader cannot abort, so abandonment is by identity). */
  startedAtMs?: number;
  /** GPU bytes a decoded relief map holds while it waits for its upload —
   *  TextureUpgrade.pendingUpgradeBytes for the data ladder. It is on the
   *  device from the decode, and the material only takes it once the upload
   *  is paid, so the stretch between the two has to be in the ledger. */
  pendingBytes?: number;
}

export function makeNormalUpgrade(
  normalKey: string | undefined,
  material: THREE.MeshStandardMaterial,
): NormalUpgrade | undefined {
  if (!normalKey) return undefined;
  const tier = NORMAL_UPGRADE_TIERS[normalKey];
  if (!tier) return undefined;
  // A device that can't hold the step never arms the handle, mirroring
  // effectiveMaxTier — no per-frame trigger can then spin on it.
  if (clampTier(tier) !== tier) return undefined;
  return { key: normalKey, tier, material, state: 'idle', generation: 0 };
}

/** Abandon any in-flight relief fetch (mode disposal): the late completion
 *  then disposes itself instead of writing to a torn-down material or
 *  queueing an upload into the reset warmer. */
export function cancelNormalUpgrade(up: NormalUpgrade | undefined): void {
  if (!up || up.state !== 'inflight') return;
  up.generation++;
  up.state = 'idle';
}

/** True while the handle still has (or may retry) work — the LOD loop keeps
 *  measuring a moon for this the same way it does for an unfinished colour
 *  ladder. */
export function normalUpgradePending(up: NormalUpgrade | undefined): boolean {
  return !!up && up.state !== 'done';
}

/**
 * Rank-guarded normal-map swap — applyColorTierTexture's data-map sibling.
 * The boot relief and the 4K relief race over the network (the boot file is
 * durable and can land minutes late on a bad link), so both arrivals pass
 * through this guard: whichever rank is higher stays, the loser is disposed.
 */
export function applyNormalTierTexture(
  mat: THREE.MeshStandardMaterial,
  tex: THREE.Texture,
  rank: number,
): boolean {
  const current = (mat.userData.normalTierRank as number | undefined) ?? 0;
  if (rank <= current) {
    tex.dispose();
    return false;
  }
  const prev = mat.normalMap;
  mat.normalMap = tex;
  // The scale stays whatever the surface authored (the cloud deck's relief is
  // a brightness proxy and reads at 0.6): a rung is a sharper map of the same
  // relief, and resetting the depth on arrival would make the swap a pop.
  mat.userData.normalTierRank = rank;
  mat.needsUpdate = true;
  if (import.meta.env.DEV) smoothTraceEvent('rung', `relief ${tex.name || 'tier'} rank ${rank}`);
  if (prev) prev.dispose();
  return true;
}

/**
 * Fetch a moon's close-approach relief once its disc has earned it — the same
 * screen fraction that earns the first colour rung, since relief legibility
 * and texel legibility track the same disc size. Failure cools down and the
 * trigger asks again while the body still fills the view, exactly like the
 * colour ladder. A fetch that outlives an arrival simply applies late: the
 * warm queue uploads it off-gesture, and the moon draws it on return.
 */
export function upgradeNormalOnApproach(
  up: NormalUpgrade | undefined,
  fraction: number,
  nowMs = performance.now(),
): void {
  if (!up) return;
  if (up.state === 'inflight') {
    // A request that never calls back would otherwise hold 'inflight' for the
    // session and no retry could ever start. Past the shared attempt timeout
    // the attempt is abandoned by identity and the handle freed to try again.
    if (up.startedAtMs !== undefined && nowMs - up.startedAtMs >= UPGRADE_ATTEMPT_TIMEOUT_MS) {
      up.generation++;
      up.state = 'idle';
    } else return;
  }
  if (up.state !== 'idle') return;
  if (up.retryAtMs !== undefined && nowMs < up.retryAtMs) return;
  const at = UPGRADE_TRIGGER_FRACTION['4k'];
  if (at === undefined || !(fraction > at)) return;
  up.state = 'inflight';
  up.startedAtMs = nowMs;
  const generation = ++up.generation;
  const abandoned = () => up.generation !== generation;
  const url = resolveTextureUrl(PLANET_TEXTURE_FILES[up.key], up.tier);
  loadUpgradeTexture(
    url,
    (tex) => {
      if (abandoned()) {
        tex.dispose();
        return;
      }
      applyTextureDefaults(tex, 'data');
      const finish = () => {
        if (abandoned()) {
          tex.dispose();
          return;
        }
        // Warm first, assign second — the order the colour ladder holds, for
        // the same reason: a map big enough to be uploaded in bands draws as
        // unwritten storage until its last band lands. The relief map on disk
        // is a fraction under the size the slicer takes, so holding
        // the order here is what keeps that a question of file size rather
        // than one of what a body draws. Its bytes are resident from the
        // decode, so the envelope counts them until the swap.
        const bytes = textureGpuBytes(tex, TIER_MAP_WIDTH[up.tier]);
        up.pendingBytes = (up.pendingBytes ?? 0) + bytes;
        queueTextureWarm(tex, (outcome) => {
          const owed = (up.pendingBytes ?? 0) - bytes;
          up.pendingBytes = owed > 0 ? owed : undefined;
          if (outcome === 'disposed' || abandoned()) {
            tex.dispose();
            return;
          }
          up.state = 'done';
          applyNormalTierTexture(up.material, tex, TIER_RANK[up.tier]);
        });
      };
      const img = tex.image as { decode?: () => Promise<void> } | undefined;
      if (img && typeof img.decode === 'function') img.decode().then(finish, finish);
      else finish();
    },
    (err) => {
      if (abandoned()) return;
      up.state = 'idle';
      up.retryAtMs = performance.now() + UPGRADE_RETRY_MS;
      debugWarn('Normal-map upgrade failed', {
        key: up.key,
        tier: up.tier,
        reason: err instanceof Error ? err.message : String(err),
      });
    },
  );
}
