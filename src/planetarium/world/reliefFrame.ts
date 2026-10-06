/**
 * The frame a body's tangent-space relief is turned into a normal with.
 *
 * three builds that frame from screen-space derivatives of the map's UV
 * (normalmap_pars_fragment `getTangentFrame`): the cotangent pair grad u,
 * grad v, both scaled by the larger one's length. Two consequences here:
 *
 * 1. It reads the UV the map is SAMPLED with. A streamed sector samples a crop
 *    through a transform, and while that transform scaled u and v alike the
 *    frame was the globe's — which is why normal crops used to be cut two
 *    sectors wide. The surface shader now hands three's own function the
 *    GLOBE's UV (the mesh attribute the map's transform starts from, carried
 *    as its own varying), so the frame on a sector is the globe's whatever
 *    shape its crop is, and crops are cut one sector wide (sectorGrid). At
 *    balance 0 this is three's frame computed from exactly the inputs it
 *    always had, up to a uniform scale its normalisation removes: the picture
 *    as it was, triangle facets and polar fans included.
 *
 * 2. Its balance suits a map stored in slope per UV unit. The relief this app
 *    draws is stored in PHYSICAL slope instead, the longitude difference
 *    divided by cos(latitude) (gen-maps.mjs `normalsFromHeights`,
 *    reliefNormals.ts), and on an equirect sphere |grad u| : |grad v| is
 *    1 : 2 cos(lat). So three draws such a map with its east-west slopes at
 *    half the weight of its north-south ones at the equator, equal at 60°, and
 *    the other way round toward the poles — and a low Sun near a terminator
 *    shines from the east or west, onto the halved ones. The test holds that
 *    to a transcription of three's function.
 *
 * `reliefBalance` (the shared uniform, `?reliefbalance=`) blends from three's
 * frame at 0 toward the sphere's own orthonormal east and north at 1, the
 * balance the maps are baked in. 0 is the default until the look is judged.
 *
 * Contract for the sphere frame: an equirect-mapped sphere in three's
 * SphereGeometry convention, positively and uniformly scaled, its pole the
 * object's +Y, u growing along pole × n and v toward the pole. Every surface
 * that binds a tangent-space normal map today is one (the Moon and Mars, their
 * sectors, their Look-inside skins and the warm-up probe that stands for
 * them). Earth's cloud deck keeps three's frame untouched, because its relief
 * is a brightness proxy and not a slope; anything else that is not such a
 * sphere must opt out the same way.
 */

/** The balance a page boots with, from `?reliefbalance=` (any build): 0 is
 *  three's frame and the default, 1 the sphere's physical frame; a value
 *  between is clamped into [0, 1], and an unreadable one is 0. */
export function parseReliefBalance(search: string): number {
  const asked = new URLSearchParams(search).get('reliefbalance');
  if (asked === null || asked.trim() === '') return 0;
  const value = Number(asked);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** The sphere's own frame in GLSL: unit east and north at `n` about `pole`
 *  (both in one space, view space in the shader; `n` unit). Exactly at a pole
 *  east is undefined and the frame collapses onto n, so that one point draws
 *  flat; anywhere else east is the map's +x at that longitude, which is what
 *  an equirect map means there. */
export const RELIEF_SPHERE_FRAME_GLSL = /* glsl */ `
mat3 reliefSphereFrame( vec3 pole, vec3 n ) {
	vec3 east = cross( normalize( pole ), n );
	east /= max( length( east ), 1e-6 );
	return mat3( east, cross( n, east ), n );
}
`;
