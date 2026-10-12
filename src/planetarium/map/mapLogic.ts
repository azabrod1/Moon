/**
 * System-map card logic — pure, no THREE, no DOM. Decides which commit verbs a
 * picked body offers and whether a commit is accepted, so the card and the deck
 * stay in lock-step with the mode's real arrival semantics.
 */

/** Internal commit ids; the card paints the shipped user-facing verbs —
 *  Teleport / Observatory / Autopilot / Leave. The deck's tabs speak the first
 *  three; 'leave' is the card's own, for the body the player stands on. */
export type MapVerb = 'travel' | 'observe' | 'pilot' | 'leave';

/**
 * A card button. The kinds are deliberately different types rather than one
 * widened verb union: Focus moves the map camera and commits nothing, and
 * Look inside opens a tool on the body and commits no arrival either, so both
 * must be structurally impossible to route into the arrival path that
 * Teleport / Observatory / Autopilot share.
 */
export type MapCardAction =
  | { kind: 'commit'; verb: MapVerb; label: string }
  | { kind: 'focus'; label: string }
  | { kind: 'inside'; label: string };

/** A body the map can act on — the same shape the landed body and every commit
 *  target already speak in, so a picked body needs no translation on its way to
 *  the arrival path. A moon carries its parent: two moons of different planets
 *  never share a name today, but the arrival path is given a system, not a
 *  guess. */
export type MapBodyRef =
  | { type: 'planet'; name: string }
  | { type: 'moon'; name: string; parentPlanet: string };

/**
 * The buttons a picked body offers.
 *
 * | Target                  | Buttons                                                  |
 * |-------------------------|----------------------------------------------------------|
 * | Planet, not here        | Teleport · Observatory · Autopilot · Focus · Look inside |
 * | Sun                     | Teleport · Autopilot · Focus (no surface, no interior)   |
 * | The current landed body | Leave · Observatory · Focus · Look inside                |
 *
 * "Leave" is its own verb — a take-off, never a teleport. It is NOT 'travel'
 * on the landed body: that one is a real teleport to the body's flyby pose
 * (the deck's Teleport tab lists the body you stand on, and a Teleport that
 * silently took off instead sent an Observatory excursion back to wherever
 * the ship was before it). "Observatory" on the landed body is verb 'observe'
 * whose sameBody path reopens the panel. Autopilot is withheld on the landed
 * body — its sameBody branch would lift off and park rather than engage.
 * Focus is on every card: it flies the map camera
 * and nothing else, so no target can refuse it. Look inside is on every body
 * with an interior to show — every planet and moon; the Sun waits for its
 * own model — and opens the Look-inside tool on it, committing no arrival.
 */
export function mapCardActions(
  target: MapBodyRef,
  landedOn: MapBodyRef | null,
): MapCardAction[] {
  const focus: MapCardAction = { kind: 'focus', label: 'Focus' };
  const inside: MapCardAction = { kind: 'inside', label: 'Look inside' };
  const sameBody =
    !!landedOn && landedOn.type === target.type && landedOn.name === target.name;
  if (sameBody) {
    return [
      { kind: 'commit', verb: 'leave', label: 'Leave' },
      { kind: 'commit', verb: 'observe', label: 'Observatory' },
      focus,
      inside,
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
    inside,
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
 * the arrival veil, which ignores a rival while one is covering. A Teleport is
 * busy even on the body the player stands on: it is a real jump through the
 * veil like any other. Leave and a same-body Observatory-reopen never touch
 * the veil, and Autopilot engages without it, so none of those is ever busy.
 */
export function commitBodyPickOutcome(input: {
  missionActive: boolean;
  arrivalInFlight: boolean;
  verb: MapVerb;
  sameBody: boolean;
}): CommitOutcome {
  if (input.missionActive) return 'refused';
  if (
    (input.verb === 'travel' || (input.verb === 'observe' && !input.sameBody)) &&
    input.arrivalInFlight
  ) {
    return 'busy';
  }
  return 'accepted';
}
