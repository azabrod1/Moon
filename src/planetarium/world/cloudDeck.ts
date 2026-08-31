/**
 * The cloud deck's own shading terms: the numbers that author how a whole-globe
 * cloud sheet reads, each one paired with the GLSL that uses it so the two
 * cannot drift. The deck is drawn by the same augmented surface material every
 * other body uses (world/surfaceShading), and every term here is switched on by
 * a uniform rather than by a second copy of the shader — one compiled program
 * still serves every surface in the app.
 *
 * COVERAGE IS THE ALPHA. The cloud map is a grey field, not a cut-out mask, and
 * for years the deck drew it at a flat 35 % over the whole globe: clear sky was
 * dimmed by 35 % everywhere and the thickest anvil could never exceed it, which
 * is exactly the wash a frame at orbital altitude reads as. So the deck's alpha
 * is the map's own luminance through an authored curve instead, and its opacity
 * is 1: where the map is dark there is no deck at all and the ground is at full
 * brightness, and where it is bright the deck owns the pixel.
 *
 * The curve is authored against the map's STORED luminance — what the eight-bit
 * file holds — not the linear value the sampler returns, because "clear sky"
 * and "thick cloud" are gradings of the file. On the shipped map (2K, the same
 * product every rung is cut from) the authored pair leaves 21.7 % of the globe
 * fully clear, drives 5.9 % to full opacity, and averages 0.25 over the sphere
 * by area.
 *
 * The upper edge is high — 0.75, not the 0.6 the disc's mean alone would
 * suggest — because what the night side needs is GRADATION. At 0.6 a seventh of
 * the world is fully opaque cloud, and over the night hemisphere that is a
 * bright sheet with cities extinguished under it; at 0.75 the same field runs
 * through the whole range and the lights read through it, which is what an
 * orbital night photograph shows. The day disc is indifferent between the two.
 *
 * The map's compression noise reaches the alpha through this curve, which is
 * new: the deck's webp is encoded at q60 because it used to draw at 0.35. The
 * curve's slope is 1.9 per unit of stored luminance, so 2/255 of encoder error
 * is 0.015 of alpha — under a quantisation step of the frame it lands in.
 */

/**
 * How high the deck stands above the ground, in kilometres.
 *
 * A whole-globe deck stands for everything from a 2 km marine layer to a 16 km
 * anvil, and 10 is the middle of that range. This is the MESH's altitude as
 * well as the altitude its air is looked up at, and the two have to agree:
 * drawn higher than a cloud top really is, the deck's own silhouette clears the
 * globe's by more than any cloud does, and a near-band or limb frame shows a
 * sheet standing off the planet with the ground visible under its edge. At the
 * 1.01 R this shell was built at, that clearance was 64 km — six real cloud
 * tops — which is what a limb frame read as a detached deck.
 */
export const CLOUD_TOP_KM = 10;

/** The shell radius a deck of that height wants, as a multiple of the body's
 *  own radius. Stated once, because the mesh and the air segment that ends at
 *  the cloud top are the same altitude and must never be two numbers. */
export function cloudShellScale(bodyRadiusKm: number): number {
  return 1 + CLOUD_TOP_KM / bodyRadiusKm;
}

/** Stored luminance at and below which there is no cloud at all. */
export const CLOUD_COVERAGE_LOW = 0.06;
/** ...and at which the deck is fully opaque. */
export const CLOUD_COVERAGE_HIGH = 0.75;

/**
 * The transfer the stored luminance is recovered through. The maps are ordinary
 * sRGB images and the sampler hands back linear light; 2.2 is the gamma that
 * inverts that to within a fraction of a code value over the whole range, and
 * it costs one pow against the piecewise curve's compare-and-two-branches.
 */
const STORED_GAMMA = 2.2;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * The deck's alpha at a fragment whose cloud map sampled to this LINEAR
 * luminance: 0 over clear sky, 1 under thick cloud. Mirrored exactly by
 * `cloudCoverage` in CLOUD_COVERAGE_GLSL, which is generated from the same
 * constants.
 */
export function cloudCoverageAlpha(linearLuminance: number): number {
  const stored = Math.pow(Math.max(linearLuminance, 0), 1 / STORED_GAMMA);
  return smoothstep(CLOUD_COVERAGE_LOW, CLOUD_COVERAGE_HIGH, stored);
}

/** The GLSL half of `cloudCoverageAlpha`, for the surface augmentation. */
export const CLOUD_COVERAGE_GLSL = /* glsl */`
// The cloud deck's alpha, from the coverage its own colour map states. The
// sampler returns linear light and the curve is authored on the file's stored
// values, so the transfer is undone first.
float cloudCoverage(float linearLuminance) {
  float stored = pow(max(linearLuminance, 0.0), ${(1 / STORED_GAMMA).toFixed(6)});
  return smoothstep(${CLOUD_COVERAGE_LOW.toFixed(6)}, ${CLOUD_COVERAGE_HIGH.toFixed(6)}, stored);
}
`;

/**
 * The albedo the deck is drawn at, once its alpha carries the coverage.
 *
 * The cloud map states COVERAGE, not albedo: a mid-grey texel is a pixel half
 * covered by white cloud, not a pixel of grey cloud. Drawing it as its own
 * value once the alpha already carries that coverage counts the same fraction
 * twice, and over bright ground the result is a dark ring around every cloud —
 * a half-covered pixel comes out at half the cloud's brightness AND half the
 * desert's. So the map's luminance sets the alpha and this sets the colour.
 *
 * 0.85 is a cloud top's own reflectance. It reads well against the ground it
 * covers: Earth's day map runs about 0.5 over bright desert and 0.05 over open
 * ocean, so cloud is the brightest thing on the lit disc, which is what it is.
 * The map's HUE survives — only its brightness is replaced — so a tinted map
 * still tints the deck.
 */
export const CLOUD_ALBEDO = 0.85;

/**
 * How much of the map's brightness is COVERAGE rather than the cloud's own
 * albedo: 1 hands all of it to the alpha and draws the deck at a flat 0.85,
 * 0 leaves the map as the albedo and puts the dark ring back.
 *
 * Not 1, because the two are not cleanly separable. Above the coverage curve's
 * upper edge every pixel is fully covered and the map's remaining variation is
 * real — thicker cloud IS brighter cloud — so a fully normalised deck draws its
 * solid interiors as one flat white with no structure at all. 0.8 keeps a fifth
 * of the map's brightness range as albedo: thin cloud lands near 0.55 and solid
 * cloud near 0.81, so the interiors have shape and the edges still sit above
 * the desert they cover rather than below it.
 */
export const CLOUD_ALBEDO_BLEND = 0.8;

/**
 * How deep the deck's relief reads, as the material's `normalScale`.
 *
 * The height field behind it is the cloud map's own brightness (gen-maps'
 * earth-clouds-normal job), which is a proxy: a bright pixel is thick cloud,
 * and thick cloud is usually tall cloud, but a bright low stratus deck is not a
 * mountain. So the relief is authored SHALLOW. At 1 the banks emboss into
 * ridges the moment the Sun is low, which is the same overstatement the Mars
 * relief was halved for; 0.6 keeps the towers legible at the terminator without
 * turning a marine layer into terrain.
 *
 * It lives on the material rather than in the map so that both rungs of the
 * relief ladder — the boot map and the sharper one an approach earns — arrive
 * at one depth and the swap reads as a sharpen rather than a pop.
 */
export const CLOUD_NORMAL_SCALE = 0.6;

/** Rec.709 luminance weights — the one place the deck's grey is measured. */
export const LUMINANCE_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/** The luminance of a sampled cloud-map colour, in whatever space it is in. */
export function luminance(r: number, g: number, b: number): number {
  return LUMINANCE_WEIGHTS[0] * r + LUMINANCE_WEIGHTS[1] * g + LUMINANCE_WEIGHTS[2] * b;
}

// --- The detail the deck's own map is too coarse to carry --------------------
//
// Everything below drives one texel fetch of the tileable noise map
// (world/cloudDetailNoise) per deck fragment, and nothing at all on any other
// surface. The map holds the field in R and its own gradient in G and B, so the
// erosion and the normal perturbation share the fetch.

/**
 * How much of the deck's alpha the noise may eat where the coverage is at an
 * EDGE. A cloud map's edges are the resolution its authoring stopped at, not
 * the shape of a real cloud; eroding them by the noise puts the ragged margin
 * back. Solid interiors and clear sky are both left alone — a cloud does not
 * get holes in the middle, and clear sky does not acquire wisps that the map
 * says are not there.
 */
export const CLOUD_DETAIL_ERODE = 0.45;

/** Where the edge band starts and ends, in coverage alpha. Erosion peaks
 *  between the inner pair and is gone outside the outer pair. */
export const CLOUD_EDGE_BAND: readonly [number, number, number, number] = [0.10, 0.35, 0.65, 0.90];

/**
 * The height the detail field's full range stands for, in kilometres. A cloud
 * top varies by a few kilometres over a few tens of kilometres, and that is the
 * slope the perturbation is built to produce: the shader turns the packed
 * gradient into a real gradient with this and the deck's own radius, so the
 * relief is a physical slope rather than a number tuned against one frame.
 */
export const CLOUD_DETAIL_RELIEF_KM = 3;

/**
 * Screen texels per pixel at which the detail starts to go, and where it is
 * gone. Above one texel per pixel the map is being minified: what is left is
 * the tile's repeat rather than its texture, and the fine octave crawls. The
 * mip chain already averages it away — this is what stops it reading as a
 * pattern on the way there, and it is why a deck seen from arrival range (about
 * nine texels per pixel) carries no detail term at all.
 */
export const CLOUD_DETAIL_FADE_START = 0.6;
export const CLOUD_DETAIL_FADE_END = 2.0;

/** How much of the detail survives at this many noise texels per screen pixel.
 *  Mirrored exactly by `cloudDetailFade` in CLOUD_DETAIL_GLSL. */
export function cloudDetailFade(texelsPerPixel: number): number {
  return 1 - smoothstep(CLOUD_DETAIL_FADE_START, CLOUD_DETAIL_FADE_END, texelsPerPixel);
}

/** The weight the erosion carries at this coverage alpha: 0 in clear sky and in
 *  solid cloud, 1 across the edge between them. Mirrored by `cloudEdgeBand`. */
export function cloudEdgeBand(alpha: number): number {
  return smoothstep(CLOUD_EDGE_BAND[0], CLOUD_EDGE_BAND[1], alpha)
    * (1 - smoothstep(CLOUD_EDGE_BAND[2], CLOUD_EDGE_BAND[3], alpha));
}

/** The GLSL halves of the two curves above, from the same constants. */
export const CLOUD_DETAIL_GLSL = /* glsl */`
// What survives at this many noise texels per screen pixel.
float cloudDetailFade(float texelsPerPixel) {
  return 1.0 - smoothstep(${CLOUD_DETAIL_FADE_START.toFixed(6)}, ${CLOUD_DETAIL_FADE_END.toFixed(6)}, texelsPerPixel);
}
// 0 in clear sky and in solid cloud, 1 across the edge between them.
float cloudEdgeBand(float alpha) {
  return smoothstep(${CLOUD_EDGE_BAND[0].toFixed(6)}, ${CLOUD_EDGE_BAND[1].toFixed(6)}, alpha)
    * (1.0 - smoothstep(${CLOUD_EDGE_BAND[2].toFixed(6)}, ${CLOUD_EDGE_BAND[3].toFixed(6)}, alpha));
}
`;

// --- Lit from below ---------------------------------------------------------

/**
 * How brightly a city glows through the deck above it, as a multiple of the
 * night map's own values.
 *
 * The night-lights shell draws that map at 1.5, so 0.45 is three tenths of a
 * city's bare brightness: a town fully under cloud reads at 30 % of the town
 * beside it in clear air, and the deck's own alpha takes the rest of the way
 * down as the cover thins. It is authored to a long exposure like every other
 * night term in the app — a photograph of a city through cloud is not a
 * radiometric measurement of one.
 *
 * The term is weighted by the deck's alpha, so cloud that is not there does not
 * glow, and by the shared night weight, so it fades along the same line every
 * other non-solar source does rather than switching on at its own terminator.
 */
export const CLOUD_CITY_GLOW = 0.45;

/**
 * The equirectangular UV three's SphereGeometry gives a point on it, from that
 * point's direction in the sphere's OWN frame. The night lights are painted on
 * the globe and the deck stands above it with a drift of its own, so a deck
 * fragment has to look the ground's map up at the ground's longitude — its own
 * UV is that drift out.
 *
 * u is wrapped into [0, 1); at the poles it is degenerate and the caller gets
 * whatever atan2 returns for a zero vector, which is a texel of a map that has
 * no data there either.
 */
export function sphereEquirectUv(x: number, y: number, z: number): [number, number] {
  const u = Math.atan2(z, -x) / (2 * Math.PI);
  return [u - Math.floor(u), 0.5 + Math.asin(Math.min(1, Math.max(-1, y))) / Math.PI];
}

/** The GLSL half of `sphereEquirectUv`, and the derivative of it that lets the
 *  lookup pick a mip without an implicit one — the deck samples this map inside
 *  a per-fragment condition, where an implicit derivative is undefined. */
export const SPHERE_EQUIRECT_UV_GLSL = /* glsl */`
// The UV three's SphereGeometry gives a unit direction in the sphere's frame.
vec2 sphereEquirectUv(vec3 d) {
  return vec2(atan(d.z, -d.x) * ${(1 / (2 * Math.PI)).toFixed(7)},
              0.5 + asin(clamp(d.y, -1.0, 1.0)) * ${(1 / Math.PI).toFixed(7)});
}
// ...and how that UV moves when the direction does. No wrap in it: a gradient
// is a difference, and the seam's jump belongs to the value, not the slope.
vec2 sphereEquirectUvGrad(vec3 d, vec3 dd) {
  float cosLat = max(sqrt(d.x * d.x + d.z * d.z), 1e-4);
  return vec2((d.z * dd.x - d.x * dd.z) / (cosLat * cosLat) * ${(1 / (2 * Math.PI)).toFixed(7)},
              dd.y / cosLat * ${(1 / Math.PI).toFixed(7)});
}
`;
