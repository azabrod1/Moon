/**
 * Earth's haze, its table lookups evaluated once per small block of the screen
 * instead of once per surface fragment.
 *
 * **Why.** Every fragment of Earth's ground and cloud deck is dimmed by the
 * air between it and the camera and has that air's own light added (world/
 * surfaceShading, "Aerial perspective, last"). That block is the frame's
 * single most expensive term up close: two 2D fetches for the transmittance
 * and eight dependent fetches from the 3D scattering tables for each light's
 * in-scatter — two ends of the segment, two nu slabs each, and the single-Mie
 * colour beside each — the Sun's always, the Moon's again on the night side.
 * Measured on an M5 Max (Chromium, ANGLE/Metal, High) the block costs about
 * 0.9 ms of a frame at the postcard pose and 1.1 ms straight down from 1.05 R,
 * which is the difference between that frame fitting a 120 Hz refresh and
 * missing it. The air itself changes slowly across the screen: each quantity
 * is an integral along a ray through a few kilometres of scale height, and
 * neighbouring rays a few pixels apart cross nearly the same air.
 *
 * **What is cached.** The three table quantities of that block, at one unit
 * of irradiance — the segment's transmittance (a colour), the Sun's
 * in-scatter and the Moon's — for each of the two layers the surfaces end
 * their segments at — the ground at the body's radius and the cloud deck at
 * its stated altitude (AIR_LOOKUP_RADIUS) — on a grid of one cell per
 * `HAZE_CACHE_DIVISOR` × `HAZE_CACHE_DIVISOR` scene pixels, rebuilt every frame
 * from nothing (no history, so nothing can lag or smear). Each cell runs the
 * surfaces' own GLSL (`aerialSegment`, `aerialTransmittance`,
 * `aerialInscatter`, `aerialForLight`) on the segment from the camera to where
 * the ray through the cell's centre first meets the layer's sphere. Everything
 * else in the block stays per fragment and exact: the segment, the haze
 * weight, the loading fade, the cloud shadow's share of the air, the eclipse,
 * the Moon's own weight and irradiance, and the bridge to the scene's Sun.
 * Earth's night-lights shell is its own material and stays exact. Earth only:
 * Earth is where the cost is, and every other body with tables keeps its
 * exact per-fragment haze — its uniforms never switch the cache on. Its
 * program does carry the cache's read, the text being one for every body, and
 * a longer program can round a lit term differently by one display step at a
 * scattering of pixels; at the Moon and Mars poses it measured no change.
 *
 * **The atlas.** A surface material may bind one more sampler and no more
 * (the census holds the busiest program at 15 of 16 units), so each layer's
 * three quantities share one RGBA16F texture: three blocks side by side, the
 * Sun's in-scatter with the alpha, then the transmittance, then the Moon's
 * in-scatter with an alpha of its own, a guard column between blocks. A
 * surface reads each block with the same sampler at its own offset, its
 * coordinate clamped a 256th of a texel inside that block's outer texel
 * centres, so a bilinear footprint never takes weight from beyond the block's
 * drawn cells — not even through a coordinate rounded the wrong way on
 * hardware that snaps sub-texel weights; the guard is a margin behind that.
 * The pass draws each block of each layer over that layer's region (below):
 * each texel finds its block from its column, evaluates its cell's segment
 * once and only its own block's quantity. The transmittance is evaluated in
 * all three blocks, because both in-scatters are near minus far carried back
 * through it; that is two 2D fetches each. The Moon's block is not drawn while no moonlight is bound —
 * the surfaces read it only where moonlight is bound, on the same uniform —
 * and is left empty in any cell whose ground point has the Sun too high for a
 * fragment near it to take moonlight (HAZE_MOON_MARGIN_SIN): an empty Moon
 * cell carries alpha 0, so a fragment that would read it is evaluated exactly
 * instead.
 *
 * **Allocated once.** The atlas is sized from the ALLOCATED scene size
 * (main.ts sceneRectsLive.alloc), not the drawn one: under Dynamic the frame
 * is drawn into a sub-rectangle of a fixed allocation and the rectangle moves
 * on every rung, and a cache that followed it would free and re-create both
 * atlases in a frame that is already late. The blocks are laid out at the
 * allocated width; each frame draws only the cells the active rectangle needs
 * (through a viewport), and the surfaces read only those. The two atlases are
 * held for the session, about 3 bytes per allocated scene pixel: at High on a
 * 1728 × 1117 window at a ratio of 2 (a 5184 × 3351 allocation) each is
 * 3890 × 838 half-float texels, about 26 MB, 52 MB for the two; at Medium on
 * the same window about 23 MB. They are counted in the device's GPU memory
 * envelope beside the atmosphere tables (`hazeCacheGpuBytes`, read by
 * PlanetariumMode.liveGlobalMapBytes), from the targets that exist, so a
 * texture rung is admitted against what is really left. They are made, storage
 * and all, on the first frame the tables are live and the ground is in view,
 * whether or not the pass is drawn that frame.
 *
 * **Where the cache is not trusted.** The cached value is a different segment
 * from the fragment's own: the mesh is a polyhedron and the cache ends on the
 * true sphere, and between cell centres the value is interpolated. Both are
 * small where the air varies slowly and wrong where it does not, so a
 * fragment evaluates all three exactly, as it did before the cache existed,
 * when ANY of these holds:
 *
 *   - its segment does not reach the ground (the other half of the folded
 *     table, and the thin ring of deck outside the ground's silhouette);
 *   - it is seen within `HAZE_EXACT_GRAZING` of grazing (the haze weight's own
 *     grazing measure, at the segment's end): the limb, where the column
 *     changes fastest and a footprint of 8 or 16 pixels can reach across the
 *     silhouette;
 *   - its own segment-entry Sun cosine — or, where the Moon lights it, the
 *     Moon's — lies within `HAZE_MIE_EPS` of the interval `0 … 0.01` over
 *     which `aerialInscatter` switches single Mie off below the horizon, a cut
 *     0.57 degrees wide that interpolation would smear;
 *   - the footprint's alpha says so (below), which is also where the cut is
 *     guarded at the scale of a cell: the pass knows the entry cosines of the
 *     nine rays around each cell, and how fast they change across a cell
 *     depends on how far the camera stands from where the ray enters the air
 *     — a fortieth of the cut's width per cell from 1.05 R, several cuts' worth
 *     per cell from 8 R — so no fixed margin on the fragment could be right at
 *     every distance.
 *
 * **The alpha contract.** It lives in the Sun's block and decides all three
 * reads at that coordinate. Each texel's alpha is computed in the pass from
 * the geometry alone, no table fetch: the cell and its eight neighbours each
 * cast a ray through their centres, and the cell is trusted only if all nine
 * reach the ground and the range of their nine segment-entry Sun cosines
 * stays clear of the single-Mie cut (widened by `HAZE_MIE_EPS`); the Moon's
 * block carries the same test on the Moon's cosines in its own alpha, which
 * the surface reads where the Moon lights it. A trusted cell's alpha is its distance from the ground's
 * projected silhouette, in cache texels (the angle between its ray and the
 * body's centre against the silhouette cone `asin(R/|camera|)`, times the
 * scene camera's focal length in texels), mapped `(distance − 1) / 3` onto
 * 0 … 1; an untrusted one's is 0. Because the flag is dilated by one cell, any
 * 2 × 2 footprint that touches a cell whose own ray misses the ground reads
 * alpha exactly 0, with no neighbour reads in the surface shader. The surface
 * then takes: alpha 0 → exact; alpha 1 → the cache; in between → exact and
 * cache mixed by alpha, which is the band from about one to four texels inside
 * the silhouette. The exact transmittance is evaluated wherever the alpha is
 * below 1, because every exact term is carried back through it. A cell whose
 * own ray misses the ground stores zero: every footprint that could weight it
 * reads alpha 0 and takes the exact branch, so the value is never read. The
 * cached transmittance dims the sea's glint where the fragment is on the
 * cache, exactly as the exact one does elsewhere.
 *
 * **The pass.** A composer pass right before the scene's RenderPass and one
 * right after it (main.ts buildComposer, the planetarium's composer only).
 * The first refreshes the camera's and the body's world matrices itself — the
 * scene render that would otherwise do it comes later — draws each layer's
 * region into its own half-float target, and only then switches the layer on
 * for the surfaces; the second switches it off again. So the cache is in force
 * only for the one scene draw it was rendered for: a warm-up draw, a census
 * link, a resize, a mode change, a table rebind or a context restore between
 * frames always sees it off and draws the exact haze; a pass that begins
 * switches the last frame's layers off before anything else, so not even a
 * scene draw that threw can leave them on. The cells are the ACTIVE scene
 * draw rectangle's (main.ts applySceneViewports), not the canvas's: the rays
 * and the surfaces' coordinates both run over that rectangle. Linear data: no
 * tone curve, no blending, no depth, no mipmaps; the targets are linear,
 * clamped and filtered.
 *
 * **Drawn over the disc.** The pass's cost follows Earth's disc, not the
 * screen: each frame each layer is drawn only over the cells its surfaces can
 * read, one rectangle of them (hazeSphereCells) drawn in each block through a
 * viewport. The rectangle is the screen bounds of the layer's sphere — the
 * larger of its own radius and the ground's — under the scene camera's own
 * projection, the one the scene draw uses, padded by HAZE_REGION_PAD_PX scene
 * pixels, taken to cells and widened by HAZE_REGION_PAD_CELLS; a sphere the
 * camera's plane cuts (the camera close in) has no finite bounds and gets
 * every cell. A cell outside the rectangle holds whatever an earlier frame left
 * there, and no fragment reads one:
 *
 *   - a fragment exists only inside its own mesh's silhouette. The globe and
 *     its sectors have every vertex on the body's sphere and the deck on its
 *     own, so their triangles lie inside those spheres and their pixels inside
 *     the spheres' screen bounds — a pixel's centre, where it is shaded, within
 *     0.71 px of them under multisampling. (A surface also uses an atlas value
 *     only where its segment reaches the ground, hazeExactOnly; elsewhere what
 *     it fetched is discarded by a select, whatever it was.)
 *   - such a fragment reads at cell coordinate (n + 1)/2 × cw for its NDC n,
 *     clamped inside the drawn cells, and its bilinear footprint is the texel at
 *     floor(c − ½) and the one after it: at most one cell past the coordinate's
 *     own cell, at any divisor;
 *   - the rectangle reaches 2 px past the bounds and then 2 cells either way.
 *
 * So every texel any fragment's footprint touches — both texels on each axis,
 * whatever their weights — was drawn this frame. The trust test is computed
 * inside each drawn cell from its own nine rays and reads no other texel, so
 * the alpha contract holds inside the rectangle exactly as it did over the
 * whole grid. The guard columns are never drawn and keep the zero WebGL gives a
 * new texture; the columns past the drawn width on a lower Dynamic rung, like
 * the rows past the drawn height, keep what a higher rung left, and the clamp
 * on the read (HAZE_EDGE) stops a footprint short of them. Each block's draw is
 * scissored to its viewport as well, for a tile GPU that takes the area it
 * loads and stores from the scissor. `__moon.hazeCache({ poison: true })` clears every texel to an
 * alpha-1 magenta before each frame's rectangle is drawn, so a read of an
 * undrawn one would show as a glaring pixel (the test of all this in a
 * browser). Nothing is cleared: a clear would only spend bandwidth on cells no
 * fragment reads, and an out-of-region read would be as wrong from a cleared
 * cell as from a stale one, so the guarantee is the rectangle, not the clear.
 *
 * **Skipped when small.** Inside a frame the pass costs about 0.02 ms however
 * small its rectangle (its two render passes, one per layer) and about 2e-8
 * ms per scene pixel of the ground's rectangle; the surfaces save about 8e-8
 * ms per such pixel on a far disc and more close in. Below HAZE_MIN_REGION_PX
 * the fixed part is not paid back, so the pass is not drawn, both layers stay
 * off and the surfaces evaluate exactly — the path the fidelity gates already
 * hold the cache to, so the crossing does not show. Measured on an M5 Max
 * (headless Chromium, ANGLE/Metal, High at a ratio of 2, a 5184 × 3351 scene,
 * on battery in Low Power Mode, which reads every cost about 2.6 times the
 * mains figures): the pass's cost in a frame by drawing it 21 times a frame
 * and reading the whole frame (0.021 ms at a 34 000-pixel rectangle, 0.11 ms at
 * 4.4 million, 0.66 ms over the whole scene); the surfaces' saving from 170
 * interleaved pairs at discs from 2.5 R to 12 R, fitted against the
 * rectangle's size (0.07–0.09 ms per million pixels; a single pose's saving is
 * below that run's resolution, about 0.2 ms). The break-even this brackets,
 * 0.36–0.82 million pixels, is a pixel count rather than a share of the
 * screen because the fixed part is: a smaller window or a lower Dynamic rung
 * needs a larger share of its screen before the pass pays. Other GPUs are
 * unmeasured; a wrong threshold costs a few hundredths of a millisecond near
 * it, never a picture.
 *
 * **Linked in the idle.** The pass's program is linked where the atmosphere
 * tier is armed (PlanetariumMode.warmHazeCacheProgram, inside the muted-link
 * window, before the bake), with the pass's own mesh and camera and a 1 × 1
 * target of the atlas format (`warmup`), so its first frame links nothing.
 *
 * **Doors.** `?hazecache=0` (any build) compiles the surfaces without the
 * cache at all: the define is gone and every surface program is the program
 * from before the cache, character for character. The DEV switch `haze-cache`
 * (app/perfSwitches.ts) turns it off live, inside one compiled program, for an
 * A/B out of one page load. DEV `?hazecachediv=<n>` sets the divisor,
 * `?hazeexact=<grazing>,<scale of HAZE_MIE_EPS>` the exact band, `?hazecache32f=1`
 * stores the cache in 32-bit float to separate storage error from spatial
 * error, `?hazeprobe=1` compiles the full-resolution probes and the reason
 * readout, and `__moon.hazeCache()` reads the state out (size, divisor, exact
 * band, the layers drawn, each layer's rectangle and the ground's size in
 * pixels, why the pass was skipped, and — with the probes compiled — `{
 * coverage: true }`, the share of the visible surface on the cache and on each
 * exact reason); `__moon.hazeCache({ minRegionPx })` moves the skip threshold
 * (0 draws at every size) and `{ poison: true }` poisons the undrawn texels.
 * The pass is the "Haze cache" row of `__moon.gpuProfile`.
 */
import * as THREE from 'three';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import {
  AERIAL_PERSPECTIVE_GLSL,
  ATMOSPHERE_LOOKUP_GLSL,
  atmosphereLookupUniforms,
  atmosphereSessionSizes,
  atmosphereTableDefines,
} from '../planetarium/world/atmosphereLut';
import { perfSwitchOn } from './perfSwitches';

/** Scene pixels per cache texel, each way. */
export const HAZE_CACHE_DIVISOR = 4;
/** The haze weight's grazing measure (1 − cos of the view angle at the
 *  segment's end) from which a fragment always evaluates the haze exactly:
 *  about 72.5 degrees from straight down, the outer 5 % of a disc's radius
 *  seen from afar. Measured, not chosen: at 0.8 the deck's cached
 *  transmittance and light, interpolated across the last few texels where the
 *  column lengthens fastest, left the twilight band of a far disc a step
 *  darker in one channel in eight; at 0.7 that band is within the gate. */
export const HAZE_EXACT_GRAZING = 0.7;
/** How far past the surfaces' own moonlight limit (the subject's
 *  `moonDayLimitSin`) the pass still fills the Moon's block, in the Sun's
 *  elevation sine at the cell's ground point: about 6 degrees. A saving, not
 *  the guarantee: the surfaces weight moonlight by the Sun over their own
 *  (relief-perturbed) normal, and far out two cells near the grazing band can
 *  span more than this, so an empty Moon cell carries alpha 0 and a fragment
 *  whose footprint touches one is evaluated exactly. */
export const HAZE_MOON_MARGIN_SIN = 0.1;
/** The single-Mie cut-off `aerialInscatter` applies, as the segment-entry Sun
 *  cosine at which it is complete. Its start is 0. */
export const HAZE_MIE_CUT = 0.01;
/** How far either side of that cut a light's segment-entry cosine still
 *  counts as inside it: a tenth of the cut's own width. The cell's test (the
 *  range of its nine rays) brackets the cosine across the cell; this covers
 *  what the bracket can miss — the cosine's curvature between ray centres,
 *  and the fragment's own segment ending on the mesh rather than on the
 *  sphere — and it is also the fragment's own margin, kept because a
 *  fragment that sits in the cut is exact whatever its cells say. */
export const HAZE_MIE_EPS = 0.001;
/** What a bilinear alpha has to reach to count as one: 1 − 1/1024, so a
 *  footprint whose weights round a hair under one still takes the cache. */
export const HAZE_FULL = 1 - 1 / 1024;
/** How far inside its outer texel centres a block is read, in texels. */
export const HAZE_EDGE = 1 / 256;
/** Scene pixels a layer's screen bounds are widened by before they become
 *  cells. A multisampled pixel is shaded at its centre whenever any of its
 *  samples is covered, so a fragment's centre can sit up to 0.71 px outside
 *  the silhouette it was drawn for; the rest is margin. */
export const HAZE_REGION_PAD_PX = 2;
/** Cells a layer's drawn region reaches past those bounds on every side: one
 *  for the bilinear footprint, whose second texel lies up to one cell beyond
 *  the read coordinate's own, and one of margin. */
export const HAZE_REGION_PAD_CELLS = 2;
/** The smallest ground region, in scene pixels (cells × divisor²), the pass is
 *  drawn for; below it the surfaces evaluate the haze exactly. Measured, as the
 *  break-even of what the pass costs inside a frame against what the surfaces
 *  save (header, "Skipped when small"): between about 0.36 and 0.82 million
 *  region pixels on an M5 Max; half a million is the rectangle of a disc
 *  seen from about 7 R in the 60-degree view on a 5184 × 3351 scene, and from
 *  between 5.5 and 6 R on a 4320 × 2700 one (High, 1440 × 900 at 2×). */
export const HAZE_MIN_REGION_PX = 500_000;

/** `?hazecache=0`, any build: the surfaces compile without the cache. */
export function parseHazeCacheParam(search: string): boolean {
  return new URLSearchParams(search).get('hazecache') !== '0';
}
/** DEV `?hazecachediv=<n>`: scene pixels per cache texel. */
export function parseHazeDivisorParam(search: string, dev: boolean): number {
  const n = dev ? Number(new URLSearchParams(search).get('hazecachediv')) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : HAZE_CACHE_DIVISOR;
}
/** DEV `?hazeexact=<grazing>,<margin scale>`: the exact band. */
export function parseHazeExactParam(search: string, dev: boolean): { grazing: number; margin: number } {
  const raw = dev ? new URLSearchParams(search).get('hazeexact') : null;
  const [g, m] = (raw ?? '').split(',').map(Number);
  return {
    grazing: Number.isFinite(g) && g > 0 && g <= 1 ? g : HAZE_EXACT_GRAZING,
    margin: Number.isFinite(m) && m >= 0 ? m : 1,
  };
}
/** DEV `?hazecache32f=1`: the cache stored in 32-bit float, the diagnostic. */
export function parseHaze32fParam(search: string, dev: boolean): boolean {
  return dev && new URLSearchParams(search).get('hazecache32f') === '1';
}

/** DEV `?hazeprobe=1`: the surfaces also compile the full-resolution probes
 *  and the reason readout (HAZE_PROBE), for a measurement session; without
 *  it a development program has the shipping structure, so it can be timed. */
export function parseHazeProbeParam(search: string, dev: boolean): boolean {
  return dev && new URLSearchParams(search).get('hazeprobe') === '1';
}
let probeCompiled = false;
export function setHazeProbeCompiled(on: boolean): void {
  probeCompiled = import.meta.env.DEV && on;
}
/** Whether the surfaces compile the probes and the readout this session. */
export function hazeProbeCompiled(): boolean {
  return probeCompiled;
}

let compiled = true;
/** Set once at boot from the URL, before any surface material exists. */
export function setHazeCacheCompiled(on: boolean): void {
  compiled = on;
}
/** Whether the surfaces compile the cache's read this session. */
export function hazeCacheCompiled(): boolean {
  return compiled;
}

/**
 * The camera ray through a point of the active scene viewport, shared by the
 * pass and by the surfaces' development probe so the two derive it with one
 * text. `ray` is the projection's (1/P00, 1/P11, P20/P00, P21/P11) — exact for
 * any perspective, the off-axis terms included — and `basis` the camera's
 * world rotation; the result is in the world's axes, which is the frame the
 * surfaces' segments are in (body-centred, world-axis offsets).
 */
export const HAZE_RAY_GLSL = /* glsl */ `
vec3 hazeRayDir(vec2 ndc, vec4 ray, mat3 basis) {
  return normalize(basis * vec3(ndc.x * ray.x + ray.z, ndc.y * ray.y + ray.w, -1.0));
}
// The distance along a unit ray to its first crossing of the sphere of this
// radius about the centre, or -1. The discriminant from the ray's closest
// approach rather than as a difference of two squares of the camera's
// distance, which loses its digits far out.
float hazeSphereHit(vec3 origin, vec3 dir, float radius) {
  float b = dot(origin, dir);
  vec3 perp = origin - dir * b;
  float disc = radius * radius - dot(perp, perp);
  if (disc < 0.0) return -1.0;
  float t = -b - sqrt(disc);
  return t > 0.0 ? t : -1.0;
}
`;

/** Where the cells sit in a layer's atlas. `cw × ch` cells are drawn this
 *  frame (the active rectangle over the divisor); the blocks are laid out at
 *  the allocation's width `cwAlloc`, `stride` texels apart, so a rung step
 *  moves no memory. */
export interface HazeAtlasLayout {
  cw: number;
  ch: number;
  cwAlloc: number;
  chAlloc: number;
  stride: number;
  atlasW: number;
  atlasH: number;
}

/** The atlas for an active draw rectangle inside an allocation, both in
 *  scene pixels. Its size depends on the allocation alone. */
export function hazeAtlasLayout(
  drawW: number, drawH: number, allocW: number, allocH: number, divisor: number,
): HazeAtlasLayout {
  const cw = Math.max(1, Math.ceil(drawW / divisor));
  const ch = Math.max(1, Math.ceil(drawH / divisor));
  const cwAlloc = Math.max(cw, Math.ceil(allocW / divisor));
  const chAlloc = Math.max(ch, Math.ceil(allocH / divisor));
  const stride = cwAlloc + 1;
  return { cw, ch, cwAlloc, chAlloc, stride, atlasW: 2 * stride + cwAlloc, atlasH: chAlloc };
}

/** The pass's reading of an atlas column (its GLSL, in integers): which
 *  block and which cell, or null for a column no cell is drawn into. */
export function hazeAtlasCell(x: number, layout: HazeAtlasLayout): { block: number; local: number } | null {
  const block = Math.floor(x / layout.stride);
  const local = x - block * layout.stride;
  return block > 2 || local >= layout.cw ? null : { block, local };
}

/** The surface's read of block `block` from the pixel centre (x, y) of a
 *  drawW × drawH rectangle, in atlas texels, as its GLSL computes it in single
 *  precision: the cell coordinate clamped HAZE_EDGE inside the outer cell
 *  centres (a block one cell wide at its centre), then the block's offset. */
export function hazeAtlasSample(
  x: number, y: number, drawW: number, drawH: number, layout: HazeAtlasLayout, block: number,
): [number, number] {
  const f = Math.fround;
  const clampCell = (v: number, n: number): number => {
    const lo = Math.min(f(0.5 + HAZE_EDGE), f(0.5 * n));
    const hi = Math.max(f(n - 0.5 - HAZE_EDGE), f(0.5 * n));
    return Math.min(Math.max(v, lo), hi);
  };
  const cx = clampCell(f(f(x / drawW) * layout.cw), layout.cw);
  const cy = clampCell(f(f(y / drawH) * layout.ch), layout.ch);
  const u = f(f(cx * f(1 / layout.atlasW)) + f(block * f(layout.stride / layout.atlasW)));
  const v = f(cy * f(1 / layout.atlasH));
  return [u * layout.atlasW, v * layout.atlasH];
}

/** The projection's ray terms, (1/P00, 1/P11, P20/P00, P21/P11). */
export function hazeRayTerms(projection: ArrayLike<number>, out: THREE.Vector4): THREE.Vector4 {
  return out.set(1 / projection[0], 1 / projection[5], projection[8] / projection[0], projection[9] / projection[5]);
}

/** HAZE_RAY_GLSL's hazeRayDir on the CPU. */
export function hazeRayDirCpu(
  ndcX: number, ndcY: number, ray: THREE.Vector4, basis: THREE.Matrix3, out: THREE.Vector3,
): THREE.Vector3 {
  return out.set(ndcX * ray.x + ray.z, ndcY * ray.y + ray.w, -1).applyMatrix3(basis).normalize();
}

const _gvToCentre = new THREE.Vector3();
const _gvAxis = new THREE.Vector3();
const SIGNS = [-1, 1] as const;
/**
 * Whether a view can reach a sphere's ground at all: the angle from the
 * view's axis to the sphere's centre against the sphere's silhouette cone
 * plus the view's widest corner, the corners taken from the projection itself
 * (its off-axis terms included) and a degree over. A camera close to the body
 * is inside any bounding sphere wherever it looks — the Observatory looking
 * straight up — so a frustum test alone draws the cache for a frame with no
 * ground in it.
 */
export function hazeGroundInView(
  camPos: THREE.Vector3, camMatrixWorld: THREE.Matrix4, projection: ArrayLike<number>,
  centre: THREE.Vector3, groundRadius: number,
): boolean {
  _gvToCentre.subVectors(centre, camPos);
  const dist = _gvToCentre.length();
  if (!(dist > groundRadius)) return true;
  const edge = Math.asin(groundRadius / dist);
  _gvAxis.set(0, 0, -1).transformDirection(camMatrixWorld);
  const axisAngle = _gvAxis.angleTo(_gvToCentre);
  let corner = 0;
  for (const sx of SIGNS) {
    for (const sy of SIGNS) {
      const vx = (sx + projection[8]) / projection[0];
      const vy = (sy + projection[9]) / projection[5];
      corner = Math.max(corner, Math.atan(Math.hypot(vx, vy)));
    }
  }
  return axisAngle <= edge + corner + THREE.MathUtils.degToRad(1);
}

/** A rectangle of a layer's cells: `x0 ≤ x < x1`, `y0 ≤ y < y1`. */
export interface HazeCellRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The cells a surface fragment drawn inside a sphere can read this frame, in a
 * grid of `cw × ch` cells over the scene draw rectangle; null when no pixel of
 * the rectangle can hold such a fragment.
 *
 * The sphere's screen bounds are exact for a perspective projection, off-axis
 * terms included: on the tangent plane (x/−z, y/−z), which the projection maps
 * to NDC affinely, the extremes along x are the planes through the camera
 * parallel to the view's y axis that touch the sphere — `(cx·d ± r·√(cx² + d²
 * − r²)) / (d² − r²)` for a centre at view-space (cx, ·, −d) — and likewise
 * along y. They are padded by HAZE_REGION_PAD_PX scene pixels, taken to cells
 * (a fragment at NDC n reads cell coordinate (n + 1)/2 × cw), widened by
 * HAZE_REGION_PAD_CELLS and clamped to the grid. A sphere not wholly in front
 * of the camera's plane has unbounded screen bounds and gets every cell; one
 * wholly behind it gets none. So does any projection that is not a
 * perspective one this models: every cell.
 */
export function hazeSphereCells(
  view: ArrayLike<number>, projection: ArrayLike<number>, centre: THREE.Vector3, radius: number,
  cw: number, ch: number, drawW: number, drawH: number, out: HazeCellRect,
): HazeCellRect | null {
  out.x0 = 0;
  out.y0 = 0;
  out.x1 = cw;
  out.y1 = ch;
  const p = projection;
  if (p[11] !== -1 || p[15] !== 0 || p[3] !== 0 || p[7] !== 0 || p[1] !== 0 || p[4] !== 0
      || !(p[0] > 0) || !(p[5] > 0)) return out;
  const v = view;
  const cx = v[0] * centre.x + v[4] * centre.y + v[8] * centre.z + v[12];
  const cy = v[1] * centre.x + v[5] * centre.y + v[9] * centre.z + v[13];
  const cz = v[2] * centre.x + v[6] * centre.y + v[10] * centre.z + v[14];
  // The view matrix's own scale, should it carry one, applies to the radius too.
  const r = radius * Math.max(Math.hypot(v[0], v[1], v[2]), Math.hypot(v[4], v[5], v[6]), Math.hypot(v[8], v[9], v[10]));
  const d = -cz;
  if (!(d > r)) return cz >= r ? null : out;
  const k = d * d - r * r;
  const qx = r * Math.sqrt(cx * cx + k);
  const qy = r * Math.sqrt(cy * cy + k);
  const padX = (2 * HAZE_REGION_PAD_PX) / drawW;
  const padY = (2 * HAZE_REGION_PAD_PX) / drawH;
  // NDC from the tangent: n = P00·t − P20 (and P11, P21 along y).
  const lx = (p[0] * ((cx * d - qx) / k) - p[8] - padX + 1) * 0.5 * cw;
  const hx = (p[0] * ((cx * d + qx) / k) - p[8] + padX + 1) * 0.5 * cw;
  const ly = (p[5] * ((cy * d - qy) / k) - p[9] - padY + 1) * 0.5 * ch;
  const hy = (p[5] * ((cy * d + qy) / k) - p[9] + padY + 1) * 0.5 * ch;
  if (!(hx >= 0 && lx <= cw && hy >= 0 && ly <= ch)) return null;
  out.x0 = Math.max(0, Math.floor(lx) - HAZE_REGION_PAD_CELLS);
  out.x1 = Math.min(cw, Math.ceil(hx) + HAZE_REGION_PAD_CELLS);
  out.y0 = Math.max(0, Math.floor(ly) - HAZE_REGION_PAD_CELLS);
  out.y1 = Math.min(ch, Math.ceil(hy) + HAZE_REGION_PAD_CELLS);
  return out;
}

/** A region's size in scene pixels: its cells times the divisor squared. */
export function hazeRegionPx(rect: HazeCellRect, divisor: number): number {
  return (rect.x1 - rect.x0) * (rect.y1 - rect.y0) * divisor * divisor;
}

/** The skip rule: the pass is drawn only for a ground region of at least
 *  `minPx` scene pixels (HAZE_MIN_REGION_PX). */
export function hazeRegionWorthDrawing(rect: HazeCellRect | null, divisor: number, minPx: number): boolean {
  return rect !== null && hazeRegionPx(rect, divisor) >= minPx;
}

/**
 * What the surfaces add under `HAZE_CACHE`: the cache's uniforms and the
 * function that hands the aerial block its Sun in-scatter. Injected right
 * after the lookup and AERIAL_PERSPECTIVE_GLSL, so the segment type and the
 * lookups exist. Every line is inside the define's own conditional.
 *
 * The fetch is `textureLod` at level 0: it sits in a branch that is uniform
 * for the draw, but the exact branch below it diverges per fragment, and the
 * cache has no levels to choose between anyway. Development builds can add,
 * under HAZE_PROBE (`?hazeprobe=1`), the full-resolution probes (`uHazeProbe`:
 * the cache's own endpoint on the true sphere, evaluated per fragment
 * wherever the cache would be read, optionally round-tripped through half
 * float, or everywhere) and the reason readout (`uHazeDiag`); left out by
 * default, because each probe inlines the lookup again and a program that
 * size does not time like the one that ships.
 */
export function hazeSurfaceDeclsGlsl(dev: boolean): string {
  const probe = dev ? `#ifdef HAZE_PROBE
uniform float uHazeProbe;
uniform vec4 uHazeRay;
uniform mat3 uHazeBasis;
uniform float uHazeDiag;
float hazeReason = 0.0;
${HAZE_RAY_GLSL}
vec3 hazeHalf(vec3 s) {
  return vec3(unpackHalf2x16(packHalf2x16(s.rg)), unpackHalf2x16(packHalf2x16(vec2(s.b, 0.0))).x);
}
// The cache's own endpoint, the true sphere under this pixel's centre,
// evaluated here at full resolution: 1 where the cache would be read (the
// exact rules honoured), 2 the same stored through half float, 3 everywhere.
vec3 hazeProbeInscatter(AerialSegment seg, vec3 airT) {
  if (uHazeProbe < 2.5 && hazeExactOnly(seg, false)) return aerialInscatter(uScattering, seg, airT);
  vec2 ndc = 2.0 * (gl_FragCoord.xy - uHazeViewport.xy) / uHazeViewport.zw - 1.0;
  vec3 c = vAirCam / uPlanetRadius;
  vec3 d = hazeRayDir(ndc, uHazeRay, uHazeBasis);
  float t = hazeSphereHit(c, d, uAirLookupRadius > 0.0 ? uAirLookupRadius : uBottomRadius);
  if (t > 0.0) {
    AerialSegment sphere = aerialSegment(c, c + d * t, normalize(uSunDirWorld));
    if (sphere.valid) {
      vec3 s = aerialInscatter(uScattering, sphere, aerialTransmittance(uTransmittance, sphere));
      return uHazeProbe > 1.5 && uHazeProbe < 2.5 ? hazeHalf(s) : s;
    }
  }
  return aerialInscatter(uScattering, seg, airT);
}
#endif
` : '';
  const full = HAZE_FULL.toFixed(10);
  const edge = HAZE_EDGE.toFixed(8);
  const reason = dev
    ? `#ifdef HAZE_PROBE
    hazeReason = !seg.hitsGround ? 2.0 : hazeGrazing(seg) >= uHazeExact.x ? 3.0 : hazeMieBand(seg.muS) ? 4.0
        : moonOn && hazeMieBand(hazeMoonMuS(seg)) ? 5.0 : sunA.a <= 0.0 ? 6.0
        : moonOn && moonA.a < ${full} ? 5.0 : sunA.a < ${full} ? 7.0 : 8.0;
#endif
`
    : '';
  return `#ifdef HAZE_CACHE
uniform sampler2D uHazeSun;
uniform float uHazeOn;
uniform vec4 uHazeViewport;
uniform vec2 uHazeExact;
uniform vec4 uHazeAtlas;
uniform float uHazeStride;
// The haze weight's own grazing measure, at the segment's end.
float hazeGrazing(AerialSegment seg) {
  vec3 up = normalize(seg.origin + seg.view * seg.d);
  return 1.0 - clamp(dot(up, -seg.view), 0.0, 1.0);
}
// A segment-entry light cosine inside the single-Mie cut-off, widened by the
// margin: the Sun's, or the Moon's for its own share.
bool hazeMieBand(float muS) {
  return muS >= -uHazeExact.y && muS <= ${HAZE_MIE_CUT.toFixed(2)} + uHazeExact.y;
}
float hazeMoonMuS(AerialSegment seg) {
  return clampCosine(dot(seg.origin, normalize(uMoonDirWorld)) / seg.r);
}
// Where every cached quantity is always evaluated exactly.
bool hazeExactOnly(AerialSegment seg, bool moonOn) {
  return !seg.hitsGround || hazeGrazing(seg) >= uHazeExact.x || hazeMieBand(seg.muS)
      || (moonOn && hazeMieBand(hazeMoonMuS(seg)));
}
${probe}// What the cache holds for this fragment, and how far to trust it: a is 0
// off or untrusted, 1 the cache alone, between the two a mix; the exact
// transmittance is evaluated wherever a < 1, because every exact term reads it.
struct HazeRead {
  float a;
  vec3 t;
  vec3 sun;
  vec3 moon;
  vec3 tExact;
};
HazeRead hazeRead(AerialSegment seg, bool moonOn) {
  HazeRead h = HazeRead(0.0, vec3(1.0), vec3(0.0), vec3(0.0), vec3(1.0));
${dev ? '#ifdef HAZE_PROBE\n  hazeReason = 1.0;\n#endif\n' : ''}  if (uHazeOn > 0.0) {
    vec2 uv = (gl_FragCoord.xy - uHazeViewport.xy) / uHazeViewport.zw;
    // The drawn cells of the first block, clamped a 256th of a texel inside
    // their outer centres (a block one cell wide is read at its centre); the
    // other two blocks lie a stride further on.
    vec2 lo = min(vec2(0.5 + ${edge}), 0.5 * uHazeAtlas.xy);
    vec2 cell = clamp(uv * uHazeAtlas.xy, lo, max(uHazeAtlas.xy - 0.5 - ${edge}, 0.5 * uHazeAtlas.xy));
    vec2 at = cell * uHazeAtlas.zw;
    vec4 sunA = textureLod(uHazeSun, at, 0.0);
    vec4 moonA = vec4(0.0);
    h.a = hazeExactOnly(seg, moonOn) ? 0.0 : sunA.a;
    if (h.a > 0.0) {
      h.sun = sunA.rgb;
      h.t = textureLod(uHazeSun, at + vec2(uHazeStride, 0.0), 0.0).rgb;
      if (moonOn) {
        // The Moon's own alpha: below one where a cell of the footprint was
        // left empty or straddles the Moon's cut-off, and then every quantity
        // is evaluated exactly.
        moonA = textureLod(uHazeSun, at + vec2(2.0 * uHazeStride, 0.0), 0.0);
        if (moonA.a < ${full}) h.a = 0.0;
        else h.moon = moonA.rgb;
      }
    }
${reason}  }
  if (h.a < ${full}) h.tExact = aerialTransmittance(uTransmittance, seg);
  return h;
}
vec3 hazeTransmittance(HazeRead h) {
  return h.a >= ${full} ? h.t : h.a > 0.0 ? mix(h.tExact, h.t, h.a) : h.tExact;
}
vec3 hazeSunInscatter(HazeRead h, AerialSegment seg) {
${dev ? '#ifdef HAZE_PROBE\n  if (uHazeProbe > 0.5) return hazeProbeInscatter(seg, h.tExact);\n#endif\n' : ''}  if (h.a >= ${full}) return h.sun;
  vec3 exact = aerialInscatter(uScattering, seg, h.tExact);
  return h.a > 0.0 ? mix(exact, h.sun, h.a) : exact;
}
vec3 hazeMoonInscatter(HazeRead h, AerialSegment seg) {
  if (h.a >= ${full}) return h.moon;
  vec3 exact = aerialInscatter(uScattering, aerialForLight(seg, normalize(uMoonDirWorld)), h.tExact);
  return h.a > 0.0 ? mix(exact, h.moon, h.a) : exact;
}
#endif
`;
}

/** The reasons the development readout names, by the code the surface writes
 *  (`hazeReason`); 0 is a fragment with no air in front of it. */
export const HAZE_REASONS = ['no air', 'cache off', 'misses the ground', 'grazing', 'Mie cut-off', 'Moon cut-off or empty Moon cell', 'silhouette or cut footprint', 'blend', 'cache'] as const;

const PASS_VERTEX = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const PASS_FRAGMENT = /* glsl */ `
${ATMOSPHERE_LOOKUP_GLSL}
${AERIAL_PERSPECTIVE_GLSL}
${HAZE_RAY_GLSL}
// The two tables this pass reads; the lookup text leaves their declarations
// to each consumer.
uniform sampler2D uTransmittance;
uniform sampler3D uScattering;
uniform vec3 uSunDirWorld;
uniform vec3 uMoonDirWorld;
uniform float uHazeMoonOn;
uniform float uHazeMoonSin;
uniform float uHazeMieEps;
uniform vec3 uHazeCam;
uniform float uHazeLayerRadius;
uniform vec4 uHazeRay;
uniform mat3 uHazeBasis;
// x, y: the cells drawn this frame; z: the block stride in texels.
uniform vec3 uHazeTexels;
uniform float uHazeFocal;

// Whether a ray from the camera reaches the ground sphere, from the geometry
// alone: ahead of the camera and passing closer to the centre than the ground.
bool hazeGroundRay(vec3 c, vec3 d) {
  float b = dot(c, d);
  vec3 perp = c - d * b;
  return b < 0.0 && dot(perp, perp) <= uBottomRadius * uBottomRadius;
}

// The light's cosine at the point where a ray from the camera enters the air,
// as aerialSegment derives the segment's own: the camera itself when it is
// inside the top. A ray that misses the air has no entry; 2 keeps it out of
// any band (its cell is untrusted anyway: it misses the ground).
float hazeEntryMuS(vec3 c, vec3 d, vec3 l) {
  float r = length(c);
  if (r > uTopRadius) {
    float rmu = dot(c, d);
    float disc = rmu * rmu - r * r + uTopRadius * uTopRadius;
    if (disc < 0.0) return 2.0;
    c += d * (-rmu - sqrt(disc));
    r = uTopRadius;
  }
  return clampCosine(dot(c, l) / r);
}

// Whether a light's entry cosine, over the cell and its eight neighbours,
// comes within the margin of the single-Mie cut: the cut is then somewhere in
// the cell's footprint, whatever the distance makes a cell's span of it.
bool hazeCutInCell(vec3 c, vec2 ndc, vec2 texel, vec3 l) {
  float lo = 2.0;
  float hi = -2.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      float mu = hazeEntryMuS(c, hazeRayDir(ndc + vec2(float(i), float(j)) * texel, uHazeRay, uHazeBasis), l);
      if (mu < 1.5) { lo = min(lo, mu); hi = max(hi, mu); }
    }
  }
  return hi >= -uHazeMieEps && lo <= ${HAZE_MIE_CUT.toFixed(2)} + uHazeMieEps;
}

void main() {
  // Which block of the atlas this texel is in, and which cell of it: blocks
  // laid out at the allocation's width, a guard column after the first two,
  // and only the first cw × ch cells of each drawn. In integers: a GPU's float
  // division is not correctly rounded, and the first column of a block, an
  // exact multiple of the stride, can divide to just under its block number.
  int cw = int(uHazeTexels.x + 0.5);
  int stride = int(uHazeTexels.z + 0.5);
  int xi = int(gl_FragCoord.x);
  int block = xi / stride;
  int local = xi - block * stride;
  if (local >= cw) { gl_FragColor = vec4(0.0); return; }
  vec2 uv = vec2((float(local) + 0.5) / float(cw), gl_FragCoord.y / uHazeTexels.y);
  vec2 ndc = uv * 2.0 - 1.0;
  vec2 texel = 2.0 / uHazeTexels.xy;
  vec3 c = uHazeCam;
  vec3 d = hazeRayDir(ndc, uHazeRay, uHazeBasis);
  float t = hazeSphereHit(c, d, uHazeLayerRadius);
  // A cell whose own ray misses the ground holds nothing: every footprint
  // that could weight it reads alpha 0 and is evaluated exactly.
  if (!(t > 0.0) || !hazeGroundRay(c, d)) { gl_FragColor = vec4(0.0); return; }
  vec3 moonDir = normalize(uMoonDirWorld);
  // The Moon's block is empty (alpha 0) while no moonlight is bound, wherever
  // the Sun stands so high over the cell's ground point that no fragment near
  // it can take moonlight (uHazeMoonSin), and where the Moon's own cut-off
  // crosses the cell — all decided before any lookup.
  if (block == 2 && !(uHazeMoonOn > 0.0
      && dot(normalize(c + d * t), normalize(uSunDirWorld)) < uHazeMoonSin
      && !hazeCutInCell(c, ndc, texel, moonDir))) {
    gl_FragColor = vec4(0.0);
    return;
  }
  AerialSegment seg = aerialSegment(c, c + d * t, normalize(uSunDirWorld));
  if (!seg.valid) { gl_FragColor = vec4(0.0); return; }
  vec3 airT = aerialTransmittance(uTransmittance, seg);
  if (block == 2) {
    // The Moon's in-scatter at one unit of irradiance.
    gl_FragColor = vec4(aerialInscatter(uScattering, aerialForLight(seg, moonDir), airT), 1.0);
    return;
  }
  if (block == 1) { gl_FragColor = vec4(airT, 1.0); return; }
  // The Sun's block carries the alpha that decides all three.
  bool trusted = true;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      trusted = trusted && hazeGroundRay(c, hazeRayDir(ndc + vec2(float(i), float(j)) * texel, uHazeRay, uHazeBasis));
    }
  }
  float alpha = 0.0;
  if (trusted && !hazeCutInCell(c, ndc, texel, normalize(uSunDirWorld))) {
    vec3 toCentre = -normalize(c);
    float angle = atan(length(cross(d, toCentre)), dot(d, toCentre));
    float edge = asin(min(uBottomRadius / length(c), 1.0));
    alpha = clamp(((edge - angle) * uHazeFocal - 1.0) / 3.0, 0.0, 1.0);
  }
  gl_FragColor = vec4(aerialInscatter(uScattering, seg, airT), alpha);
}
`;

/** One layer's surface-side uniforms, as the air block carries them. */
export interface HazeLayerUniforms {
  uHazeSun: THREE.IUniform;
  uHazeOn: THREE.IUniform;
}

/** The uniforms every surface's air block carries for the cache: the ground
 *  layer's under their GLSL names, the deck's under `…Deck` (the deck's
 *  material points the GLSL names at those), and the ones the two share. */
export function createHazeAirUniforms(dummy: THREE.Texture): Record<string, THREE.IUniform> {
  const u: Record<string, THREE.IUniform> = {
    uHazeSun: { value: dummy },
    uHazeOn: { value: 0 },
    uHazeSunDeck: { value: dummy },
    uHazeOnDeck: { value: 0 },
    uHazeViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
    uHazeExact: { value: new THREE.Vector2(HAZE_EXACT_GRAZING, HAZE_MIE_EPS) },
    // The atlas's layout: the cells drawn this frame (x, y), one texel in
    // texture coordinates (z, w), and one block's stride in texture
    // coordinates.
    uHazeAtlas: { value: new THREE.Vector4(1, 1, 1 / 3, 1) },
    uHazeStride: { value: 1 / 3 },
  };
  if (import.meta.env.DEV) {
    u.uHazeProbe = { value: 0 };
    u.uHazeRay = { value: new THREE.Vector4(1, 1, 0, 0) };
    u.uHazeBasis = { value: new THREE.Matrix3() };
    u.uHazeDiag = hazeDiagUniform;
  }
  return u;
}

/** The development readout's switch, one object for every surface. */
export const hazeDiagUniform = { value: 0 };

/** What the cache is told about the body it serves, each frame. The
 *  provider hands back one object, rewritten in place, rather than a new one
 *  a frame. */
export interface HazeCacheSubject {
  /** The body's air block (world/surfaceShading SurfaceAirFx). */
  air: Record<string, THREE.IUniform>;
  /** The body's sun direction uniform, the one its surfaces read. */
  sunDirWorld: THREE.IUniform;
  globe: THREE.Object3D;
  /** The cloud deck, when one is drawn this frame. */
  deck: THREE.Object3D | null;
  /** The deck's radius in the tables' radius units (1 = the ground). */
  deckRadius: number;
  /** The Sun's elevation sine at a fragment's ground point from which the
   *  surfaces take no moonlight (the night side's sun-down weight reaches
   *  zero there: NIGHT_FILL's terminator width, the globe's and the deck's). */
  moonDayLimitSin: number;
}

/** The scene rectangles the cache is laid out from (main.ts sceneRectsLive). */
export interface HazeSceneRects {
  draw: { width: number; height: number };
  alloc: { width: number; height: number };
}

export type HazeProbe = 'off' | 'endpoint-sphere' | 'endpoint-sphere-half' | 'endpoint-sphere-raw';

/** The development readout (`__moon.hazeCache()`). The geometry fields are
 *  written only in a development build. */
export interface HazeCacheState {
  compiled: boolean;
  /** Whether the development probes and the readout are compiled (`?hazeprobe=1`). */
  probeCompiled: boolean;
  on: boolean;
  probe: HazeProbe;
  divisor: number;
  grazing: number;
  marginScale: number;
  storage: '16f' | '32f';
  layers: 'ground' | 'both';
  /** The cells drawn this frame. */
  size: [number, number] | null;
  /** The active rectangle, and the atlas as allocated. */
  viewport: [number, number] | null;
  atlas: [number, number] | null;
  drawn: { ground: boolean; deck: boolean };
  /** The cells each layer was drawn over this frame, [x0, y0, x1, y1] (the
   *  development build only). */
  regions: { ground: [number, number, number, number] | null; deck: [number, number, number, number] | null };
  /** The ground region's size in scene pixels, the skip rule's measure. */
  regionPx: number | null;
  /** The skip rule's threshold (HAZE_MIN_REGION_PX unless moved). */
  minRegionPx: number;
  /** Development: every undrawn texel cleared to an alpha-1 magenta before
   *  each frame's cells are drawn, so a fragment that read one would show. */
  poison: boolean;
  mieMargin: number;
  /** Whether moonlight is bound this frame, so the Moon's block was drawn. */
  moonLit: boolean;
  skipped: string | null;
  /** The body-centred camera in radius units and the Sun's direction, for a
   *  probe that rebuilds the frame's geometry on the CPU. */
  geometry: { camera: [number, number, number]; sun: [number, number, number]; radiusAU: number } | null;
}

let sessionCache: HazeCache | null = null;
/** The session's cache: the one whose atlases the memory envelope counts. */
export function setSessionHazeCache(cache: HazeCache | null): void {
  sessionCache = cache;
}
/** GPU bytes the session's atlases hold right now; 0 before the first frame
 *  with live tables and the ground in view, which is when they are made. */
export function hazeCacheGpuBytes(): number {
  return sessionCache?.gpuBytes() ?? 0;
}
/** The session's pass program to link in the idle (HazeCache.warmup), or null
 *  when there is none to link. */
export function sessionHazeCacheWarmup(): ReturnType<HazeCache['warmup']> {
  return sessionCache?.warmup() ?? null;
}

const _camPos = new THREE.Vector3();
const _bodyPos = new THREE.Vector3();
const _layerPos = new THREE.Vector3();
/** The table uniforms the pass reads off the body's air block each frame. */
const LOOKUP_KEYS = Object.keys(atmosphereLookupUniforms());
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _viewProj = new THREE.Matrix4();

const _clearColour = new THREE.Color();
const POISON = new THREE.Color(1, 0, 1);

interface LayerDraw {
  layer: 'ground' | 'deck';
  mesh: THREE.Object3D | null;
  radius: number;
  /** The cells drawn this frame, or null for none. */
  rect: HazeCellRect | null;
  readonly cells: HazeCellRect;
}

/** The pass's one triangle over its viewport. Its own, not FullScreenQuad's:
 *  the idle warm-up links the program for this mesh and this camera, the
 *  objects the pass then draws with, so the two can never ask three for
 *  different programs. */
function passTriangle(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  return geometry;
}

/**
 * The cache's GPU side: the pass material and the two layer atlases, kept for
 * the session across composer rebuilds (a rebuild disposes its passes, never
 * this).
 */
export class HazeCache {
  private material: THREE.ShaderMaterial | null = null;
  private mesh: THREE.Mesh | null = null;
  /** The camera the pass's triangle is drawn with; its vertex stage ignores
   *  it. A perspective one only because the idle warm-up takes one. */
  private readonly passCamera = new THREE.PerspectiveCamera();
  private targets: { ground: THREE.WebGLRenderTarget | null; deck: THREE.WebGLRenderTarget | null } = { ground: null, deck: null };
  private live: HazeCacheSubject | null = null;
  private state: HazeCacheState;
  private readonly basis = new THREE.Matrix3();
  private readonly ray = new THREE.Vector4();
  private readonly layerDraws: [LayerDraw, LayerDraw] = [
    { layer: 'ground', mesh: null, radius: 1, rect: null, cells: { x0: 0, y0: 0, x1: 0, y1: 0 } },
    { layer: 'deck', mesh: null, radius: 1, rect: null, cells: { x0: 0, y0: 0, x1: 0, y1: 0 } },
  ];

  constructor(
    private readonly subject: () => HazeCacheSubject | null,
    private readonly rects: () => HazeSceneRects,
    opts: { divisor: number; grazing: number; margin: number; f32: boolean },
  ) {
    this.state = {
      compiled: hazeCacheCompiled(),
      probeCompiled: hazeProbeCompiled(),
      on: false,
      probe: 'off',
      divisor: opts.divisor,
      grazing: opts.grazing,
      marginScale: opts.margin,
      storage: opts.f32 ? '32f' : '16f',
      layers: 'both',
      size: null,
      viewport: null,
      atlas: null,
      drawn: { ground: false, deck: false },
      regions: { ground: null, deck: null },
      regionPx: null,
      minRegionPx: HAZE_MIN_REGION_PX,
      poison: false,
      mieMargin: HAZE_MIE_EPS * opts.margin,
      moonLit: false,
      skipped: null,
      geometry: null,
    };
  }

  /** Development: move the knobs live; reads the state back. */
  devSet(opts: Partial<{
    divisor: number; grazing: number; margin: number; probe: HazeProbe; layers: 'ground' | 'both';
    minRegionPx: number; poison: boolean;
  }>): HazeCacheState {
    if (import.meta.env.DEV) {
      if (opts.divisor !== undefined && Number.isInteger(opts.divisor) && opts.divisor >= 1 && opts.divisor <= 16) this.state.divisor = opts.divisor;
      if (opts.grazing !== undefined && opts.grazing > 0 && opts.grazing <= 1) this.state.grazing = opts.grazing;
      if (opts.margin !== undefined && opts.margin >= 0) this.state.marginScale = opts.margin;
      if (opts.probe !== undefined) this.state.probe = opts.probe;
      if (opts.layers !== undefined) this.state.layers = opts.layers;
      if (opts.minRegionPx !== undefined && opts.minRegionPx >= 0) this.state.minRegionPx = opts.minRegionPx;
      if (opts.poison !== undefined) this.state.poison = opts.poison;
    }
    return this.readout();
  }

  readout(): HazeCacheState {
    return { ...this.state, drawn: { ...this.state.drawn }, regions: { ...this.state.regions } };
  }

  /** GPU bytes the atlases that exist hold: width × height × 8 for half
   *  float (16 for the 32-bit diagnostic), each. */
  gpuBytes(): number {
    const held = (t: THREE.WebGLRenderTarget | null): number =>
      (t ? t.width * t.height * (t.texture.type === THREE.FloatType ? 16 : 8) : 0);
    return held(this.targets.ground) + held(this.targets.deck);
  }

  /** The layer's atlas, for a test or a readout; null before it exists. */
  targetOf(layer: 'ground' | 'deck'): THREE.WebGLRenderTarget | null {
    return this.targets[layer];
  }

  /** What the idle warm-up links (PlanetariumMode.armAtmosphereTierSteps):
   *  the pass's own mesh and camera, and a 1 × 1 target of the atlases' own
   *  format to compile and draw it in — three keys a program on the target
   *  being drawn into, and the pipeline behind it on the target's format.
   *  Null in a session compiled without the cache, which never draws it. */
  warmup(): { root: THREE.Object3D; camera: THREE.PerspectiveCamera; createTarget: () => THREE.WebGLRenderTarget } | null {
    if (!hazeCacheCompiled()) return null;
    this.ensureMaterial();
    return {
      root: this.mesh!,
      camera: this.passCamera,
      createTarget: () => new THREE.WebGLRenderTarget(1, 1, this.targetOptions()),
    };
  }

  private ensureMaterial(): THREE.ShaderMaterial {
    if (this.material) return this.material;
    const lookup = atmosphereLookupUniforms();
    const uniforms: Record<string, THREE.IUniform> = {
      ...lookup,
      uSunDirWorld: { value: new THREE.Vector3(1, 0, 0) },
      uMoonDirWorld: { value: new THREE.Vector3(0, 0, 1) },
      uHazeMoonOn: { value: 0 },
      uHazeMoonSin: { value: 1 },
      uHazeMieEps: { value: HAZE_MIE_EPS },
      uHazeCam: { value: new THREE.Vector3() },
      uHazeLayerRadius: { value: 1 },
      uHazeRay: { value: new THREE.Vector4() },
      uHazeBasis: { value: new THREE.Matrix3() },
      uHazeTexels: { value: new THREE.Vector3(1, 1, 2) },
      uHazeFocal: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'HazeCache',
      uniforms,
      defines: atmosphereTableDefines(atmosphereSessionSizes()),
      vertexShader: PASS_VERTEX,
      fragmentShader: PASS_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(passTriangle(), this.material);
    this.mesh.frustumCulled = false;
    return this.material;
  }

  private targetOptions(): THREE.RenderTargetOptions {
    return {
      type: this.state.storage === '32f' ? THREE.FloatType : THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    };
  }

  /** The layer's atlas at the allocation's size: made once, and sized again
   *  only when the allocation itself moves (a resize, a level, a pin), never
   *  on a rung step. */
  private ensureTarget(layer: 'ground' | 'deck', w: number, h: number): THREE.WebGLRenderTarget {
    let target = this.targets[layer];
    const options = this.targetOptions();
    if (target && target.texture.type !== options.type) {
      target.dispose();
      target = null;
    }
    if (!target) {
      target = new THREE.WebGLRenderTarget(w, h, options);
      target.texture.name = `HazeCache ${layer}`;
      this.targets[layer] = target;
    } else if (target.width !== w || target.height !== h) {
      target.setSize(w, h);
    }
    return target;
  }

  /** Before the scene draw: last frame's layers off, the frame's geometry
   *  onto the subject's surfaces, the layers drawn, and only then the layers
   *  switched on. */
  begin(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    this.end();
    this.state.drawn.ground = false;
    this.state.drawn.deck = false;
    this.state.moonLit = false;
    this.state.skipped = null;
    if (import.meta.env.DEV) {
      this.state.regions.ground = null;
      this.state.regions.deck = null;
      this.state.regionPx = null;
    }
    this.state.compiled = hazeCacheCompiled();
    const on = this.state.compiled && (import.meta.env.DEV ? perfSwitchOn('haze-cache') : true);
    this.state.on = on;
    if (!this.state.compiled) { this.state.skipped = 'not compiled'; return; }
    const subject = this.subject();
    if (!subject) { this.state.skipped = 'no body with live tables'; return; }
    const cam = camera as THREE.PerspectiveCamera;
    if (!cam.isPerspectiveCamera) { this.state.skipped = 'not a perspective camera'; return; }
    const air = subject.air;
    const radiusAU = air.uPlanetRadius.value as number;
    if (!((air.uAirDensity.value as number) > 0) || !(radiusAU > 0)) { this.state.skipped = 'tables not live'; return; }

    // The matrices the scene draw is about to use, refreshed here because it
    // has not run yet: the camera's and the body's, from their own transforms.
    cam.updateWorldMatrix(true, false);
    subject.globe.updateWorldMatrix(true, false);
    _camPos.setFromMatrixPosition(cam.matrixWorld);
    _bodyPos.setFromMatrixPosition(subject.globe.matrixWorld);
    _viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_viewProj);
    _sphere.set(_bodyPos, radiusAU * Math.max(subject.deckRadius, 1) * 1.02);
    if (!subject.globe.visible || !_frustum.intersectsSphere(_sphere)) { this.state.skipped = 'body not in view'; return; }
    const p = cam.projectionMatrix.elements;
    if (!hazeGroundInView(_camPos, cam.matrixWorld, p, _bodyPos, (air.uBottomRadius.value as number) * radiusAU)) {
      this.state.skipped = 'ground not in view';
      return;
    }

    const rects = this.rects();
    const W = rects.draw.width;
    const H = rects.draw.height;
    const layout = hazeAtlasLayout(W, H, rects.alloc.width, rects.alloc.height, this.state.divisor);
    const { cw, ch, stride, atlasW, atlasH } = layout;
    hazeRayTerms(p, this.ray);
    this.basis.setFromMatrix4(cam.matrixWorld);
    this.state.mieMargin = HAZE_MIE_EPS * this.state.marginScale;

    (air.uHazeViewport.value as THREE.Vector4).set(0, 0, W, H);
    (air.uHazeAtlas.value as THREE.Vector4).set(cw, ch, 1 / atlasW, 1 / atlasH);
    air.uHazeStride.value = stride / atlasW;
    (air.uHazeExact.value as THREE.Vector2).set(this.state.grazing, this.state.mieMargin);
    const sun = subject.sunDirWorld.value as THREE.Vector3;
    if (import.meta.env.DEV) {
      (air.uHazeRay.value as THREE.Vector4).copy(this.ray);
      (air.uHazeBasis.value as THREE.Matrix3).copy(this.basis);
      this.state.viewport = [W, H];
      this.state.size = [cw, ch];
      this.state.atlas = [atlasW, atlasH];
      this.state.geometry = {
        camera: [(_camPos.x - _bodyPos.x) / radiusAU, (_camPos.y - _bodyPos.y) / radiusAU, (_camPos.z - _bodyPos.z) / radiusAU],
        sun: [sun.x, sun.y, sun.z],
        radiusAU,
      };
    }
    this.live = subject;
    if (!on) { this.state.skipped = 'switched off'; return; }
    if (import.meta.env.DEV && this.state.probe !== 'off' && hazeProbeCompiled()) {
      air.uHazeProbe.value = { 'endpoint-sphere': 1, 'endpoint-sphere-half': 2, 'endpoint-sphere-raw': 3 }[this.state.probe];
      this.state.skipped = `probe ${this.state.probe}`;
      return;
    }

    // The cells each layer's surfaces can read this frame (the header's
    // "Drawn over the disc"), each about its own mesh's centre; the ground's
    // decides whether the pass is worth drawing at all.
    const ground = this.layerDraws[0];
    ground.mesh = subject.globe;
    ground.radius = air.uBottomRadius.value as number;
    const deck = this.layerDraws[1];
    deck.mesh = subject.deck && this.state.layers === 'both' ? subject.deck : null;
    deck.radius = subject.deckRadius;
    if (deck.mesh) deck.mesh.updateWorldMatrix(true, false);
    const view = cam.matrixWorldInverse.elements;
    for (const draw of this.layerDraws) {
      draw.rect = null;
      if (!draw.mesh) continue;
      const centre = draw.layer === 'ground' ? _bodyPos : _layerPos.setFromMatrixPosition(draw.mesh.matrixWorld);
      // The larger of the layer's sphere and the ground's — a fragment reads
      // only where its segment reaches the ground — and of the mesh's own
      // world scale, should it carry one.
      const reach = radiusAU * Math.max(1, draw.radius, air.uBottomRadius.value as number)
          * Math.max(1, draw.mesh.matrixWorld.getMaxScaleOnAxis());
      draw.rect = hazeSphereCells(view, p, centre, reach, cw, ch, W, H, draw.cells);
      if (import.meta.env.DEV && draw.rect) {
        this.state.regions[draw.layer] = [draw.rect.x0, draw.rect.y0, draw.rect.x1, draw.rect.y1];
      }
    }
    // The atlases exist, storage and all, from the first frame the tables are
    // live and the ground is in view, however small the disc: the memory
    // envelope counts the targets that exist, so a texture rung admitted while
    // the disc is small is admitted against what the session will really hold,
    // and the allocation's zero-fill lands here rather than in the frame of
    // an approach that first draws the pass.
    for (const draw of this.layerDraws) {
      if (!draw.mesh) continue;
      const fresh = !this.targets[draw.layer];
      const target = this.ensureTarget(draw.layer, atlasW, atlasH);
      if (fresh) renderer.initRenderTarget(target);
    }
    if (ground.rect) this.state.regionPx = hazeRegionPx(ground.rect, this.state.divisor);
    if (!ground.rect) { this.state.skipped = 'disc off screen'; return; }
    if (!hazeRegionWorthDrawing(ground.rect, this.state.divisor, this.state.minRegionPx)) {
      this.state.skipped = 'disc too small';
      return;
    }

    const material = this.ensureMaterial();
    const u = material.uniforms;
    for (const key of LOOKUP_KEYS) u[key].value = air[key].value;
    (u.uSunDirWorld.value as THREE.Vector3).copy(sun);
    (u.uMoonDirWorld.value as THREE.Vector3).copy(air.uMoonDirWorld.value as THREE.Vector3);
    u.uHazeMoonOn.value = (air.uMoonIrradiance.value as THREE.Vector3).y > 0 ? 1 : 0;
    this.state.moonLit = u.uHazeMoonOn.value === 1;
    u.uHazeMoonSin.value = subject.moonDayLimitSin + HAZE_MOON_MARGIN_SIN;
    u.uHazeMieEps.value = this.state.mieMargin;
    (u.uHazeRay.value as THREE.Vector4).copy(this.ray);
    (u.uHazeBasis.value as THREE.Matrix3).copy(this.basis);
    (u.uHazeTexels.value as THREE.Vector3).set(cw, ch, stride);
    // The vertical focal length, in cache texels.
    u.uHazeFocal.value = (ch / 2) * p[5];
    // The Moon's block is read only where moonlight is bound (the surfaces'
    // own test, on the same uniform), so it is not drawn while none is.
    const blocks = this.state.moonLit ? 3 : 2;

    const previous = renderer.getRenderTarget();
    const oldAutoClear = renderer.autoClear;
    const poison = import.meta.env.DEV && this.state.poison;
    const oldClearAlpha = poison ? renderer.getClearAlpha() : 1;
    if (poison) {
      renderer.getClearColor(_clearColour);
      renderer.setClearColor(POISON, 1);
    }
    renderer.autoClear = false;
    try {
      for (const draw of this.layerDraws) {
        const r = draw.rect;
        if (!draw.mesh || !r) continue;
        const target = this.ensureTarget(draw.layer, atlasW, atlasH);
        // Each layer from its own mesh's centre, as its own vertex stage
        // derives `vAirCam`.
        const centre = draw.layer === 'ground' ? _bodyPos : _layerPos.setFromMatrixPosition(draw.mesh.matrixWorld);
        (u.uHazeCam.value as THREE.Vector3).set(
          (_camPos.x - centre.x) / radiusAU, (_camPos.y - centre.y) / radiusAU, (_camPos.z - centre.z) / radiusAU,
        );
        u.uHazeLayerRadius.value = draw.radius;
        // The region in each block: the triangle covers the viewport, and the
        // texel finds its block and cell from its window coordinate. No clear:
        // nothing outside the region is read ("Drawn over the disc"), so
        // clearing it would only spend bandwidth on cells no one reads. The
        // scissor is the viewport again, which changes no texel: it is there
        // for a tile GPU that sizes the area it loads and stores from the
        // scissor rather than the viewport, and would otherwise carry the
        // whole atlas through every pass.
        if (poison) {
          target.scissorTest = false;
          renderer.setRenderTarget(target);
          renderer.clear(true, false, false);
        }
        target.scissorTest = true;
        for (let block = 0; block < blocks; block++) {
          target.viewport.set(block * stride + r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
          target.scissor.copy(target.viewport);
          renderer.setRenderTarget(target);
          renderer.render(this.mesh!, this.passCamera);
        }
        if (draw.layer === 'ground') air.uHazeSun.value = target.texture;
        else air.uHazeSunDeck.value = target.texture;
        this.state.drawn[draw.layer] = true;
      }
    } finally {
      renderer.setRenderTarget(previous);
      renderer.autoClear = oldAutoClear;
      if (poison) renderer.setClearColor(_clearColour, oldClearAlpha);
    }
    // Published only now that this frame's layers are drawn.
    air.uHazeOn.value = this.state.drawn.ground ? 1 : 0;
    air.uHazeOnDeck.value = this.state.drawn.deck ? 1 : 0;
  }

  /** After the scene draw, and before the next one begins: nothing outside
   *  the draw it was made for may read a frame's cache. */
  end(): void {
    const air = this.live?.air;
    if (!air) return;
    air.uHazeOn.value = 0;
    air.uHazeOnDeck.value = 0;
    if (import.meta.env.DEV) air.uHazeProbe.value = 0;
    this.live = null;
  }

  dispose(): void {
    this.targets.ground?.dispose();
    this.targets.deck?.dispose();
    this.targets = { ground: null, deck: null };
    this.mesh?.geometry.dispose();
    this.material?.dispose();
    this.mesh = null;
    this.material = null;
  }
}

/** The composer pass before the scene's RenderPass. Disposing it leaves the
 *  cache's targets alone: a composer rebuild disposes every pass. */
export class HazeCachePass extends Pass {
  constructor(private readonly cache: HazeCache, private readonly camera: THREE.Camera) {
    super();
    this.needsSwap = false;
  }

  render(renderer: THREE.WebGLRenderer): void {
    this.cache.begin(renderer, this.camera);
  }
}

/** The composer pass right after the scene's RenderPass. */
export class HazeCacheEndPass extends Pass {
  constructor(private readonly cache: HazeCache) {
    super();
    this.needsSwap = false;
  }

  render(): void {
    this.cache.end();
  }
}
