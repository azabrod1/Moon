import { ALL_BODIES, LIGHT_SPEED_AU_PER_S, AU_IN_KM } from './planets/planetData';

export interface ExploreStats {
  distanceFromSunAU: number;
  lightTravelTime: string;     // formatted "Xm XXs"
  solarIntensityPct: number;   // % of Earth's
  speedC: number;              // multiples of light speed
  speedKmS: number;
  nearestPlanet: { name: string; distanceAU: number } | null;
  blackbodyTempK: number;
  distanceTraveled: number;
  timeElapsed: string;         // formatted
}

export function computeStats(
  posX: number, posY: number, posZ: number,
  speedAUPerS: number,
  distanceTraveled: number,
  timeElapsedS: number,
  planetPositions: Map<string, { x: number; y: number; z: number }>,
): ExploreStats {
  const distFromSun = Math.sqrt(posX * posX + posY * posY + posZ * posZ);

  // Light travel time
  const lightTimeS = distFromSun / LIGHT_SPEED_AU_PER_S;
  const lightMin = Math.floor(lightTimeS / 60);
  const lightSec = Math.floor(lightTimeS % 60);
  const lightTravelTime = lightMin > 0 ? `${lightMin}m ${lightSec}s` : `${lightSec}s`;

  // Solar intensity (inverse square, Earth = 1 AU = 100%)
  const solarIntensityPct = distFromSun > 0 ? (1 / (distFromSun * distFromSun)) * 100 : 99999;

  // Speed
  const speedC = speedAUPerS / LIGHT_SPEED_AU_PER_S;
  const speedKmS = speedAUPerS * AU_IN_KM;

  // Find nearest planet
  let nearestPlanet: { name: string; distanceAU: number } | null = null;
  let nearestDist = Infinity;

  for (const body of ALL_BODIES) {
    const pPos = planetPositions.get(body.name);
    if (!pPos) continue;

    const dx = pPos.x - posX;
    const dy = pPos.y - posY;
    const dz = pPos.z - posZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist < nearestDist) {
      nearestDist = dist;
      nearestPlanet = { name: body.name, distanceAU: dist };
    }
  }

  // Approximate blackbody equilibrium temperature (assuming albedo ~0.3)
  // T = 278.5 / sqrt(distance_AU) for Earth-like albedo
  const blackbodyTempK = distFromSun > 0 ? 278.5 / Math.sqrt(distFromSun) : 5778;

  // Format time elapsed
  const totalMin = Math.floor(timeElapsedS / 60);
  const sec = Math.floor(timeElapsedS % 60);
  const timeElapsed = `${totalMin}:${sec.toString().padStart(2, '0')}`;

  return {
    distanceFromSunAU: distFromSun,
    lightTravelTime,
    solarIntensityPct,
    speedC,
    speedKmS,
    nearestPlanet,
    blackbodyTempK,
    distanceTraveled,
    timeElapsed,
  };
}

export function formatAU(au: number): string {
  if (au < 0.01) return au.toFixed(5);
  if (au < 1) return au.toFixed(3);
  return au.toFixed(2);
}
