/**
 * Shared procedural-moon surface generation primitives, used by BOTH the CPU
 * texture path (createMoonTextures, the fallback) and the GPU texturer
 * (ProceduralMoonTexturer). Centralising the archetype classifier, the noise,
 * the palette, the seed and the crater field here is what guarantees the two
 * paths agree: a moon must look the same whether it was painted on the CPU or
 * the GPU.
 *
 * "The same" means the same kind of surface, not the same sample points. The
 * GPU runs the noise in f32 from a reduced seed (a ~1e9 seed quantises in f32
 * and bands), and the sin-hash multiplies its argument by 43758, so no hash of
 * this family can agree across precisions — that was already true and stays
 * true. What IS identical is everything computed here on the CPU for both
 * paths: the palette, and the whole crater field, placement and morphology
 * alike. Craters are the surface's landmarks, so they must not move.
 *
 * The noise is a wrapped LATTICE field, not a per-texel hash: values are drawn
 * at integer lattice points and interpolated, which is what gives a moon
 * landforms instead of sandpaper, and the x lattice wraps modulo its own cell
 * count so the equirect map has no seam at 0° longitude. Both paths spend the
 * lattice differently — the shader hashes four corners per texel, the CPU
 * hoists two lattice rows out of the pixel loop — and a test pins them equal.
 */

// Tiny irregular moons render as a handful of pixels even up close, so they get
// half-dimension textures (a quarter of the per-pixel work); round, inspectable
// moons keep full resolution. Shared so both paths size textures identically.
export const SMALL_MOON_RADIUS_KM = 150;

/**
 * Baseline texture dimensions (equirectangular 2:1), sized for the FLYTHROUGH,
 * where a moon's on-screen size tracks its physical size: tiny irregulars are a
 * few specks (256), everything else 512. The Observatory magnifies any moon to a
 * fixed screen fraction regardless of physical size, so the landed path
 * re-renders the observed moon sharper on demand (ProceduralMoonTexturer.upgrade)
 * — that is where inspection resolution comes from, not this baseline. Keeping
 * the baseline modest means we only hold a hi-res texture for moons actually
 * inspected, not all ~65 at once.
 */
export function moonTextureSize(radiusKm: number): { width: number; height: number } {
  const width = radiusKm < SMALL_MOON_RADIUS_KM ? 256 : 512;
  return { width, height: width / 2 };
}

export function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function seededRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807 + 0) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/** Sine-based hash, evaluated at integer lattice points (and, for the grain,
 *  at integer texel coordinates). f64 here; the GPU port runs the same form in
 *  highp f32. */
export function valueNoise(x: number, y: number, seed: number): number {
  const a = Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453;
  return a - Math.floor(a);
}

/** Quintic fade: C2 at the cell boundary, so the lattice leaves no crease in a
 *  surface that is also used as a height field. */
export function fadeCurve(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Smoothstep on an already-normalised 0..1 argument. */
export function smooth01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

export interface TerrainOctave {
  /** lattice columns around the equator; rows are half that, so a cell is
   *  square where the equirect map is undistorted. */
  cells: number;
  amp: number;
  /** offset added to the moon's seed, so octaves are independent fields */
  seedOff: number;
}

/**
 * The octave table both paths walk. Five octaves span basin-scale patches down
 * to the size of a small crater; `cells` is even so the row count is a whole
 * number, and the x wrap is modulo `cells`.
 */
export const TERRAIN_OCTAVES: readonly TerrainOctave[] = [
  { cells: 6, amp: 0.45, seedOff: 0 },
  { cells: 14, amp: 0.5, seedOff: 131 },
  { cells: 28, amp: 0.42, seedOff: 277 },
  { cells: 56, amp: 0.34, seedOff: 431 },
  { cells: 112, amp: 0.24, seedOff: 577 },
];

/** First octave counted as surface texture rather than landform. A moon that
 *  already wears a photographed map takes ONLY these into its bump: relief the
 *  photograph does not show must not be embossed onto it, and fine roughness
 *  is the part no map at this scale contradicts. */
export const TERRAIN_FINE_FROM = 3;

const TERRAIN_SUM = TERRAIN_OCTAVES.reduce((a, o) => a + o.amp, 0);
const TERRAIN_FINE_SUM = TERRAIN_OCTAVES.slice(TERRAIN_FINE_FROM).reduce((a, o) => a + o.amp, 0);

/**
 * The equirect map's poles are where a cylindrical lattice pinches to a point,
 * and low-frequency noise there reads as a pinwheel. Fade the landform field
 * toward its mid-level inside this much of the pole (in units of cos latitude)
 * so the caps go smooth instead of spoked. The per-texel grain fades with it,
 * for the same reason: texel columns converge at the pole, so texel-scale noise
 * magnifies into radial streaks there. Craters are unaffected — they carry
 * their own latitude correction and stay round.
 */
export const POLE_FADE_COS = 0.62;

/** How much of the landform field survives at this row, 0 at the pole. `ny` is
 *  the top-origin row fraction both paths compute the same way. */
export function poleFade(ny: number): number {
  return smooth01(Math.sin(ny * Math.PI) / POLE_FADE_COS);
}

/** One octave of interpolated lattice noise on a cylinder: wraps in x, extends
 *  in y. `u`/`v` are 0..1 across the map. */
export function terrainOctave(u: number, v: number, cells: number, seed: number): number {
  const rows = cells / 2;
  const x = u * cells;
  const y = v * rows;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fadeCurve(x - ix);
  const fy = fadeCurve(y - iy);
  const x0 = ((ix % cells) + cells) % cells;
  const x1 = (x0 + 1) % cells;
  const n00 = valueNoise(x0, iy, seed);
  const n10 = valueNoise(x1, iy, seed);
  const n01 = valueNoise(x0, iy + 1, seed);
  const n11 = valueNoise(x1, iy + 1, seed);
  const a = n00 + (n10 - n00) * fx;
  const b = n01 + (n11 - n01) * fx;
  return a + (b - a) * fy;
}

/** Reference landform field, 0..1 — the definition the fast row sampler and the
 *  shader both have to reproduce. */
export function terrainShade(u: number, v: number, seed: number): number {
  let sum = 0;
  for (const o of TERRAIN_OCTAVES) sum += o.amp * terrainOctave(u, v, o.cells, seed + o.seedOff);
  return sum / TERRAIN_SUM;
}

/** Reference fine-texture field, 0..1: the high octaves only. */
export function terrainFine(u: number, v: number, seed: number): number {
  let sum = 0;
  for (let i = TERRAIN_FINE_FROM; i < TERRAIN_OCTAVES.length; i++) {
    const o = TERRAIN_OCTAVES[i];
    sum += o.amp * terrainOctave(u, v, o.cells, seed + o.seedOff);
  }
  return sum / TERRAIN_FINE_SUM;
}

/** Per-texel micro-variation. Deliberately a raw hash, not lattice noise: it is
 *  the one term meant to live at the texel, and it is the only per-pixel
 *  transcendental left in the CPU loop. */
export function terrainGrain(x: number, y: number, seed: number): number {
  return valueNoise(x, y, seed + 1013);
}

export interface TerrainRowSampler {
  /** Move to a texture row, given its top-origin row fraction. */
  beginRow(ny: number): void;
  /** Sample column `x` of the current row; returns the landform field, 0..1,
   *  and leaves the fine-texture field ready in `fine()`. */
  sample(x: number): number;
  /** The fine-texture field for the column most recently sampled. */
  fine(): number;
}

/**
 * Row-major sampler for the CPU painter. For one texture row every octave needs
 * only its two lattice rows — `cells` hashes each — so the sine hash leaves the
 * per-pixel loop entirely and the interpolation is arithmetic. Equal to
 * terrainShade/terrainFine at every texel by construction; a test pins it.
 */
export function createTerrainRowSampler(width: number, seed: number): TerrainRowSampler {
  const octs = TERRAIN_OCTAVES.map((o) => {
    const x0 = new Int32Array(width);
    const x1 = new Int32Array(width);
    const fx = new Float64Array(width);
    for (let x = 0; x < width; x++) {
      const xx = (x / width) * o.cells;
      const ix = Math.floor(xx);
      fx[x] = fadeCurve(xx - ix);
      x0[x] = ((ix % o.cells) + o.cells) % o.cells;
      x1[x] = (x0[x] + 1) % o.cells;
    }
    return {
      amp: o.amp,
      cells: o.cells,
      rows: o.cells / 2,
      seed: seed + o.seedOff,
      x0,
      x1,
      fx,
      row0: new Float64Array(o.cells),
      row1: new Float64Array(o.cells),
      loadedRow: Number.NaN,
      fy: 0,
    };
  });
  let full = 0;
  let fineSum = 0;
  return {
    beginRow(ny: number): void {
      for (const o of octs) {
        const yy = ny * o.rows;
        const iy = Math.floor(yy);
        o.fy = fadeCurve(yy - iy);
        if (o.loadedRow !== iy) {
          for (let i = 0; i < o.cells; i++) {
            o.row0[i] = valueNoise(i, iy, o.seed);
            o.row1[i] = valueNoise(i, iy + 1, o.seed);
          }
          o.loadedRow = iy;
        }
      }
    },
    sample(x: number): number {
      full = 0;
      fineSum = 0;
      for (let i = 0; i < octs.length; i++) {
        const o = octs[i];
        const i0 = o.x0[x];
        const i1 = o.x1[x];
        const f = o.fx[x];
        const a = o.row0[i0] + (o.row0[i1] - o.row0[i0]) * f;
        const b = o.row1[i0] + (o.row1[i1] - o.row1[i0]) * f;
        const v = o.amp * (a + (b - a) * o.fy);
        full += v;
        if (i >= TERRAIN_FINE_FROM) fineSum += v;
      }
      full /= TERRAIN_SUM;
      fineSum /= TERRAIN_FINE_SUM;
      return full;
    },
    fine(): number {
      return fineSum;
    },
  };
}

export interface MoonArchetypeFlags {
  isIcy: boolean;
  isVolcanic: boolean;
}

/**
 * Surface archetype from the catalog chip's own sRGB bytes — the colour the
 * chip renders as, which is what the thresholds were written against. Reading
 * them through a linear working space instead pushes almost every grey moon
 * below the ice threshold (a 0.55 linear cut is a 0.77 sRGB one), which left
 * the icy and volcanic branches with two residents between them and every ring
 * moonlet painted as dark rock.
 *
 * This is deliberately NOT the scene's two-value moonArchetype()/ICY_MOONS
 * lookup: that one is name-keyed and drives night fill and roughness. Drive the
 * procedural look from this one.
 */
export function classifyMoonArchetype(colorHex: number): MoonArchetypeFlags {
  const r = ((colorHex >> 16) & 255) / 255;
  const g = ((colorHex >> 8) & 255) / 255;
  const b = (colorHex & 255) / 255;
  return {
    isIcy: r * 0.299 + g * 0.587 + b * 0.114 > 0.55,
    isVolcanic: r > 0.6 && g > 0.4 && b < 0.35,
  };
}

/**
 * Archetype code: 0 icy, 1 volcanic, 2 rocky.
 *
 * Volcanic wins a tie. The ice test is brightness alone and the volcanic test
 * is a hue, so on a bright saturated chip both fire — Io and Titan are the two
 * that do, and letting brightness win would paint the solar system's most
 * volcanic surface as ice and leave the volcanic branch with no residents at
 * all. The more specific test takes precedence.
 */
export function archetypeCode(flags: MoonArchetypeFlags): number {
  if (flags.isVolcanic) return 1;
  if (flags.isIcy) return 0;
  return 2;
}

/**
 * How an archetype turns a catalog chip into a surface. Levels are stated in
 * texture-byte fractions, the same currency the shipped photo maps were
 * levelled in, because that is the only way a painted moonlet and a
 * photographed one can be compared at all: the chip supplies hue and the
 * ordering within an archetype, the archetype supplies the albedo.
 */
interface ArchetypeLook {
  /** chip-luma window the level ramp spans */
  lumaLo: number;
  lumaHi: number;
  /** how much of the chip's saturation the surface keeps. A catalog chip is a
   *  UI token picked to be legible at 14 px, not a photometric measurement, so
   *  taking one at face value paints a beach ball; the real bodies are duller
   *  than their chips by a long way. */
  saturation: number;
  /** map level at each end of that window */
  levelLo: number;
  levelHi: number;
  /** total albedo swing across the noise field, as a fraction of the level */
  contrast: number;
  /** chroma multipliers at the dark and bright end of the swing */
  shadow: readonly [number, number, number];
  light: readonly [number, number, number];
  /** per-texel grain, in field units */
  grain: number;
  /** how far a crater's relief profile moves colour, and height */
  craterColor: number;
  craterRelief: number;
  /** ray brightness, in field units */
  ray: number;
}

// Anchored on the shipped maps' own equatorial-band means: the icy Saturnians
// sit at bytes 131-169, Ganymede/Iapetus at 118-121, Callisto at 100/84/70 and
// Io at 154/129/88. A painted moonlet has to land in those neighbourhoods or it
// reads as a different material next to them.
const ARCHETYPE_LOOKS: Record<number, ArchetypeLook> = {
  // Icy: bright, nearly neutral, contrast carried by craters rather than by
  // broad albedo patches; lows lean very slightly blue, the way shadowed ice
  // photographs.
  0: {
    lumaLo: 0.52,
    lumaHi: 0.82,
    saturation: 0.85,
    levelLo: 0.42,
    levelHi: 0.64,
    contrast: 0.55,
    shadow: [0.94, 0.97, 1.03],
    light: [1.02, 1.01, 0.99],
    grain: 0.05,
    craterColor: 0.85,
    craterRelief: 1,
    ray: 0.5,
  },
  // Volcanic: splotchy and hot — broad patches instead of craters, lows toward
  // red-brown sulphur, highs toward pale yellow.
  1: {
    lumaLo: 0.4,
    lumaHi: 0.8,
    saturation: 0.85,
    levelLo: 0.4,
    levelHi: 0.64,
    contrast: 0.85,
    shadow: [0.95, 0.7, 0.4],
    light: [1.02, 1.02, 0.9],
    grain: 0.05,
    craterColor: 0.45,
    craterRelief: 0.8,
    ray: 0.3,
  },
  // Rocky/dark: low albedo, warm in the highlights, and the highest crater
  // contrast of the three — on a dark body the excavated material is the only
  // bright thing on it.
  2: {
    lumaLo: 0.18,
    lumaHi: 0.62,
    saturation: 0.75,
    levelLo: 0.17,
    levelHi: 0.44,
    contrast: 0.58,
    shadow: [0.95, 0.94, 0.95],
    light: [1.05, 1.01, 0.96],
    grain: 0.06,
    craterColor: 0.75,
    craterRelief: 1,
    ray: 0.45,
  },
};

/**
 * The palette a moon is painted with: two endpoint colours the noise field
 * mixes between, plus the gains the crater field is applied with. Both paths
 * take these already multiplied out, so the archetype table is read in exactly
 * one place and the shader is a mix().
 *
 * Colours are texture-byte fractions (0..1) — what lands in the map, before the
 * sampler's sRGB decode — not linear light.
 */
export interface MoonSurfaceLook {
  low: [number, number, number];
  high: [number, number, number];
  grain: number;
  craterColor: number;
  craterRelief: number;
  ray: number;
}

export function moonSurfaceLook(colorHex: number, flags: MoonArchetypeFlags): MoonSurfaceLook {
  const look = ARCHETYPE_LOOKS[archetypeCode(flags)];
  const r = ((colorHex >> 16) & 255) / 255;
  const g = ((colorHex >> 8) & 255) / 255;
  const b = (colorHex & 255) / 255;
  const luma = r * 0.299 + g * 0.587 + b * 0.114;
  const t = smooth01((luma - look.lumaLo) / (look.lumaHi - look.lumaLo));
  const level = look.levelLo + (look.levelHi - look.levelLo) * t;
  // Chroma at unit luma: the chip decides hue and saturation, the archetype
  // decides how bright the body is. A chip with no luma to divide by has no hue
  // to carry either, so it falls back to neutral rather than to a black moon.
  const sat = luma > 1e-3 ? look.saturation : 0;
  const chroma: [number, number, number] = [
    1 + (r / Math.max(luma, 1e-3) - 1) * sat,
    1 + (g / Math.max(luma, 1e-3) - 1) * sat,
    1 + (b / Math.max(luma, 1e-3) - 1) * sat,
  ];
  const lo = level * (1 - look.contrast / 2);
  const hi = level * (1 + look.contrast / 2);
  return {
    low: [chroma[0] * look.shadow[0] * lo, chroma[1] * look.shadow[1] * lo, chroma[2] * look.shadow[2] * lo],
    high: [chroma[0] * look.light[0] * hi, chroma[1] * look.light[1] * hi, chroma[2] * look.light[2] * hi],
    grain: look.grain,
    craterColor: look.craterColor,
    craterRelief: look.craterRelief,
    ray: look.ray,
  };
}

export interface Crater {
  /** centre, in texels */
  cx: number;
  cy: number;
  /** radius to the rim crest, in texels along the surface */
  cr: number;
  /** floor depression, in field units */
  depth: number;
  /** rim height above the surrounding surface, in field units */
  rim: number;
  /** ejecta-ray strength, 0 for everything but the young minority */
  rays: number;
  /** ray pattern phase, radians */
  phase: number;
  /** central-peak weight, 0..1 — only the largest craters have one */
  peak: number;
}

// Crater radii were originally tuned in pixels for a 512-wide texture. Scaling
// them by width/512 keeps craters the SAME size relative to the moon at any
// resolution, so re-rendering a moon larger on observe is a pure sharpen, not a
// surface redesign (smaller-looking craters).
const CRATER_REFERENCE_WIDTH = 512;

/**
 * Crater budget. Two vec4 slots per crater (centre+radius+depth, then
 * rim+rays+phase+peak) is what carries morphology at all, and a uniform array
 * element occupies a full vec4 register, so the shader spends 2×MAX_CRATERS
 * registers on craters alone. The floor to design against is WebGL 2's
 * guaranteed MAX_FRAGMENT_UNIFORM_VECTORS of 224: 64 craters is 128 of those,
 * three's ShaderMaterial prefix (viewMatrix, cameraPosition, isOrthographic)
 * takes 6, and the rest of this shader's uniforms take about a dozen — call it
 * 146 of 224, with the driver's real limit normally several times that. The
 * texturer still asks the context for the number at prewarm and falls back to
 * the CPU if a driver comes in under what the layout needs.
 */
export const MAX_CRATERS = 64;

/** Uniform vectors one crater costs the fragment shader. */
export const CRATER_UNIFORM_VECTORS = 2;

interface CraterMix {
  /** count range */
  countMin: number;
  countSpan: number;
  /** radius range at the reference width, in texels */
  rMin: number;
  rMax: number;
  /** depth and rim of the freshest crater, in field units */
  depth: number;
  rim: number;
  /** ray strength of the freshest rayed crater */
  ray: number;
}

// Many small, few large: the radius is drawn as rMin·(rMax/rMin)^(u³), which
// puts the median a fifth of the way up the range and leaves two or three
// craters per moon near the top of it. The cube and the ceiling are both
// deliberate — several basin-sized craters at once read as ripples on a pond
// rather than as a cratered world, and a crater much under the floor lands on
// two or three texels of a small moon's baseline map, which magnifies into a
// square (the CPU fallback never re-renders sharper, so it wears that floor).
// Counts differ by archetype because the surfaces do: icy moons resurface,
// volcanic ones bury everything, dark rock keeps every scar.
const CRATER_MIX: Record<number, CraterMix> = {
  0: { countMin: 36, countSpan: 20, rMin: 5.5, rMax: 22, depth: 0.5, rim: 0.26, ray: 0.5 },
  1: { countMin: 3, countSpan: 5, rMin: 5, rMax: 14, depth: 0.35, rim: 0.18, ray: 0.15 },
  2: { countMin: 44, countSpan: 20, rMin: 6, rMax: 26, depth: 0.58, rim: 0.3, ray: 0.38 },
};

/**
 * How far the terrain field is allowed to warp a crater's radius. Craters drawn
 * as exact circles read as stamps; running the distance through the surface's
 * own noise costs nothing (both paths already have the field at that texel) and
 * gives every rim an irregular outline that still closes.
 */
export const CRATER_WARP = 0.3;

/** Youngest sixth of the population throws rays, and only once a crater is big
 *  enough for them to resolve. */
const CRATER_RAY_AGE = 0.16;
const CRATER_RAY_MIN_RADIUS = 10;
/** Central peaks start here (reference-width texels) and are full-strength a
 *  little above it — the complex-crater transition, in miniature. */
const CRATER_PEAK_MIN_RADIUS = 11;
const CRATER_PEAK_SPAN = 8;

/**
 * Seeded crater field. Draw order is fixed — count, then per crater
 * (x, latitude, radius, age, ray phase) — so a moon's craters are identical on
 * both paths and at every resolution; changing the order changes every moon's
 * face. Centres are uniform on the SPHERE, not on the map, so the poles do not
 * collect a crowd; cx/cy scale with the texture dims and cr with width, so
 * re-rendering larger is a sharpen.
 */
export function generateCraters(
  rng: () => number,
  width: number,
  height: number,
  archetype: number,
): Crater[] {
  const mix = CRATER_MIX[archetype] ?? CRATER_MIX[2];
  const radiusScale = width / CRATER_REFERENCE_WIDTH;
  const craterCount = Math.min(mix.countMin + Math.floor(rng() * mix.countSpan), MAX_CRATERS);
  const ratio = mix.rMax / mix.rMin;
  const craters: Crater[] = [];
  for (let i = 0; i < craterCount; i++) {
    const cx = Math.floor(rng() * width);
    // Uniform on the sphere: rows near the poles cover less surface, so they
    // are drawn less often.
    const lat = Math.asin(rng() * 2 - 1);
    const cy = Math.min(height - 1, Math.max(0, Math.floor((0.5 - lat / Math.PI) * height)));
    const u = rng();
    const refRadius = mix.rMin * ratio ** (u * u * u);
    const cr = refRadius * radiusScale;
    const age = rng();
    const phase = rng() * Math.PI * 2;
    const fresh = 1 - age;
    craters.push({
      cx,
      cy,
      cr,
      depth: mix.depth * (0.45 + 0.55 * fresh),
      rim: mix.rim * (0.3 + 0.7 * fresh),
      rays: age < CRATER_RAY_AGE && refRadius > CRATER_RAY_MIN_RADIUS
        ? mix.ray * (1 - age / CRATER_RAY_AGE)
        : 0,
      phase,
      peak: smooth01((refRadius - CRATER_PEAK_MIN_RADIUS) / CRATER_PEAK_SPAN),
    });
  }
  return craters;
}

/** Where the bowl floor gives way to the inner wall, in crater radii. Most of
 *  the disc is floor and the wall is the narrow band that climbs to the rim —
 *  a wide wall reads as a soft doughnut rather than a crater. */
export const CRATER_FLOOR_T = 0.7;

/** How far a crater's ejecta reaches, in crater radii: a narrow collar on an
 *  old crater, a wide bright blanket on a young one, which together with the
 *  rays is what makes a fresh crater read as fresh. */
export function craterReach(rays: number): number {
  return 1.22 + rays * 1.6;
}

/** Outermost texel a crater can touch once the warp has stretched it — the
 *  bound the CPU painter's per-crater box has to cover. */
export function craterOuterTexels(cr: number, rays: number): number {
  return (cr * craterReach(rays)) / (1 - CRATER_WARP / 2);
}

/**
 * Crater relief at `t` radii from the centre, in field units: a depressed floor
 * with a central peak on the big ones, an inner wall, a raised rim at t = 1,
 * and an ejecta blanket decaying outward. Rays are separate (craterRay) because
 * they are the only term that needs an angle, and only a few craters have any.
 *
 * The shader carries the same profile; the two are edited together.
 */
export function craterHeight(c: Crater, t: number): number {
  if (t < CRATER_FLOOR_T) {
    const s = t / CRATER_FLOOR_T;
    const bowl = -c.depth * (1 - 0.3 * s * s);
    return bowl + c.peak * c.depth * 1.6 * (1 - smooth01(s / 0.38));
  }
  if (t < 1) {
    return -c.depth + (c.rim + c.depth) * smooth01((t - CRATER_FLOOR_T) / (1 - CRATER_FLOOR_T));
  }
  const reach = craterReach(c.rays);
  if (t >= reach) return 0;
  const w = 1 - (t - 1) / (reach - 1);
  return c.rim * w * w;
}


/** Ray brightening at `t` radii and bearing `theta`. Zero outside the reach and
 *  for every crater that is not one of the young ones. */
export function craterRay(c: Crater, t: number, theta: number): number {
  if (c.rays <= 0 || t < 1) return 0;
  const reach = craterReach(c.rays);
  if (t >= reach) return 0;
  const w = 1 - (t - 1) / (reach - 1);
  const spokes = Math.sin(theta * 5 + c.phase);
  if (spokes <= 0) return 0;
  return spokes ** 8 * c.rays * w;
}

/**
 * Reduced seed for the GPU shader. The CPU path uses the full hashString seed in
 * f64; in f32 a ~1e9 seed quantises the noise (banding), so the GPU path uses a
 * bounded seed. ≥ 2^16 to stay collision-resistant (mod 997 collided Miranda/
 * Styx) while small enough that f32 ulp (~0.015 at 1e5) keeps the noise smooth.
 */
export function gpuSeed(name: string): number {
  return hashString(name) % 131071; // largest prime < 2^17
}
