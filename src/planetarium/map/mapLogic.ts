/**
 * System-map card logic — pure, no THREE, no DOM. Decides which commit verbs a
 * picked body offers and whether a commit is accepted, so the card and the deck
 * stay in lock-step with the mode's real arrival semantics.
 */

/** Internal commit ids (unchanged from the deck); the card paints the shipped
 *  user-facing verbs — Teleport / Observatory / Autopilot / Leave. */
export type MapVerb = 'travel' | 'observe' | 'pilot';

/**
 * A card button. The two kinds are deliberately different types rather than one
 * widened verb union: Focus moves the map camera and commits nothing, so it
 * must be structurally impossible to route into the arrival path that
 * Teleport / Observatory / Autopilot share.
 */
export type MapCardAction =
  | { kind: 'commit'; verb: MapVerb; label: string }
  | { kind: 'focus'; label: string };

/** A body the map can act on. The map shows planets + the Sun; the landed body
 *  may be a moon (you can be standing on Io), which never matches a picked
 *  planet, so its full planet card shows. */
export interface MapBodyRef {
  type: 'planet' | 'moon';
  name: string;
}

/**
 * The buttons a picked body offers.
 *
 * | Target                  | Buttons                                    |
 * |-------------------------|--------------------------------------------|
 * | Planet, not here        | Teleport · Observatory · Autopilot · Focus |
 * | Sun                     | Teleport · Autopilot · Focus (no surface)  |
 * | The current landed body | Leave · Observatory · Focus                |
 *
 * "Leave" is verb 'travel' whose sameBody path is a take-off; "Observatory" on
 * the landed body is verb 'observe' whose sameBody path reopens the panel.
 * Autopilot is withheld on the landed body — its sameBody branch would lift off
 * and park rather than engage. Focus is on every card: it flies the map camera
 * and nothing else, so no target can refuse it.
 */
export function mapCardActions(
  target: MapBodyRef,
  landedOn: MapBodyRef | null,
): MapCardAction[] {
  const focus: MapCardAction = { kind: 'focus', label: 'Focus' };
  const sameBody =
    !!landedOn && landedOn.type === target.type && landedOn.name === target.name;
  if (sameBody) {
    return [
      { kind: 'commit', verb: 'travel', label: 'Leave' },
      { kind: 'commit', verb: 'observe', label: 'Observatory' },
      focus,
    ];
  }
  if (target.name === 'Sun') {
    return [
      { kind: 'commit', verb: 'travel', label: 'Teleport' },
      { kind: 'commit', verb: 'pilot', label: 'Autopilot' },
      focus,
    ];
  }
  return [
    { kind: 'commit', verb: 'travel', label: 'Teleport' },
    { kind: 'commit', verb: 'observe', label: 'Observatory' },
    { kind: 'commit', verb: 'pilot', label: 'Autopilot' },
    focus,
  ];
}

/**
 * Whether the card for `target` (given the landed body) actually offers `verb`.
 * Every commit path runs this so a verb the card never painted can't be
 * committed — protecting the bridge (`mapCommit('observe')` on the Sun) and any
 * UI race where the pick changed under an in-flight click.
 */
export function mapCardOffersVerb(
  target: MapBodyRef,
  landedOn: MapBodyRef | null,
  verb: MapVerb,
): boolean {
  return mapCardActions(target, landedOn)
    .some((a) => a.kind === 'commit' && a.verb === verb);
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
