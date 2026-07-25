/**
 * System-map card logic — pure, no THREE, no DOM. Decides which commit verbs a
 * picked body offers and whether a commit is accepted, so the card and the deck
 * stay in lock-step with the mode's real arrival semantics.
 */

/** Internal commit ids (unchanged from the deck); the card paints the shipped
 *  user-facing verbs — Teleport / Observatory / Autopilot / Leave. */
export type MapVerb = 'travel' | 'observe' | 'pilot';

export interface MapCardAction {
  verb: MapVerb;
  label: string;
}

/** A body the map can act on. The map shows planets + the Sun; the landed body
 *  may be a moon (you can be standing on Io), which never matches a picked
 *  planet, so its full planet card shows. */
export interface MapBodyRef {
  type: 'planet' | 'moon';
  name: string;
}

/**
 * The verb buttons a picked body offers.
 *
 * | Target                | Buttons                            |
 * |-----------------------|------------------------------------|
 * | Planet, not here      | Teleport · Observatory · Autopilot |
 * | Sun                   | Teleport · Autopilot (no surface)  |
 * | The current landed body | Leave · Observatory              |
 *
 * "Leave" is verb 'travel' whose sameBody path is a take-off; "Observatory" on
 * the landed body is verb 'observe' whose sameBody path reopens the panel.
 * Autopilot is withheld on the landed body — its sameBody branch would lift off
 * and park rather than engage.
 */
export function mapCardActions(
  target: MapBodyRef,
  landedOn: MapBodyRef | null,
): MapCardAction[] {
  const sameBody =
    !!landedOn && landedOn.type === target.type && landedOn.name === target.name;
  if (sameBody) {
    return [
      { verb: 'travel', label: 'Leave' },
      { verb: 'observe', label: 'Observatory' },
    ];
  }
  if (target.name === 'Sun') {
    return [
      { verb: 'travel', label: 'Teleport' },
      { verb: 'pilot', label: 'Autopilot' },
    ];
  }
  return [
    { verb: 'travel', label: 'Teleport' },
    { verb: 'observe', label: 'Observatory' },
    { verb: 'pilot', label: 'Autopilot' },
  ];
}

export type CommitOutcome = 'accepted' | 'refused' | 'busy';

/**
 * The refusal decision shared by every body commit (deck row, map card,
 * bridge). Refused outright during a mission. "Busy" when a Teleport/Observatory
 * commit would be silently dropped by an in-flight arrival — those route through
 * the arrival veil, which ignores a rival while one is covering. A same-body
 * Leave / Observatory-reopen never touches the veil, and Autopilot engages
 * without it, so neither is ever busy.
 */
export function commitBodyPickOutcome(input: {
  missionActive: boolean;
  arrivalInFlight: boolean;
  verb: MapVerb;
  sameBody: boolean;
}): CommitOutcome {
  if (input.missionActive) return 'refused';
  if (
    !input.sameBody &&
    (input.verb === 'travel' || input.verb === 'observe') &&
    input.arrivalInFlight
  ) {
    return 'busy';
  }
  return 'accepted';
}
