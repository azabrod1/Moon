/**
 * The frame a body's tangent-space relief is turned into a normal with: the
 * sphere's own orthonormal east and north at the fragment.
 *
 * The relief this app draws is stored in PHYSICAL slope, the longitude
 * difference divided by cos(latitude) (gen-maps.mjs `normalsFromHeights`,
 * reliefNormals.ts), so east and north must weigh the same. three's own
 * frame (normalmap_pars_fragment `getTangentFrame`) does not: it is the
 * cotangent pair grad u, grad v from screen derivatives, both scaled by the
 * larger one's length, and on an equirect sphere |grad u| : |grad v| is
 * 1 : 2 cos(lat). It drew such a map with its east-west slopes at half the
 * weight of its north-south ones at the equator, equal at 60°, and the other
 * way round toward the poles — and a low Sun near a terminator shines from
 * the east or west, onto the halved ones. The test holds that to a
 * transcription of three's function. The sphere's frame reads no UV, so a
 * streamed sector's crop of any shape is drawn in the frame its globe is, and
 * crops are cut one sector wide (sectorGrid). Judged on a sheet of the Moon,
 * its pole, Mars and Look inside against three's frame (2026-10-06).
 *
 * Contract: an equirect-mapped sphere in three's SphereGeometry convention,
 * positively and uniformly scaled, its pole the object's +Y, u growing along
 * pole × n and v toward the pole. Every surface that binds a tangent-space
 * normal map today is one (the Moon and Mars, their sectors, their
 * Look-inside skins and the warm-up probe that stands for them). Earth's
 * cloud deck keeps three's frame, because its relief is a brightness proxy
 * and not a slope; anything else that is not such a sphere must opt out the
 * same way.
 */

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
