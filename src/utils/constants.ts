// === Real astronomical values (km) ===
export const REAL = {
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

// === Scene scale: 1 unit = Earth radius ===
export const SCENE = {
  EARTH_RADIUS: 1,
  MOON_RADIUS: REAL.MOON_RADIUS / REAL.EARTH_RADIUS,     // ~0.2727
  // Keep the Moon orbit proportional to reality and size the artistic Sun so its
  // apparent diameter remains close to the real value at the simulator's Sun distance.
  SUN_RADIUS: 120 * Math.tan((REAL.SUN_ANGULAR_SIZE_DEG * Math.PI) / 360),
  EARTH_MOON_DIST: REAL.EARTH_MOON_DIST / REAL.EARTH_RADIUS, // real = 60.3 Earth radii
  EARTH_SUN_DIST: 120,                                     // artistic (real = 23455, way too far)
  MOON_INCLINATION: (REAL.MOON_INCLINATION_DEG * Math.PI) / 180,
  EARTH_AXIAL_TILT: (REAL.EARTH_AXIAL_TILT_DEG * Math.PI) / 180,
};

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

// Texture URLs — bundled locally in public/textures/
const BASE = import.meta.env.BASE_URL + 'textures/';
export const TEXTURES = {
  EARTH_DAY: BASE + 'earth-day.jpg',
  EARTH_NIGHT: BASE + 'earth-night.jpg',
  EARTH_CLOUDS: BASE + 'earth-clouds.jpg',
  EARTH_BUMP: BASE + 'earth-bump.png',
  MOON: BASE + 'moon.jpg',
};
