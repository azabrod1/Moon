/**
 * The map's body roster, and the single seam every name lookup on the chart
 * resolves through.
 *
 * The chart names three kinds of body: the Sun, the catalog planets, and the
 * catalog moons. Resolving a name against the planet orbits alone answers an
 * unknown name with the origin, with a zero radius, or with nothing — all three
 * silent, and the origin is where the Sun is, so a camera handed one flies into
 * the star. One roster and one resolver make an unresolvable name null
 * everywhere it is asked, and hand a moon its parent, its true radius and its
 * catalog tint along with its name.
 *
 * Pure: catalogs in, plain records out. No THREE, no DOM, no camera.
 */

import { PLANETARIUM_BODIES, SUN_DATA } from '../planets/planetData';
import { MOONS } from '../planets/moonData';
import type { MapBodyRef } from './mapLogic';

export type MapBodyKind = 'sun' | 'planet' | 'moon';

export interface MapBody {
  kind: MapBodyKind;
  /** Catalog name — the key every map surface (pick, card, probe) speaks in. */
  name: string;
  /** Catalog name of the planet a moon orbits; null for the Sun and planets. */
  parentPlanet: string | null;
  /** True radius in AU: what framing, clip planes and the size policy meter
   *  against, never a drawn radius the chart marker may have floored. */
  radiusAU: number;
  /** Catalog tint, 0xRRGGBB. The Sun is outside the body catalogs — its tint
   *  comes from SUN_DATA, the one commented exception to the catalog rule. */
  color: number;
}

/** Every body the chart can name, in the order labels claim priority: the Sun
 *  first, then the planets inner→outer, then the moons. */
export const MAP_BODIES: readonly MapBody[] = [
  {
    kind: 'sun',
    name: SUN_DATA.name,
    parentPlanet: null,
    radiusAU: SUN_DATA.radiusAU,
    color: SUN_DATA.color,
  },
  ...PLANETARIUM_BODIES.map((planet): MapBody => ({
    kind: 'planet',
    name: planet.name,
    parentPlanet: null,
    radiusAU: planet.radiusAU,
    color: planet.color,
  })),
  ...MOONS.map((moon): MapBody => ({
    kind: 'moon',
    name: moon.name,
    parentPlanet: moon.parentPlanet,
    radiusAU: moon.radiusAU,
    color: moon.color,
  })),
];

/**
 * Screen anchors the map can need at once: every body in the roster, plus the
 * ship marker. A pool sized from this cannot be written past — sizing it from
 * the planets alone leaves the write off the end of the array, which for a
 * plain array is an undefined slot and for a typed array is a silent no-op.
 */
export const MAP_PICK_ANCHOR_CAPACITY = MAP_BODIES.length + 1;

/** Labels the map can place in one frame: one per body, no ship label. */
export const MAP_LABEL_CAPACITY = MAP_BODIES.length;

const BY_NAME: ReadonlyMap<string, MapBody> = new Map(
  MAP_BODIES.map((body) => [body.name, body]),
);

/** The roster entry for a catalog name, or null when the chart has no such
 *  body. Null is the whole point: every caller must decide what to do without
 *  a body rather than inherit a zero that reads as a real answer. */
export function mapBody(name: string): MapBody | null {
  return BY_NAME.get(name) ?? null;
}

/**
 * Whether the map's camera may be sent to a body — flown to, followed, dived
 * at. Narrower than "the name resolves", which every body in the roster does:
 * the camera settles on a scalar shell about its subject, and a subject that
 * ORBITS something else is carried around inside that distance. Where the orbit
 * is comparable to the shell, the azimuth that puts the subject between the
 * camera and its parent leaves the camera |shell − orbit| from the parent's
 * centre — inside the planet for an inner moon, reached within hours of
 * simulated time at any warp. Until a body is drawn with a shell that clears
 * whatever it orbits, the camera does not go there.
 *
 * `isDrawn` is the caller's reach predicate, and SystemMap answers it with
 * whether the chart CAN build the body's system rather than whether it has:
 * the Focus picker is built once per open, from the overview, where no moon
 * is drawn yet. So a moon earns this as soon as its system is buildable, and
 * the Sun, which orbits nothing, always has it.
 */
export function mapBodyAcceptsCamera(
  name: string,
  isDrawn: (name: string) => boolean,
): boolean {
  const body = mapBody(name);
  if (!body) return false;
  return body.kind === 'sun' || isDrawn(body.name);
}

/**
 * The commit-target shape for a picked body — what the card offers verbs on and
 * what an accepted commit hands the arrival path. A moon carries its parent, so
 * the target matches the landed body exactly when you are standing on it.
 *
 * The Sun rides as a planet-typed ref: it has no surface to land on, and the
 * card's verb table already answers it by name.
 */
export function mapBodyRefFor(name: string): MapBodyRef | null {
  const body = mapBody(name);
  if (!body) return null;
  if (body.kind === 'moon' && body.parentPlanet) {
    return { type: 'moon', name: body.name, parentPlanet: body.parentPlanet };
  }
  return { type: 'planet', name: body.name };
}
