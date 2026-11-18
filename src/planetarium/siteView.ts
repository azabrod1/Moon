/**
 * A place to stand: the pure geometry of a site on a body — where it is, which
 * way is up, north and east there, the altitude and azimuth of anything in the
 * sky, how far the horizon dips, and when a body crosses a given altitude.
 * It also holds the spot picker's side of the same geometry (a point on the
 * globe back to a latitude and longitude, a ray against the sphere, typed
 * coordinates) and the rule for where the gaze rests so a low target is
 * framed with the horizon. No scene or DOM access: callers pass the body's orientation and the
 * directions they have; siteView.test.ts holds the whole chain (site frame,
 * Earth's orientation, the ephemeris, parallax) to JPL Horizons' topocentric
 * azimuth and elevation on Earth and on the Moon.
 *
 * Body frame, as everywhere here: +X longitude 0, +Y the north pole, +Z
 * longitude 90° W. Longitudes are east-positive. On Earth the latitude is
 * geodetic and the height is above the WGS 84 ellipsoid (earthShape.ts), so a
 * site's coordinates are the ones on a map or a GPS; every other body is the
 * sphere it is drawn as, with planetocentric latitude.
 */
import * as THREE from 'three';
import { geodeticToBodyFrameKm } from '../astronomy/earthShape';

const DEG = Math.PI / 180;

/**
 * Where the gaze rests, as an altitude, while the view tracks a target from a
 * site through a vertical field of `fovDeg`.
 *
 * A target high in the sky is simply centred: the horizon is far out of the
 * frame. A low one is not, because centring it leaves the horizon just off
 * the bottom edge and the picture reads as a disc on black, with nothing to
 * say the viewer is standing anywhere. So under a low target the gaze drops
 * until the horizon lies a sixth of the field below centre (two-thirds of
 * the way down the picture) with the target above it. The target is never
 * lifted more than a quarter of the field above centre, where a disc fitted
 * to the frame still clears the top row of controls; past that the gaze
 * eases back onto the target, reaching it a whole field up. A target under
 * the horizon gets the same low gaze at its azimuth: the horizon it will
 * rise over, in the same place in the frame, so the picture does not jump
 * as it sets.
 *
 * Continuous in both arguments, so a running clock or a pinch moves the
 * framing smoothly, and never above the target.
 */
export function siteGazeAltitudeDeg(targetAltitudeDeg: number, fovDeg: number): number {
  const low = fovDeg / 6;
  const lift = fovDeg / 4;
  if (targetAltitudeDeg >= fovDeg) return targetAltitudeDeg;
  if (targetAltitudeDeg <= low + lift) return low;
  return low + ((targetAltitudeDeg - low - lift) * (fovDeg - low)) / (fovDeg - low - lift);
}

export interface Site {
  /** The body stood on: a planet's or a moon's catalog name. */
  body: string;
  latitudeDeg: number;
  /** East-positive. */
  longitudeDeg: number;
  /** Eye height above the ground (Earth: above the ellipsoid), km. */
  heightKm: number;
  /** A named place's name (sitePlaces.ts); absent for bare coordinates. */
  name?: string;
}

/** A site's local frame, in the scene frame. */
export interface SiteFrame {
  /** From the body's centre to the eye, km. */
  offsetKm: THREE.Vector3;
  zenith: THREE.Vector3;
  north: THREE.Vector3;
  east: THREE.Vector3;
}

export function createSiteFrame(): SiteFrame {
  return { offsetKm: new THREE.Vector3(), zenith: new THREE.Vector3(), north: new THREE.Vector3(), east: new THREE.Vector3() };
}

const geodeticScratch = { latitudeDeg: 0, longitudeDeg: 0, heightKm: 0 };

/**
 * The site's frame for a body of `radiusKm` turned by `orientation` (the
 * body-to-scene rotation planetary.ts and lunarOrientation.ts build). Earth's
 * up is the ellipsoid's normal; elsewhere it is the radius.
 */
export function siteFrame(
  site: Site,
  radiusKm: number,
  orientation: THREE.Quaternion,
  out: SiteFrame = createSiteFrame(),
): SiteFrame {
  const latitude = site.latitudeDeg * DEG;
  const longitude = site.longitudeDeg * DEG;
  const cosLatitude = Math.cos(latitude);
  const sinLatitude = Math.sin(latitude);
  const cosLongitude = Math.cos(longitude);
  const sinLongitude = Math.sin(longitude);
  // Up, north and east of a latitude and longitude in the body frame; on
  // Earth the latitude is geodetic, so this up is the ellipsoid's normal.
  out.zenith.set(cosLatitude * cosLongitude, sinLatitude, -cosLatitude * sinLongitude);
  out.north.set(-sinLatitude * cosLongitude, cosLatitude, sinLatitude * sinLongitude);
  out.east.set(-sinLongitude, 0, -cosLongitude);
  if (site.body === 'Earth') {
    geodeticScratch.latitudeDeg = site.latitudeDeg;
    geodeticScratch.longitudeDeg = site.longitudeDeg;
    geodeticScratch.heightKm = site.heightKm;
    geodeticToBodyFrameKm(geodeticScratch, out.offsetKm);
  } else {
    out.offsetKm.copy(out.zenith).multiplyScalar(radiusKm + site.heightKm);
  }
  out.offsetKm.applyQuaternion(orientation);
  out.zenith.applyQuaternion(orientation);
  out.north.applyQuaternion(orientation);
  out.east.applyQuaternion(orientation);
  return out;
}

export interface AltAz {
  altitudeDeg: number;
  /** From north through east, [0, 360). */
  azimuthDeg: number;
}

/** Altitude and azimuth of a scene-frame direction (any length) at a site. */
export function altAz(direction: THREE.Vector3, frame: SiteFrame, out: AltAz = { altitudeDeg: 0, azimuthDeg: 0 }): AltAz {
  const length = direction.length() || 1;
  const up = direction.dot(frame.zenith) / length;
  out.altitudeDeg = Math.asin(Math.max(-1, Math.min(1, up))) / DEG;
  const azimuth = Math.atan2(direction.dot(frame.east), direction.dot(frame.north)) / DEG;
  out.azimuthDeg = azimuth < 0 ? azimuth + 360 : azimuth;
  return out;
}

/** The scene-frame unit direction at an altitude and azimuth. */
export function directionFromAltAz(altitudeDeg: number, azimuthDeg: number, frame: SiteFrame, out: THREE.Vector3): THREE.Vector3 {
  const altitude = altitudeDeg * DEG;
  const azimuth = azimuthDeg * DEG;
  const level = Math.cos(altitude);
  return out
    .copy(frame.zenith).multiplyScalar(Math.sin(altitude))
    .addScaledVector(frame.north, level * Math.cos(azimuth))
    .addScaledVector(frame.east, level * Math.sin(azimuth));
}

/** How far the horizon dips below level from an eye `heightKm` above a
 *  sphere of `radiusKm`: acos(R / (R + h)), in degrees. Computed in doubles
 *  so it holds at a two-metre eye on a body thousands of km across. */
export function horizonDipDeg(radiusKm: number, heightKm: number): number {
  if (!(heightKm > 0)) return 0;
  return Math.acos(radiusKm / (radiusKm + heightKm)) / DEG;
}

/**
 * The first instant after `startMs` at which `altitudeDegAt` crosses
 * `thresholdDeg` going `direction` ('rise': upward, 'set': downward), to a
 * second; null when it does not within `maxSteps` steps of `stepMs` (a body
 * that never rises or never sets there). Scans for a bracketing step, then
 * bisects. `stepMs` must be short enough that no rise and set both fit in it
 * (an hour is safe for the Sun and the Moon anywhere but the Moon's fast-moving
 * sky from a low orbit, which is not a site).
 */
export function findAltitudeCrossing(
  altitudeDegAt: (utcMs: number) => number,
  startMs: number,
  thresholdDeg: number,
  direction: 'rise' | 'set',
  stepMs: number,
  maxSteps: number,
): number | null {
  const sign = direction === 'rise' ? 1 : -1;
  let previousMs = startMs;
  let previous = altitudeDegAt(previousMs) - thresholdDeg;
  for (let step = 1; step <= maxSteps; step++) {
    const nextMs = startMs + step * stepMs;
    const next = altitudeDegAt(nextMs) - thresholdDeg;
    if (sign * previous < 0 && sign * next >= 0) {
      let lowMs = previousMs;
      let highMs = nextMs;
      while (highMs - lowMs > 1000) {
        const middleMs = (lowMs + highMs) / 2;
        if (sign * (altitudeDegAt(middleMs) - thresholdDeg) >= 0) highMs = middleMs;
        else lowMs = middleMs;
      }
      return (lowMs + highMs) / 2;
    }
    previousMs = nextMs;
    previous = next;
  }
  return null;
}

/** "rises in 5 hours", the Observatory's countdown wording, or the plain
 *  truth when the search found no rise: some bodies never rise at a site
 *  (Earth from the Moon's far side). */
export function siteRiseText(nowMs: number, riseMs: number | null): string {
  if (riseMs === null) return 'it does not rise here in the next month';
  const totalMinutes = Math.max(1, Math.floor((riseMs - nowMs) / 60_000));
  if (totalMinutes < 60) return `rises in ${totalMinutes} min`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 48) return `rises in ${totalHours} ${totalHours === 1 ? 'hour' : 'hours'}`;
  const totalDays = Math.floor(totalHours / 24);
  return `rises in ${totalDays} ${totalDays === 1 ? 'day' : 'days'}`;
}

export interface LatLon {
  latitudeDeg: number;
  /** East-positive, (−180, 180]. */
  longitudeDeg: number;
}

/** The body-frame unit direction of a latitude and longitude: siteFrame's up
 *  before the body is turned. */
export function bodyDirectionFromLatLon(latitudeDeg: number, longitudeDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const latitude = latitudeDeg * DEG;
  const longitude = longitudeDeg * DEG;
  const cosLatitude = Math.cos(latitude);
  return out.set(cosLatitude * Math.cos(longitude), Math.sin(latitude), -cosLatitude * Math.sin(longitude));
}

/** The latitude and longitude a body-frame direction (any length) points
 *  at: bodyDirectionFromLatLon, inverted. Planetocentric, so on Earth it is
 *  not the geodetic latitude a map prints (up to 0.19° apart). */
export function latLonFromBodyDirection(direction: THREE.Vector3, out: LatLon = { latitudeDeg: 0, longitudeDeg: 0 }): LatLon {
  const length = direction.length() || 1;
  out.latitudeDeg = Math.asin(Math.max(-1, Math.min(1, direction.y / length))) / DEG;
  out.longitudeDeg = Math.atan2(-direction.z, direction.x) / DEG;
  return out;
}

/**
 * Where a ray first meets a sphere, as the distance along the ray; null when
 * it misses or the sphere is behind the origin. `direction` is unit length.
 */
export function raySphereDistance(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  centre: THREE.Vector3,
  radius: number,
): number | null {
  const toCentreX = centre.x - origin.x;
  const toCentreY = centre.y - origin.y;
  const toCentreZ = centre.z - origin.z;
  const along = toCentreX * direction.x + toCentreY * direction.y + toCentreZ * direction.z;
  const offAxisSq = toCentreX * toCentreX + toCentreY * toCentreY + toCentreZ * toCentreZ - along * along;
  const halfChordSq = radius * radius - offAxisSq;
  if (halfChordSq < 0) return null;
  const distance = along - Math.sqrt(halfChordSq);
  return distance > 0 ? distance : null;
}

/**
 * Coordinates as a person types them: "2 S 80 W", "2.0° S, 80.0° W",
 * "-2, -80", "0.67N 23.47E", "12.7 N 86.52 E". Latitude first, then
 * longitude; a hemisphere letter sets the sign, and without letters the
 * numbers are signed with east positive. Longitudes beyond ±180 wrap (a
 * 0–360 east longitude is what planetary maps often print). Null when the
 * text is not two numbers in range.
 */
export function parseCoordinates(text: string): LatLon | null {
  const match = /^\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*([EWew])?\s*$/.exec(text);
  if (!match) return null;
  let latitudeDeg = Number(match[1]);
  let longitudeDeg = Number(match[3]);
  if (!Number.isFinite(latitudeDeg) || !Number.isFinite(longitudeDeg)) return null;
  if (match[2]) latitudeDeg = Math.abs(latitudeDeg) * (match[2].toUpperCase() === 'S' ? -1 : 1);
  if (match[4]) longitudeDeg = Math.abs(longitudeDeg) * (match[4].toUpperCase() === 'W' ? -1 : 1);
  if (Math.abs(latitudeDeg) > 90 || Math.abs(longitudeDeg) > 360) return null;
  // One turn at most is out of range, and a value already in range must come
  // back exactly as typed.
  if (longitudeDeg > 180) longitudeDeg -= 360;
  else if (longitudeDeg <= -180) longitudeDeg += 360;
  return { latitudeDeg, longitudeDeg };
}

/** "2.0° S, 80.0° W": a spot to a tenth of a degree, the grain a tap on the
 *  globe can honestly claim. */
export function formatSpot(latitudeDeg: number, longitudeDeg: number): string {
  const latitude = `${Math.abs(latitudeDeg).toFixed(1)}° ${latitudeDeg >= 0 ? 'N' : 'S'}`;
  const longitude = `${Math.abs(longitudeDeg).toFixed(1)}° ${longitudeDeg >= 0 ? 'E' : 'W'}`;
  return `${latitude}, ${longitude}`;
}

/** "0.67° N 23.47° E": a site's place as the HUD prints it. */
export function formatSiteCoordinates(site: Site): string {
  const latitude = `${Math.abs(site.latitudeDeg).toFixed(2)}° ${site.latitudeDeg >= 0 ? 'N' : 'S'}`;
  const longitude = `${Math.abs(site.longitudeDeg).toFixed(2)}° ${site.longitudeDeg >= 0 ? 'E' : 'W'}`;
  return `${latitude} ${longitude}`;
}
