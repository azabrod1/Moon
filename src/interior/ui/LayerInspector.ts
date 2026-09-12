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
 * never a stored one.
 */
import type { Annotation, ClaimKind, Coverage } from '../data/interiorTypes';
import { coverageBulk } from '../data/interiorTypes';
import { competingTopology } from '../data/interiorRegistry';
import { FAMILY_LABEL, PHASE_LABEL } from '../data/artParams';
import { EVIDENCE_LEVEL_LABEL, SHOW_EVIDENCE_NUMERALS, evidenceScore, type EvidenceScore } from '../evidenceScore';
import type { DrawnModel, DrawnRegion } from '../drawnModel';
import { closeButton, element, meterBar } from './dom';
import { boundaryText, depthRangeText, formatKm, heatText, quantityText, sourcedText, thicknessText } from './inspectorText';

export const CLAIM_TITLE: Readonly<Record<ClaimKind, string>> = {
  existence: 'This region exists',
  extent: 'Its size',
  state: 'Its state',
  composition: 'Its composition',
  temperature: 'Its temperature',
};

/** The five-segment meter with the level word and, behind the flag, the numeral. */
export function buildMeter(score: EvidenceScore): HTMLElement {
  const wrap = element('span', 'ev-meter-wrap');
  wrap.append(element('span', `ev-level ev-${score.level}`, EVIDENCE_LEVEL_LABEL[score.level]), meterBar(score.score));
  if (SHOW_EVIDENCE_NUMERALS) wrap.append(element('span', 'ev-score', String(score.score)));
  return wrap;
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
    // The unresolved whole: the bulk line is all there is to say.
    const bulk = coverageBulk(coverage);
    root.append(element('div', 'ii-depth', `${formatKm(drawn.referenceRadiusKm)} km to the centre`));
    root.append(element('p', 'ii-text', bulk ? bulk.note : region.composition));
    if (bulk?.densityKgM3) {
      root.append(line('Bulk density', `${formatKm(bulk.densityKgM3.value)} kg/m³ (${bulk.densityKgM3.basis})`));
      root.append(element('div', 'ii-src', bulk.densityKgM3.source));
    }
    root.append(element('div', 'ii-foot', 'No interior model is drawn for this body; the flat grey is the no-data treatment, not a material.'));
    return;
  }

  root.append(element('div', 'ii-depth', `${depthRangeText(schema, region.innerRadiusKm, drawn.referenceRadiusKm)} · ${thicknessText(schema, region.innerRadiusKm)}`));
  root.append(element('p', 'ii-text', sourcedText(schema.composition)));
  if (schema.rheology) root.append(element('p', 'ii-text ii-rheology', schema.rheology));

  const scores = claimScores(context);
  if (schema.claims.length > 0) {
    root.append(element('div', 'ii-sec', 'Evidence'));
    schema.claims.forEach((claim, claimIndex) => {
      const button = element('button', 'ii-claim');
      button.type = 'button';
      button.dataset.claim = claim.kind;
      button.setAttribute('aria-label', `${CLAIM_TITLE[claim.kind]}: ${EVIDENCE_LEVEL_LABEL[scores[claimIndex].level]}, open the evidence`);
      button.append(element('span', 'ii-claim-title', CLAIM_TITLE[claim.kind]), buildMeter(scores[claimIndex]));
      button.addEventListener('click', () => context.onEvidence(claimIndex));
      root.append(button);
    });
  }

  root.append(element('div', 'ii-sec', 'Conditions'));
  root.append(line('Temperature', quantityText(schema.temperatureK, 'K')));
  root.append(line('Pressure', quantityText(schema.pressureGPa, 'GPa')));
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

  const model = drawn.model;
  if (model) {
    if (coverage.state === 'competing') {
      const others = coverage.models.filter((candidate) => candidate.modelId !== model.modelId);
      if (others.length > 0) {
        const alt = element('div', 'ii-alt');
        alt.append(element('b', '', 'Another reading. '), document.createTextNode(coverage.distinguishedBy));
        root.append(alt);
      }
    }
    const review = model.review === 'reviewed' ? `reviewed ${model.reviewedOn}` : `provisional, ${model.reviewedOn}`;
    root.append(element('div', 'ii-foot', `${model.modelId} v${model.version} · ${review} · epoch ${model.epoch}. Colours and textures are illustrative treatments, not data.`));
  }
}
