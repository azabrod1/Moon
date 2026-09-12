/**
 * Validation of interior models and coverage entries (plan §7), pinned by
 * tests over every shipped model: radii strictly increasing and the last
 * equal to the reference radius; no more regions than the studio draws
 * (MAX_REGIONS) and no two with one key; every region carries an existence
 * claim with at least one evidence row and every row a source; probabilities
 * only with a proposition and a source, and a value in [0, 1]; a boundary's
 * interval or model spread brackets the radius it is drawn at, an interval's
 * level in (0, 1]; temperatures never decrease inward where known, are never
 * interpolated 'none' (the faces draw a ramp), and profile samples ascend in
 * radius; annotations lie within the body; competing models share one
 * reference radius; only a poorly constrained body's scenario is labelled
 * illustrative, and it is labelled in its own data; a body drawn as an
 * unresolved whole says why. A problem is a sentence an author can act on,
 * not a boolean.
 */
import type { Coverage, InteriorModel, Quantity, Region } from './interiorTypes';
import { MAX_REGIONS, coverageModels } from './interiorTypes';

export function validateInteriorModel(model: InteriorModel): string[] {
  const problems: string[] = [];
  const where = `${model.body}/${model.modelId}`;
  if (model.regions.length === 0) {
    problems.push(`${where}: no regions`);
    return problems;
  }
  if (model.regions.length > MAX_REGIONS) {
    problems.push(`${where}: ${model.regions.length} regions, but the studio draws at most ${MAX_REGIONS}`);
  }
  let previousOuter = 0;
  const keys = new Set<string>();
  for (const region of model.regions) {
    if (keys.has(region.key)) problems.push(`${where}/${region.key}: another region already has this key`);
    keys.add(region.key);
    if (!(region.outerRadiusKm > previousOuter)) {
      problems.push(`${where}/${region.key}: outer radius ${region.outerRadiusKm} km is not greater than the previous ${previousOuter} km`);
    }
    previousOuter = region.outerRadiusKm;
    problems.push(...validateRegion(region, where));
  }
  const last = model.regions[model.regions.length - 1];
  if (last.outerRadiusKm !== model.referenceRadiusKm) {
    problems.push(`${where}: the last region's outer radius ${last.outerRadiusKm} km must equal the reference radius ${model.referenceRadiusKm} km exactly`);
  }
  for (let index = 1; index < model.regions.length; index++) {
    // Deeper (index − 1) must be at least as hot at its top as the shallower region at its bottom.
    const deeper = model.regions[index - 1];
    const shallower = model.regions[index];
    const deeperTop = endpointValue(deeper.temperatureK, 'outer');
    const shallowerBottom = endpointValue(shallower.temperatureK, 'inner');
    if (deeperTop !== null && shallowerBottom !== null && deeperTop < shallowerBottom) {
      problems.push(`${where}: temperature decreases inward across ${shallower.key} → ${deeper.key} (${shallowerBottom} K → ${deeperTop} K)`);
    }
  }
  for (const annotation of model.annotations) {
    if (!(annotation.innerRadiusKm >= 0 && annotation.innerRadiusKm < annotation.outerRadiusKm && annotation.outerRadiusKm <= model.referenceRadiusKm)) {
      problems.push(`${where}: annotation "${annotation.name}" (${annotation.innerRadiusKm}–${annotation.outerRadiusKm} km) does not lie within the body`);
    }
    if (!annotation.source) problems.push(`${where}: annotation "${annotation.name}" has no source`);
  }
  if (model.sources.length === 0) problems.push(`${where}: no sources listed`);
  if (!model.title.trim()) problems.push(`${where}: no title for the model switch`);
  if (model.review === 'reviewed' && !model.reviewedOn) problems.push(`${where}: reviewed but reviewedOn is empty`);
  return problems;
}

function validateRegion(region: Region, where: string): string[] {
  const problems: string[] = [];
  const here = `${where}/${region.key}`;
  const existence = region.claims.find((claim) => claim.kind === 'existence');
  if (!existence) problems.push(`${here}: no existence claim`);
  else if (existence.evidence.length === 0) problems.push(`${here}: the existence claim has no evidence rows`);
  for (const claim of region.claims) {
    for (const row of claim.evidence) {
      if (!row.source) problems.push(`${here}: a ${claim.kind} evidence row (${row.method}) has no source`);
    }
    if (claim.probability) {
      if (!claim.probability.proposition || !claim.probability.source) {
        problems.push(`${here}: a ${claim.kind} probability needs a proposition and a source`);
      }
      if (!(claim.probability.value >= 0 && claim.probability.value <= 1)) {
        problems.push(`${here}: a ${claim.kind} probability of ${claim.probability.value} is not between 0 and 1`);
      }
    }
  }
  if (!region.composition.source) problems.push(`${here}: composition has no source`);
  const location = region.boundary.knowledge.location;
  if (location && (location.kind === 'interval' || location.kind === 'modelSpread')) {
    if (!(location.low <= region.outerRadiusKm && region.outerRadiusKm <= location.high)) {
      problems.push(`${here}: the boundary's ${location.kind} ${location.low}–${location.high} km does not bracket the outer radius ${region.outerRadiusKm} km it is drawn at`);
    }
    if (location.kind === 'interval' && !(location.level > 0 && location.level <= 1)) {
      problems.push(`${here}: the boundary interval's level ${location.level} is not a confidence in (0, 1]`);
    }
  }
  if (region.temperatureK.kind === 'endpoints' && region.temperatureK.inner.value < region.temperatureK.outer.value) {
    problems.push(`${here}: temperature decreases inward within the region`);
  }
  if (region.temperatureK.kind !== 'unknown' && region.temperatureK.interpolation === 'none') {
    problems.push(`${here}: a temperature cannot be interpolated 'none'; the faces draw it as a linear or log ramp`);
  }
  for (const [name, quantity] of [['temperature', region.temperatureK], ['pressure', region.pressureGPa], ['density', region.densityKgM3]] as const) {
    if (quantity.kind !== 'profile') continue;
    for (let index = 1; index < quantity.samples.length; index++) {
      if (!(quantity.samples[index].radiusKm > quantity.samples[index - 1].radiusKm)) {
        problems.push(`${here}: the ${name} profile's samples are not in ascending radius at sample ${index}`);
        break;
      }
    }
  }
  for (const generated of region.heat.generated) {
    if (!generated.note) problems.push(`${here}: heat source ${generated.kind} has no note`);
  }
  return problems;
}

function endpointValue(quantity: Quantity, end: 'inner' | 'outer'): number | null {
  if (quantity.kind === 'endpoints') return quantity[end].value;
  if (quantity.kind === 'profile' && quantity.samples.length > 0) {
    const samples = quantity.samples;
    return end === 'inner' ? samples[0].value : samples[samples.length - 1].value;
  }
  return null;
}

export function validateCoverage(bodyId: string, coverage: Coverage): string[] {
  const problems: string[] = [];
  const models = coverageModels(coverage);
  for (const model of models) {
    if (model.body !== bodyId) problems.push(`${bodyId}: model ${model.modelId} is for ${model.body}`);
    problems.push(...validateInteriorModel(model));
  }
  if (coverage.state === 'constrained' || coverage.state === 'competing') {
    for (const model of models) {
      if (model.illustrative) {
        problems.push(`${bodyId}: model ${model.modelId} is labelled illustrative, but a ${coverage.state} entry draws measured models only`);
      }
    }
  }
  if (coverage.state === 'competing') {
    if (coverage.models.length < 2) problems.push(`${bodyId}: a competing entry needs at least two models`);
    if (!coverage.models.some((model) => model.modelId === coverage.defaultModelId)) {
      problems.push(`${bodyId}: default model ${coverage.defaultModelId} is not one of the competing models`);
    }
    if (!coverage.distinguishedBy) problems.push(`${bodyId}: a competing entry must say what distinguishes its models`);
    const references = new Set(coverage.models.map((model) => model.referenceRadiusKm));
    if (references.size > 1) problems.push(`${bodyId}: competing models disagree on the reference radius`);
  }
  if (coverage.state === 'notYetModelled' && !coverage.bulk.note) {
    problems.push(`${bodyId}: a not-yet-modelled entry needs a note`);
  }
  if (coverage.state === 'poorlyConstrained') {
    if (!coverage.bulk.note) problems.push(`${bodyId}: a poorly constrained entry needs a note`);
    if (coverage.illustrative && !coverage.illustrative.illustrative) {
      problems.push(`${bodyId}: the illustrative model must be labelled illustrative in its own data`);
    }
  }
  for (const entry of coverage.history) {
    if (!entry.note) problems.push(`${bodyId}: interpretation ${entry.modelId} has no note`);
  }
  return problems;
}
