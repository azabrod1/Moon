/**
 * Moon-view scene units. 1 unit = Earth radius. Distances are artistically
 * compressed so the Sun fits on screen while keeping the Moon orbit proportional.
 * Only the Moon view consumes these; the Planetarium uses AU directly.
 */
import { KM_CONSTANTS } from './physicalData';

const BODY_VISUAL_SCALE = 1;

export const SCENE_UNITS = {
  EARTH_RADIUS: BODY_VISUAL_SCALE,
  MOON_RADIUS: (KM_CONSTANTS.MOON_RADIUS / KM_CONSTANTS.EARTH_RADIUS) * BODY_VISUAL_SCALE,
  // Sun radius chosen so its apparent diameter at SUN_DIST matches the real angular size.
  SUN_RADIUS: 120 * Math.tan((KM_CONSTANTS.SUN_ANGULAR_SIZE_DEG * Math.PI) / 360),
  EARTH_MOON_DIST: KM_CONSTANTS.EARTH_MOON_DIST / KM_CONSTANTS.EARTH_RADIUS, // real ≈ 60.3
  EARTH_SUN_DIST: 120,                                                        // artistic (real ≈ 23,455)
  MOON_INCLINATION: (KM_CONSTANTS.MOON_INCLINATION_DEG * Math.PI) / 180,
  EARTH_AXIAL_TILT: (KM_CONSTANTS.EARTH_AXIAL_TILT_DEG * Math.PI) / 180,
};
