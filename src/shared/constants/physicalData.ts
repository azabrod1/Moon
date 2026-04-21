/**
 * Real astronomical values in kilometers and degrees. Used for scaling UI readouts
 * and deriving scene-unit proportions (see `sceneUnits.ts`). Never use these for
 * rendering directly — rendering consumes SCENE_UNITS.
 */
export const KM_CONSTANTS = {
  EARTH_RADIUS: 6_371,
  MOON_RADIUS: 1_737.4,
  SUN_RADIUS: 696_340,
  EARTH_MOON_DIST: 384_400,
  EARTH_SUN_DIST: 149_600_000,
  MOON_INCLINATION_DEG: 5.145,
  EARTH_AXIAL_TILT_DEG: 23.44,
  MOON_SIDEREAL_PERIOD_DAYS: 27.322,
  MOON_SYNODIC_PERIOD_DAYS: 29.530,
  SUN_ANGULAR_SIZE_DEG: 0.533,
  MOON_ANGULAR_SIZE_DEG: 0.517,
};
