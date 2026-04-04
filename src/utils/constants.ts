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
  SUN_RADIUS: 8,                                           // artistic (real = 109, too big)
  EARTH_MOON_DIST: 20,                                     // artistic (real = 60.3, too far)
  EARTH_SUN_DIST: 120,                                     // artistic (real = 23455, way too far)
  MOON_INCLINATION: (REAL.MOON_INCLINATION_DEG * Math.PI) / 180,
  EARTH_AXIAL_TILT: (REAL.EARTH_AXIAL_TILT_DEG * Math.PI) / 180,
};

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

// Texture URLs — NASA public domain imagery from solar system scope
export const TEXTURES = {
  EARTH_DAY: 'https://unpkg.com/three-globe@2.41.12/example/img/earth-blue-marble.jpg',
  EARTH_NIGHT: 'https://unpkg.com/three-globe@2.41.12/example/img/earth-night.jpg',
  EARTH_CLOUDS: 'https://unpkg.com/three-globe@2.41.12/example/img/earth-clouds.png',
  EARTH_BUMP: 'https://unpkg.com/three-globe@2.41.12/example/img/earth-topology.png',
  MOON: 'https://unpkg.com/three-globe@2.41.12/example/img/lunar-surface.jpg',
};
