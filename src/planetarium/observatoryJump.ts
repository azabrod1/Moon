/**
 * Pure vantage policy for the Observatory's "watch this from the ground"
 * step: given the live event and where the player stands, decide whether
 * stepping through the sky window re-lands them first. No scene or DOM
 * access — PlanetariumMode executes the decision.
 *
 * Time jumps never move the ground; only an explicit step through the window
 * does, and only where the other ground is genuinely the better seat.
 *
 * That is Earth's own almanac pair and nothing else. Earth's ground is where
 * the renderer's fireworks live: a corona needs an occluder almost exactly
 * the Sun's angular size (the Moon/Sun ratio sits near 1.0), and the
 * blood-red umbral floor of a lunar eclipse is modelled for Earth's Moon
 * alone. Earth↔Moon is also the only pair with a one-tap swap back, so a
 * relocation there is always reversible.
 *
 * Generic systems never relocate: standing on Io, Jupiter fills ~19° of sky
 * and the local view IS the show — moving the player would take the sight
 * away rather than improve it. Cross-system relocation is refused outright:
 * the destination may still be unpainted, and there is no arrival veil on
 * this path to hold it.
 *
 * Unit-tested in observatoryJump.test.ts.
 */
import type { SurfaceLandedInfo } from './surfaceView';

export interface ShowVantageInput {
  /** The planet whose sky the event happens in. */
  eventParentPlanet: string;
  /** The moon the event involves. */
  eventMoonName: string;
  landed: SurfaceLandedInfo;
}

export interface ShowVantage {
  /** Re-land on the event's parent planet before the sky is pointed at. */
  relocateToParent: boolean;
}

/** Whether stepping through the window relocates the player first. */
export function resolveShowVantage(input: ShowVantageInput): ShowVantage {
  const isEarthAlmanacPair =
    input.eventParentPlanet === 'Earth' && input.eventMoonName === 'Moon';
  return {
    relocateToParent:
      isEarthAlmanacPair &&
      input.landed.type === 'moon' &&
      input.landed.parentPlanet === 'Earth',
  };
}
