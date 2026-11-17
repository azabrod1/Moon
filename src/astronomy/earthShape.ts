/**
 * Earth's shape for the analytic geometry: the WGS 84 ellipsoid (a =
 * 6378.137 km, f = 1/298.257223563; NGA TR8350.2), in the body frame every
 * body here uses (+X toward longitude 0, +Y toward the north pole, +Z toward
 * longitude 90° W), in kilometres.
 *
 * Earth is drawn as a sphere of the equatorial radius, but where a point on
 * the ground has to be right — an eclipse's centre line, a place someone
 * stands — the sphere is not good enough: it puts the poles 21 km too high,
 * and a latitude read off it is geocentric, which differs from the geodetic
 * latitude of maps and GPS by up to 0.19° (21 km). A shadow axis meeting the
 * ground at a slant moves further still.
 *
 * Pure; tested against JPL Horizons' own geodetic-to-cylindrical conversion
 * in earthShape.test.ts.
 */
import * as THREE from 'three';

export const WGS84_EQUATORIAL_RADIUS_KM = 6378.137;
export const WGS84_FLATTENING = 1 / 298.257223563;
export const WGS84_POLAR_RADIUS_KM = WGS84_EQUATORIAL_RADIUS_KM * (1 - WGS84_FLATTENING);
const ECCENTRICITY_SQUARED = WGS84_FLATTENING * (2 - WGS84_FLATTENING);
const DEG = Math.PI / 180;

export interface GeodeticPosition {
  latitudeDeg: number;
  /** East-positive, (−180, 180]. */
  longitudeDeg: number;
  heightKm: number;
}

/** A geodetic position as a body-frame point in kilometres. */
export function geodeticToBodyFrameKm(position: GeodeticPosition, out: THREE.Vector3): THREE.Vector3 {
  const latitude = position.latitudeDeg * DEG;
  const longitude = position.longitudeDeg * DEG;
  const sinLatitude = Math.sin(latitude);
  const primeVerticalRadius =
    WGS84_EQUATORIAL_RADIUS_KM / Math.sqrt(1 - ECCENTRICITY_SQUARED * sinLatitude * sinLatitude);
  const equatorialDistance = (primeVerticalRadius + position.heightKm) * Math.cos(latitude);
  // Earth-fixed x, y (90° E) and z (north) become body +X, −Z and +Y.
  return out.set(
    equatorialDistance * Math.cos(longitude),
    (primeVerticalRadius * (1 - ECCENTRICITY_SQUARED) + position.heightKm) * sinLatitude,
    -equatorialDistance * Math.sin(longitude),
  );
}

/**
 * A body-frame point in kilometres as a geodetic position. Fixed-point
 * iteration on the latitude, which settles to well under a millimetre within
 * a few steps anywhere outside the planet's centre.
 */
export function bodyFrameKmToGeodetic(point: THREE.Vector3, out: GeodeticPosition): GeodeticPosition {
  const earthFixedX = point.x;
  const earthFixedY = -point.z;
  const earthFixedZ = point.y;
  const equatorialDistance = Math.hypot(earthFixedX, earthFixedY);
  out.longitudeDeg = Math.atan2(earthFixedY, earthFixedX) / DEG;
  let latitude = Math.atan2(earthFixedZ, equatorialDistance * (1 - ECCENTRICITY_SQUARED));
  let primeVerticalRadius = WGS84_EQUATORIAL_RADIUS_KM;
  for (let iteration = 0; iteration < 8; iteration++) {
    const sinLatitude = Math.sin(latitude);
    primeVerticalRadius =
      WGS84_EQUATORIAL_RADIUS_KM / Math.sqrt(1 - ECCENTRICITY_SQUARED * sinLatitude * sinLatitude);
    latitude = Math.atan2(earthFixedZ + ECCENTRICITY_SQUARED * primeVerticalRadius * sinLatitude, equatorialDistance);
  }
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  out.latitudeDeg = latitude / DEG;
  // The height along the normal, in whichever form stays well conditioned.
  out.heightKm = Math.abs(cosLatitude) > 0.1
    ? equatorialDistance / cosLatitude - primeVerticalRadius
    : earthFixedZ / sinLatitude - primeVerticalRadius * (1 - ECCENTRICITY_SQUARED);
  return out;
}

/**
 * Where a ray first meets the ellipsoid raised by `heightKm` along its axes
 * (a + h, b + h; close enough to the true raised surface for heights of a
 * few hundred kilometres): the distance along the unit `direction` from
 * `origin` (body frame, km), or null if it misses or the surface is behind.
 */
export function rayEllipsoidDistanceKm(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  heightKm = 0,
): number | null {
  const equatorialRadius = WGS84_EQUATORIAL_RADIUS_KM + heightKm;
  const polarRadius = WGS84_POLAR_RADIUS_KM + heightKm;
  // Stretch the polar axis so the ellipsoid becomes a sphere of the
  // equatorial radius, and solve the sphere's quadratic there.
  const stretch = equatorialRadius / polarRadius;
  const originX = origin.x;
  const originY = origin.y * stretch;
  const originZ = origin.z;
  const directionX = direction.x;
  const directionY = direction.y * stretch;
  const directionZ = direction.z;
  const quadratic = directionX * directionX + directionY * directionY + directionZ * directionZ;
  const linear = originX * directionX + originY * directionY + originZ * directionZ;
  const constant =
    originX * originX + originY * originY + originZ * originZ - equatorialRadius * equatorialRadius;
  const discriminant = linear * linear - quadratic * constant;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const near = (-linear - root) / quadratic;
  if (near >= 0) return near;
  const far = (-linear + root) / quadratic;
  return far >= 0 ? far : null;
}
