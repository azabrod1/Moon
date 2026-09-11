/**
 * The evidence rubric (plan §8): a function from a claim's evidence rows to
 * a score, a multiple of five between 0 and 95, and a level. Nothing in the
 * data stores a score; this is the only place a number about certainty is
 * made, so the popover can show the reader the arithmetic that produced it.
 *
 * Rules (points):
 *   first supporting row from a method that detects the claim directly
 *     (seismology, normal modes counted as their own further row, helio-
 *     seismology, sample, in situ, neutrinos)                          +45
 *   first supporting row when only indirect methods support it         +35
 *   each further supporting row from a distinct method — an indirect one
 *     (gravity, moment of inertia, magnetic, tides, libration, normal
 *     modes) or a second direct one (samples beside seismology)
 *                                                        +15 each, max +30
 *   a supporting laboratory row for the material state at those
 *     conditions                                                        +10
 *     — or, when no direct or indirect method supports the claim, the
 *     laboratory row is the first support (+35, not +10): a melting curve
 *     plus an adiabat is how a temperature is known at all
 *   no challenging rows and no competing topology for this region       +10
 *   each challenging row                                   −25 each, max −50
 *   constraining rows                              0, listed in the popover
 *   density-only support                     +15, level capped Model-dependent
 *
 * Levels: Directly detected 85–95 with a direct row present; Well
 * constrained 65–84; Constrained 45–64; Model-dependent 25–44; Hypothesis
 * under 25. The score never reaches 100 by construction.
 *
 * Pinned worked examples (evidenceScore.test.ts): Earth's outer core 95,
 * Directly detected; Jupiter's dilute core, gravity with competing topology,
 * Model-dependent; Io's shallow magma ocean, induction supported and Juno
 * challenged, Hypothesis; Callisto's ocean on induction alone, Constrained;
 * Earth's outer-core temperature, a melting curve plus an adiabat model,
 * Constrained.
 */
import type { Claim, Evidence, EvidenceMethod } from './data/interiorTypes';

export type EvidenceLevel = 'directlyDetected' | 'wellConstrained' | 'constrained' | 'modelDependent' | 'hypothesis';

export const EVIDENCE_LEVEL_LABEL: Readonly<Record<EvidenceLevel, string>> = {
  directlyDetected: 'Directly detected',
  wellConstrained: 'Well constrained',
  constrained: 'Constrained',
  modelDependent: 'Model-dependent',
  hypothesis: 'Hypothesis',
};

/** How each level reads, for the legend and the popover explainer. */
export const EVIDENCE_LEVEL_READS_AS: Readonly<Record<EvidenceLevel, string>> = {
  directlyDetected: 'A measurement reaches this region itself',
  wellConstrained: 'Several independent measurements agree',
  constrained: 'One class of measurement plus models',
  modelDependent: 'Interior models with real degeneracy',
  hypothesis: 'Plausible, unconfirmed, or challenged',
};

/** Whether numerals show beside the five-segment meter; off leaves the level word. */
export const SHOW_EVIDENCE_NUMERALS = true;

const DIRECT_METHODS: ReadonlySet<EvidenceMethod> = new Set(['seismology', 'helioseismology', 'sample', 'inSitu', 'neutrinos']);
const FURTHER_METHODS: ReadonlySet<EvidenceMethod> = new Set(['gravity', 'momentOfInertia', 'magnetic', 'tides', 'libration', 'normalModes']);

export const POINTS = {
  firstDirect: 45,
  firstIndirect: 35,
  further: 15,
  furtherMax: 30,
  lab: 10,
  unchallenged: 10,
  challenge: -25,
  challengeMax: -50,
  densityOnly: 15,
  max: 95,
} as const;

export interface ScoreLine {
  /** What earned or cost the points, in the reader's words. */
  label: string;
  points: number;
  /** The row this line comes from, when it comes from one. */
  evidence?: Evidence;
}

export interface EvidenceScore {
  score: number;
  level: EvidenceLevel;
  lines: ScoreLine[];
  /** True when a direct-method row supports the claim. */
  direct: boolean;
}

export interface ScoreContext {
  /** Another model of this body draws this region differently or not at all. */
  competingTopology?: boolean;
}

/** The method in the reader's words, for the score lines and the popover. */
export function methodLabel(method: EvidenceMethod): string {
  switch (method) {
    case 'seismology': return 'seismology';
    case 'normalModes': return 'normal modes';
    case 'helioseismology': return 'helioseismology';
    case 'neutrinos': return 'neutrinos';
    case 'gravity': return 'gravity field';
    case 'momentOfInertia': return 'moment of inertia';
    case 'magnetic': return 'magnetic field';
    case 'tides': return 'tides';
    case 'libration': return 'libration';
    case 'labHighPressure': return 'high-pressure laboratory';
    case 'sample': return 'samples';
    case 'inSitu': return 'in-situ measurement';
    case 'density': return 'bulk density';
    case 'model': return 'interior model';
  }
}

export function evidenceScore(claim: Claim, context: ScoreContext = {}): EvidenceScore {
  const lines: ScoreLine[] = [];
  const supporting = claim.evidence.filter((row) => row.relation === 'supports');
  const challenging = claim.evidence.filter((row) => row.relation === 'challenges');
  const constraining = claim.evidence.filter((row) => row.relation === 'constrains');

  const directRow = supporting.find((row) => DIRECT_METHODS.has(row.method));
  const labRows = supporting.filter((row) => row.method === 'labHighPressure');
  const densityRows = supporting.filter((row) => row.method === 'density');
  const modelRows = supporting.filter((row) => row.method === 'model');
  // A second direct method is a further method too: rock in hand beside the seismic Moho.
  const furtherCandidates = supporting.filter((row) => FURTHER_METHODS.has(row.method) || (DIRECT_METHODS.has(row.method) && row !== directRow));
  const densityOnly = supporting.length > 0 && supporting.every((row) => row.method === 'density' || row.method === 'model') && densityRows.length > 0;

  let total = 0;
  const seenMethods = new Set<EvidenceMethod>();
  let firstClaimed = false;

  let labClaimedFirst = false;
  if (directRow) {
    total += POINTS.firstDirect;
    seenMethods.add(directRow.method);
    firstClaimed = true;
    lines.push({ label: `Detected directly by ${methodLabel(directRow.method)}`, points: POINTS.firstDirect, evidence: directRow });
  } else if (densityOnly) {
    total += POINTS.densityOnly;
    firstClaimed = true;
    lines.push({ label: 'Only the bulk density supports it', points: POINTS.densityOnly, evidence: densityRows[0] });
  } else if (labRows.length > 0 && furtherCandidates.length === 0) {
    // Nothing reaches the region and nothing indirect supports it: the
    // laboratory is the support (a temperature from a melting curve).
    total += POINTS.firstIndirect;
    firstClaimed = true;
    labClaimedFirst = true;
    lines.push({ label: `Laboratory work at these conditions is the support (${methodLabel(labRows[0].method)})`, points: POINTS.firstIndirect, evidence: labRows[0] });
  }

  let furtherTotal = 0;
  for (const row of furtherCandidates) {
    if (seenMethods.has(row.method)) continue;
    seenMethods.add(row.method);
    if (!firstClaimed) {
      total += POINTS.firstIndirect;
      firstClaimed = true;
      lines.push({ label: `Inferred from the ${methodLabel(row.method)}`, points: POINTS.firstIndirect, evidence: row });
      continue;
    }
    if (furtherTotal >= POINTS.furtherMax) {
      lines.push({ label: `Also ${methodLabel(row.method)} (further methods already at their cap)`, points: 0, evidence: row });
      continue;
    }
    furtherTotal += POINTS.further;
    total += POINTS.further;
    lines.push({ label: `An independent method agrees: ${methodLabel(row.method)}`, points: POINTS.further, evidence: row });
  }

  if (labRows.length > 0 && !labClaimedFirst) {
    total += POINTS.lab;
    lines.push({ label: 'Laboratory work reproduces the state at these conditions', points: POINTS.lab, evidence: labRows[0] });
  }

  for (const row of modelRows) {
    if (densityOnly && row === densityRows[0]) continue;
    lines.push({ label: `An interior model is consistent (${methodLabel(row.method)})`, points: 0, evidence: row });
  }
  for (const row of constraining) {
    lines.push({ label: `Constrains it without deciding: ${methodLabel(row.method)}`, points: 0, evidence: row });
  }

  let challengeTotal = 0;
  for (const row of challenging) {
    const points = challengeTotal > POINTS.challengeMax ? Math.max(POINTS.challenge, POINTS.challengeMax - challengeTotal) : 0;
    challengeTotal += points;
    total += points;
    lines.push({ label: `Challenged by ${methodLabel(row.method)}`, points, evidence: row });
  }

  if (challenging.length === 0 && !context.competingTopology && supporting.length > 0) {
    total += POINTS.unchallenged;
    lines.push({ label: 'Nothing published argues against it, and no rival model draws it differently', points: POINTS.unchallenged });
  } else if (context.competingTopology) {
    lines.push({ label: 'Another model of this body draws this region differently', points: 0 });
  }

  let score = Math.round(Math.min(POINTS.max, Math.max(0, total)) / 5) * 5;
  let level = levelFor(score, !!directRow);
  if (densityOnly && (level === 'directlyDetected' || level === 'wellConstrained' || level === 'constrained')) {
    level = 'modelDependent';
    score = Math.min(score, 40);
  }
  return { score, level, lines, direct: !!directRow };
}

export function levelFor(score: number, direct: boolean): EvidenceLevel {
  if (score >= 85 && direct) return 'directlyDetected';
  if (score >= 65) return 'wellConstrained';
  if (score >= 45) return 'constrained';
  if (score >= 25) return 'modelDependent';
  return 'hypothesis';
}

/** How many of the meter's five segments a score fills. */
export function meterSegments(score: number): number {
  return Math.max(0, Math.min(5, Math.ceil(score / 20)));
}
