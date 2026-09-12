/**
 * The words the inspector and the popover put beside the data (plan §8):
 * pure formatters from schema values to strings, so what a reader sees can
 * be pinned by a test and every number keeps its basis. A quantity reads
 * as its range with the basis word; unknown reads as "not known", never as
 * a number.
 */
import type { Basis, HeatBudget, HeatKind, Quantity, Region, Sourced, Uncertainty } from '../data/interiorTypes';
import type { EvidenceRelation } from '../data/interiorTypes';

export const BASIS_WORD: Readonly<Record<Basis, string>> = {
  measured: 'measured',
  inferred: 'inferred',
  modelled: 'modelled',
  interpolated: 'interpolated',
};

export const RELATION_WORD: Readonly<Record<EvidenceRelation, string>> = {
  supports: 'supports',
  challenges: 'challenges',
  constrains: 'constrains',
};

export const HEAT_KIND_WORD: Readonly<Record<HeatKind, string>> = {
  radiogenicDecay: 'radioactive decay',
  primordial: 'heat of formation',
  latentCrystallisation: 'latent heat of freezing',
  tidal: 'tidal flexing',
  gravitationalContraction: 'gravitational contraction',
  heliumRain: 'helium rain',
  fusion: 'fusion',
  none: 'none of its own',
};

export const TRANSPORT_WORD: Readonly<Record<HeatBudget['transport'], string>> = {
  conduction: 'by conduction',
  convection: 'by convection',
  radiation: 'by radiation',
  mixed: 'by conduction and convection',
  unresolved: 'unresolved',
};

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const DECIMAL = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** A number for the panel: whole above 10, up to two decimals below. */
export function formatNumber(value: number): string {
  return Math.abs(value) >= 10 ? NUMBER.format(value) : DECIMAL.format(value);
}

export function formatKm(km: number): string {
  return formatNumber(km);
}

/**
 * A quantity as text: "inner–outer unit (basis)" for endpoints, the range
 * of the samples for a profile, and the no-data phrase for unknown. The
 * inner value is listed first because the inspector reads deep to shallow
 * within a region as the legend reads the body outside-in.
 */
export function quantityText(quantity: Quantity, unit: string, noData = 'not known'): string {
  if (quantity.kind === 'unknown') return noData;
  if (quantity.kind === 'endpoints') {
    const inner = quantity.inner.value;
    const outer = quantity.outer.value;
    const basis = quantity.inner.basis === quantity.outer.basis
      ? BASIS_WORD[quantity.inner.basis]
      : `${BASIS_WORD[quantity.outer.basis]} to ${BASIS_WORD[quantity.inner.basis]}`;
    const range = inner === outer ? formatNumber(inner) : `${formatNumber(outer)}–${formatNumber(inner)}`;
    return `${range} ${unit} (${basis})`;
  }
  if (quantity.samples.length === 0) return noData;
  let low = Infinity;
  let high = -Infinity;
  for (const sample of quantity.samples) {
    low = Math.min(low, sample.value);
    high = Math.max(high, sample.value);
  }
  const range = low === high ? formatNumber(low) : `${formatNumber(low)}–${formatNumber(high)}`;
  return `${range} ${unit} (${BASIS_WORD[quantity.basis]}, ${quantity.samples.length} samples)`;
}

export function sourcedText(sourced: Sourced<string>): string {
  return sourced.note ? `${sourced.value}. ${sourced.note}` : sourced.value;
}

/** A region's span as depths below the surface, "top–bottom km". */
export function depthRangeText(region: Region, innerRadiusKm: number, referenceRadiusKm: number): string {
  const top = referenceRadiusKm - region.outerRadiusKm;
  const bottom = referenceRadiusKm - innerRadiusKm;
  return `${formatKm(top)}–${formatKm(bottom)} km down`;
}

/** The thickness of a region, km. */
export function thicknessText(region: Region, innerRadiusKm: number): string {
  return `${formatKm(region.outerRadiusKm - innerRadiusKm)} km thick`;
}

/** An uncertainty record as one line. */
export function uncertaintyText(uncertainty: Uncertainty | null): string | null {
  if (!uncertainty) return null;
  switch (uncertainty.kind) {
    case 'interval':
      return `${formatKm(uncertainty.low)}–${formatKm(uncertainty.high)} km at ${Math.round(uncertainty.level * 100)}% confidence`;
    case 'modelSpread':
      return `${formatKm(uncertainty.low)}–${formatKm(uncertainty.high)} km across models (${uncertainty.models.join(', ')})`;
    case 'spatialRange':
    case 'qualitative':
      return uncertainty.note;
  }
}

/** The outer boundary in words: how sharp it is and how well it is placed. */
export function boundaryText(region: Region): string {
  const transition = region.boundary.transition;
  const physical = transition.kind === 'sharp'
    ? 'A sharp boundary'
    : transition.kind === 'distributed'
      ? `A gradual change over about ${formatKm(transition.widthKm.value)} km`
      : 'Whether the boundary is sharp or gradual is not known';
  const location = uncertaintyText(region.boundary.knowledge.location);
  return location ? `${physical}; placed at ${location}.` : `${physical}.`;
}

/** The heat budget as a sentence or two. `received` is authored as the phrase
 *  that follows "warmed by", so it is printed as written: a proper noun keeps its capital. */
export function heatText(heat: HeatBudget): string {
  const generated = heat.generated.map((entry) => HEAT_KIND_WORD[entry.kind]);
  const sources = generated.length === 0 ? 'No heat of its own' : `Heat from ${generated.join(', ')}`;
  const received = heat.received ? `; warmed by ${heat.received}` : '';
  const moved = heat.transport === 'unresolved' ? 'how it moves is unresolved' : `moved ${TRANSPORT_WORD[heat.transport]}`;
  return `${sources}${received}; ${moved}.`;
}

/** "Mission, year", "year" or "" for an evidence row's provenance line. */
export function provenanceText(mission: string | undefined, year: number | undefined): string {
  if (mission && year) return `${mission}, ${year}`;
  if (mission) return mission;
  if (year) return String(year);
  return '';
}
