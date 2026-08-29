/**
 * Async mesh construction for all Planetarium bodies: planet spheres with
 * per-body texture + atmosphere glow, Earth-specific night-lights/clouds,
 * Saturn rings, major moons, and the Planetarium's Sun (bigger, animated
 * corona, optional bloom). Falls back to procedurally generated canvas
 * textures on load failure so the app never blocks on a missing file.
 */
import * as THREE from 'three';
import { type PlanetData, SUN_DATA } from './planets/planetData';
import { createPlanetRings, RING_CONFIGS, type RingShadingFx } from './planets/rings';
import {
  atmosphereVertexShader,
  atmosphereFragmentShader,
} from '../shared/shaders/atmosphere';
import {
  sunGlareFragmentShader,
  sunGlareVertexShader,
  sunLensGhostFragmentShader,
  sunLensGhostVertexShader,
  sunPhotosphereFragmentShader,
  sunPhotosphereVertexShader,
  sunProminenceFragmentShader,
  sunProminenceVertexShader,
  SUN_GLARE_EXTENT_SOLAR_RADII,
} from '../shared/shaders/sun';
import { debugWarn } from '../shared/debug';
import { applyTextureDefaults, clampTier, deviceTextureProfile, resolveTextureUrl, TIER_MAP_WIDTH, type TextureTier, type MapKind } from './world/texturePolicy';
import { augmentSurfaceMaterial, type SurfaceArchetype, type SurfaceShadingFx } from './world/surfaceShading';
import { queueTextureWarm } from './world/textureWarmer';
import { createEarthNightShellMaterial } from './world/earthNightMaterial';
import { createLensShaderUniforms } from '../shared/three/lensShader';
import { fetchTextureDurably, type DurableTextureFetch } from './world/textureRetry';
import { loadStreamedTexture, type TextureLoad } from './world/textureBitmapLoader';

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

/**
 * Decode a freshly loaded image off the render thread, then queue its GPU
 * upload for the budgeted warm pump — so the first frame that draws the map
 * pays neither a synchronous JPEG/PNG decode nor a 4K-scale upload. Planet-
 * level maps only: moon photos/paints must NOT be warmed (they'd upload tens
 * of MB of hidden moons at boot; cold arrivals upload under the arrival veil
 * instead). Fire-and-forget — if decode is unavailable or rejects, the pump
 * (or the first draw) pays the decode exactly as before.
 */
function decodeThenQueueWarm(tex: THREE.Texture): void {
  const img = tex.image as { decode?: () => Promise<void> } | undefined;
  if (!(img && typeof img.decode === 'function')) {
    queueTextureWarm(tex);
    return;
  }
  // Cancellation-aware: if the texture is disposed while its decode is still
  // pending (a rapid volume-compare pair swap disposes the texture it just
  // loaded), the deferred enqueue must be dropped. queueTextureWarm registers
  // its own dispose listener, but by then the dispose event has already fired,
  // so the dead texture would sit in the warm pump and get uploaded to GPU
  // storage that nothing ever frees. Track the disposal across the decode window
  // and skip the enqueue; live textures queue exactly as before.
  let disposed = false;
  const onDispose = () => { disposed = true; };
  tex.addEventListener('dispose', onDispose);
  const finish = () => {
    tex.removeEventListener('dispose', onDispose);
    if (!disposed) queueTextureWarm(tex);
  };
  img.decode().then(finish, finish);
}

/**
 * Run `apply` once the texture's image has been decoded off the render thread.
 * For a map that lands mid-session the body is already on screen, so the swap
 * must not put a synchronous JPEG/PNG decode on the frame that first draws it.
 * Falls straight through where `decode` is unavailable.
 *
 * Disposal-aware across the decode window, exactly as decodeThenQueueWarm is:
 * the apply callbacks hand textures to materials and to the warm pump, and a
 * texture disposed while its decode was pending would be pinned into GPU
 * storage nothing ever frees.
 */
function afterDecode(tex: THREE.Texture, apply: () => void): void {
  const img = tex.image as { decode?: () => Promise<void> } | undefined;
  if (!(img && typeof img.decode === 'function')) {
    apply();
    return;
  }
  let disposed = false;
  const onDispose = () => { disposed = true; };
  tex.addEventListener('dispose', onDispose);
  const finish = () => {
    tex.removeEventListener('dispose', onDispose);
    if (!disposed) apply();
  };
  img.decode().then(finish, finish);
}

/**
 * Moon photo/normal uploads are warmed only for systems the player is landed
 * in. Those moons are about to be drawn, so the upload is inevitable and
 * warming moves it off the gesture frame at no extra VRAM — while warming
 * every system's photos would push tens of MB of hidden moons to the GPU
 * (the big base maps are 4096×2048). Frustum culling is why the landed case
 * matters: a landed camera frames the parent, so an off-screen moon's first
 * draw — and its whole upload bill — otherwise waits for exactly the gesture
 * that points the camera at it (vantage swap, Look up).
 */
let warmEligibleMoonParents: ReadonlySet<string> = new Set();

export function setWarmEligibleMoonParents(parents: ReadonlySet<string>): void {
  warmEligibleMoonParents = parents;
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
};

// Planets with a real measured elevation-derived normal map (linear data map):
// they drop the colour-as-bump fallback in favour of the true relief.
const PLANET_NORMAL_KEYS: Record<string, string> = {
  Mars: 'marsNormal',
};

// Fallback colors if textures fail
const FALLBACK_COLORS: Record<string, string> = {
  mercury: '#7a7168',
  venus: '#c4b08a',
  earthDay: '#2a4a88',
  earthNight: '#050510',
  earthClouds: '#ffffff',
  earthBump: '#444444',
  mars: '#9a4a2a',
  jupiter: '#a89060',
  saturn: '#bfb08a',
  uranus: '#6aa0b8',
  neptune: '#2a4ab8',
  pluto: '#9a8e7a',
};

// Atmosphere configs per planet. Drives the single-scatter shell: a Rayleigh
// day-limb tint that warms toward `sunsetColor` at the terminator, plus a Mie
// forward-scatter halo (`mieColor`, asymmetry `mieG`). `intensity` is overall
// brightness, `scale` the shell radius relative to the planet. `haloStrength`
// scales the fringe where it shows past the limb over black space: thin-shell
// worlds over a surface keep it higher so the fringe reads at all (Earth 0.75,
// Mars 0.5), while cloud-deck Venus and the all-atmosphere giants keep it low so
// their limb can't ring against black.
export interface AtmosphereConfig {
  dayColor: [number, number, number];
  sunsetColor: [number, number, number];
  mieColor: [number, number, number];
  rayleighStrength: number;
  mieStrength: number;
  mieG: number;
  power: number;
  intensity: number;
  haloStrength: number;
  scale: number;
}

// Sun's physical radius in AU — for solar angular radius (penumbra width) at a planet.
const SUN_RADIUS_AU = 695_700 / 149_597_870.7;

// Exported so the volume-compare mode's ghost shell reads the same tuning —
// a hand-kept copy would drift the moment these numbers get touched.
export const ATMOSPHERES: Record<string, AtmosphereConfig> = {
  // Venus reads as a cloud deck, not a surface under thin air: front-lit it
  // shows limb darkening and a crisp edge (no ring in flyby photos); its one
  // dramatic geometry is the back-lit ring of light, carried here by the Mie
  // term. Shell kept near the real haze height (~1.5% of the radius).
  Venus: {
    dayColor: [0.95, 0.85, 0.55], sunsetColor: [1.0, 0.7, 0.4], mieColor: [1.0, 0.93, 0.78],
    rayleighStrength: 0.3, mieStrength: 2.2, mieG: 0.78, power: 1.2, intensity: 0.5, haloStrength: 0.3, scale: 1.025,
  },
  Earth: {
    dayColor: [0.3, 0.55, 1.0], sunsetColor: [1.0, 0.45, 0.22], mieColor: [1.0, 0.96, 0.9],
    rayleighStrength: 1.1, mieStrength: 0.5, mieG: 0.83, power: 1.15, intensity: 0.6, haloStrength: 0.75, scale: 1.02,
  },
  Mars: {
    dayColor: [0.78, 0.6, 0.5], sunsetColor: [0.6, 0.55, 0.65], mieColor: [0.85, 0.72, 0.6],
    rayleighStrength: 0.3, mieStrength: 0.5, mieG: 0.7, power: 1.5, intensity: 0.4, haloStrength: 0.5, scale: 1.014,
  },
  Jupiter: {
    dayColor: [0.8, 0.7, 0.52], sunsetColor: [0.85, 0.6, 0.4], mieColor: [0.9, 0.83, 0.68],
    rayleighStrength: 0.55, mieStrength: 0.5, mieG: 0.65, power: 1.6, intensity: 0.3, haloStrength: 0.12, scale: 1.015,
  },
  Saturn: {
    dayColor: [0.82, 0.74, 0.54], sunsetColor: [0.85, 0.62, 0.42], mieColor: [0.92, 0.85, 0.68],
    rayleighStrength: 0.5, mieStrength: 0.45, mieG: 0.65, power: 1.6, intensity: 0.28, haloStrength: 0.12, scale: 1.015,
  },
  // Uranus and Neptune intentionally have no atmosphere shell. They are all
  // atmosphere — no surface for a thin scattering layer to sit above — and at
  // 19–30 AU the sunlight is far too weak to throw a visible limb glow. The
  // gas-giant limb darkening on the body itself carries the soft edge.
};

/** Atmosphere shell scale by planet, for consumers that must treat the shell
 *  as the planet's outermost surface: the shells render BackSide at full
 *  alpha on close approach, so a ship or camera parked against the SOLID
 *  radius would sit inside the glow (Jupiter's shell alone is ~1,072 km
 *  thick). Derived from the one ATMOSPHERES config — never restate a scale. */
export const ATMOSPHERE_SHELL_SCALES: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(ATMOSPHERES).map(([name, config]) => [name, config.scale]),
);

/**
 * Hand-off for a texture that arrives after `loadTexture` already resolved its
 * procedural fallback. By then the promise is spent, and the material that
 * wants the map does not exist until the awaiting caller resumes — so a late
 * arrival can land BEFORE anyone is listening. The slot holds it and replays it
 * the instant the swap registers; neither order drops the texture, which is
 * what used to leave a body wearing procedural speckle for the whole session.
 * Typed structurally so the hand-off ordering is testable without a GL texture.
 */
export interface LateTextureSlot<T extends { dispose(): void } = THREE.Texture> {
  /** A real texture landed after the promise settled. */
  deliver(tex: T): void;
  /** Register the swap onto the live material; a held arrival replays at once. */
  connect(apply: (tex: T) => void): void;
}

export function createLateTextureSlot<T extends { dispose(): void } = THREE.Texture>(): LateTextureSlot<T> {
  let swap: ((tex: T) => void) | null = null;
  let held: T | null = null;
  return {
    deliver(tex) {
      if (swap) {
        swap(tex);
        return;
      }
      // Only one fetch is ever in flight per slot (a retry starts only after
      // the previous attempt failed), so this cannot normally fire — but a
      // superseded hold must be freed rather than silently dropped.
      held?.dispose();
      held = tex;
    },
    connect(apply) {
      swap = apply;
      const pending = held;
      held = null;
      if (pending) apply(pending);
    },
  };
}

/**
 * The failure count the procedural fallback resolves ON, letting the world
 * build without waiting further. The first failure is absorbed — one blip
 * retries fast enough (half a second) that the real map still arrives for
 * construction with no visible swap; the second means the connection is
 * actually down, and nothing is gained by holding the whole scene for it.
 * The fetch itself is never abandoned: it keeps climbing its ladder and hands
 * the map to the late slot whenever it lands.
 */
export const FALLBACK_AFTER_FAILURES = 2;

export interface LoadTextureOptions {
  /** How long before the procedural fallback resolves. The fetch keeps going. */
  timeoutMs?: number;
  /** Where a texture that arrives after the fallback resolved should land. */
  late?: LateTextureSlot;
  /** Fallback constructor seam. The default builds the procedural canvas,
   *  which needs a 2D context — tests running without a DOM inject a plain
   *  texture here so the timeout/late/retry machinery itself stays testable. */
  makeFallback?: () => THREE.Texture;
}

/**
 * Load one planet-level texture by key, resolving a grey procedural fallback on
 * timeout or a second failure so a caller never blocks on a missing file.
 * Returns a FRESH texture on every call — the caller owns it and must dispose it
 * itself (the volume-compare mode loads container/filler maps this way and
 * disposes them on each pair change).
 *
 * Neither a slow file nor a failing one is abandoned at the timeout: three's
 * loader cannot be aborted and the map is still the right one, so the fetch
 * keeps retrying and hands the result to `options.late` once the caller's
 * material exists. Callers that pass no slot have nowhere to put a late
 * arrival, so there the fetch stops once the fallback has resolved.
 */
export function loadTexture(
  key: string,
  tier: TextureTier = '2k',
  kind: MapKind = 'color',
  options: LoadTextureOptions = {},
): Promise<THREE.Texture> {
  const { timeoutMs = 8000, late, makeFallback = () => createFallbackTexture(key, kind) } = options;
  const file = PLANET_TEXTURE_FILES[key];
  if (!file) return Promise.resolve(makeFallback());
  const url = resolveTextureUrl(file, tier);

  return new Promise((resolve) => {
    let settled = false;
    let fetch: DurableTextureFetch | null = null;
    let cancelWanted = false;
    // Once the fallback has resolved and there is no late seam to deliver
    // through, another attempt could only fetch a map nobody can use.
    const stopFetching = () => {
      cancelWanted = true;
      fetch?.cancel();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      debugWarn('Planet texture timeout', { key, url });
      resolve(makeFallback());
      if (!late) stopFetching();
    }, timeoutMs);

    fetch = fetchTextureDurably({
      url,
      context: { map: 'planet texture', key },
      onLoad: (tex) => {
        clearTimeout(timer);
        applyTextureDefaults(tex, kind);
        if (!settled) {
          settled = true;
          // loadTexture serves planet-level maps only (bases + Earth details),
          // which are unconditionally on screen — always safe to warm.
          decodeThenQueueWarm(tex);
          resolve(tex);
          return;
        }
        if (late) late.deliver(tex);
        else tex.dispose();
      },
      onFailure: (_err, attemptsFailed) => {
        if (settled) {
          if (!late) stopFetching();
          return;
        }
        if (attemptsFailed < FALLBACK_AFTER_FAILURES) return;
        // Give the caller the procedural map so the scene can be built; the
        // real one lands on the late slot whenever the network comes back.
        settled = true;
        clearTimeout(timer);
        debugWarn('Planet texture fallback activated', { key, url, attempt: attemptsFailed });
        resolve(makeFallback());
        if (!late) stopFetching();
      },
    });
    if (cancelWanted) fetch.cancel(); // a failure that arrived synchronously
  });
}

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
  /** GPU bytes the map a swap has DECODED but not yet assigned will hold.
   *  Between the decode and the assignment both maps are on the device, so
   *  both are in the ledger — otherwise the transient is spent behind the
   *  back of the admission test and the tiles are never trimmed for it. */
  pendingReleaseBytes?: number;
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

// Every 8K colour tier ships GPU-compressed (KTX2/UASTC, mip chain baked by
// tools/gen-ktx2.mjs): the raw upload of a 33MP RGBA map is the largest
// unsliceable main-thread bill in the app — measured as THE dropped frame
// right after a Moon teleport — while a compressed upload takes a few
// milliseconds and stays compressed in VRAM (~43 MiB instead of ~171). The
// wire cost is real (UASTC+zstd is a few times the webp), paid only when a
// session earns the tier and cached by the service worker thereafter. The
// override is consulted only while a KTX2 loader is bound, so tests and a
// session whose transcoder failed to load never ask for a container they
// cannot read.
//
// `webp` says whether a classic map of the same resolution also ships, which
// is what an unbound loader falls back to. Where it does not, the rung is
// ABSENT rather than merely expensive: the ladder's top drops to the rung
// below (or the boot map) instead of fetching a URL that 404s, and the
// memory arithmetic never charges an uncompressed 8K for a map that does not
// exist in that form. Only the two maps that predate the compressed pipeline
// carry a webp twin — new 8K rungs ship as one file, because a second copy of
// a 33MP map on disk is 4 MB nothing with a working transcoder fetches.
export interface CompressedRung {
  /** Filename under the tier's folder — resolveTextureUrl adds the rest. */
  file: string;
  /** A classic map of the same resolution ships beside it. */
  webp: boolean;
}
export const TIER_FILE_OVERRIDES: Record<string, Partial<Record<TextureTier, CompressedRung>>> = {
  moon: { '8k': { file: 'moon.ktx2', webp: true } },
  earthClouds: { '8k': { file: 'earth-clouds.ktx2', webp: true } },
  earthDay: { '8k': { file: 'earth-day.v2.ktx2', webp: false } },
  earthNight: { '8k': { file: 'earth-night.v2.ktx2', webp: false } },
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
 * GPU bytes an equirect colour map of this width holds: its texel count (a
 * 2:1 map) times four bytes — or one, for a GPU-compressed upload, which is
 * what a transcoded map costs — plus a third for its mip chain.
 */
export function equirectMapGpuBytes(width: number, compressed = false): number {
  if (!(width > 0)) return 0;
  return Math.round(width * (width / 2) * (compressed ? 1 : 4) * (4 / 3));
}

/**
 * GPU bytes one colour map holds, read from the texture that is really there
 * rather than from the tier's nominal size: a GPU-compressed rung holds
 * exactly the blocks its container carries (a quarter to an eighth of the raw
 * map, and the ratio is the format's, not ours to assume), and a map is not
 * always the width its tier is named for — Earth's day map boots wider than
 * its tier name. `nominalWidth` is the fallback for a texture with no
 * readable image; 0 asks for no fallback.
 *
 * A rung whose decoded source has been closed after its upload keeps the
 * figure stashed on the texture (userData.gpuBytes): what is on the GPU has
 * not changed, only what is left in RAM to read it from. Same convention as
 * the sector tiles, whose bitmaps are closed for the same reason.
 *
 * Takes a plain texture, not a handle, so the same measurement runs on a
 * decoded CANDIDATE before it is applied — the moment the admission test has
 * to weigh it, and the moment a handle-shaped reader can say nothing at all.
 */
export function textureGpuBytes(tex: THREE.Texture | null | undefined, nominalWidth = 0): number {
  const map = tex as
    | (THREE.Texture & { isCompressedTexture?: boolean; mipmaps?: Array<{ data?: { byteLength?: number } } | null> })
    | null
    | undefined;
  if (!map) return 0;
  const stashed = map.userData?.gpuBytes;
  if (typeof stashed === 'number') return stashed;
  if (map.isCompressedTexture) {
    let bytes = 0;
    for (const level of map.mipmaps ?? []) bytes += level?.data?.byteLength ?? 0;
    if (bytes > 0) return bytes;
  }
  const img = map.image as { width?: unknown; height?: unknown } | undefined;
  const w = img && typeof img.width === 'number' ? img.width : 0;
  const h = img && typeof img.height === 'number' ? img.height : 0;
  if (w > 0 && h > 0) return Math.round(w * h * (map.isCompressedTexture ? 1 : 4) * (4 / 3));
  return equirectMapGpuBytes(nominalWidth, map.isCompressedTexture === true);
}

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
  // once, and the transient is real device memory whoever is asking.
  const pending = up.pendingReleaseBytes ?? 0;
  if (!up.appliedTier) return pending; // the boot map is not the ladder's weight
  return appliedTierGpuBytes(up) + retainedSourceBytes(materialColorMap(up.material)) + pending;
}

/** Bytes of decoded image a texture is still holding in RAM. Only the bitmap
 *  path retains one; a compressed texture's mip data is what
 *  `textureGpuBytes` already measures, and counting it twice would make one
 *  honest measurement look like two. */
export function retainedSourceBytes(tex: THREE.Texture | null | undefined): number {
  const map = tex as (THREE.Texture & { isCompressedTexture?: boolean }) | null | undefined;
  if (!map || map.isCompressedTexture) return 0;
  // A rung whose source has been closed keeps a small stand-in to re-upload
  // from after a context loss — 2 MiB against the 33 MiB it replaced, and a
  // couple of rungs' worth across the whole scene.
  if (map.userData?.sourceReleased === true) return 0;
  const img = map.image as { width?: unknown; height?: unknown; close?: unknown } | undefined;
  if (!img || typeof img.close !== 'function') return 0; // an <img> element, not a bitmap
  const w = typeof img.width === 'number' ? img.width : 0;
  const h = typeof img.height === 'number' ? img.height : 0;
  return w > 0 && h > 0 ? w * h * 4 : 0;
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

/**
 * Silhouette detail upgrade, the geometry sibling of the colour ladders above:
 * a body's sphere is rebuilt at a fine segment count once it grows large
 * enough on screen for its polygon chords to show.
 *
 * A sphere of N longitude segments cuts its own silhouette into flat chords
 * whose sagitta — how far each chord sits inside the true circle — is
 * (1 − cos(π/N)) × the on-screen radius. At 64 segments that is 0.0012r, which
 * reaches a quarter-pixel around 400px of radius and a visible three-quarter
 * pixel around 625px: past there the disc reads faintly scalloped, which is
 * what an "oval" close-up actually is. At 256 segments the same figure is
 * 7.5e-5r — still under half a pixel with the body at 5000px of radius, i.e.
 * below what antialiasing already smooths away at any framing the app offers.
 */
export interface GeometryUpgrade {
  /** Every mesh whose silhouette is this body's silhouette, each with the
   *  radius its sphere was built at — the globe, plus any shell drawn just
   *  above it that draws a hard edge of its own. */
  spheres: readonly { mesh: THREE.Mesh; radiusAU: number }[];
  /** One-way: the fine spheres are built once and kept for the session. */
  applied: boolean;
}

// Screen diameter past which the coarsest silhouette in use starts to show its
// chords. Set by the coarsest, not the average: a body built at more segments
// crosses it having shown nothing, and pays one rebuild it did not strictly
// need — cheaper than carrying a second threshold per segment tier.
const GEOMETRY_UPGRADE_AT_PX = 1250;
const GEOMETRY_UPGRADE_SEGMENTS = 256;

export function makeGeometryUpgrade(
  spheres: readonly { mesh: THREE.Mesh; radiusAU: number }[],
): GeometryUpgrade {
  return { spheres, applied: false };
}

/** Has this body grown large enough for its chords to show, with the fine
 *  spheres not yet built? */
export function needsGeometryUpgrade(up: GeometryUpgrade, diameterPx: number): boolean {
  return !up.applied && diameterPx > GEOMETRY_UPGRADE_AT_PX;
}

/**
 * Rebuild a body's spheres at the fine segment count. Built here rather than at
 * creation because most bodies never come close enough to need one, and 65k
 * triangles per body at boot would be paid by every body in the system.
 *
 * The swap is safe to make on a body already on screen and already textured.
 * Assigning `geometry` touches nothing about the object's transform, so the
 * render-curve inflation carried on mesh.scale and the body's rotation phase
 * both survive it; SphereGeometry lays out the same equirectangular UVs at any
 * segment count, so whatever colour map has already won stays registered
 * exactly as it was; and the mesh is never without geometry between the two
 * statements, so no frame can draw a half-built body.
 */
export function upgradeGeometryOnApproach(up: GeometryUpgrade, diameterPx: number): boolean {
  if (!needsGeometryUpgrade(up, diameterPx)) return false;
  up.applied = true;
  for (const { mesh, radiusAU } of up.spheres) {
    const previous = mesh.geometry;
    mesh.geometry = new THREE.SphereGeometry(
      radiusAU,
      GEOMETRY_UPGRADE_SEGMENTS,
      GEOMETRY_UPGRADE_SEGMENTS / 2,
    );
    previous.dispose();
  }
  return true;
}

/**
 * Whether a body's per-frame LOD measurement could possibly act, given a
 * conservative OVERestimate of its screen diameter. This is the skip gate in
 * front of the full 32-ray footprint: it asks the very predicates the loop
 * would feed (`needsGeometryUpgrade`, `earnedUpgradeTier`, the procedural
 * re-render threshold), so a threshold the overestimate does not cross is one
 * the real — smaller — footprint cannot cross either. Feeding it anything
 * other than a true overestimate breaks that guarantee and can strand a body
 * on its boot map. `proceduralThresholdPx` is null when the procedural
 * re-render path is not in play for this body this frame.
 */
export function lodMeasurementRelevant(
  geo: GeometryUpgrade,
  ups: readonly TextureUpgrade[],
  estimatedDiameterPx: number,
  canvasHeight: number,
  proceduralThresholdPx: number | null,
): boolean {
  if (needsGeometryUpgrade(geo, estimatedDiameterPx)) return true;
  if (proceduralThresholdPx !== null && estimatedDiameterPx > proceduralThresholdPx) return true;
  const fraction = estimatedDiameterPx / Math.max(canvasHeight, 1);
  for (const up of ups) {
    if (upgradeComplete(up)) continue;
    // Both earned and resolve grow with the fraction, so a tier the
    // OVERestimate cannot resolve into a fetchable step is one the real
    // footprint cannot either — e.g. a Moon already on 4K stops pulling
    // measurements until the estimate reaches into the 8K band.
    const earned = earnedUpgradeTier(up, fraction);
    if (earned !== null && resolveUpgradeTier(up, earned) !== null) return true;
  }
  return false;
}

/** Rank guard for the colour maps (procedural floor = 0, 2K = 2, 4K = 4):
 *  strictly higher wins, so a late 2K arrival can never downgrade a 4K that
 *  already won the race, and a real map always beats the procedural floor. */
export function shouldApplyColorTier(currentRank: number, arrivingRank: number): boolean {
  return arrivingRank > currentRank;
}

/** The rank a material starts at, given the texture its construction received.
 *  loadTexture hands back either the real map or a procedural fallback, and the
 *  guard above can only protect the real one if the two are told apart — an
 *  unstamped material reads as the floor, so a fallback and a real 2K would
 *  otherwise both look replaceable by anything. A material built with no map
 *  at all is the floor too: the first arrival is the best thing it has. */
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
 * directly rather than via loadTexture so a failed fetch leaves the current
 * map in place instead of resolving a grey fallback. Cheap to call every
 * frame — canAttempt is the whole guard, and it no-ops on a GPU that can't
 * hold the step, so it never thrashes there.
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
        const room = admitTier(up, tier, textureGpuBytes(tex, TIER_MAP_WIDTH[tier]));
        if (room !== 'admit') {
          up.attempt = undefined;
          if (room === 'refuse') up.warmGoal = undefined;
          tex.dispose();
          return;
        }
        up.attempt = undefined;
        up.appliedTier = tier;
        if (up.lastFailure && TIER_RANK[tier] >= TIER_RANK[up.lastFailure.tier]) {
          up.lastFailure = undefined;
        }
        up.belowBandSinceMs = undefined;
        if (applyColorTierTexture(up.material, tex, TIER_RANK[tier])) {
          queueTextureWarm(tex, (outcome) => { if (outcome === 'warmed') releaseUpgradeSource(tex); });
        }
        up.material.userData.photoLoaded = true; // keep the lazy painter off it
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
 * the swap happens on a decoded texture or not at all — so a release is
 * invisible except as a softening, and never re-opens the arrival cover: the
 * material keeps a real map and `photoLoaded` through every step.
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
        // Decoded and about to be assigned: for these few statements the
        // device holds the map being given back AND the one replacing it, so
        // the transient goes into the ledger first and comes out with the
        // high map. Whoever shares the envelope trims for it synchronously,
        // rather than discovering the peak a frame after it has passed.
        up.pendingReleaseBytes = textureGpuBytes(tex, TIER_MAP_WIDTH[toTier]);
        opts.onLedgerChange?.();
        releaseColorTier(up.material, tex, TIER_RANK[toTier]);
        up.pendingReleaseBytes = undefined;
        queueTextureWarm(tex, (outcome) => { if (outcome === 'warmed') releaseUpgradeSource(tex); });
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

// Higher-resolution RELIEF tiers on disk, per normal-map key. The Moon's
// close-approach relief (2880x1440, ~8.8 MB) used to ship as the boot map —
// a third of all boot traffic for detail no spawn-distance Moon can show —
// so boot now fetches the 1440x720 map and this tier streams in on approach,
// exactly like the colour ladders above.
const NORMAL_UPGRADE_TIERS: Record<string, TextureTier> = {
  moonNormal: '4k',
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
  mat.normalScale.set(1, 1);
  mat.userData.normalTierRank = rank;
  mat.needsUpdate = true;
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
        up.state = 'done';
        if (applyNormalTierTexture(up.material, tex, TIER_RANK[up.tier])) queueTextureWarm(tex);
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

function createFallbackTexture(key: string, kind: MapKind = 'color'): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  if (kind === 'data') {
    // A failed data map (roughness / bump) should read neutral, not as colour
    // noise: flat mid-grey in linear space.
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 256, 128);
    const tex = new THREE.CanvasTexture(canvas);
    applyTextureDefaults(tex, 'data');
    tex.userData.proceduralFallback = true;
    return tex;
  }

  const baseColor = FALLBACK_COLORS[key] || '#888888';
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, 256, 128);

  const imageData = ctx.getImageData(0, 0, 256, 128);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 30;
    data[i] = Math.max(0, Math.min(255, data[i] + noise));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
  }

  // For gas giants, add horizontal bands
  if (key === 'jupiter' || key === 'saturn') {
    for (let y = 0; y < 128; y++) {
      const bandIntensity = Math.sin(y * 0.35) * 25 + Math.sin(y * 0.8) * 10;
      for (let x = 0; x < 256; x++) {
        const idx = (y * 256 + x) * 4;
        data[idx] = Math.max(0, Math.min(255, data[idx] + bandIntensity));
        data[idx + 1] = Math.max(0, Math.min(255, data[idx + 1] + bandIntensity * 0.8));
        data[idx + 2] = Math.max(0, Math.min(255, data[idx + 2] + bandIntensity * 0.5));
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  applyTextureDefaults(tex, 'color');
  // Marks the floor: a material built on this map must rank as replaceable, so
  // the real texture still wins when it arrives after the load timeout.
  tex.userData.proceduralFallback = true;
  return tex;
}

/**
 * The atmosphere glow ShaderMaterial — the ONE place the shader's uniform
 * block is assembled from an AtmosphereConfig, shared with the volume-compare
 * ghost so a uniform added to shared/shaders/atmosphere.ts is wired here and
 * nowhere else. Callers own geometry, scale and render order.
 */
export function createAtmosphereMaterial(
  config: AtmosphereConfig,
  planetRadius: number,
  opts?: { initialAlpha?: number; initialSunDir?: THREE.Vector3 },
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereFragmentShader,
    uniforms: {
      uSunDirWorld: { value: opts?.initialSunDir?.clone() ?? new THREE.Vector3(0, 0, 1) },
      alphaScale: { value: opts?.initialAlpha ?? 0.0 },
      uDayColor: { value: new THREE.Vector3(...config.dayColor) },
      uSunsetColor: { value: new THREE.Vector3(...config.sunsetColor) },
      uMieColor: { value: new THREE.Vector3(...config.mieColor) },
      uRayleighStrength: { value: config.rayleighStrength },
      uMieStrength: { value: config.mieStrength },
      uMieG: { value: config.mieG },
      uPower: { value: config.power },
      uIntensity: { value: config.intensity },
      uHaloStrength: { value: config.haloStrength },
      uPlanetRadius: { value: planetRadius },
    },
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function createAtmosphereGlow(radiusAU: number, config: AtmosphereConfig): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radiusAU * config.scale, 64, 32);
  // alphaScale starts at 0: faded out until the per-frame distance feed runs
  // (no first-frame flash); uSunDirWorld is fed per frame the same way.
  return new THREE.Mesh(geo, createAtmosphereMaterial(config, radiusAU));
}

// Earth's companion shells sit just above the globe: the night lights hug the
// surface, the cloud deck floats a little higher. Both are drawn at the same
// segment count as the globe, so all three silhouettes coarsen and refine
// together.
const EARTH_NIGHT_SHELL_SCALE = 1.001;
const EARTH_CLOUD_SHELL_SCALE = 1.01;

export interface PlanetMesh {
  group: THREE.Group;
  mesh: THREE.Mesh;
  data: PlanetData;
  rings?: THREE.Mesh;
  ringFx?: RingShadingFx; // per-frame sun-direction feed for the ring shadow/translucency
  atmosphere?: THREE.Mesh;
  nightMesh?: THREE.Mesh;
  nightMaterial?: THREE.ShaderMaterial; // For Earth night lights
  /** Unscaled radius the night shell is built at — what anything that has to
   *  sit ON the shell (its streamed sector tiles) builds its geometry at, so
   *  the shell's height above the globe is stated once. */
  nightRadiusAU?: number;
  cloudsMesh?: THREE.Mesh;
  fx?: SurfaceShadingFx;
  /** Colour-map ladders streamed in on close approach — one per upgradable
   *  material, so Earth's globe and its cloud shell each carry their own.
   *  Empty for a body with no higher tier on disk. */
  textureUpgrades: TextureUpgrade[];
  /** Silhouette detail, rebuilt on close approach — the globe and every shell
   *  that draws an edge at the body's own radius. */
  geometryUpgrade: GeometryUpgrade;
  /** Live heliocentric position (AU), stashed by the mode's rebuild pass.
   *  Typed here (not on userData) so the dozen per-frame readers share one
   *  nullability story instead of each restating the shape through a cast.
   *  Absent until the first rebuild. */
  worldPosAU?: { x: number; y: number; z: number };
  /** Per-frame world velocity (AU/s on the capped frame dt) for the
   *  governor's moving-body credit; zeroed across clock discontinuities.
   *  Absent until the first velocity pass. */
  worldVelAUPerS?: { x: number; y: number; z: number };
}

// Icy / high-albedo moons get the icy night-fill (and, later, a specular ice
// response); dark or rocky bodies (our Moon, Io, Phobos, Deimos, Hyperion,
// Phoebe) fall through to the airless floor.
const ICY_MOONS = new Set([
  'Europa', 'Ganymede', 'Callisto', 'Titan', 'Mimas', 'Enceladus', 'Tethys',
  'Dione', 'Rhea', 'Iapetus', 'Miranda', 'Ariel', 'Umbriel', 'Titania',
  'Oberon', 'Triton', 'Charon',
]);

// planetArchetype/moonArchetype are exported for the volume-compare fillers,
// so a body's night-fill + limb character match everywhere it renders.
export function planetArchetype(planet: PlanetData): SurfaceArchetype {
  if (planet.name === 'Earth') return 'earth';
  if (planet.isGasGiant) return 'gas';
  if (planet.name === 'Mercury' || planet.name === 'Pluto') return 'airless';
  // Venus's visible "surface" is an optically thick cloud deck — it limb-
  // darkens like a giant, not like bare rock.
  if (planet.name === 'Venus') return 'gas';
  return 'rocky'; // Mars
}

export function moonArchetype(moon: MoonData): SurfaceArchetype {
  return ICY_MOONS.has(moon.name) ? 'icy' : 'airless';
}

/**
 * Register the late-arrival swap for a detail map (night lights, clouds, bump,
 * roughness) — the maps that hang off their own slot rather than the ranked
 * colour map. Decode first (the body is on screen by the time one of these
 * lands), then assign before freeing the fallback it replaces, so no frame
 * samples a disposed texture.
 */
export function connectLateDetailMap(
  slot: LateTextureSlot,
  material: THREE.Material,
  read: () => THREE.Texture | null,
  write: (tex: THREE.Texture) => void,
): void {
  slot.connect((tex) => afterDecode(tex, () => {
    const prev = read();
    write(tex);
    material.needsUpdate = true;
    if (prev && prev !== tex) prev.dispose();
    queueTextureWarm(tex);
  }));
}

/**
 * Register the late arrival for a detail map that is ALSO a ranked colour map
 * — the cloud deck, which hangs off a slot like the other three but carries
 * its own upgrade handle on the same material.
 *
 * It cannot take the direct-assign path above: a boot-tier fetch that
 * recovered late would overwrite (and free) a higher tier the approach had
 * already installed, and the handle — still reporting that tier applied —
 * would never fetch it again, leaving the deck downgraded for the session.
 * Routing through the rank guard makes the recovered arrival lose instead.
 */
export function connectLateColorMap(
  slot: LateTextureSlot,
  material: THREE.Material,
  rank: number,
): void {
  slot.connect((tex) => afterDecode(tex, () => {
    // The guard owns the whole swap: assign before dispose, and disposing the
    // arrival itself when it lost the race.
    if (applyColorTierTexture(material, tex, rank)) queueTextureWarm(tex);
  }));
}

/** The Earth-specific slot set, one per detail map. */
export interface EarthLateSlots {
  night: LateTextureSlot;
  clouds: LateTextureSlot;
  bump: LateTextureSlot;
  roughness: LateTextureSlot;
}

/**
 * Wire all four Earth detail slots onto their materials. One function so the
 * complete set is pinnable as a unit — a slot left unconnected would hold its
 * late arrival forever, leaving Earth on flat city lights, a blank cloud deck,
 * or a noise-free ocean for the session while leaking the real texture.
 */
export function wireEarthLateDetail(
  slots: EarthLateSlots,
  nightMat: THREE.ShaderMaterial,
  cloudMat: THREE.MeshStandardMaterial,
  earthMat: THREE.MeshStandardMaterial,
): void {
  // The night lights are a colour map on a shader shell: it keeps the texture
  // in a uniform rather than in `map`, so this is where that uniform is named
  // and the boot map's rank stamped — the late arrival below and the tier
  // ladder then swap it through the one rank guard, and a boot map that
  // recovered late loses to a tier the approach already installed rather than
  // overwriting (and freeing) it. The cloud deck is the same shape, in `map`.
  nightMat.userData.colorMapUniform = 'nightTexture';
  nightMat.userData.colorTierRank = initialColorTierRank(
    nightMat.uniforms.nightTexture.value as THREE.Texture | null,
  );
  connectLateColorMap(slots.night, nightMat, TIER_RANK['2k']);
  connectLateColorMap(slots.clouds, cloudMat, TIER_RANK['2k']);
  connectLateDetailMap(slots.bump, earthMat, () => earthMat.bumpMap, (tex) => { earthMat.bumpMap = tex; });
  connectLateDetailMap(
    slots.roughness, earthMat,
    () => earthMat.roughnessMap,
    (tex) => { earthMat.roughnessMap = tex; },
  );
}

export async function createPlanetMesh(planet: PlanetData): Promise<PlanetMesh> {
  const group = new THREE.Group();
  group.name = planet.name;

  // One late-delivery slot per map. A texture that misses loadTexture's timeout
  // still belongs on this body, but by the time it lands the promise is spent
  // and the material does not exist yet — the slots carry it across to the
  // materials built below, in whichever order the two happen.
  const surfaceLate = createLateTextureSlot();
  const earthLate = planet.name === 'Earth'
    ? {
        night: createLateTextureSlot(),
        clouds: createLateTextureSlot(),
        bump: createLateTextureSlot(),
        roughness: createLateTextureSlot(),
      }
    : null;

  const surfaceTexturePromise = loadTexture(planet.textureKey, '2k', 'color', { late: surfaceLate });
  const earthDetailTexturePromise = earthLate
    ? Promise.all([
        loadTexture('earthNight', '2k', 'color', { late: earthLate.night }),
        loadTexture('earthClouds', '2k', 'color', { late: earthLate.clouds }),
        // Height map: linear, not sRGB. Kind is what types each late swap too.
        loadTexture('earthBump', '2k', 'data', { late: earthLate.bump }),
        // Ocean-glint roughness: linear.
        loadTexture('earthRoughness', '2k', 'data', { late: earthLate.roughness }),
      ])
    : null;
  const texture = await surfaceTexturePromise;

  // Boot detail, sized to keep first load cheap across a whole system. A body
  // the player actually closes on rebuilds finer through its geometryUpgrade.
  const segments = planet.radiusKm > 50000 ? 128 : planet.radiusKm > 5000 ? 96 : 64;

  const geo = new THREE.SphereGeometry(planet.radiusAU, segments, segments / 2);

  // Use texture as both color map and bump map for surface detail
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    // Gas giants drop the colour-as-bump hack — embossing cloud bands as relief
    // just reads as fake crinkle; their banding lives entirely in the albedo.
    bumpMap: planet.isGasGiant ? null : texture,
    bumpScale: planet.radiusAU * 0.01, // subtle bump
    roughness: planet.name === 'Mercury' || planet.name === 'Mars' ? 0.95 : 0.8,
    metalness: 0.05,
  });
  // Rank the map construction actually got, so every later arrival (the late
  // stream below, the 4K upgrade on approach) can tell a real map from the
  // procedural fallback instead of reading both as the floor.
  mat.userData.colorTierRank = initialColorTierRank(texture);
  // Saturn's dense rings shadow its globe; hand the surface shader the annulus
  // so it can trace the cast shadow. Other giants' rings are too faint to bother.
  const ringCfg = RING_CONFIGS[planet.name];
  const ringShadow = ringCfg?.style === 'saturn'
    ? { inner: planet.radiusAU * ringCfg.innerFactor, outer: planet.radiusAU * ringCfg.outerFactor }
    : undefined;
  const sunTan = SUN_RADIUS_AU / planet.semiMajorAxisAU; // solar angular radius at the planet
  const fx = augmentSurfaceMaterial(mat, planetArchetype(planet), ringShadow, sunTan);
  // Higher colour tiers on close approach, for the keys that have them (see
  // TEXTURE_UPGRADE_TIERS). The boot map above is the floor; updateBodyLOD
  // walks the ladder from there.
  const textureUpgrades: TextureUpgrade[] = [];
  const surfaceUpgrade = makeTextureUpgrade(planet.textureKey, mat);
  if (surfaceUpgrade) textureUpgrades.push(surfaceUpgrade);

  // Real elevation-derived normal map where one exists (Mars/MOLA): it replaces
  // the colour-as-bump fallback. No procedural stand-in — the surface stays
  // flat until the real relief lands, however long the fetch takes.
  const planetNormalKey = PLANET_NORMAL_KEYS[planet.name];
  if (planetNormalKey) {
    mat.bumpMap = null;
    const normalUrl = resolveTextureUrl(PLANET_TEXTURE_FILES[planetNormalKey], '2k');
    fetchTextureDurably({
      url: normalUrl,
      context: { map: 'planet normal', name: planet.name },
      onLoad: (nrm) => {
        applyTextureDefaults(nrm, 'data');
        // Decode off-thread first: a normal map landing mid-session must not
        // put a synchronous PNG decode on the frame that adopts it.
        afterDecode(nrm, () => {
          mat.normalMap = nrm;
          // Softened: the MOLA rainbow-decoded relief is noisy and over-embossed,
          // which reads as harsh facets on crater rims up close. Halve it.
          mat.normalScale.set(0.5, 0.5);
          mat.needsUpdate = true;
          queueTextureWarm(nrm); // planet-level (always on screen) — safe to warm
        });
      },
    });
  }

  // A base map that missed the load timeout lands here rather than on the
  // floor. Rank 2 = the 2K tier, so an on-approach 4K that already won is not
  // downgraded; the same seam re-points the colour-as-bump alias and frees the
  // fallback it replaces.
  surfaceLate.connect((tex) => afterDecode(tex, () => {
    if (applyColorTierTexture(mat, tex, 2)) queueTextureWarm(tex);
  }));

  const mesh = new THREE.Mesh(geo, mat);
  group.add(mesh);

  // Atmosphere glow for planets with atmospheres
  let atmosphere: THREE.Mesh | undefined;
  const atmosConfig = ATMOSPHERES[planet.name];
  if (atmosConfig) {
    atmosphere = createAtmosphereGlow(planet.radiusAU, atmosConfig);
    atmosphere.name = `${planet.name}Atmosphere`;
    group.add(atmosphere);
  }

  // Earth-specific enhancements: night lights + clouds
  let nightMaterial: THREE.ShaderMaterial | undefined;
  let nightMesh: THREE.Mesh | undefined;
  let cloudsMesh: THREE.Mesh | undefined;

  if (earthLate && earthDetailTexturePromise) {
    const [nightTex, cloudTex, bumpTex, roughTex] = await earthDetailTexturePromise;

    const nightGeo = new THREE.SphereGeometry(planet.radiusAU * EARTH_NIGHT_SHELL_SCALE, segments, segments / 2);
    // Bound locally as well as returned: the late-detail wiring below needs the
    // material itself, and the returned handle is optional. Built through the
    // same factory the night SECTORS use, so a tile drawn over the shell is the
    // shell's own program on a sharper map rather than a second version of it.
    const nightMat = createEarthNightShellMaterial(nightTex);
    nightMaterial = nightMat;
    nightMesh = new THREE.Mesh(nightGeo, nightMat);
    group.add(nightMesh);

    const cloudGeo = new THREE.SphereGeometry(planet.radiusAU * EARTH_CLOUD_SHELL_SCALE, segments, segments / 2);
    const cloudMat = new THREE.MeshStandardMaterial({
      map: cloudTex,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      roughness: 1.0,
    });
    // Ranked like the globe's map: the deck takes tier arrivals from two
    // directions — its upgrade handle and its late slot — and both have to be
    // able to tell the map construction got from the procedural fallback.
    cloudMat.userData.colorTierRank = initialColorTierRank(cloudTex);
    cloudsMesh = new THREE.Mesh(cloudGeo, cloudMat);
    group.add(cloudsMesh);
    // The cloud deck is its own colour map on its own shell, so it carries its
    // own handle: the globe and the clouds sharpen independently.
    const cloudsUpgrade = makeTextureUpgrade('earthClouds', cloudMat);
    if (cloudsUpgrade) textureUpgrades.push(cloudsUpgrade);

    const earthMat = mesh.material as THREE.MeshStandardMaterial;
    earthMat.bumpMap = bumpTex;
    earthMat.bumpScale = planet.radiusAU * 0.02;
    // Ocean glint: the map drives roughness (ocean glossy, land/ice matte), so a
    // tight solar specular reads as the blue-marble sun glint on the seas. Water
    // is a dielectric — keep metalness 0; the gloss alone makes the highlight.
    earthMat.roughnessMap = roughTex;
    earthMat.roughness = 1.0;
    earthMat.metalness = 0.0;
    earthMat.needsUpdate = true;

    // Detail maps that missed their timeout replace the fallback in place —
    // otherwise Earth keeps flat grey city lights, a blank cloud deck, or a
    // noise-free ocean for the session. This also declares where the night
    // shell keeps its colour map, which the handle below then sharpens.
    wireEarthLateDetail(earthLate, nightMat, cloudMat, earthMat);
    // The night lights climb their own ladder on their own shell, like the
    // cloud deck: 500 m Black Marble where the boot map is 20 km per pixel.
    const nightUpgrade = makeTextureUpgrade('earthNight', nightMat);
    if (nightUpgrade) textureUpgrades.push(nightUpgrade);
  }

  let rings: THREE.Mesh | undefined;
  let ringFx: RingShadingFx | undefined;
  if (ringCfg) {
    const built = createPlanetRings(planet.radiusAU, ringCfg, sunTan);
    rings = built.mesh;
    ringFx = built.fx;
    group.add(rings);
  }

  // Every mesh that draws a hard edge at the body's own radius refines
  // together — up close the cloud deck, not the globe, IS Earth's silhouette.
  // The atmosphere shell is left out: it renders soft additive alpha with no
  // edge for a chord to break, so its own segment count never shows.
  const geometryUpgrade = makeGeometryUpgrade([
    { mesh, radiusAU: planet.radiusAU },
    ...(nightMesh ? [{ mesh: nightMesh, radiusAU: planet.radiusAU * EARTH_NIGHT_SHELL_SCALE }] : []),
    ...(cloudsMesh ? [{ mesh: cloudsMesh, radiusAU: planet.radiusAU * EARTH_CLOUD_SHELL_SCALE }] : []),
  ]);

  return {
    group, mesh, data: planet, rings, ringFx, atmosphere, nightMesh, nightMaterial,
    nightRadiusAU: nightMesh ? planet.radiusAU * EARTH_NIGHT_SHELL_SCALE : undefined,
    cloudsMesh, fx, textureUpgrades, geometryUpgrade,
  };
}

export function createPlanetariumSun(useBloom = true): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Sun';

  // HDR white-light photosphere. The shader's object-space granulation is
  // seamless at the poles and longitude wrap; exposure decides how much of
  // that detail survives when the camera points at the star.
  // 128×64 segments: the cruise governor parks the camera at 1.2 photosphere
  // radii, where a 64-segment silhouette shows visible polygon chords. The Sun
  // carries no geometry upgrade beyond that — its limb is never a hard edge to
  // break into chords, being drawn under an additive corona and glare stack
  // that washes the photosphere boundary out at exactly the framings where a
  // planet's chords would start to read.
  const geo = new THREE.SphereGeometry(SUN_DATA.radiusAU, 128, 64);
  const sunMat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      uAtmosphereMix: { value: 0 },
      uAtmosphereColor: { value: new THREE.Color(1, 0.55, 0.24) },
      // Submersion fade for the interior fog (1 outside; the controller drives
      // it from depth below the photosphere).
      uInteriorFade: { value: 1 },
      // Proximity whiteout (0 far, 1 = full-frame saturated white); the
      // controller drives it from distance outside and submersion inside.
      uWhiteout: { value: 0 },
    },
    vertexShader: sunPhotosphereVertexShader,
    fragmentShader: sunPhotosphereFragmentShader,
  });

  const mesh = new THREE.Mesh(geo, sunMat);
  mesh.name = 'SunCore';
  group.add(mesh);

  // Interior fog shell: the same sphere drawn back-face-only, visible only
  // while the camera is below the photosphere (the controller toggles it).
  // A separate mesh — not DoubleSide on the main material — because at 1 AU
  // the whole Sun spans less than one depth-buffer step, so exterior back
  // fragments could patchily win over the granulation; this shell simply never
  // rasterizes outside. Sharing the uniforms object keeps its time/fade in
  // sync with the main material for free. Its depth write is what keeps the
  // starfield from showing through a star's core.
  const interiorMat = new THREE.ShaderMaterial({
    uniforms: sunMat.uniforms,
    defines: { SUN_INTERIOR: 1 },
    vertexShader: sunPhotosphereVertexShader,
    fragmentShader: sunPhotosphereFragmentShader,
    side: THREE.BackSide,
  });
  const interior = new THREE.Mesh(geo, interiorMat);
  interior.name = 'Sun interior';
  interior.visible = false;
  group.add(interior);

  const prominenceMat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      uCloseVisibility: { value: 0 },
    },
    vertexShader: sunProminenceVertexShader,
    fragmentShader: sunProminenceFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const prominences = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_DATA.radiusAU * 1.065, 96, 48),
    prominenceMat,
  );
  prominences.name = 'Sun chromosphere';
  prominences.renderOrder = 7;
  group.add(prominences);

  // One analytic point-spread profile replaces two baked canvas gradients.
  // Its vertex shader billboards it; the controller supplies the visible
  // photosphere fraction so occultations affect glare and exposure together.
  const glareExtent = SUN_GLARE_EXTENT_SOLAR_RADII;
  const glareMat = new THREE.ShaderMaterial({
    uniforms: {
      uExtent: { value: glareExtent },
      uVisibleFraction: { value: 1 },
      // Independent foreground transmission for the player ship. Celestial
      // visibility keeps owning eclipse/corona state; this factor only removes
      // direct camera-optics light whose source rays the nearby hull blocks.
      uShipSunVisibility: { value: 1 },
      uGlareStrength: { value: useBloom ? 1.05 : 1.35 },
      uPointLike: { value: 0 },
      uCameraFx: { value: 0 },
      uEclipseLike: { value: 0 },
      uOccluderRadii: { value: 1 },
      uOccluderShade: { value: 0 },
      uOccluderOffsetSr: { value: new THREE.Vector2() },
      // Exposed-crescent centroid (solar radii) and authored diamond-ring
      // strength; both 0 unless an occluder is on the disc, so an un-occluded Sun
      // draws with neither term.
      uGlareCentroidSr: { value: new THREE.Vector2() },
      uDiamondOccluderSr: { value: new THREE.Vector2() },
      uBeadCarveDepth: { value: 0 },
      uDiamondRing: { value: 0 },
      // Screen angle of the Sun's rotation axis and how much the corona's
      // shape should lean on it; driven per frame from the IAU pole.
      uSunPoleScreenAngle: { value: 0 },
      uSunPoleAnisotropy: { value: 0 },
      // Contact chromosphere on each limb, on their own wall-time envelopes.
      uChromoAnti: { value: 0 },
      uChromoToward: { value: 0 },
      uExposureScale: { value: 1 },
      uEmergenceFlash: { value: 0 },
      uAtmosphereMix: { value: 0 },
      uAtmosphereColor: { value: new THREE.Color(1, 0.55, 0.24) },
      uMinHalfSizePx: { value: useBloom ? 18 : 22 },
      uViewportHeight: { value: Math.max(window.innerHeight, 1) },
      ...createLensShaderUniforms(),
      // Wide veiling-glare wash. uVeilStrength is its peak HDR contribution at
      // frame centre; uVeilWarmth mixes a whisper of warmth into the outer fade.
      // uVeilAmt (occlusion x distance-falloff x huge-disc cutoff) and uVeilHalfPx
      // (the billboard half-size in px the veil needs) are driven per frame.
      uVeilStrength: { value: 1.4 },
      uVeilWarmth: { value: 0.12 },
      uVeilAmt: { value: 0 },
      uVeilHalfPx: { value: 0 },
      // Fraction of the fading starburst kept alive once the disc is resolved,
      // so a mid-range Sun still throws modest diffraction spikes.
      uSpikeSustain: { value: 0.45 },
      // Veil diffraction-arm decay lengths (CSS px) and coefficient, driven
      // per frame so the arms shrink with the veil's reach and fade as the disc
      // resolves. The controller sizes the billboard to the same decay lengths.
      uArmDecayPx: { value: 0 },
      uArmDecayYPx: { value: 0 },
      uArmCoeff: { value: 0 },
    },
    vertexShader: sunGlareVertexShader,
    fragmentShader: sunGlareFragmentShader,
    transparent: true,
    depthWrite: false,
    // Screen-space camera glare, not a scene object: it must not be z-cut by
    // an occluding limb. Occultation energy arrives through uVisibleFraction,
    // which the controller derives from the same bodies the depth test saw.
    depthTest: false,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
    side: THREE.DoubleSide,
  });
  const glare = new THREE.Mesh(
    new THREE.PlaneGeometry(SUN_DATA.radiusAU * glareExtent * 2, SUN_DATA.radiusAU * glareExtent * 2),
    glareMat,
  );
  glare.name = 'Sun glare';
  glare.renderOrder = 8;
  // The vertex shader's minimum-pixel boost renders far outside the geometry
  // bounds in the outer system; default culling would pop the glint at the
  // viewport edge. Behind-camera vertices still clip.
  glare.frustumCulled = false;
  group.add(glare);

  // Three tiny clip-space quads make one restrained optical ghost train. They
  // share a draw call and never touch a full-screen buffer; the controller
  // supplies the Sun's NDC position and fades them outside camera-like scales.
  const ghostPositions: number[] = [];
  const ghostFactors: number[] = [];
  const ghostSizes: number[] = [];
  const ghostTints: number[] = [];
  const corners = [
    -1, -1, 1, -1, 1, 1,
    -1, -1, 1, 1, -1, 1,
  ];
  const ghosts = [
    { factor: -0.28, sizePx: 24, tint: 0 },
    { factor: -0.62, sizePx: 16, tint: 1 },
    { factor: 0.22, sizePx: 11, tint: 2 },
  ];
  for (const ghost of ghosts) {
    for (let i = 0; i < corners.length; i += 2) {
      ghostPositions.push(corners[i], corners[i + 1], 0);
      ghostFactors.push(ghost.factor);
      ghostSizes.push(ghost.sizePx);
      ghostTints.push(ghost.tint);
    }
  }
  const ghostGeo = new THREE.BufferGeometry();
  ghostGeo.setAttribute('position', new THREE.Float32BufferAttribute(ghostPositions, 3));
  ghostGeo.setAttribute('aGhostFactor', new THREE.Float32BufferAttribute(ghostFactors, 1));
  ghostGeo.setAttribute('aGhostSizePx', new THREE.Float32BufferAttribute(ghostSizes, 1));
  ghostGeo.setAttribute('aGhostTint', new THREE.Float32BufferAttribute(ghostTints, 1));
  const ghostMat = new THREE.ShaderMaterial({
    uniforms: {
      uSunNdc: { value: new THREE.Vector2() },
      uViewportPx: { value: new THREE.Vector2(Math.max(window.innerWidth, 1), Math.max(window.innerHeight, 1)) },
      uGhostStrength: { value: 0 },
      uExposureScale: { value: 1 },
      uEmergenceFlash: { value: 0 },
      uAtmosphereMix: { value: 0 },
      uAtmosphereColor: { value: new THREE.Color(1, 0.55, 0.24) },
      ...createLensShaderUniforms(),
    },
    vertexShader: sunLensGhostVertexShader,
    fragmentShader: sunLensGhostFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
  });
  const lensGhosts = new THREE.Mesh(ghostGeo, ghostMat);
  lensGhosts.name = 'Sun lens ghosts';
  lensGhosts.renderOrder = 9;
  lensGhosts.frustumCulled = false;
  group.add(lensGhosts);

  const light = new THREE.PointLight(0xfff5e0, 3, 0, 0.3);
  group.add(light);

  group.userData.sunMaterial = sunMat;
  group.userData.sunInteriorMesh = interior;
  group.userData.sunProminenceMaterial = prominenceMat;
  group.userData.sunGlareMaterial = glareMat;
  group.userData.sunLensGhostMaterial = ghostMat;
  return group;
}

// Sun halo tiers: per-sprite scale (× photosphere radius) and opacity. With
// bloom the pass supplies the near-Sun spread, so the sprites stay tight and
// lean; without it they hold more of the glow themselves. The tier is baked
// from the hardware bloom capability at construction and re-applied when a dev
// bloom toggle flips at runtime, so a toggled state matches the real build.
const SUN_GLOW_TIERS = {
  bloom: { innerScale: 2.6, innerOpacity: 0.7, outerScale: 4.5, outerOpacity: 0.30 },
  noBloom: { innerScale: 3.8, innerOpacity: 0.8, outerScale: 6.5, outerOpacity: 0.42 },
} as const;

/**
 * Apply a Sun halo tier to a group built by createPlanetariumSun, using the
 * inner/outer glow sprite refs stashed in its userData.
 */
export function applySunGlowTier(sunGroup: THREE.Group, useBloom: boolean): void {
  const inner = sunGroup.userData.sunGlowInner as THREE.Sprite | undefined;
  const outer = sunGroup.userData.sunGlowOuter as THREE.Sprite | undefined;
  const tier = useBloom ? SUN_GLOW_TIERS.bloom : SUN_GLOW_TIERS.noBloom;
  if (inner) {
    inner.scale.setScalar(SUN_DATA.radiusAU * tier.innerScale * 2);
    (inner.material as THREE.SpriteMaterial).opacity = tier.innerOpacity;
  }
  if (outer) {
    outer.scale.setScalar(SUN_DATA.radiusAU * tier.outerScale * 2);
    (outer.material as THREE.SpriteMaterial).opacity = tier.outerOpacity;
  }
}

// ---- Moon meshes ----

import { type MoonData, getMoonsByPlanet } from './planets/moonData';
import {
  classifyMoonArchetype,
  generateCraters,
  hashString,
  moonTextureSize,
  seededRng,
  valueNoise,
  fractalNoise,
} from './world/proceduralMoon';

export interface MoonMesh {
  mesh: THREE.Mesh;
  data: MoonData;
  /** Procedural surface textures generated yet? Painted lazily (MoonPainter);
   *  a moon is never made visible before this is true. */
  painted: boolean;
  fx?: SurfaceShadingFx;
  /** Colour-map ladder streamed in on close approach — one entry for a
   *  photo-textured moon with higher tiers on disk, empty for every other. */
  textureUpgrades: TextureUpgrade[];
  /** Close-approach relief tier, for the moons whose measured normal map
   *  ships one (the Moon). Undefined when no tier exists on disk or the
   *  device can't hold it. */
  normalUpgrade?: NormalUpgrade;
  /** Silhouette detail, rebuilt on close approach. Every moon carries one:
   *  the Observatory frames even a tiny moon to a fixed screen fraction, so
   *  size at boot says nothing about the silhouette it will be asked to
   *  draw. */
  geometryUpgrade: GeometryUpgrade;
  /** Per-frame moon-dot cache (updateMoonPositions → updateMoonDotsForCamera):
   *  the sun-visible fraction from this frame's eclipse shading, and the dot's
   *  final screen alpha / size that the label pass reads for its sub-pixel
   *  gating and offset. Transient — meaningful only for a shown moon. */
  dotSunVisibleFraction?: number;
  dotScreenAlpha?: number;
  /** The same dot alpha and point size computed with illumination forced full
   *  (phase and eclipse shading both 1). Every other fade — parent-dominance
   *  gate, system edge, disc handoff, light-grasp knee — composes into them
   *  identically, so they differ from the real pair by illumination alone: the
   *  label pass names a moon by what it would show fully lit, yet a name still
   *  dies where the system stops being shown.
   *
   *  The label contest bids alpha × size, and that bid must not move with the
   *  terminator, or the contest simply hands the flicker to whichever neighbour
   *  loses the slot. So BOTH factors of a dark moon's bid come from the lit
   *  twin. The alpha alone is not enough: an unlit dot's apparent magnitude is
   *  +Infinity, which clamps the star mapping's point size to its floor, so a
   *  dark moon bidding its real size still sinks by several times.
   *
   *  Zeroed with dotScreenAlpha whenever the dot is hidden. */
  dotLitScreenAlpha?: number;
  dotLitScreenSizePx?: number;
  dotScreenSizePx?: number;
  /** Per-frame effective-radius screen projection, shared between the
   *  occlusion-disc pass and the label pass (same centre, same rendered-size
   *  radius, same camera — whichever runs first this frame measures, the other
   *  reuses). `frame` is PlanetariumMode's frameStamp; the centre fields
   *  (x/y/ndcZ) are radius-independent by the projection's pinned invariant.
   *  Allocated once per moon, transient like the dot cache above. */
  effProj?: {
    frame: number; x: number; y: number; ndcZ: number;
    radiusPx: number; footprintX: number; footprintY: number;
  };
  /** Whether the label pass actually drew this moon's name last frame. The pick
   *  list is built before the labels are placed, so it reads a one-frame-old
   *  answer — imperceptible at label timescales, and it keeps the rule exact: a
   *  moon dark enough to have no dot is aimable only where you can read it. */
  labelDisplayed?: boolean;
  /** Sticky `.unlit` style bit across frames (the hysteresis band lives in
   *  MOON_LABEL_PLACEMENT_PARAMS), so the dark style cannot pulse with a dot
   *  flickering across a single threshold. */
  labelUnlit?: boolean;
  /** Applied-shading limiter state (world/shadeSmoothing): the smoothed
   *  sun-visible fraction actually shown, its wall-clock stamp, and whether the
   *  blood-moon tint is held while the smoothed value is still under the red
   *  floor. Transient presentation state — the astronomy stays raw. */
  shadeSmoothed?: number;
  shadeStampMs?: number;
  shadeUmbraSticky?: boolean;
}

/**
 * Generate a moon's procedural colour + bump textures synchronously, without
 * building any mesh or material — the exact classifier/noise/crater pipeline
 * the lazy painter uses. Exported so the volume-compare mode can grab a
 * procedural moon's colour map directly; constructing a moon mesh for its
 * material instead would race ~60 async photo loads against disposed materials.
 * The caller owns both returned textures and disposes them itself.
 */
export function createMoonTextures(
  color: number,
  name: string,
  radiusKm: number,
): { colorTex: THREE.Texture; bumpTex: THREE.Texture } {
  const { width: textureWidth, height: textureHeight } = moonTextureSize(radiusKm);
  const seed = hashString(name);
  const rng = seededRng(seed);

  // Base colour + archetype (the exact brightness/hue classifier, shared with
  // the GPU texturer via proceduralMoon so both paths agree).
  const baseColor = new THREE.Color(color);
  const { isIcy, isVolcanic } = classifyMoonArchetype(color);

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = textureWidth;
  colorCanvas.height = textureHeight;
  const ctx = colorCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = textureWidth;
  bumpCanvas.height = textureHeight;
  const bCtx = bumpCanvas.getContext('2d')!;

  // Generate per-pixel with fractal noise
  const colorData = ctx.createImageData(textureWidth, textureHeight);
  const bumpData = bCtx.createImageData(textureWidth, textureHeight);
  const colorPixels = colorData.data;
  const bumpPixels = bumpData.data;

  const baseR = baseColor.r * 255;
  const baseG = baseColor.g * 255;
  const baseB = baseColor.b * 255;

  // The image buffers are Uint8ClampedArray, so writes clamp to 0–255 and round
  // on assignment — the per-channel Math.max/min below are redundant. ny and the
  // row base depend only on y; hoist them out of the inner loop.
  for (let y = 0; y < textureHeight; y++) {
    const ny = y / textureHeight;
    const rowBase = y * textureWidth;
    for (let x = 0; x < textureWidth; x++) {
      const idx = (rowBase + x) * 4;
      const nx = x / textureWidth;

      // Large-scale terrain variation (3 octaves)
      const terrain = fractalNoise(nx * 6, ny * 6, seed, 3);
      // Medium detail
      const detail = fractalNoise(nx * 18, ny * 18, seed + 500, 2);
      // Fine grain
      const grain = valueNoise(nx * 50, ny * 50, seed + 1000);

      // Combine: terrain drives large color shifts, detail adds texture
      let variation: number;
      if (isIcy) {
        // Icy: smoother, subtle cracks
        variation = terrain * 0.15 + detail * 0.08 + grain * 0.03;
      } else if (isVolcanic) {
        // Volcanic: splotchy, high contrast
        variation = terrain * 0.3 + detail * 0.12 + grain * 0.04;
      } else {
        // Rocky: moderate cratering and noise
        variation = terrain * 0.22 + detail * 0.1 + grain * 0.04;
      }

      // Apply variation as brightness shift centered around 0
      const shift = (variation - 0.15) * 255;
      colorPixels[idx] = baseR + shift;
      colorPixels[idx + 1] = baseG + shift;
      colorPixels[idx + 2] = baseB + shift;
      colorPixels[idx + 3] = 255;

      // Bump map: terrain + detail as height
      const height = (terrain * 0.7 + detail * 0.3) * 255;
      bumpPixels[idx] = height;
      bumpPixels[idx + 1] = height;
      bumpPixels[idx + 2] = height;
      bumpPixels[idx + 3] = 255;
    }
  }

  // Add craters (seeded; placement shared with the GPU texturer).
  const craters = generateCraters(rng, textureWidth, textureHeight, isIcy);
  for (const { cx, cy, cr } of craters) {
    for (let dy = -Math.ceil(cr); dy <= Math.ceil(cr); dy++) {
      for (let dx = -Math.ceil(cr); dx <= Math.ceil(cr); dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > cr) continue;
        const px = ((cx + dx) % textureWidth + textureWidth) % textureWidth;
        const py = Math.max(0, Math.min(textureHeight - 1, cy + dy));
        const idx = (py * textureWidth + px) * 4;
        const t = dist / cr;
        if (t < 0.75) {
          // Dark crater floor
          const darken = (1 - t / 0.75) * 30;
          colorPixels[idx] = colorPixels[idx] - darken;
          colorPixels[idx + 1] = colorPixels[idx + 1] - darken;
          colorPixels[idx + 2] = colorPixels[idx + 2] - darken;
          bumpPixels[idx] = bumpPixels[idx] - darken * 2;
          bumpPixels[idx + 1] = bumpPixels[idx]; bumpPixels[idx + 2] = bumpPixels[idx];
        } else {
          // Bright rim
          const brighten = (1 - (t - 0.75) / 0.25) * 20;
          colorPixels[idx] = colorPixels[idx] + brighten;
          colorPixels[idx + 1] = colorPixels[idx + 1] + brighten;
          colorPixels[idx + 2] = colorPixels[idx + 2] + brighten;
          bumpPixels[idx] = bumpPixels[idx] + brighten * 2;
          bumpPixels[idx + 1] = bumpPixels[idx]; bumpPixels[idx + 2] = bumpPixels[idx];
        }
      }
    }
  }

  ctx.putImageData(colorData, 0, 0);
  bCtx.putImageData(bumpData, 0, 0);

  const colorTex = new THREE.CanvasTexture(colorCanvas);
  applyTextureDefaults(colorTex, 'color');
  const bumpTex = new THREE.CanvasTexture(bumpCanvas);
  applyTextureDefaults(bumpTex, 'data');
  return { colorTex, bumpTex };
}

/**
 * Generate and attach a moon's procedural surface textures. Idempotent — the
 * lazy painter and the visibility gate both call this and may reach the same
 * moon more than once. If the real photo already streamed in (photoLoaded),
 * only the bump is applied; the procedural colour is the floor that shows
 * until/unless a photo wins, so a moon whose JPG fails stays textured, not grey.
 */
export function paintMoonTextures(moon: MoonMesh): void {
  if (moon.painted) return;
  const mat = moon.mesh.material as THREE.MeshStandardMaterial;
  const { colorTex, bumpTex } = createMoonTextures(moon.data.color, moon.data.name, moon.data.radiusKm);
  // A real measured normal map (e.g. the Moon's LOLA relief) supersedes the
  // procedural bump — don't stack both.
  if (mat.userData.hasRealNormal) {
    bumpTex.dispose();
  } else {
    mat.bumpMap = bumpTex;
    mat.bumpScale = Math.max(moon.data.radiusAU * 0.15, 0.0000005);
  }
  if (mat.userData.photoLoaded) {
    colorTex.dispose();
  } else {
    mat.map = colorTex;
    mat.color.setRGB(1, 1, 1);
  }
  mat.needsUpdate = true;
  moon.painted = true;
}

// Moons with a real measured elevation-derived normal map (linear data map,
// keyed into PLANET_TEXTURE_FILES). Only Earth's Moon today (LOLA via gen-maps);
// others fall back to the procedural bump.
const MOON_NORMAL_KEYS: Record<string, string> = {
  Moon: 'moonNormal',
};

/**
 * Shader-variant warm-up probes. Moon materials start as bare placeholders;
 * their maps arrive later (procedural paint, streamed photo, measured normal),
 * and each arrival flips USE_MAP/USE_BUMPMAP/USE_NORMALMAP — a different
 * shader program than the placeholder's. Compiling the scene at boot therefore
 * builds the wrong variants, and the real ones still link mid-gesture (the
 * measured surface-view stall). These three tiny meshes carry exactly the
 * post-arrival combinations; the augmentation is byte-identical GLSL across
 * bodies (uniforms only), so one compile per combination covers every moon.
 * Add to the scene before renderer.compileAsync, remove + dispose after it
 * settles. The group starts invisible for ordinary frames; activation briefly
 * makes it visible only for a one-pixel, load-veiled real draw on drivers where
 * compileAsync cannot guarantee a completed link.
 */
export function createShaderWarmupProbes(): { group: THREE.Group; dispose: () => void } {
  const makeTex = (kind: MapKind): THREE.Texture => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 1, 1);
    const tex = new THREE.CanvasTexture(canvas);
    applyTextureDefaults(tex, kind); // colour space is part of the program key
    return tex;
  };
  const geo = new THREE.SphereGeometry(1e-9, 4, 2);
  const group = new THREE.Group();
  group.visible = false;
  const mats: THREE.MeshStandardMaterial[] = [];
  const combos: Array<Partial<Record<'map' | 'bumpMap' | 'normalMap', THREE.Texture>>> = [
    { map: makeTex('color'), bumpMap: makeTex('data') }, // painted moon / photo + procedural bump
    { map: makeTex('color'), normalMap: makeTex('data') }, // photo + measured normal (the Moon)
    { map: makeTex('color') }, // photo arrived before the paint
  ];
  for (const combo of combos) {
    const mat = new THREE.MeshStandardMaterial(combo);
    augmentSurfaceMaterial(mat, 'rocky'); // archetype is uniform-only — any value keys the same program
    mats.push(mat);
    group.add(new THREE.Mesh(geo, mat));
  }
  return {
    group,
    dispose: () => {
      for (const mat of mats) {
        mat.map?.dispose();
        mat.bumpMap?.dispose();
        mat.normalMap?.dispose();
        mat.dispose();
      }
      geo.dispose();
    },
  };
}

/**
 * Create moon meshes for a planet. Moons orbit at their real orbital radius
 * (in AU). The surface texture is NOT generated here — it's painted lazily
 * (paintMoonTextures / MoonPainter) so first load isn't blocked on ~65 canvas
 * generations; meshes start with a flat placeholder material.
 */
export function createMoonMeshes(planetName: string): MoonMesh[] {
  const moons = getMoonsByPlanet(planetName);
  const result: MoonMesh[] = [];

  for (const moonData of moons) {
    // Observatory frames every moon to a fixed screen fraction regardless of
    // size, so even tiny moons need a smooth limb up close — the old 16/24
    // segment tiers faceted visibly. Floor at 48 (cheap: ~2k tris); big moons 64.
    // Boot detail only: a moon the player observes rebuilds finer through its
    // geometryUpgrade, whatever bucket its radius put it in here.
    const segments = moonData.radiusKm > 1000 ? 64 : 48;
    const geo = new THREE.SphereGeometry(moonData.radiusAU, segments, segments / 2);

    // Flat placeholder. A moon is never made visible before it's painted (the
    // gate in updateMoonPositions), so this colour is a safety floor, not a
    // state the player normally sees.
    const archetype = moonArchetype(moonData);
    const mat = new THREE.MeshStandardMaterial({
      color: moonData.color,
      // Ice is a low-roughness dielectric (broad moving glint); rock is matte.
      // Neither is metallic.
      roughness: archetype === 'icy' ? 0.4 : 0.9,
      metalness: 0,
      emissive: new THREE.Color(moonData.color),
      emissiveIntensity: 0.03,
    });
    const fx = augmentSurfaceMaterial(mat, archetype);

    // Real elevation-derived normal map (linear), where one exists. The flag
    // goes up with the request, not with the arrival, so the lazy painter never
    // spends a bump on a moon that has measured relief coming; the moon reads
    // smooth until that relief lands (a local file, so normally the same beat
    // it is painted — an outage is what stretches it).
    const normalKey = MOON_NORMAL_KEYS[moonData.name];
    if (normalKey) {
      mat.userData.hasRealNormal = true;
      const normalUrl = resolveTextureUrl(PLANET_TEXTURE_FILES[normalKey], '2k');
      fetchTextureDurably({
        url: normalUrl,
        context: { map: 'moon normal', name: moonData.name },
        onLoad: (tex) => {
          applyTextureDefaults(tex, 'data');
          // Decode off-thread before assigning (the moon simply keeps drawing
          // smooth until the normal is cheap to draw); warm the upload only
          // when the player is landed in this system. Rank-guarded: on a bad
          // link this durable boot fetch can land AFTER the close-approach
          // relief tier, and must not downgrade it.
          afterDecode(tex, () => {
            if (applyNormalTierTexture(mat, tex, TIER_RANK['2k']) && warmEligibleMoonParents.has(planetName)) {
              queueTextureWarm(tex);
            }
          });
        },
      });
    }

    // Photo-textured moons (Moon, Io, …) stream their real image; on arrival it
    // replaces the procedural colour through the same rank swap the 4K upgrade
    // uses, whether that arrival is at boot or minutes later. Until then the
    // painted texture is what shows — a failed fetch never puts grey on a moon.
    // photoLoaded tells the painter not to clobber a photo that already won.
    const photoFile = moonData.textureKey ? PLANET_TEXTURE_FILES[moonData.textureKey] : undefined;
    const photoUrl = photoFile ? resolveTextureUrl(photoFile, '2k') : undefined;
    if (photoUrl) {
      fetchTextureDurably({
        url: photoUrl,
        context: { map: 'moon photo', name: moonData.name },
        onLoad: (tex) => {
          applyTextureDefaults(tex, 'color');
          // Decode off-thread before the rank swap — the procedural colour
          // stays until the photo is cheap to draw, so the swap can't freeze
          // a frame on a synchronous JPEG decode.
          afterDecode(tex, () => {
            mat.userData.photoLoaded = true;
            // Boot-tier rank: a later tier upgrade supersedes this, and a tier
            // that already won can't be downgraded by a late-arriving boot map.
            if (applyColorTierTexture(mat, tex, TIER_RANK['2k']) && warmEligibleMoonParents.has(planetName)) {
              queueTextureWarm(tex);
            }
          });
        },
      });
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = moonData.name;
    mesh.visible = false; // hidden until painted and the player is close

    const photoUpgrade = makeTextureUpgrade(moonData.textureKey, mat);
    result.push({
      mesh,
      data: moonData,
      painted: false,
      fx,
      textureUpgrades: photoUpgrade ? [photoUpgrade] : [],
      normalUpgrade: makeNormalUpgrade(normalKey, mat),
      geometryUpgrade: makeGeometryUpgrade([{ mesh, radiusAU: moonData.radiusAU }]),
    });
  }

  return result;
}
