/**
 * The pages of the Look-inside panel: what a pin opens and where it leads.
 * One host holds one page at a time, on both breakpoints — the bottom sheet
 * on a phone, the side panel on a desktop — and the layer list is the page
 * they all come back to.
 *
 *   summary   the compact card a pin opens: the region's name, its material
 *             and phase, the standing its evidence gives it (in words, from
 *             the KIND of evidence — evidenceSummary — never from points), one
 *             line of composition, depth and temperature, and two doors
 *   details   every property with its basis word, the boundary above it, the
 *             heat budget, the structures named over it
 *   evidence  every claim's rows grouped under the property they explain
 *             (evidenceView): what was observed, what it is read to mean, what
 *             it assumes and leaves open, and the sources — only the parts a
 *             row actually has
 *   model     what is drawn and how far to trust it: the model's title, its
 *             editorial status (reviewed, or this app's own reading awaiting
 *             one), the radius convention, competing pictures, and the
 *             earlier ones
 *
 * The hover card is here too: the desktop's preview beside the pointer.
 *
 * Every number goes through inspectorText in the reader's unit, so the words
 * are the ones the tests pin. A region drawn as an unresolved whole has no
 * schema behind it: its summary says so, and its only door is the model page.
 */
import type { ClaimKind, Coverage } from '../data/interiorTypes';
import { coverageBulk, coverageModels } from '../data/interiorTypes';
import { FAMILY_LABEL, PHASE_LABEL } from '../data/artParams';
import type { DrawnModel, DrawnRegion } from '../drawnModel';
import { STANDING_READS_AS, regionEvidenceSummary, type EvidenceSummary } from '../evidenceSummary';
import { modelStatusText, radiusLineText } from '../interiorLogic';
import { element } from './dom';
import { evidenceGroups } from './evidenceView';
import {
  BOUNDARY_ABOVE, DENSITY, DEPTH_BELOW_SURFACE, DETAILS, EARLIER_MODELS, EVIDENCE_AND_SOURCES, HEAT_SOURCES,
  INTERPRETATION, LAYERS, LIMITATIONS, MODEL_AND_SOURCES, OBSERVATION, PRESSURE, PROPERTIES, RELATED_STRUCTURES,
  SOURCES, TEMPERATURE, TEXTURES_NOTE, THICKNESS,
} from './interiorCopy';
import {
  NOT_KNOWN,
  boundaryText,
  depthBelowSurfaceText,
  formatKm,
  heatText,
  pressureQuantityText,
  quantityText,
  sourcedText,
  temperatureQuantityText,
  temperatureRangeText,
  thicknessText,
  type TemperatureUnit,
} from './inspectorText';

export type InteriorPanelPage =
  | { kind: 'layers' }
  | { kind: 'summary'; regionKey: string }
  | { kind: 'details'; regionKey: string }
  | { kind: 'evidence'; regionKey: string; claimKind: ClaimKind | null }
  | { kind: 'model' };

export interface PageContext {
  drawn: DrawnModel;
  coverage: Coverage;
  unit: TemperatureUnit;
  /** Inside-out index of the region a region page is about; ignored by the model page. */
  index: number;
  onLayers: () => void;
  onSummary: () => void;
  onDetails: () => void;
  onEvidence: (claimKind: ClaimKind | null) => void;
  onModel: () => void;
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

/** Render one page into the host. Returns the element a caller may want to bring into view (an asked-for evidence group), or null. */
export function renderPage(root: HTMLElement, page: InteriorPanelPage, context: PageContext): HTMLElement | null {
  root.replaceChildren();
  root.dataset.page = page.kind;
  switch (page.kind) {
    case 'layers': return null;
    case 'summary': renderSummary(root, context); return null;
    case 'details': renderDetails(root, context); return null;
    case 'evidence': return renderEvidence(root, context, page.claimKind);
    case 'model': renderModel(root, context); return null;
  }
}

// ---- pieces ---------------------------------------------------------------

function navRow(backLabel: string, onBack: () => void, title?: string): HTMLElement {
  const nav = element('div', 'ii-nav');
  const back = element('button', 'ii-back', `‹ ${backLabel}`);
  back.type = 'button';
  back.addEventListener('click', onBack);
  nav.append(back);
  if (title) nav.append(element('div', 'ii-page-title', title));
  return nav;
}

function actionButton(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const button = element('button', `interior-view ii-action${primary ? ' on' : ''}`, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function propertyLine(label: string, value: string): HTMLElement {
  const row = element('div', 'ii-line');
  row.append(element('span', 'ii-key', label), element('span', 'ii-val', value));
  return row;
}

function fact(label: string, value: string): HTMLElement {
  const block = element('div', 'ii-fact');
  block.append(element('div', 'ii-fact-key', label), element('div', 'ii-fact-val', value));
  return block;
}

function standingLine(summary: EvidenceSummary): HTMLElement {
  const line = element('div', `ii-standing ii-standing-${summary.standing}`, summary.phrase);
  line.title = STANDING_READS_AS[summary.standing];
  return line;
}

function regionHead(region: DrawnRegion, standing: EvidenceSummary | null): HTMLElement {
  const head = element('div', 'ii-head');
  head.append(element('div', 'ii-name', region.name), element('div', 'ii-kicker', familyPhaseText(region)));
  if (standing) head.append(standingLine(standing));
  return head;
}

const PAST_STATUS_WORD: Readonly<Record<'current' | 'superseded' | 'disfavoured', string>> = {
  current: 'also current',
  superseded: 'superseded',
  disfavoured: 'disfavoured',
};

// ---- the summary ------------------------------------------------------------

function renderSummary(root: HTMLElement, context: PageContext): void {
  const { drawn, unit } = context;
  const region = drawn.regionsInsideOut[context.index];
  if (!region) return;
  root.append(navRow(LAYERS, context.onLayers));
  const schema = region.region;
  if (!schema) {
    // The unresolved whole: what the density says is all there is to say here.
    root.append(regionHead(region, null));
    root.append(element('p', 'ii-text', region.composition));
    const facts = element('div', 'ii-facts');
    facts.append(fact('Radius', `${formatKm(drawn.referenceRadiusKm)} km`));
    const bulk = coverageBulk(context.coverage);
    if (bulk?.densityKgM3) facts.append(fact('Bulk density', `${formatKm(bulk.densityKgM3.value)} kg/m³`));
    root.append(facts);
    root.append(element('div', 'ii-foot', 'No interior model is drawn for this body; the grey hatch means not known, not a material.'));
    const actions = element('div', 'ii-actions');
    actions.append(actionButton(MODEL_AND_SOURCES, context.onModel));
    root.append(actions);
    return;
  }
  root.append(regionHead(region, regionEvidenceSummary(schema)));
  root.append(element('p', 'ii-text', schema.composition.value));
  const facts = element('div', 'ii-facts');
  facts.append(fact(DEPTH_BELOW_SURFACE, depthBelowSurfaceText(schema, region.innerRadiusKm, drawn.referenceRadiusKm)));
  facts.append(fact(TEMPERATURE, temperatureRangeText(schema.temperatureK, unit) || NOT_KNOWN));
  root.append(facts);
  const actions = element('div', 'ii-actions');
  actions.append(actionButton(DETAILS, context.onDetails), actionButton(EVIDENCE_AND_SOURCES, () => context.onEvidence(null)));
  root.append(actions);
}

// ---- the details ------------------------------------------------------------

function renderDetails(root: HTMLElement, context: PageContext): void {
  const { drawn, unit } = context;
  const region = drawn.regionsInsideOut[context.index];
  const schema = region?.region;
  if (!region || !schema) return;
  root.append(navRow(region.name, context.onSummary, DETAILS));
  root.append(regionHead(region, null));
  root.append(element('p', 'ii-text', sourcedText(schema.composition)));
  if (schema.rheology) root.append(element('p', 'ii-text ii-rheology', schema.rheology));

  root.append(element('div', 'ii-sec', PROPERTIES));
  root.append(propertyLine(DEPTH_BELOW_SURFACE, depthBelowSurfaceText(schema, region.innerRadiusKm, drawn.referenceRadiusKm)));
  root.append(propertyLine(THICKNESS, thicknessText(schema, region.innerRadiusKm)));
  root.append(propertyLine(TEMPERATURE, temperatureQuantityText(schema.temperatureK, unit)));
  root.append(propertyLine(PRESSURE, pressureQuantityText(schema.pressureGPa)));
  root.append(propertyLine(DENSITY, quantityText(schema.densityKgM3, 'kg/m³')));
  // The outermost region's outer boundary is the surface itself: nothing to say about it here.
  const outermost = context.index === drawn.regionsInsideOut.length - 1;
  if (!outermost) root.append(propertyLine(BOUNDARY_ABOVE, boundaryText(schema)));

  root.append(element('div', 'ii-sec', HEAT_SOURCES));
  root.append(element('p', 'ii-text', heatText(schema.heat)));
  for (const generated of schema.heat.generated) {
    if (generated.note) root.append(element('div', 'ii-note', generated.note));
  }

  const model = drawn.model;
  const notes = model
    ? model.annotations.filter((note) => note.innerRadiusKm < region.outerRadiusKm && note.outerRadiusKm > region.innerRadiusKm)
    : [];
  if (notes.length > 0) {
    root.append(element('div', 'ii-sec', RELATED_STRUCTURES));
    for (const note of notes) {
      const row = element('div', 'ii-annotation');
      row.append(element('b', '', note.name), document.createTextNode(` ${note.note}`));
      root.append(row);
    }
  }

  const actions = element('div', 'ii-actions');
  actions.append(actionButton(EVIDENCE_AND_SOURCES, () => context.onEvidence(null)), actionButton(MODEL_AND_SOURCES, context.onModel));
  root.append(actions);
}

// ---- the evidence -----------------------------------------------------------

function renderEvidence(root: HTMLElement, context: PageContext, askedKind: ClaimKind | null): HTMLElement | null {
  const region = context.drawn.regionsInsideOut[context.index];
  const schema = region?.region;
  if (!region || !schema) return null;
  root.append(navRow(region.name, context.onSummary, EVIDENCE_AND_SOURCES));
  root.append(regionHead(region, null));
  let asked: HTMLElement | null = null;
  for (const group of evidenceGroups(schema)) {
    const block = element('section', 'ev-group');
    block.dataset.claim = group.kind;
    const head = element('div', 'ev-group-head');
    head.append(element('div', 'ev-group-title', group.title), standingLine(group.summary));
    block.append(head);
    if (group.probability) block.append(element('div', 'ev-prob', group.probability));
    for (const entry of group.entries) {
      const row = element('div', `ev-row ev-${entry.relation}`);
      const rowHead = element('div', 'ev-row-head');
      rowHead.append(element('b', '', entry.method), element('span', `ev-tag ev-tag-${entry.relation}`, entry.relationWord));
      if (entry.provenance) rowHead.append(element('span', 'ev-prov', entry.provenance));
      row.append(rowHead);
      const parts: [string, string][] = [
        [OBSERVATION, entry.observation],
        [INTERPRETATION, entry.interpretation],
        [LIMITATIONS, entry.limitations],
        [SOURCES, entry.source],
      ];
      for (const [label, text] of parts) {
        if (!text) continue;
        const part = element('div', 'ev-part');
        part.append(element('div', 'ev-part-key', label), element('div', 'ev-part-val', text));
        row.append(part);
      }
      block.append(row);
    }
    if (group.kind === askedKind) {
      block.classList.add('asked');
      asked = block;
    }
    root.append(block);
  }
  return asked;
}

// ---- the model --------------------------------------------------------------

function renderModel(root: HTMLElement, context: PageContext): void {
  const { drawn, coverage } = context;
  root.append(navRow(LAYERS, context.onLayers, MODEL_AND_SOURCES));
  const model = drawn.model;
  const head = element('div', 'ii-head');
  head.append(element('div', 'ii-name', model ? model.title : modelStatusText(coverage, drawn)));
  root.append(head);
  root.append(element('p', 'ii-text', modelStatusText(coverage, drawn)));
  root.append(propertyLine('Radius', radiusLineText(drawn).replace(/^Radius /, '')));
  if (coverage.state === 'competing') {
    root.append(element('div', 'ii-sec', `${coverageModels(coverage).length} models fit the data`));
    root.append(element('p', 'ii-text', coverage.distinguishedBy));
  }
  const bulk = model === null ? coverageBulk(coverage) : null;
  if (bulk) {
    root.append(element('div', 'ii-sec', 'Bulk'));
    root.append(element('p', 'ii-text', bulk.note));
    if (bulk.densityKgM3) root.append(element('div', 'ii-src', bulk.densityKgM3.source));
  }
  const past = coverage.history.filter((entry) => entry.status !== 'current' || entry.modelId !== drawn.modelId);
  if (past.length > 0) {
    root.append(element('div', 'ii-sec', EARLIER_MODELS));
    for (const entry of past) {
      const row = element('div', 'ii-annotation');
      row.append(element('b', '', `${entry.year} · ${PAST_STATUS_WORD[entry.status]}`), document.createTextNode(` ${entry.note}`));
      root.append(row);
    }
  }
  root.append(element('div', 'ii-foot', TEXTURES_NOTE));
}
