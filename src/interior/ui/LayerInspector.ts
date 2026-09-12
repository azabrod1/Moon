/**
 * The hover card and the pinned inspector for one region (plan §4, §8):
 * DOM built from the schema region behind a drawn region, nothing cached.
 * The hover card is the preview (name, material and phase, the depth under
 * the pointer); the inspector is the reading: composition, the claims with
 * their computed levels and meters (each opens the evidence popover),
 * conditions with their basis words, the boundary above, the heat budget,
 * the overlapping annotations, and the model's own provenance line. A
 * region drawn as an unresolved whole has no claims and says so.
 *
 * Every number goes through inspectorText, so the words are the same ones
 * the tests pin, and the score beside every claim is evidenceScore's,
 * never a stored one. Where the copy names the reader's own gesture it asks
 * the pointer (pointerVerb): a finger taps, a mouse clicks.
 */
import type { Annotation, ClaimKind, Coverage } from '../data/interiorTypes';
import { coverageBulk } from '../data/interiorTypes';
import { competingTopology } from '../data/interiorRegistry';
import { FAMILY_LABEL, PHASE_LABEL } from '../data/artParams';
import { EVIDENCE_LEVEL_LABEL, EVIDENCE_LEVEL_READS_AS, POINTS, SHOW_EVIDENCE_NUMERALS, evidenceScore, type EvidenceScore } from '../evidenceScore';
import type { DrawnModel, DrawnRegion } from '../drawnModel';
import { closeButton, element, meterBar } from './dom';
import {
  boundaryText,
  depthRangeText,
  formatKm,
  heatText,
  pressureQuantityText,
  quantityText,
  reviewDateText,
  sourcedText,
  temperatureQuantityText,
  thicknessText,
} from './inspectorText';

export const CLAIM_TITLE: Readonly<Record<ClaimKind, string>> = {
  existence: 'This region exists',
  extent: 'Its size',
  state: 'Its state',
  composition: 'Its composition',
  temperature: 'Its temperature',
};

/** The five-segment meter with the level word (its plain gloss on hover) and, where asked for
 *  and behind the flag, the numeral "65 of 95". The legend leaves the numeral to the inspector. */
export function buildMeter(score: EvidenceScore, options: { numeral?: boolean } = {}): HTMLElement {
  const wrap = element('span', 'ev-meter-wrap');
  const level = element('span', `ev-level ev-${score.level}`, EVIDENCE_LEVEL_LABEL[score.level]);
  level.title = EVIDENCE_LEVEL_READS_AS[score.level];
  wrap.append(level, meterBar(score.score));
  if (SHOW_EVIDENCE_NUMERALS && options.numeral) wrap.append(element('span', 'ev-score', `${score.score} of ${POINTS.max}`));
  return wrap;
}

/** The word for the gesture the reader has: a finger taps, a mouse clicks. */
export function pointerVerb(): string {
  return window.matchMedia?.('(pointer: coarse)').matches ? 'tap' : 'click';
}

export function familyPhaseText(region: DrawnRegion): string {
  return `${FAMILY_LABEL[region.family]} · ${PHASE_LABEL[region.phase]}`;
}

/** The hover preview: name, material and phase, the depth under the pointer. */
export function renderHoverCard(card: HTMLElement, region: DrawnRegion, depthKm: number | null): void {
  card.replaceChildren();
  card.append(element('div', 'ih-name', region.name));
  card.append(element('div', 'ih-kicker', familyPhaseText(region)));
  if (depthKm !== null) card.append(element('div', 'ih-depth', `${formatKm(Math.max(0, depthKm))} km down`));
  const verb = pointerVerb();
  card.append(element('div', 'ih-hint', `${verb.charAt(0).toUpperCase()}${verb.slice(1)} to read`));
}

export interface InspectorContext {
  drawn: DrawnModel;
  /** Inside-out index of the region. */
  index: number;
  coverage: Coverage;
  /** Open the evidence popover for the region's claim at this index. */
  onEvidence: (claimIndex: number) => void;
  onClose: () => void;
}

/** The scores for a region's claims, in claim order, with the rubric's topology context. */
export function claimScores(context: Pick<InspectorContext, 'drawn' | 'index' | 'coverage'>): EvidenceScore[] {
  const region = context.drawn.regionsInsideOut[context.index]?.region;
  if (!region || !context.drawn.modelId) return [];
  const topology = competingTopology(context.coverage, context.drawn.modelId, region.key);
  return region.claims.map((claim) => evidenceScore(claim, { competingTopology: topology }));
}

function annotationsOver(drawn: DrawnModel, region: DrawnRegion): Annotation[] {
  const model = drawn.model;
  if (!model) return [];
  return model.annotations.filter((note) => note.innerRadiusKm < region.outerRadiusKm && note.outerRadiusKm > region.innerRadiusKm);
}

function line(label: string, value: string): HTMLElement {
  const row = element('div', 'ii-line');
  row.append(element('span', 'ii-key', label), element('span', 'ii-val', value));
  return row;
}

export function renderInspector(root: HTMLElement, context: InspectorContext): void {
  const { drawn, index, coverage } = context;
  const region = drawn.regionsInsideOut[index];
  root.replaceChildren();
  if (!region) return;

  const head = element('div', 'ii-head');
  const titles = element('div', 'ii-titles');
  titles.append(element('div', 'ii-name', region.name), element('div', 'ii-kicker', familyPhaseText(region)));
  head.append(titles, closeButton(() => context.onClose(), 'pk-x ii-close'));
  root.append(head);

  const schema = region.region;
  if (!schema) {
    // The unresolved whole: the bulk line is all there is to say, and the panel already
    // carries the note, so the card keeps to the number and its source.
    const bulk = coverageBulk(coverage);
    root.append(element('div', 'ii-depth', `${formatKm(drawn.referenceRadiusKm)} km to the centre`));
    root.append(element('p', 'ii-text', region.composition));
    if (bulk?.densityKgM3) {
      root.append(line('Bulk density', `${formatKm(bulk.densityKgM3.value)} kg/m³ (${bulk.densityKgM3.basis})`));
      root.append(element('div', 'ii-src', bulk.densityKgM3.source));
    }
    root.append(element('div', 'ii-foot', 'No interior model is drawn for this body; the grey hatch means not known, not a material.'));
    return;
  }

  root.append(element('div', 'ii-depth', `${depthRangeText(schema, region.innerRadiusKm, drawn.referenceRadiusKm)} · ${thicknessText(schema, region.innerRadiusKm)}`));
  root.append(element('p', 'ii-text', sourcedText(schema.composition)));
  if (schema.rheology) root.append(element('p', 'ii-text ii-rheology', schema.rheology));

  const scores = claimScores(context);
  if (schema.claims.length > 0) {
    root.append(element('div', 'ii-sec', `How sure we are · ${pointerVerb()} a row for the evidence`));
    schema.claims.forEach((claim, claimIndex) => {
      const button = element('button', 'ii-claim');
      button.type = 'button';
      button.dataset.claim = claim.kind;
      button.setAttribute('aria-label', `${CLAIM_TITLE[claim.kind]}: ${EVIDENCE_LEVEL_LABEL[scores[claimIndex].level]}, open the evidence`);
      button.append(element('span', 'ii-claim-title', CLAIM_TITLE[claim.kind]), buildMeter(scores[claimIndex], { numeral: true }));
      button.addEventListener('click', () => context.onEvidence(claimIndex));
      root.append(button);
    });
  }

  root.append(element('div', 'ii-sec', 'Conditions'));
  root.append(line('Temperature', temperatureQuantityText(schema.temperatureK)));
  root.append(line('Pressure', pressureQuantityText(schema.pressureGPa)));
  root.append(line('Density', quantityText(schema.densityKgM3, 'kg/m³')));
  root.append(line('Boundary above', boundaryText(schema)));

  root.append(element('div', 'ii-sec', 'Heat'));
  root.append(element('p', 'ii-text', heatText(schema.heat)));
  for (const generated of schema.heat.generated) {
    if (generated.note) root.append(element('div', 'ii-note', generated.note));
  }

  const notes = annotationsOver(drawn, region);
  if (notes.length > 0) {
    root.append(element('div', 'ii-sec', 'Also named here'));
    for (const note of notes) {
      const row = element('div', 'ii-annotation');
      row.append(element('b', '', note.name), document.createTextNode(` ${note.note}`));
      root.append(row);
    }
  }

  // Past readings: how the picture of this body has changed, from the registry's history.
  const past = coverage.history.filter((entry) => entry.status !== 'current' || entry.modelId !== drawn.modelId);
  if (past.length > 0) {
    root.append(element('div', 'ii-sec', 'Past readings'));
    for (const entry of past) {
      const row = element('div', 'ii-annotation');
      row.append(element('b', '', `${entry.year} · ${PAST_STATUS_WORD[entry.status]}`), document.createTextNode(` ${entry.note}`));
      root.append(row);
    }
  }

  const model = drawn.model;
  if (model) {
    const review = model.review === 'reviewed' ? `Reviewed model, ${reviewDateText(model.reviewedOn)}` : `Provisional model, last checked ${reviewDateText(model.reviewedOn)}`;
    root.append(element('div', 'ii-foot', `${review}. Colours and textures are illustrative, not data.`));
  }
}

const PAST_STATUS_WORD: Readonly<Record<'current' | 'superseded' | 'disfavoured', string>> = {
  current: 'also current',
  superseded: 'superseded',
  disfavoured: 'disfavoured',
};
