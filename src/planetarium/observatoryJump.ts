/**
 * Pure vantage/view policy for Observatory event jumps: given the event, where
 * the player stands, and which control asked, decide whether the jump re-lands
 * the player and whether it watches from the ground or from the landed orbit
 * camera. No scene or DOM access — PlanetariumMode executes the decision.
 *
 * A jump is a promise to show the event, and the event is a sky: the surface
 * view is the default. Shadow guides are the one exception — the cone
 * silhouettes, crossing rings and season tick are only legible from outside
 * the cone, so a player who switched that instrument on keeps the orbit view.
 *
 * The panel makes two different promises and they stay distinct. The four
 * Earth-almanac stepper rows (Full/New Moon, Lunar/Solar Eclipse) are
 * event-TYPE requests named for Earth-sky phenomena, so they stage the
 * observer their name implies and relocate a player standing on the Moon. An
 * upcoming-list row promises "this event, from where you stand" — its ∅ badge
 * and what-you'll-see hint are observer-conditioned — so it never moves the
 * ground.
 *
 * Unit-tested in observatoryJump.test.ts.
 */
import type { SurfaceLandedInfo } from './surfaceView';

export interface JumpPolicyInput {
  /**
   * The planet whose sky names the event. Shadow jumps pass the event spec's
   * parentPlanet; the phase steppers (full/new moon) are Earth-almanac rows
   * and pass Earth.
   */
  eventParentPlanet: string;
  landed: SurfaceLandedInfo;
  /** True for the type-stepper rows, false for an upcoming-list row. */
  isStepper: boolean;
  /** The Shadow guides toggle — session-sticky, off by default. */
  guidesOn: boolean;
}

export interface JumpPolicy {
  /** Re-land on the event's parent planet before the framing is chosen. */
  relocateToParent: boolean;
  /** Where the jump ends up watching from. */
  view: 'surface' | 'orbit';
}

/**
 * The jump's vantage and view.
 *
 * Relocation is same-system-only and only ever moon → its own parent: a
 * cross-system re-land would drop the player onto a body that may still be
 * unpainted, with no arrival veil to hold it. This function relocates for any
 * same-system stepper; the stricter rule — relocate only where a one-tap
 * return exists — is carried by which steppers exist at all. Today that is
 * the Earth rows alone (Earth↔Moon is the only two-way swap), so a stepper
 * for another system must not ship until its parent offers a swap back to
 * the moon.
 */
export function resolveJumpPolicy(input: JumpPolicyInput): JumpPolicy {
  const relocateToParent =
    input.isStepper &&
    input.landed.type === 'moon' &&
    input.landed.parentPlanet === input.eventParentPlanet;
  return { relocateToParent, view: input.guidesOn ? 'orbit' : 'surface' };
}
