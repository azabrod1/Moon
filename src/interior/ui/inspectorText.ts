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
  primordial: 'heat left over from its formation',
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

const ONE_DECIMAL = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** A distance in km: whole above 10, one decimal below, and a clean 0 at the surface. */
export function formatKm(km: number): string {
  if (Math.abs(km) < 0.05) return '0';
  return Math.abs(km) >= 10 ? NUMBER.format(km) : ONE_DECIMAL.format(km);
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

/** An uncertainty record as one line: a place for an interval or a spread, the note itself otherwise. */
export function uncertaintyText(uncertainty: Uncertainty | null): string | null {
  if (!uncertainty) return null;
  switch (uncertainty.kind) {
    case 'interval':
      return `${formatKm(uncertainty.low)}–${formatKm(uncertainty.high)} km from the centre, at ${Math.round(uncertainty.level * 100)}% confidence`;
    case 'modelSpread':
      return `${formatKm(uncertainty.low)}–${formatKm(uncertainty.high)} km from the centre across models (${uncertainty.models.join(', ')})`;
    case 'spatialRange':
    case 'qualitative':
      return uncertainty.note;
  }
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The outer boundary in words: how sharp it is and how well it is placed. A placed
 *  boundary reads "placed N–M km from the centre"; a note about it is its own sentence. */
export function boundaryText(region: Region): string {
  const transition = region.boundary.transition;
  const physical = transition.kind === 'sharp'
    ? 'A sharp boundary'
    : transition.kind === 'distributed'
      ? `A gradual change over about ${formatKm(transition.widthKm.value)} km`
      : 'Whether the boundary is sharp or gradual is not known';
  const location = region.boundary.knowledge.location;
  if (!location) return `${physical}.`;
  const words = uncertaintyText(location)!;
  if (location.kind === 'interval' || location.kind === 'modelSpread') return `${physical}; placed ${words}.`;
  return `${physical}. ${sentence(words)}`;
}

const KELVIN_ZERO_C = -273.15;

/** A quantity's low and high with its basis words, or null when unknown. */
function quantityBounds(quantity: Quantity): { low: number; high: number; basis: string; samples: number } | null {
  if (quantity.kind === 'unknown') return null;
  if (quantity.kind === 'endpoints') {
    const basis = quantity.inner.basis === quantity.outer.basis
      ? BASIS_WORD[quantity.inner.basis]
      : `${BASIS_WORD[quantity.outer.basis]} to ${BASIS_WORD[quantity.inner.basis]}`;
    return { low: Math.min(quantity.inner.value, quantity.outer.value), high: Math.max(quantity.inner.value, quantity.outer.value), basis, samples: 0 };
  }
  if (quantity.samples.length === 0) return null;
  let low = Infinity;
  let high = -Infinity;
  for (const sample of quantity.samples) {
    low = Math.min(low, sample.value);
    high = Math.max(high, sample.value);
  }
  return { low, high, basis: BASIS_WORD[quantity.basis], samples: quantity.samples.length };
}

function rangeText(low: number, high: number, format: (value: number) => string = formatNumber): string {
  return low === high ? format(low) : `${format(low)}–${format(high)}`;
}

/** A temperature with its celsius beside it: "1,900–3,700 K · 1,600–3,400 °C (inferred)". */
export function temperatureQuantityText(quantity: Quantity, noData = 'not known'): string {
  const bounds = quantityBounds(quantity);
  if (!bounds) return noData;
  const basis = bounds.samples > 0 ? `${bounds.basis}, ${bounds.samples} samples` : bounds.basis;
  return `${rangeText(bounds.low, bounds.high)} K · ${rangeText(bounds.low + KELVIN_ZERO_C, bounds.high + KELVIN_ZERO_C)} °C (${basis})`;
}

/** "1.3 million" or "240,000": a count of atmospheres a reader can hold. */
export function atmospheresText(atmospheres: number): string {
  if (atmospheres >= 1e6) return `${DECIMAL.format(Math.round(atmospheres / 1e5) / 10)} million`;
  return NUMBER.format(atmospheres);
}

const ATMOSPHERES_PER_GPA = 9869;

/** A pressure in gigapascals with a gloss in atmospheres: "24–136 GPa (inferred); about 240,000–1.3 million atmospheres". */
export function pressureQuantityText(quantity: Quantity, noData = 'not known'): string {
  const bounds = quantityBounds(quantity);
  if (!bounds) return noData;
  const basis = bounds.samples > 0 ? `${bounds.basis}, ${bounds.samples} samples` : bounds.basis;
  const gloss = rangeText(bounds.low * ATMOSPHERES_PER_GPA, bounds.high * ATMOSPHERES_PER_GPA, atmospheresText);
  return `${rangeText(bounds.low, bounds.high)} GPa (${basis}); about ${gloss} atmospheres`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An ISO date as "11 Sep 2026"; anything else is printed as it came. */
export function reviewDateText(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : isoDate;
}

/** The heat budget as a sentence or two. `received` is authored as the phrase
 *  that follows "warmed by", so it is printed as written: a proper noun keeps its capital. */
export function heatText(heat: HeatBudget): string {
  const generated = heat.generated.filter((entry) => entry.kind !== 'none').map((entry) => HEAT_KIND_WORD[entry.kind]);
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
