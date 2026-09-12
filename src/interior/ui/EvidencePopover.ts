/**
 * The evidence popover (plan §8): for one claim, the rows that make it —
 * observed, inferred, assumed, uncertain, each tagged supports, challenges
 * or constrains, with mission and year and source — then the arithmetic
 * that produced the score, line by line, then the rubric so a reader can
 * check the sum. It opens from the inspector's claim rows, never from the
 * transient hover card, and stays until dismissed.
 */
import type { Claim } from '../data/interiorTypes';
import {
  DIRECTLY_DETECTED_MIN_SCORE,
  EVIDENCE_LEVEL_LABEL,
  EVIDENCE_LEVEL_READS_AS,
  POINTS,
  methodLabel,
  type EvidenceLevel,
  type EvidenceScore,
} from '../evidenceScore';
import { CLAIM_TITLE } from './LayerInspector';
import { closeButton, element, meterBar } from './dom';
import { RELATION_WORD, provenanceText } from './inspectorText';

const LEVEL_ORDER: readonly EvidenceLevel[] = ['directlyDetected', 'wellConstrained', 'constrained', 'modelDependent', 'hypothesis'];

const LEVEL_RANGE: Readonly<Record<EvidenceLevel, string>> = {
  directlyDetected: `${DIRECTLY_DETECTED_MIN_SCORE} and up, with a measurement that reaches the region`,
  wellConstrained: `${DIRECTLY_DETECTED_MIN_SCORE} and up, without one`,
  constrained: '45–64',
  modelDependent: '25–44',
  hypothesis: 'under 25',
};

/** The rubric's rules as the reader sees them, one line each. */
export function rubricLines(): string[] {
  return [
    `First supporting row from a method that reaches the region itself (seismology, samples, in-situ, neutrinos, helioseismology): +${POINTS.firstDirect}`,
    `First supporting row when only indirect methods support it: +${POINTS.firstIndirect}`,
    `Each further supporting method, indirect (gravity, moment of inertia, magnetic field, tides, libration, normal modes) or a second direct one: +${POINTS.further}, up to +${POINTS.furtherMax}`,
    `Laboratory work reproducing the state at those conditions: +${POINTS.lab}`,
    `Nothing published argues against it and no rival model draws it differently: +${POINTS.unchallenged}`,
    `Each challenging row: ${POINTS.challenge}, down to ${POINTS.challengeMax}`,
    'Constraining rows, consistent models, a second row of a method already counted, and the bulk density beside stronger evidence: 0, listed for the reader',
    `Only the bulk density: +${POINTS.densityOnly}, and never above Model-dependent`,
    `The score is rounded to fives and never reaches 100: ${POINTS.max} is the ceiling.`,
    `Directly detected needs a measurement that reaches the region and a score of ${DIRECTLY_DETECTED_MIN_SCORE} or more; the same score without one is Well constrained.`,
  ];
}

export function signedPoints(points: number): string {
  if (points > 0) return `+${points}`;
  if (points < 0) return String(points);
  return '0';
}

export interface EvidencePopoverContext {
  regionName: string;
  claim: Claim;
  score: EvidenceScore;
  onClose: () => void;
}

export function renderEvidencePopover(card: HTMLElement, context: EvidencePopoverContext): void {
  const { claim, score } = context;
  card.replaceChildren();

  const head = element('div', 'body-picker-head');
  const title = element('div', 'body-picker-title');
  title.append(element('b', '', context.regionName), document.createTextNode(` · ${CLAIM_TITLE[claim.kind].toLowerCase()}`));
  head.append(title, closeButton(() => context.onClose()));
  card.append(head);

  const body = element('div', 'ev-body');
  const summary = element('div', 'ev-summary');
  summary.append(
    element('span', `ev-level ev-${score.level}`, EVIDENCE_LEVEL_LABEL[score.level]),
    meterBar(score.score),
    element('span', 'ev-score', `${score.score} of ${POINTS.max}`),
  );
  body.append(summary);
  body.append(element('div', 'ev-reads', EVIDENCE_LEVEL_READS_AS[score.level]));
  if (claim.probability) {
    body.append(element('div', 'ev-prob', `Published: ${Math.round(claim.probability.value * 100)}% that ${claim.probability.proposition} (${claim.probability.source})`));
  }

  body.append(element('div', 'ii-sec', claim.evidence.length === 1 ? 'The evidence' : `The evidence, ${claim.evidence.length} rows`));
  for (const row of claim.evidence) {
    const block = element('div', `ev-row ev-${row.relation}`);
    const rowHead = element('div', 'ev-row-head');
    rowHead.append(element('b', '', methodLabel(row.method)), element('span', `ev-tag ev-tag-${row.relation}`, RELATION_WORD[row.relation]));
    const provenance = provenanceText(row.mission, row.year);
    if (provenance) rowHead.append(element('span', 'ev-prov', provenance));
    block.append(rowHead);
    const list = element('dl', 'ev-oiau');
    for (const [label, text] of [['Observed', row.observed], ['Inferred', row.inferred], ['Assumed', row.assumed], ['Uncertain', row.uncertain]] as const) {
      list.append(element('dt', '', label), element('dd', '', text));
    }
    block.append(list, element('div', 'ev-src', row.source));
    body.append(block);
  }

  body.append(element('div', 'ii-sec', 'How the score is made'));
  const arithmetic = element('div', 'ev-arith');
  for (const scoreLine of score.lines) {
    const line = element('div', `ev-arith-line${scoreLine.points === 0 ? ' zero' : ''}`);
    line.append(element('span', 'ev-arith-label', scoreLine.label), element('span', 'ev-arith-points', signedPoints(scoreLine.points)));
    arithmetic.append(line);
  }
  const total = element('div', 'ev-arith-line ev-total');
  total.append(element('span', 'ev-arith-label', `Total, rounded to fives and capped at ${POINTS.max}`), element('span', 'ev-arith-points', String(score.score)));
  arithmetic.append(total);
  body.append(arithmetic);

  body.append(element('div', 'ii-sec', 'The rubric'));
  const levels = element('div', 'ev-rubric-levels');
  for (const level of LEVEL_ORDER) {
    const row = element('div', 'ev-rubric-level');
    row.append(element('span', `ev-level ev-${level}`, EVIDENCE_LEVEL_LABEL[level]), element('span', 'ev-rubric-range', LEVEL_RANGE[level]), element('span', 'ev-rubric-reads', EVIDENCE_LEVEL_READS_AS[level]));
    levels.append(row);
  }
  body.append(levels);
  const rules = element('ul', 'ev-rubric');
  for (const rule of rubricLines()) rules.append(element('li', '', rule));
  body.append(rules);
  body.append(element('div', 'ii-foot', 'The score is computed from these rows by a published rule; nothing about certainty is typed in by hand.'));
  card.append(body);
}
