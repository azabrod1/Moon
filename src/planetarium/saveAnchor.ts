/**
 * Saving a cruising ship relative to the body it rides with, and moving
 * journeys saved before the fitted ephemeris onto today's positions.
 *
 * A save stores the ship's heliocentric position. That is only as good as the
 * positions the bodies are drawn at: when the fitted ephemeris replaced the
 * analytic models, Earth's Moon moved by up to 210 km and Jupiter by up to
 * 2 million km, so a ship saved parked beside a body would resume beside
 * where the body used to be — or inside it. So:
 *
 *  - A save in cruise also records the body the ship rides with (the ride
 *    frame's dominant carrier) and the ship's offset from it, and a restore
 *    puts the ship back at that offset from the body's position at the
 *    saved instant. That survives any later change to the positions too.
 *  - A save from before (no `positionModel`) is migrated once, on load:
 *    the body it was near is found among the positions that build drew
 *    (astronomy/legacyPositions.ts), and the ship is moved with that body.
 *    The nearest body is the one closest in its own radii, so a ship parked
 *    over Io moves with Io, not with Jupiter.
 *
 * Landed saves are already body-relative and are left alone; deep-space saves
 * keep their position. Pure apart from the astronomy seams; tested in
 * saveAnchor.test.ts.
 */
import * as THREE from 'three';
import { computeBodyPositionAU } from '../astronomy/planetary';
import { computeMoonOffsetEquatorialAU } from '../astronomy/satellites';
import { legacyMoonOffsetAU, legacyPlanetPositionAU } from '../astronomy/legacyPositions';
import { PLANETARIUM_BODIES, type PlanetData } from './planets/planetData';
import { getMoonsByPlanet } from './planets/moonData';
import { POSITION_MODEL, type PlanetariumState, type RideAnchor } from './PlanetariumStore';

/** A planet's neighbourhood for the migration: its moon system out to this
 *  multiple of the catalog's system radius, the ride frame's release band. */
const MIGRATION_REACH_FACTOR = 1.5;

const moonOffsetScratch = new THREE.Vector3();

function planetNamed(name: string): PlanetData | undefined {
  return PLANETARIUM_BODIES.find((body) => body.name === name);
}

/** A body's position as the scene draws it now (scene AU), or null for a
 *  name the catalog does not know. */
export function currentBodyPositionAU(
  body: string,
  parentPlanet: string | undefined,
  utcMs: number,
  out: THREE.Vector3,
): THREE.Vector3 | null {
  if (parentPlanet) {
    const parent = planetNamed(parentPlanet);
    if (!parent || !getMoonsByPlanet(parentPlanet).some((moon) => moon.name === body)) return null;
    computeBodyPositionAU(parent, utcMs, out);
    return out.add(computeMoonOffsetEquatorialAU(body, parentPlanet, utcMs, moonOffsetScratch));
  }
  const planet = planetNamed(body);
  return planet ? computeBodyPositionAU(planet, utcMs, out) : null;
}

/** The anchor to save for a ship riding `body`, or null if the body is unknown. */
export function rideAnchorFor(
  body: string,
  parentPlanet: string | undefined,
  shipAU: { x: number; y: number; z: number },
  utcMs: number,
): RideAnchor | null {
  const bodyAU = currentBodyPositionAU(body, parentPlanet, utcMs, new THREE.Vector3());
  if (!bodyAU) return null;
  return {
    body,
    ...(parentPlanet ? { parentPlanet } : {}),
    offsetAU: { x: shipAU.x - bodyAU.x, y: shipAU.y - bodyAU.y, z: shipAU.z - bodyAU.z },
  };
}

/** Where an anchored ship goes on restore; false (out untouched) if the
 *  anchor names a body the catalog no longer has. */
export function anchoredShipPositionAU(anchor: RideAnchor, utcMs: number, out: THREE.Vector3): boolean {
  const bodyAU = currentBodyPositionAU(anchor.body, anchor.parentPlanet, utcMs, new THREE.Vector3());
  if (!bodyAU) return false;
  out.set(bodyAU.x + anchor.offsetAU.x, bodyAU.y + anchor.offsetAU.y, bodyAU.z + anchor.offsetAU.z);
  return true;
}

/**
 * The body a ship saved by the old build was beside, by that build's
 * positions: the planet whose neighbourhood it is in, then whichever of that
 * planet and its moons it is nearest in their own radii. Null in deep space.
 */
function legacyNeighbour(shipAU: THREE.Vector3, utcMs: number): { body: string; parentPlanet?: string; legacyAU: THREE.Vector3 } | null {
  let nearestPlanet: PlanetData | null = null;
  let nearestPlanetAU: THREE.Vector3 | null = null;
  let nearestReachFraction = Infinity;
  for (const planet of PLANETARIUM_BODIES) {
    const planetAU = legacyPlanetPositionAU(planet, utcMs, new THREE.Vector3());
    const reachFraction = shipAU.distanceTo(planetAU) / (planet.systemRadiusAU * MIGRATION_REACH_FACTOR);
    if (reachFraction < nearestReachFraction) {
      nearestReachFraction = reachFraction;
      nearestPlanet = planet;
      nearestPlanetAU = planetAU;
    }
  }
  if (!nearestPlanet || !nearestPlanetAU || nearestReachFraction > 1) return null;
  let best: { body: string; parentPlanet?: string; legacyAU: THREE.Vector3 } = {
    body: nearestPlanet.name,
    legacyAU: nearestPlanetAU,
  };
  let bestRadii = shipAU.distanceTo(nearestPlanetAU) / nearestPlanet.radiusAU;
  for (const moon of getMoonsByPlanet(nearestPlanet.name)) {
    const moonAU = legacyMoonOffsetAU(moon.name, nearestPlanet.name, utcMs, new THREE.Vector3()).add(nearestPlanetAU);
    const radii = shipAU.distanceTo(moonAU) / moon.radiusAU;
    if (radii < bestRadii) {
      bestRadii = radii;
      best = { body: moon.name, parentPlanet: nearestPlanet.name, legacyAU: moonAU };
    }
  }
  return best;
}

/**
 * A journey as loaded from storage, moved onto today's positions if it was
 * saved before them. Anything already carrying `positionModel` passes through
 * untouched; call it on the stored save only, never on a session's own
 * snapshots (they are stamped where they are made).
 */
export function migrateLegacyJourney(saved: PlanetariumState): PlanetariumState {
  if (saved.positionModel) return saved;
  if (saved.landedOn) return { ...saved, positionModel: POSITION_MODEL };
  const shipAU = new THREE.Vector3(saved.positionAU.x, saved.positionAU.y, saved.positionAU.z);
  const neighbour = legacyNeighbour(shipAU, saved.astroTimeUtcMs);
  if (!neighbour) return { ...saved, positionModel: POSITION_MODEL };
  const nowAU = currentBodyPositionAU(neighbour.body, neighbour.parentPlanet, saved.astroTimeUtcMs, new THREE.Vector3());
  if (!nowAU) return { ...saved, positionModel: POSITION_MODEL };
  const movedAU = shipAU.sub(neighbour.legacyAU).add(nowAU);
  return {
    ...saved,
    positionAU: { x: movedAU.x, y: movedAU.y, z: movedAU.z },
    positionModel: POSITION_MODEL,
  };
}
