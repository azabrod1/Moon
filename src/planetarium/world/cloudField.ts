/**
 * The cloud deck's 1.2 km field: pages of NASA's cloud map at 32k, sampled
 * inside the deck's own draw where a page is resident, the shipped sheet
 * everywhere else. This module is the field's arithmetic and its GLSL — where a
 * direction lands on a page, how much of the page a fragment may take, how a
 * page's mips are built — with a TypeScript twin of every rule the shader
 * applies, so the tests can pin the addressing without a GPU. The pool that
 * holds the pages is `cloudFieldPool.ts`, the residency that decides which
 * pages it holds `cloudFieldResidency.ts`, and the session that drives the
 * two from the live frame `cloudFieldSession.ts`.
 *
 * OFF BY DEFAULT. The shader half is a compile-time define, CLOUD_FIELD, set
 * only on the planetarium's deck and only when `?cloudtiles=1` asked for it at
 * boot (any build) and the device's profile gives the pool layers; a program
 * without the define is the program it was, after the preprocessor, but for
 * the one blank line each of the two chunks below opens with. With it, pages
 * arrive by themselves as the camera moves, and fade in over the sheet.
 *
 * THE REPRESENTATION is two channels per texel, `(A, P)` — the encoding study
 * (planning/cloud-detail/encoding) chose it: A is the deck's authored opacity,
 * `smoothstep(0.06, 0.75, s)` of the master's stored value, and P = A·C with C
 * the brightness the deck's albedo rule draws that value at. Both are computed
 * at the master's 0.93 km and area-averaged from there as plain data, so a mip
 * is a 2×2 mean of opacity and of premultiplied brightness, which is exactly
 * what a blend of those texels on screen is. The shader takes A as the alpha
 * and P / A as the brightness; the map's hue is the base sheet's, as today.
 *
 * THE GRID is 16 × 8 pages of 22.5°, each 2032 texels of content inside an
 * 8-texel gutter cut from the neighbouring content (wrapping at the date line,
 * clamped at the poles), 2048 a side, so the level is 32512 × 16256 — 0.7526 of
 * the master's 43200. Page (col, row): col 0 starts at −180°, row 0 is the
 * NORTHERN row, and the page table is laid out the same way.
 *
 * THE HANDOVER. A fragment takes the fine field at a weight w: the page's own
 * fade, times a guard that hands back to the base before the filter's
 * footprint can leave the gutter, times a boundary term that makes two pages
 * with different fades meet at one value (both sides approach the smaller of
 * the two across a narrow band at the shared edge; at a corner, the smallest of
 * the four). `(A, P)` is then the mix of the base's and the field's at w, so a
 * page arriving is a cross-fade of the alpha and the premultiplied colour,
 * never a step.
 */

type Vec3 = readonly [number, number, number];

/** Pages across the globe, and down it. */
export const CLOUD_FIELD_GRID: readonly [number, number] = [16, 8];

/**
 * The tile sets a page's two planes are read from, cut by gen-tiles' `clouds`
 * job and named in the generated table like every sector set: the key is the
 * stem of the master they are cut from (`earth-clouds.v2`, the second cut of
 * the map the deck ships), so a re-cut master ships under a new key and takes
 * its pages with it; a page is the same cell of both tiers.
 */
export const CLOUD_FIELD_SETS = { key: 'earth-clouds.v2', opacity: '32k-a', brightness: '32k-p' } as const;
/** Content texels on a page's side. */
export const CLOUD_PAGE_CONTENT = 2032;
/** Texels of neighbouring content round every page. */
export const CLOUD_PAGE_GUTTER = 8;
/** A page's side, gutter included: the array's layer size. */
export const CLOUD_PAGE_SIZE = CLOUD_PAGE_CONTENT + 2 * CLOUD_PAGE_GUTTER;
/** Every level from 2048 down to 1, which is what the array is allocated with. */
export const CLOUD_PAGE_LEVELS = Math.log2(CLOUD_PAGE_SIZE) + 1;
/** The level the pages are cut from: 32512 × 16256. */
export const CLOUD_FIELD_LEVEL_WIDTH = CLOUD_FIELD_GRID[0] * CLOUD_PAGE_CONTENT;

/**
 * The boundary band, as a fraction of a page's content: 1/32 of 22.5°, about
 * 78 km at the equator. Inside it a page's weight runs from its own fade to
 * the value it shares with the page across the edge. Narrow, so a page arriving
 * beside a resident one reads as one region filling in rather than a seam; wide
 * enough that a fade of 1 against 0.4 is a slope across tens of kilometres, not
 * a line.
 */
export const CLOUD_FIELD_EDGE_BAND = 1 / 32;

/**
 * The footprint, in a page's own texels per pixel along the footprint's MAJOR
 * axis, over which the field hands back to the base: full weight to 4 (LOD 2),
 * none from 8 (LOD 3). The major axis is the true largest singular value of
 * the screen-to-texel Jacobian (`cloudFieldMajor`), not the larger of its two
 * columns, which reads up to √2 short for a diagonal footprint.
 *
 * The PIXELS are the tile ratio's (the output ratio; the scene's own at the
 * fixed High level), on the scene target's unwarped grid: the shader's
 * derivatives are the scene target's, and one uniform, scene ratio over tile
 * ratio (`uCloudFieldPixelScale`), turns them into these. So a Dynamic rung
 * step changes no fragment's weight, and the residency, which measures pages
 * on the same grid at the tile ratio, agrees with the shader about every
 * point (`cloudFieldMeasure.ts`).
 */
export const CLOUD_FIELD_GUARD_TEXELS: readonly [number, number] = [4, 8];

/**
 * The safety term, in REAL page texels per scene pixel: what the filter actually
 * spans, whatever the rung. The gutter is 8 texels. A trilinear read at a
 * position x texels inside the layer's edge leaves the layer (clamps) once its
 * coarser level's texel is wider than 2x, so an isotropic footprint is safe at
 * the content edge (x = 8) up to 16 texels a pixel (LOD 4). An anisotropic one
 * is not: with N taps spread over (1 - 1/N) of the major axis and the level
 * chosen from major / N, the outermost tap of a 3-tap footprint sits at
 * 8 - major/3 while the level needs 2^floor(log2(major/3)), and the first read
 * past the edge comes at a major of 12. So the term reaches zero at 12, and it
 * starts at 8 / 0.75 — the main guard's own zero at the bottom of the rung
 * ladder (Low draws at 0.75 of the output ratio) — so it never moves a
 * fragment's weight on a normal rung, and bites only under a `?upscale=` pin
 * or anything else that draws the scene coarser than Low.
 */
export const CLOUD_FIELD_SAFETY_TEXELS: readonly [number, number] = [8 / 0.75, 12];

/** The scene ratio over the tile ratio at the bottom of the rung ladder. */
export const CLOUD_FIELD_LOWEST_RUNG = 0.75;

/** Page texels per tile-ratio pixel on the major axis past which the residency
 *  releases a page: half again the guard's zero, so a released page's weight
 *  is zero everywhere it is in frame (`cloudFieldMeasure.test.ts` proves it). */
export const CLOUD_FIELD_RELEASE_TEXELS = 12;

/** Table codes reserved in the R channel, tested before `layer = R - 1`:
 *  254 "see the parent level" and 255 "known clear". Both draw the base. */
export const CLOUD_TABLE_SEE_PARENT = 254;
export const CLOUD_TABLE_CLEAR = 255;

/** What a table R byte means: absent (0), a layer, or one of the reserved
 *  codes. Mirrored by the code test in CLOUD_FIELD_GLSL, which runs before the
 *  layer is computed. */
export function cloudTableCode(r: number): { kind: 'absent' } | { kind: 'layer'; layer: number }
  | { kind: 'parent' } | { kind: 'clear' } {
  if (r === 0) return { kind: 'absent' };
  if (r === CLOUD_TABLE_SEE_PARENT) return { kind: 'parent' };
  if (r === CLOUD_TABLE_CLEAR) return { kind: 'clear' };
  return { kind: 'layer', layer: r - 1 };
}

/** The array's anisotropy: trilinear with a modest anisotropic boost. */
export const CLOUD_FIELD_ANISOTROPY = 4;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** three's SphereGeometry UV for a unit direction in the sphere's own frame:
 *  the deck's map UV, which the pages are cut against. The same formula as
 *  `sphereEquirectUv` in cloudDeck.ts, repeated so this module stays free of
 *  everything but arithmetic. In two scalar halves, so a per-frame loop can
 *  find a page without building a tuple. */
function equirectU(x: number, z: number): number {
  const u = Math.atan2(z, -x) / (2 * Math.PI);
  return u - Math.floor(u);
}
function equirectV(y: number): number {
  return 0.5 + Math.asin(Math.min(1, Math.max(-1, y))) / Math.PI;
}

/** A map uv's position on the grid, in pages: x from the date line, y from
 *  the SOUTH pole, v held just inside the grid at the poles. */
const gridX = (u: number): number => u * CLOUD_FIELD_GRID[0];
const gridY = (v: number): number => Math.min(Math.max(v, 0), 0.9999999) * CLOUD_FIELD_GRID[1];
/** The cell a grid position falls in, the last one held on the grid. */
const cellOf = (g: number, cells: number): number => Math.min(Math.floor(g), cells - 1);

/** Where a deck-frame direction lands in the field. */
export interface CloudPageAddress {
  /** The page's column, 0 at −180° longitude. */
  col: number;
  /** The page's row in the TABLE, 0 the northernmost. */
  row: number;
  /** The position across the page's content, 0..1: x from its western edge,
   *  y from its SOUTHERN edge (texture coordinates run up the map). */
  s: [number, number];
  /** The texture coordinate inside the 2048 layer, gutter included. */
  local: [number, number];
}

/** The page under a direction in the deck's own frame, and where on it.
 *  Mirrored exactly by the head of `cloudFieldFine` in CLOUD_FIELD_GLSL. */
export function cloudPageAddress(dir: Vec3): CloudPageAddress {
  const gx = gridX(equirectU(dir[0], dir[2]));
  const gy = gridY(equirectV(dir[1]));
  const cx = cellOf(gx, CLOUD_FIELD_GRID[0]);
  const cy = cellOf(gy, CLOUD_FIELD_GRID[1]);
  const s: [number, number] = [gx - cx, gy - cy];
  return {
    col: cx,
    row: CLOUD_FIELD_GRID[1] - 1 - cy,
    s,
    local: [
      (CLOUD_PAGE_GUTTER + s[0] * CLOUD_PAGE_CONTENT) / CLOUD_PAGE_SIZE,
      (CLOUD_PAGE_GUTTER + s[1] * CLOUD_PAGE_CONTENT) / CLOUD_PAGE_SIZE,
    ],
  };
}

/** The table cell under a deck-frame direction as one index, `row * 16 +
 *  col` — the cell `cloudPageAddress` names, found without allocating, for
 *  the residency's per-frame measure. */
export function cloudPageIndexOf(x: number, y: number, z: number): number {
  const cy = cellOf(gridY(equirectV(y)), CLOUD_FIELD_GRID[1]);
  return (CLOUD_FIELD_GRID[1] - 1 - cy) * CLOUD_FIELD_GRID[0] + cellOf(gridX(equirectU(x, z)), CLOUD_FIELD_GRID[0]);
}

/** The page across the nearer x edge, the nearer y edge and the corner
 *  between them, as table cells; null off the grid (beyond a pole). Columns
 *  wrap at the date line. Mirrored by the neighbour reads in CLOUD_FIELD_GLSL. */
export function cloudPageNeighbours(col: number, row: number, s: readonly [number, number]): {
  x: [number, number]; y: [number, number] | null; xy: [number, number] | null;
} {
  const [W, H] = CLOUD_FIELD_GRID;
  const nx = s[0] < 0.5 ? -1 : 1;
  // Table rows run north to south and s.y runs south to north.
  const ny = s[1] < 0.5 ? 1 : -1;
  const wrap = (c: number) => (c + W) % W;
  const r = row + ny;
  const onGrid = r >= 0 && r < H;
  return {
    x: [wrap(col + nx), row],
    y: onGrid ? [col, r] : null,
    xy: onGrid ? [wrap(col + nx), r] : null,
  };
}

/**
 * A page's weight at a point on it from the fades of the pages that touch it:
 * its own fade in the interior; at an edge, the smaller of its own and its
 * neighbour's; at a corner, the smallest of the four — a bilinear blend of
 * those over the band. A missing neighbour is a fade of 0. Both pages
 * evaluate the same edge and corner values, so two neighbours meet at one
 * weight. Mirrored exactly by the boundary term in CLOUD_FIELD_GLSL.
 */
export function cloudPageEdgeWeight(
  s: readonly [number, number], f0: number, fX: number, fY: number, fXY: number,
): number {
  const tx = smoothstep(0, CLOUD_FIELD_EDGE_BAND, Math.min(s[0], 1 - s[0]));
  const ty = smoothstep(0, CLOUD_FIELD_EDGE_BAND, Math.min(s[1], 1 - s[1]));
  if (tx >= 1 && ty >= 1) return f0;
  const eX = Math.min(f0, fX);
  const eY = Math.min(f0, fY);
  const c = Math.min(eX, eY, fXY);
  const lo = c + (eY - c) * tx;
  const hi = eX + (f0 - eX) * tx;
  return lo + (hi - lo) * ty;
}

/** The guard: how much of the fine field a footprint of this many page texels
 *  a TILE-ratio pixel (along its major axis) may take. */
export function cloudFieldGuard(majorTexelsPerPixel: number): number {
  return 1 - smoothstep(CLOUD_FIELD_GUARD_TEXELS[0], CLOUD_FIELD_GUARD_TEXELS[1], majorTexelsPerPixel);
}

/**
 * The largest singular value of the 2x2 matrix whose columns are `a` and `b`:
 * the footprint's major axis. Closed form from the eigenvalues of the Gram
 * matrix, the same one `projectedStepScale` uses, stable when a column
 * collapses. Mirrored by the shader's `major`.
 */
export function cloudFieldMajor(a: readonly [number, number], b: readonly [number, number]): number {
  const aa = a[0] * a[0] + a[1] * a[1];
  const bb = b[0] * b[0] + b[1] * b[1];
  const ab = a[0] * b[0] + a[1] * b[1];
  const mean = (aa + bb) * 0.5;
  const spread = Math.sqrt(Math.max(((aa - bb) * 0.5) ** 2 + ab * ab, 0));
  return Math.sqrt(Math.max(mean + spread, 0));
}

/**
 * The shader's whole guard, twinned: `majorScene` page texels per SCENE pixel
 * on the major axis, `pixelScale` the scene ratio over the tile ratio. The
 * main term reads tile-ratio pixels; the safety term reads the real footprint.
 * Mirrored exactly by `guard` in CLOUD_FIELD_GLSL.
 */
export function cloudFieldGuardWeight(majorScene: number, pixelScale: number): number {
  const main = cloudFieldGuard(majorScene * pixelScale);
  const safety = 1 - smoothstep(CLOUD_FIELD_SAFETY_TEXELS[0], CLOUD_FIELD_SAFETY_TEXELS[1], majorScene);
  return main * safety;
}

/** The table cell's name, which is also the page files' stem. */
export function cloudPageKey(col: number, row: number): string {
  return `${col}_${row}`;
}

/** The cell a key names, or null. */
export function parseCloudPageKey(key: string): [number, number] | null {
  const m = /^(\d+)_(\d+)$/.exec(key.trim());
  if (!m) return null;
  const c = Number(m[1]);
  const r = Number(m[2]);
  return c < CLOUD_FIELD_GRID[0] && r < CLOUD_FIELD_GRID[1] ? [c, r] : null;
}

/**
 * A band of one of the page's two grey files into its channel of the page's
 * RG8 layer (`out`, size² × 2), in GL order: channel 0 the opacity A, 1 the
 * premultiplied brightness P. `src` holds the file's rows `y0` to `y0 + rows`
 * top-down. The files are north-up — row 0 is the page's northern edge, as
 * any image is — and a texture's row 0 is t = 0, the SOUTHERN edge in the
 * deck's UV, so a file row y lands on layer row size − 1 − y. `stride` is the
 * bytes a source texel takes (4 for RGBA read back off a canvas, whose grey
 * has R = G = B; 1 for a raw channel). A band at a time, so a decoder never
 * has to hold a whole file's RGBA readback, four times the channel it wants.
 */
export function packCloudPlaneRows(
  out: Uint8Array, src: Uint8Array | Uint8ClampedArray, size: number, channel: 0 | 1, y0: number, rows: number,
  stride = 1,
): void {
  for (let y = 0; y < rows; y++) {
    const from = y * size * stride;
    const to = (size - 1 - (y0 + y)) * size * 2 + channel;
    for (let x = 0; x < size; x++) out[to + 2 * x] = src[from + x * stride];
  }
}

/**
 * A page's whole mip chain from its base level, as DATA: every texel of a level
 * is the 2×2 mean of the four below it, per channel, rounded to the nearest
 * code (half up) — opacity and premultiplied brightness both average linearly,
 * which is the whole reason the field is stored as `(A, P)` rather than as the
 * map's grey. Square, power-of-two base; returns every level down to 1×1.
 */
export function buildCloudPageMips(base: Uint8Array, size: number, channels = 2): Uint8Array[] {
  if (!(size > 0) || (size & (size - 1)) !== 0) throw new Error(`mip base ${size} is not a power of two`);
  if (base.length !== size * size * channels) throw new Error('mip base is not size² × channels');
  const levels = [base];
  let prev = base;
  let n = size;
  while (n > 1) {
    const m = n >> 1;
    const next = new Uint8Array(m * m * channels);
    for (let y = 0; y < m; y++) {
      const r0 = 2 * y * n * channels;
      const r1 = r0 + n * channels;
      for (let x = 0; x < m; x++) {
        const c0 = 2 * x * channels;
        const o = (y * m + x) * channels;
        for (let k = 0; k < channels; k++) {
          const sum = prev[r0 + c0 + k] + prev[r0 + c0 + channels + k]
            + prev[r1 + c0 + k] + prev[r1 + c0 + channels + k];
          next[o + k] = (sum + 2) >> 2;
        }
      }
    }
    levels.push(next);
    prev = next;
    n = m;
  }
  return levels;
}

/** GPU bytes of an RG8 2048² array of this many layers with all twelve levels
 *  allocated: what the pool HOLDS, whatever is resident in it. */
export function cloudFieldPoolBytes(layers: number): number {
  let texels = 0;
  for (let n = CLOUD_PAGE_SIZE; n >= 1; n >>= 1) texels += n * n;
  return texels * 2 * layers;
}

const f6 = (x: number) => x.toFixed(6);
const [GX, GY] = CLOUD_FIELD_GRID;
const PAGE_SCALE = f6(CLOUD_PAGE_CONTENT / CLOUD_PAGE_SIZE);

/**
 * The development build's diagnostics in the field's text (the bridge's
 * `__moon.cloudField({ diag })`): a uniform, two helpers, and two branches in
 * the deck's block. A production build compiles none of them, and the fold
 * test in aerialPerspective.test.ts turns the development text into the
 * production one by deleting exactly these four pieces.
 */
export const CLOUD_FIELD_DIAGNOSTICS: Readonly<Record<'uniform' | 'functions' | 'probe' | 'paint', string>> =
  import.meta.env.DEV
    ? {
      uniform: 'uniform float uCloudFieldDiag;\n',
      functions: /* glsl */ `// The guard's input at a deck-frame direction, for the diagnostic that paints
// it: (major in tile-ratio pixels, major in scene pixels, the guard's weight).
vec3 cloudFieldGuardInput(vec3 deckDir, vec3 dDirX, vec3 dDirY) {
  vec2 k = vec2(${GX}.0, ${GY}.0) * ${PAGE_SCALE};
  vec2 lDx = sphereEquirectUvGrad(deckDir, dDirX) * k;
  vec2 lDy = sphereEquirectUvGrad(deckDir, dDirY) * k;
  float majorScene;
  float major = cloudFieldMajor(lDx, lDy, majorScene);
  return vec3(major, majorScene, cloudFieldGuard(major, majorScene));
}
// The diagnostic's colour for a layer: six hues, one per layer of the slice.
vec3 cloudFieldDiagColour(float layer) {
  float h = fract(layer / 6.0) * 6.0;
  return clamp(abs(mod(h + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}
`,
      probe: /* glsl */ `  if (uCloudFieldDiag > 2.5) {
    // The guard's input, written to the scene target as it stands, unlit, for
    // a readback (DEV): R the major in tile-ratio pixels, G in scene pixels,
    // B the guard's weight.
    gl_FragColor = vec4(cloudFieldGuardInput(dir, ddx, ddy), 1.0);
    return;
  }
`,
      paint: /* glsl */ `    if (uCloudFieldDiag > 0.5) {
      vec3 cloudDiag = cloudFieldDiagColour(cloudFieldLayer);
      if (uCloudFieldDiag < 1.5) {
        diffuseColor.rgb = cloudDiag;
        cloudAlpha = cloudFieldW;
      } else {
        diffuseColor.rgb *= cloudDiag;
      }
    }
`,
    }
    : { uniform: '', functions: '', probe: '', paint: '' };

/**
 * The field's GLSL: declarations and `cloudFieldFine`, every line inside
 * `#ifdef CLOUD_FIELD`. It reads `sphereEquirectUv` and `sphereEquirectUvGrad`
 * (cloudDeck.ts), declared before it in the injected text. `smoothFade` is the
 * smooth magnification filter's hand-over, in texels a pixel (the surface's
 * SURFACE_TEXEL_FADE), handed in so this module stays free of the renderer.
 *
 * Nothing here takes an implicit derivative: the table is read with
 * texelFetch, the page with explicit gradients, the smooth filter's taps at
 * level zero — so the whole function may sit under a per-fragment condition.
 */
export const cloudFieldGlsl = (smoothFade: readonly [number, number]): string => /* glsl */ `
#ifdef CLOUD_FIELD
uniform highp sampler2DArray uCloudPages;
uniform highp sampler2D uCloudPageTable;
${CLOUD_FIELD_DIAGNOSTICS.uniform}uniform float uCloudFieldPixelScale;
// The deck's smooth magnification filter (textureBSpline) on one layer of an
// array: the same cubic B-spline folded into four bilinear taps at level zero.
vec4 textureBSplineLayer(highp sampler2DArray tex, vec2 uv, float layer, vec2 texels) {
  vec2 p = uv * texels - 0.5;
  vec2 f = fract(p);
  vec2 base = p - f;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 s0 = w0 + w1;
  vec2 s1 = w2 + w3;
  vec2 t0 = (base + w1 / s0 - 0.5) / texels;
  vec2 t1 = (base + w3 / s1 + 1.5) / texels;
  return mix(
      mix(textureLod(tex, vec3(t1.x, t0.y, layer), 0.0), textureLod(tex, vec3(t0.x, t0.y, layer), 0.0), s0.x),
      mix(textureLod(tex, vec3(t1.x, t1.y, layer), 0.0), textureLod(tex, vec3(t0.x, t1.y, layer), 0.0), s0.x),
      s1.y);
}
// A page's fade from the table (R = layer + 1, 0 absent; G = the fade), 0
// where nothing is resident and beyond either pole. Columns wrap.
float cloudPageFade(ivec2 cell) {
  if (cell.y < 0 || cell.y >= ${GY}) return 0.0;
  cell.x = cell.x < 0 ? cell.x + ${GX} : (cell.x >= ${GX} ? cell.x - ${GX} : cell.x);
  vec2 e = texelFetch(uCloudPageTable, cell, 0).rg;
  int code = int(floor(e.r * 255.0 + 0.5));
  return code > 0 && code < ${CLOUD_TABLE_SEE_PARENT} ? e.g : 0.0;
}
// The guard's input: page texels a pixel on the footprint's major axis, the
// true largest singular value of [lDx lDy] (the Gram closed form), in REAL
// scene pixels (majorScene) and in tile-ratio pixels (the return value).
float cloudFieldMajor(vec2 lDx, vec2 lDy, out float majorScene) {
  float aa = dot(lDx, lDx);
  float bb = dot(lDy, lDy);
  float ab = dot(lDx, lDy);
  float mean = 0.5 * (aa + bb);
  float spread = sqrt(max(0.25 * (aa - bb) * (aa - bb) + ab * ab, 0.0));
  majorScene = sqrt(max(mean + spread, 0.0)) * ${CLOUD_PAGE_SIZE}.0;
  return majorScene * uCloudFieldPixelScale;
}
// The guard: the main hand-over in tile-ratio pixels, and the safety term on
// the real footprint, which only a scene drawn coarser than the Low rung reaches.
float cloudFieldGuard(float major, float majorScene) {
  return (1.0 - smoothstep(${f6(CLOUD_FIELD_GUARD_TEXELS[0])}, ${f6(CLOUD_FIELD_GUARD_TEXELS[1])}, major))
      * (1.0 - smoothstep(${f6(CLOUD_FIELD_SAFETY_TEXELS[0])}, ${f6(CLOUD_FIELD_SAFETY_TEXELS[1])}, majorScene));
}
// The fine field's (A, P) at a deck-frame direction, and the weight w it may
// take there (0 where no page is resident). dDirX and dDirY are the
// direction's screen derivatives, taken by the caller in uniform flow.
vec2 cloudFieldFine(vec3 deckDir, vec3 dDirX, vec3 dDirY, out float w, out float layer) {
  w = 0.0;
  layer = -1.0;
  vec2 uv = sphereEquirectUv(deckDir);
  vec2 g = vec2(uv.x, clamp(uv.y, 0.0, 0.9999999)) * vec2(${GX}.0, ${GY}.0);
  vec2 cellF = min(floor(g), vec2(${GX - 1}.0, ${GY - 1}.0));
  vec2 s = g - cellF;
  ivec2 cell = ivec2(int(cellF.x), ${GY - 1} - int(cellF.y));
  vec2 entry = texelFetch(uCloudPageTable, cell, 0).rg;
  // The reserved codes first, before any layer is formed from R: 254 (see the
  // parent level) and 255 (known clear) draw the base, as an absent page does.
  int code = int(floor(entry.r * 255.0 + 0.5));
  if (code == 0 || code >= ${CLOUD_TABLE_SEE_PARENT}) return vec2(0.0);
  // The page's texture coordinate per screen pixel: the map's, times the grid
  // and the content's share of the layer.
  vec2 k = vec2(${GX}.0, ${GY}.0) * ${PAGE_SCALE};
  vec2 lDx = sphereEquirectUvGrad(deckDir, dDirX) * k;
  vec2 lDy = sphereEquirectUvGrad(deckDir, dDirY) * k;
  float majorScene;
  float guard = cloudFieldGuard(cloudFieldMajor(lDx, lDy, majorScene), majorScene);
  if (guard <= 0.0) return vec2(0.0);
  float f0 = entry.g;
  vec2 edge = min(s, 1.0 - s);
  float tx = smoothstep(0.0, ${f6(CLOUD_FIELD_EDGE_BAND)}, edge.x);
  float ty = smoothstep(0.0, ${f6(CLOUD_FIELD_EDGE_BAND)}, edge.y);
  float wb = f0;
  if (tx < 1.0 || ty < 1.0) {
    // Table rows run north to south, the page's s.y south to north.
    ivec2 nx = ivec2(s.x < 0.5 ? -1 : 1, 0);
    ivec2 ny = ivec2(0, s.y < 0.5 ? 1 : -1);
    float eX = min(f0, cloudPageFade(cell + nx));
    float eY = min(f0, cloudPageFade(cell + ny));
    float c = min(min(eX, eY), cloudPageFade(cell + nx + ny));
    wb = mix(mix(c, eY, tx), mix(eX, f0, tx), ty);
  }
  w = wb * guard;
  if (w <= 0.0) return vec2(0.0);
  layer = float(code - 1);
  vec2 local = (${CLOUD_PAGE_GUTTER}.0 + s * ${CLOUD_PAGE_CONTENT}.0) / ${CLOUD_PAGE_SIZE}.0;
  float perPixel = max(abs(lDx.x) + abs(lDy.x), abs(lDx.y) + abs(lDy.y)) * ${CLOUD_PAGE_SIZE}.0;
  float smoothW = 1.0 - smoothstep(${f6(smoothFade[0])}, ${f6(smoothFade[1])}, perPixel);
  // Fully magnified, the mix below returns the B-spline alone: the filtered
  // fetch would be read and thrown away, so it is not taken.
  vec2 fine = vec2(0.0);
  if (smoothW < 1.0) fine = textureGrad(uCloudPages, vec3(local, layer), lDx, lDy).rg;
  if (smoothW > 0.0) {
    vec2 smoothed = textureBSplineLayer(uCloudPages, local, layer, vec2(${CLOUD_PAGE_SIZE}.0)).rg;
    fine = smoothW >= 1.0 ? smoothed : mix(fine, smoothed, smoothW);
  }
  return fine;
}
${CLOUD_FIELD_DIAGNOSTICS.functions}#endif
`;

/**
 * The field in the deck's block, right after the albedo rule has set the
 * colour the deck draws today and before the relief and the clear-sky return,
 * every line inside `#ifdef CLOUD_FIELD`. The base's `(A0, P0)` is what the
 * block draws today — its alpha (eroded at its edges by the detail noise, as
 * today) and that alpha times the brightness its colour now has — so where no
 * page is resident (w = 0) nothing here runs and the block is the block it was.
 * Where one is, `(A, P)` is the mix at w; the alpha becomes A and the
 * brightness P / A, the hue the base's. The erosion is the base's alone: the
 * field's own edges are the 1.2 km map's, so at full weight none of it remains.
 *
 * In a development build, `uCloudFieldDiag` (CLOUD_FIELD_DIAGNOSTICS): 1
 * paints each resident layer a flat colour at the alpha w (where the pages
 * sit, and how their weights meet); 2 tints the field by its layer's colour
 * (whether the cloud runs on across a page's edge); 3 writes the guard's input.
 */
export const CLOUD_FIELD_MIX_GLSL = (luminance: string): string => /* glsl */ `
#ifdef CLOUD_FIELD
  float cloudFieldW = 0.0;
  float cloudFieldLayer = -1.0;
${CLOUD_FIELD_DIAGNOSTICS.probe}  vec2 cloudFieldAP = cloudFieldFine(dir, ddx, ddy, cloudFieldW, cloudFieldLayer);
  if (cloudFieldW > 0.0) {
    float cloudC0 = dot(diffuseColor.rgb, ${luminance});
    vec3 cloudHue = cloudC0 > 1e-4 ? diffuseColor.rgb / cloudC0 : vec3(1.0);
    vec2 cloudAP = mix(vec2(cloudAlpha, cloudAlpha * cloudC0), cloudFieldAP, cloudFieldW);
    cloudAlpha = cloudAP.x;
    diffuseColor.rgb = min(cloudHue * (cloudAP.y / max(cloudAP.x, 1e-4)), vec3(1.0));
${CLOUD_FIELD_DIAGNOSTICS.paint}  }
#endif
`;
