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
  earthNightVertexShader,
  earthNightFragmentShader,
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
import { applyTextureDefaults, clampTier, resolveTextureUrl, type TextureTier, type MapKind } from './world/texturePolicy';
import { augmentSurfaceMaterial, type SurfaceArchetype, type SurfaceShadingFx } from './world/surfaceShading';
import { queueTextureWarm } from './world/textureWarmer';

const loader = new THREE.TextureLoader();
loader.crossOrigin = 'anonymous';

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
// CC BY 4.0 + NASA; Pluto is New Horizons / USGS, see TEXTURE_4K_KEYS). The
// filename stays resolution-agnostic; world/texturePolicy maps it through the
// active tier to a URL.
const PLANET_TEXTURE_FILES: Record<string, string> = {
  mercury: 'mercury.jpg',
  venus: 'venus.jpg',
  earthDay: 'earth-day.jpg',
  earthNight: 'earth-night.jpg',
  earthClouds: 'earth-clouds.jpg',
  earthBump: 'earth-bump.png',
  earthRoughness: 'earth-roughness.png',
  mars: 'mars.jpg',
  marsNormal: 'mars-normal.png',
  jupiter: 'jupiter.jpg',
  saturn: 'saturn.jpg',
  uranus: 'uranus.jpg',
  neptune: 'neptune.jpg',
  pluto: 'pluto.jpg',
  moon: 'moon.jpg',
  moonNormal: 'moon-normal.png',
  io: 'io.jpg',
  europa: 'europa.jpg',
  ganymede: 'ganymede.jpg',
  callisto: 'callisto.jpg',
  triton: 'triton.jpg',
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
 * Load one planet-level texture by key, resolving a grey procedural fallback on
 * timeout or error so a caller never blocks on a missing file. Returns a FRESH
 * texture on every call — the caller owns it and must dispose it itself (the
 * volume-compare mode loads container/filler maps this way and disposes them on
 * each pair change).
 */
export function loadTexture(key: string, tier: TextureTier = '2k', kind: MapKind = 'color', timeoutMs = 8000): Promise<THREE.Texture> {
  const file = PLANET_TEXTURE_FILES[key];
  if (!file) return Promise.resolve(createFallbackTexture(key, kind));
  const url = resolveTextureUrl(file, tier);

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        debugWarn('Planet texture timeout', { key, url });
        resolve(createFallbackTexture(key, kind));
      }
    }, timeoutMs);
    loader.load(
      url,
      (tex) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        applyTextureDefaults(tex, kind);
        // loadTexture serves planet-level maps only (bases + Earth details),
        // which are unconditionally on screen — always safe to warm.
        decodeThenQueueWarm(tex);
        resolve(tex);
      },
      undefined,
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        debugWarn('Planet texture fallback activated', {
          key,
          url,
          reason: err instanceof Error ? err.message : String(err),
        });
        resolve(createFallbackTexture(key, kind));
      },
    );
  });
}

/**
 * Streamed colour-map upgrade for a body that grows large on screen. Bodies
 * start at 2K (fast first paint); when the player gets close — or zooms the
 * Observatory telescope onto them — a 4K colour map is fetched once and swapped
 * in. Only bodies with a 4K variant on disk (public/textures/4k/) carry one.
 */
export interface TextureUpgrade {
  key: string; // PLANET_TEXTURE_FILES key
  material: THREE.MeshStandardMaterial;
  state: 'idle' | 'loading' | 'done' | 'failed';
}

// Texture keys with a 4K colour variant under public/textures/4k/. A 4K variant
// must be the SAME albedo product as its 2K base (colour-matched if its grading
// differs) so the on-approach swap reads as a pure sharpen — no brightness/contrast
// pop — and never double-counts relief against a normal map. Mars (same source at
// 2x), the Moon (SVS LRO albedo colour-matched via tools/colormatch.mjs), and
// Jupiter (SSC 4K — same product as the 2K, needed no match) qualify. Venus / Uranus
// / Neptune are genuinely low-frequency (no real 4K detail); Io/Europa/Ganymede/
// Triton already ship 4K as their base map. Pluto is a real New Horizons LORRI
// mosaic (USGS, 300 m) registered to the IAU prime meridian and tinted through a
// brightness->albedo ramp (the source is grayscale); its never-imaged south is an
// honest dark cap, and its under-imaged far hemisphere is left as the real low-res
// data — soft, but honest (synthetic relief/detail was tried and dropped: it read
// as fake craters at grazing light). Both tiers bake from one source, so 4K is a
// pure sharpen.
const TEXTURE_4K_KEYS = new Set(['mars', 'moon', 'jupiter', 'pluto']);

function makeTextureUpgrade(
  key: string | undefined,
  material: THREE.MeshStandardMaterial,
): TextureUpgrade | undefined {
  if (!key || !TEXTURE_4K_KEYS.has(key)) return undefined;
  return { key, material, state: 'idle' };
}

// Apply a freshly loaded colour map only if it out-ranks what's already on the
// material (procedural floor = 0, 2K = 2, 4K = 4). Makes the 2K stream, the 4K
// upgrade, and the lazy painter order-independent: a late 2K arrival can't
// downgrade a 4K that already won. Disposes whatever it replaces (or itself).
function applyColorTierTexture(mat: THREE.MeshStandardMaterial, tex: THREE.Texture, rank: number): boolean {
  const current = (mat.userData.colorTierRank as number | undefined) ?? 0;
  if (rank <= current) {
    tex.dispose();
    return false;
  }
  const prev = mat.map;
  mat.map = tex;
  // Colour-as-bump bodies (non-gas planets with no normal map) alias the same
  // texture as bumpMap; move the alias onto the upgraded map so the dispose
  // below can't leave bumpMap pointing at freed GPU memory.
  if (mat.bumpMap === prev) mat.bumpMap = tex;
  mat.color.setRGB(1, 1, 1);
  mat.userData.colorTierRank = rank;
  mat.needsUpdate = true;
  // Assign-new-before-dispose-old (above) so no frame samples a freed texture.
  // A GPU procedural floor's texture is backed by a render target; dispose the
  // whole RT (framebuffer + texture), not just the texture, to avoid leaking it.
  if (prev) {
    const owner = prev.userData?.ownerRenderTarget as THREE.WebGLRenderTarget | undefined;
    if (owner) {
      owner.dispose(); // disposes the RT (fires its tracked-removal listener)
      // Drop the now-dangling procedural ref so nothing points at the freed RT.
      if (mat.userData.proceduralColorRT === owner) mat.userData.proceduralColorRT = undefined;
    } else {
      prev.dispose();
    }
  }
  return true;
}

/**
 * Fetch and swap in a body's 4K colour map. One-shot (guarded by the upgrade's
 * own state). Loads directly rather than via loadTexture so a failed fetch
 * leaves the 2K map in place instead of resolving a grey fallback. No-ops on a
 * GPU that can't hold a 4096 map (clampTier), so it never thrashes there.
 */
export function upgradeTextureOnApproach(up: TextureUpgrade): void {
  if (up.state !== 'idle') return;
  if (clampTier('4k') !== '4k') {
    up.state = 'done'; // device stays at 2K; don't re-check every frame
    return;
  }
  up.state = 'loading';
  const url = resolveTextureUrl(PLANET_TEXTURE_FILES[up.key], '4k');
  loader.load(
    url,
    (tex) => {
      applyTextureDefaults(tex, 'color');
      // Decode before the rank swap: the material keeps its current map until
      // the 4K is cheap to draw, so a mid-session upgrade never freezes the
      // frame on a synchronous decode — and the warm queue then uploads it off
      // any gesture frame. The 4K trigger only fires for a body filling the
      // view, so warming here can't upload hidden bodies.
      const img = tex.image as { decode?: () => Promise<void> } | undefined;
      const applyUpgrade = () => {
        if (applyColorTierTexture(up.material, tex, 4)) queueTextureWarm(tex);
        up.material.userData.photoLoaded = true; // keep the lazy painter off it
        up.state = 'done';
      };
      if (img && typeof img.decode === 'function') img.decode().then(applyUpgrade, applyUpgrade);
      else applyUpgrade();
    },
    undefined,
    (err) => {
      up.state = 'failed';
      debugWarn('4K texture upgrade failed', {
        key: up.key,
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
  return tex;
}

function createAtmosphereGlow(radiusAU: number, config: AtmosphereConfig): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radiusAU * config.scale, 64, 32);
  const mat = new THREE.ShaderMaterial({
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereFragmentShader,
    uniforms: {
      // Fed per frame from the body's sun direction and approach distance.
      uSunDirWorld: { value: new THREE.Vector3(0, 0, 1) },
      alphaScale: { value: 0.0 }, // faded out until the per-frame distance feed runs (no first-frame flash)
      uDayColor: { value: new THREE.Vector3(...config.dayColor) },
      uSunsetColor: { value: new THREE.Vector3(...config.sunsetColor) },
      uMieColor: { value: new THREE.Vector3(...config.mieColor) },
      uRayleighStrength: { value: config.rayleighStrength },
      uMieStrength: { value: config.mieStrength },
      uMieG: { value: config.mieG },
      uPower: { value: config.power },
      uIntensity: { value: config.intensity },
      uHaloStrength: { value: config.haloStrength },
      uPlanetRadius: { value: radiusAU },
    },
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return new THREE.Mesh(geo, mat);
}

export interface PlanetMesh {
  group: THREE.Group;
  mesh: THREE.Mesh;
  data: PlanetData;
  rings?: THREE.Mesh;
  ringFx?: RingShadingFx; // per-frame sun-direction feed for the ring shadow/translucency
  atmosphere?: THREE.Mesh;
  nightMesh?: THREE.Mesh;
  nightMaterial?: THREE.ShaderMaterial; // For Earth night lights
  cloudsMesh?: THREE.Mesh;
  fx?: SurfaceShadingFx;
  textureUpgrade?: TextureUpgrade; // 4K colour map streamed in on close approach
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

export async function createPlanetMesh(planet: PlanetData): Promise<PlanetMesh> {
  const group = new THREE.Group();
  group.name = planet.name;

  const surfaceTexturePromise = loadTexture(planet.textureKey);
  const earthDetailTexturePromise = planet.name === 'Earth'
    ? Promise.all([
        loadTexture('earthNight'),
        loadTexture('earthClouds'),
        loadTexture('earthBump', '2k', 'data'),      // height map: linear, not sRGB
        loadTexture('earthRoughness', '2k', 'data'), // ocean-glint roughness: linear
      ])
    : null;
  const texture = await surfaceTexturePromise;

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
  // Saturn's dense rings shadow its globe; hand the surface shader the annulus
  // so it can trace the cast shadow. Other giants' rings are too faint to bother.
  const ringCfg = RING_CONFIGS[planet.name];
  const ringShadow = ringCfg?.style === 'saturn'
    ? { inner: planet.radiusAU * ringCfg.innerFactor, outer: planet.radiusAU * ringCfg.outerFactor }
    : undefined;
  const sunTan = SUN_RADIUS_AU / planet.semiMajorAxisAU; // solar angular radius at the planet
  const fx = augmentSurfaceMaterial(mat, planetArchetype(planet), ringShadow, sunTan);
  // 4K colour upgrade on close approach, for the bodies that carry a 4K variant
  // (Mars, Jupiter). The base 2K map above is the floor; updateTextureLOD swaps in 4K.
  const textureUpgrade = makeTextureUpgrade(planet.textureKey, mat);

  // Real elevation-derived normal map where one exists (Mars/MOLA): it replaces
  // the colour-as-bump fallback. Load directly so a failed fetch leaves the
  // surface flat rather than applying a noise normal.
  const planetNormalKey = PLANET_NORMAL_KEYS[planet.name];
  if (planetNormalKey) {
    mat.bumpMap = null;
    const normalUrl = resolveTextureUrl(PLANET_TEXTURE_FILES[planetNormalKey], '2k');
    loader.load(
      normalUrl,
      (nrm) => {
        applyTextureDefaults(nrm, 'data');
        mat.normalMap = nrm;
        // Softened: the MOLA rainbow-decoded relief is noisy and over-embossed,
        // which reads as harsh facets on crater rims up close. Halve it.
        mat.normalScale.set(0.5, 0.5);
        mat.needsUpdate = true;
        decodeThenQueueWarm(nrm); // planet-level (always on screen) — safe to warm
      },
      undefined,
      (err) =>
        debugWarn('Planet normal load failed', {
          name: planet.name,
          reason: err instanceof Error ? err.message : String(err),
        }),
    );
  }

  const mesh = new THREE.Mesh(geo, mat);
  group.add(mesh);

  // Atmosphere glow for planets with atmospheres
  let atmosphere: THREE.Mesh | undefined;
  const atmosConfig = ATMOSPHERES[planet.name];
  if (atmosConfig) {
    atmosphere = createAtmosphereGlow(planet.radiusAU, atmosConfig);
    group.add(atmosphere);
  }

  // Earth-specific enhancements: night lights + clouds
  let nightMaterial: THREE.ShaderMaterial | undefined;
  let nightMesh: THREE.Mesh | undefined;
  let cloudsMesh: THREE.Mesh | undefined;

  if (planet.name === 'Earth' && earthDetailTexturePromise) {
    const [nightTex, cloudTex, bumpTex, roughTex] = await earthDetailTexturePromise;

    const nightGeo = new THREE.SphereGeometry(planet.radiusAU * 1.001, segments, segments / 2);
    nightMaterial = new THREE.ShaderMaterial({
      uniforms: {
        nightTexture: { value: nightTex },
        sunDirection: { value: new THREE.Vector3(1, 0, 0) },
      },
      vertexShader: earthNightVertexShader,
      fragmentShader: earthNightFragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    nightMesh = new THREE.Mesh(nightGeo, nightMaterial);
    group.add(nightMesh);

    const cloudGeo = new THREE.SphereGeometry(planet.radiusAU * 1.01, segments, segments / 2);
    const cloudMat = new THREE.MeshStandardMaterial({
      map: cloudTex,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      roughness: 1.0,
    });
    cloudsMesh = new THREE.Mesh(cloudGeo, cloudMat);
    group.add(cloudsMesh);

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
  }

  let rings: THREE.Mesh | undefined;
  let ringFx: RingShadingFx | undefined;
  if (ringCfg) {
    const built = createPlanetRings(planet.radiusAU, ringCfg, sunTan);
    rings = built.mesh;
    ringFx = built.fx;
    group.add(rings);
  }

  return { group, mesh, data: planet, rings, ringFx, atmosphere, nightMesh, nightMaterial, cloudsMesh, fx, textureUpgrade };
}

export function createPlanetariumSun(useBloom = true): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Sun';

  // HDR white-light photosphere. The shader's object-space granulation is
  // seamless at the poles and longitude wrap; exposure decides how much of
  // that detail survives when the camera points at the star.
  // 128×64 segments: the cruise governor parks the camera at 1.2 photosphere
  // radii, where a 64-segment silhouette shows visible polygon chords.
  const geo = new THREE.SphereGeometry(SUN_DATA.radiusAU, 128, 64);
  const sunMat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      uAtmosphereMix: { value: 0 },
      uAtmosphereColor: { value: new THREE.Color(1, 0.55, 0.24) },
    },
    vertexShader: sunPhotosphereVertexShader,
    fragmentShader: sunPhotosphereFragmentShader,
  });

  const mesh = new THREE.Mesh(geo, sunMat);
  group.add(mesh);

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
      uGlareStrength: { value: useBloom ? 1.05 : 1.35 },
      uPointLike: { value: 0 },
      uCameraFx: { value: 0 },
      uEclipseLike: { value: 0 },
      uOccluderRadii: { value: 1 },
      uExposureScale: { value: 1 },
      uEmergenceFlash: { value: 0 },
      uAtmosphereMix: { value: 0 },
      uAtmosphereColor: { value: new THREE.Color(1, 0.55, 0.24) },
      uMinHalfSizePx: { value: useBloom ? 18 : 22 },
      uViewportHeight: { value: Math.max(window.innerHeight, 1) },
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
  group.userData.sunProminenceMaterial = prominenceMat;
  group.userData.sunGlareMaterial = glareMat;
  group.userData.sunLensGhostMaterial = ghostMat;
  return group;
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
  textureUpgrade?: TextureUpgrade; // 4K colour map streamed in on close approach
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
 * settles. The group stays invisible — compile() traverses invisible objects,
 * and nothing here may ever be drawn.
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

    // Real elevation-derived normal map (linear), where one exists. Load directly
    // so a failed fetch leaves no normal rather than a noise fallback; the flag is
    // set up front so the lazy painter skips its procedural bump for this moon.
    const normalKey = MOON_NORMAL_KEYS[moonData.name];
    if (normalKey) {
      mat.userData.hasRealNormal = true;
      const normalUrl = resolveTextureUrl(PLANET_TEXTURE_FILES[normalKey], '2k');
      loader.load(
        normalUrl,
        (tex) => {
          applyTextureDefaults(tex, 'data');
          // Decode off-thread before assigning (the moon simply keeps its
          // procedural bump until the normal is cheap to draw); warm the
          // upload only when the player is landed in this system.
          const img = tex.image as { decode?: () => Promise<void> } | undefined;
          const applyNormal = () => {
            mat.normalMap = tex;
            mat.normalScale.set(1, 1);
            mat.needsUpdate = true;
            if (warmEligibleMoonParents.has(planetName)) queueTextureWarm(tex);
          };
          if (img && typeof img.decode === 'function') img.decode().then(applyNormal, applyNormal);
          else applyNormal();
        },
        undefined,
        (err) =>
          debugWarn('Moon normal load failed', {
            name: moonData.name,
            reason: err instanceof Error ? err.message : String(err),
          }),
      );
    }

    // Photo-textured moons (Moon, Io, …) stream their real image; on true
    // success it replaces the procedural colour. Load directly rather than via
    // loadTexture (which resolves a grey fallback on failure) so a failed JPG
    // keeps the procedural texture. photoLoaded tells the painter not to
    // clobber a photo that already won.
    const photoFile = moonData.textureKey ? PLANET_TEXTURE_FILES[moonData.textureKey] : undefined;
    const photoUrl = photoFile ? resolveTextureUrl(photoFile, '2k') : undefined;
    if (photoUrl) {
      loader.load(
        photoUrl,
        (tex) => {
          applyTextureDefaults(tex, 'color');
          // Decode off-thread before the rank swap — the procedural colour
          // stays until the photo is cheap to draw, so the swap can't freeze
          // a frame on a synchronous JPEG decode.
          const img = tex.image as { decode?: () => Promise<void> } | undefined;
          const applyPhoto = () => {
            mat.userData.photoLoaded = true;
            // Rank 2: a later 4K upgrade (rank 4) supersedes this; a 4K that
            // already won can't be downgraded by a late-arriving 2K.
            if (applyColorTierTexture(mat, tex, 2) && warmEligibleMoonParents.has(planetName)) {
              queueTextureWarm(tex);
            }
          };
          if (img && typeof img.decode === 'function') img.decode().then(applyPhoto, applyPhoto);
          else applyPhoto();
        },
        undefined,
        (err) =>
          debugWarn('Moon texture load failed', {
            name: moonData.name,
            reason: err instanceof Error ? err.message : String(err),
          }),
      );
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = moonData.name;
    mesh.visible = false; // hidden until painted and the player is close

    result.push({ mesh, data: moonData, painted: false, fx, textureUpgrade: makeTextureUpgrade(moonData.textureKey, mat) });
  }

  return result;
}
