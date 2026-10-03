/**
 * The cloud deck's 1.2 km field: pages of NASA's cloud map at 32k, sampled
 * inside the deck's own draw where a page is resident, the shipped sheet
 * everywhere else. This module is the field's arithmetic and its GLSL — where a
 * direction lands on a page, how much of the page a fragment may take, how a
 * page's mips are built — with a TypeScript twin of every rule the shader
 * applies, so the tests can pin the addressing without a GPU. The pool that
 * holds the pages and the bridge that drives them are `cloudFieldPool.ts`.
 *
 * DEVELOPMENT ONLY, AND OFF. This is the vertical slice that decides whether
 * HD clouds go ahead: a few hard-wired pages, no streamer, no ground reads. The
 * shader half is a compile-time define, CLOUD_FIELD, set only on the deck's
 * material and only on the dev server with `?cloudtiles=1`; a production build
 * carries none of the text, and a development program without the define is
 * the program it was, after the preprocessor, character for character.
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
 * The footprint, in a page's own texels along the screen's longer axis, over
 * which the field hands back to the base: full weight to 4 texels a pixel
 * (LOD 2), none from 8 (LOD 3). The gutter is 8 texels, and a filter footprint
 * — however the hardware splits it between anisotropic taps and a coarser
 * level — reaches about half the major axis either side of its centre, plus a
 * bilinear texel; past 8 that would read beyond the gutter into texels that
 * belong to no neighbour. Measured on the MAJOR axis so the guard holds with
 * anisotropy on: an anisotropic footprint keeps a fine level and spreads its
 * taps along that axis instead.
 */
export const CLOUD_FIELD_GUARD_TEXELS: readonly [number, number] = [4, 8];

/** The array's anisotropy: trilinear with a modest anisotropic boost. */
export const CLOUD_FIELD_ANISOTROPY = 4;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** three's SphereGeometry UV for a unit direction in the sphere's own frame:
 *  the deck's map UV, which the pages are cut against. The same formula as
 *  `sphereEquirectUv` in cloudDeck.ts, repeated so this module stays free of
 *  everything but arithmetic. */
function equirectUv(d: Vec3): [number, number] {
  const u = Math.atan2(d[2], -d[0]) / (2 * Math.PI);
  return [u - Math.floor(u), 0.5 + Math.asin(Math.min(1, Math.max(-1, d[1]))) / Math.PI];
}

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
  const [u, v] = equirectUv(dir);
  const gx = u * CLOUD_FIELD_GRID[0];
  const gy = Math.min(Math.max(v, 0), 0.9999999) * CLOUD_FIELD_GRID[1];
  const cx = Math.min(Math.floor(gx), CLOUD_FIELD_GRID[0] - 1);
  const cy = Math.min(Math.floor(gy), CLOUD_FIELD_GRID[1] - 1);
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
 *  a pixel (along its major axis) may take. Mirrored by `guard` in the GLSL. */
export function cloudFieldGuard(majorTexelsPerPixel: number): number {
  return 1 - smoothstep(CLOUD_FIELD_GUARD_TEXELS[0], CLOUD_FIELD_GUARD_TEXELS[1], majorTexelsPerPixel);
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
 * The page's two grey channels as one RG8 layer in GL order. The files are
 * north-up — row 0 is the page's northern edge, as any image is — and a
 * texture's row 0 is t = 0, the SOUTHERN edge in the deck's UV, so the rows
 * are reversed here. `stride` is the bytes a source texel takes (4 for RGBA
 * read back off a canvas, whose grey has R = G = B; 1 for a raw channel).
 */
export function packCloudPage(
  a: Uint8Array | Uint8ClampedArray, p: Uint8Array | Uint8ClampedArray, size: number, stride = 1,
): Uint8Array {
  const out = new Uint8Array(size * size * 2);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * stride;
    const dst = y * size * 2;
    for (let x = 0; x < size; x++) {
      out[dst + 2 * x] = a[src + x * stride];
      out[dst + 2 * x + 1] = p[src + x * stride];
    }
  }
  return out;
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

/** The dev switch: `?cloudtiles=1` on the development server. */
export function cloudFieldRequested(search?: string): boolean {
  if (!import.meta.env.DEV) return false;
  const q = search ?? (typeof location !== 'undefined' ? location.search : '');
  return new URLSearchParams(q).get('cloudtiles') === '1';
}

const f6 = (x: number) => x.toFixed(6);
const [GX, GY] = CLOUD_FIELD_GRID;
const PAGE_SCALE = f6(CLOUD_PAGE_CONTENT / CLOUD_PAGE_SIZE);

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
export const cloudFieldGlsl = (smoothFade: readonly [number, number]): string => /* glsl */ `#ifdef CLOUD_FIELD
uniform highp sampler2DArray uCloudPages;
uniform highp sampler2D uCloudPageTable;
uniform float uCloudFieldDiag;
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
  return e.r > 0.0 ? e.g : 0.0;
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
  if (entry.r == 0.0) return vec2(0.0);
  // The page's texture coordinate per screen pixel: the map's, times the grid
  // and the content's share of the layer.
  vec2 k = vec2(${GX}.0, ${GY}.0) * ${PAGE_SCALE};
  vec2 lDx = sphereEquirectUvGrad(deckDir, dDirX) * k;
  vec2 lDy = sphereEquirectUvGrad(deckDir, dDirY) * k;
  float major = max(length(lDx), length(lDy)) * ${CLOUD_PAGE_SIZE}.0;
  float guard = 1.0 - smoothstep(${f6(CLOUD_FIELD_GUARD_TEXELS[0])}, ${f6(CLOUD_FIELD_GUARD_TEXELS[1])}, major);
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
  layer = floor(entry.r * 255.0 + 0.5) - 1.0;
  vec2 local = (${CLOUD_PAGE_GUTTER}.0 + s * ${CLOUD_PAGE_CONTENT}.0) / ${CLOUD_PAGE_SIZE}.0;
  vec2 fine = textureGrad(uCloudPages, vec3(local, layer), lDx, lDy).rg;
  float perPixel = max(abs(lDx.x) + abs(lDy.x), abs(lDx.y) + abs(lDy.y)) * ${CLOUD_PAGE_SIZE}.0;
  float smoothW = 1.0 - smoothstep(${f6(smoothFade[0])}, ${f6(smoothFade[1])}, perPixel);
  if (smoothW > 0.0) {
    fine = mix(fine, textureBSplineLayer(uCloudPages, local, layer, vec2(${CLOUD_PAGE_SIZE}.0)).rg, smoothW);
  }
  return fine;
}
// The diagnostic's colour for a layer: six hues, one per layer of the slice.
vec3 cloudFieldDiagColour(float layer) {
  float h = fract(layer / 6.0) * 6.0;
  return clamp(abs(mod(h + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}
#endif
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
 * `uCloudFieldDiag`: 1 paints each resident layer a flat colour at the alpha w
 * (where the pages sit, and how their weights meet); 2 tints the field by its
 * layer's colour (whether the cloud runs on across a page's edge).
 */
export const CLOUD_FIELD_MIX_GLSL = (luminance: string): string => /* glsl */ `#ifdef CLOUD_FIELD
  float cloudFieldW = 0.0;
  float cloudFieldLayer = -1.0;
  vec2 cloudFieldAP = cloudFieldFine(dir, ddx, ddy, cloudFieldW, cloudFieldLayer);
  if (cloudFieldW > 0.0) {
    float cloudC0 = dot(diffuseColor.rgb, ${luminance});
    vec3 cloudHue = cloudC0 > 1e-4 ? diffuseColor.rgb / cloudC0 : vec3(1.0);
    vec2 cloudAP = mix(vec2(cloudAlpha, cloudAlpha * cloudC0), cloudFieldAP, cloudFieldW);
    cloudAlpha = cloudAP.x;
    diffuseColor.rgb = min(cloudHue * (cloudAP.y / max(cloudAP.x, 1e-4)), vec3(1.0));
    if (uCloudFieldDiag > 0.5) {
      vec3 cloudDiag = cloudFieldDiagColour(cloudFieldLayer);
      if (uCloudFieldDiag < 1.5) {
        diffuseColor.rgb = cloudDiag;
        cloudAlpha = cloudFieldW;
      } else {
        diffuseColor.rgb *= cloudDiag;
      }
    }
  }
#endif
`;
