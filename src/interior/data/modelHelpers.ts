/**
 * Small constructors for authoring interior models, so a model file reads
 * as its content rather than as braces. Nothing here decides anything: the
 * schema is interiorTypes.ts and the rules are validate.ts.
 */
import type {
  Basis,
  Boundary,
  Claim,
  ClaimKind,
  Evidence,
  EvidenceMethod,
  EvidenceRelation,
  HeatBudget,
  HeatKind,
  Quantity,
  Sourced,
  Uncertainty,
} from './interiorTypes';

export function sourced<T>(value: T, source: string, basis: Basis, note?: string): Sourced<T> {
  return note ? { value, source, basis, note } : { value, source, basis };
}

/** A quantity from its value at the region's inner and outer boundaries. */
export function endpoints(
  innerValue: number,
  outerValue: number,
  source: string,
  basis: Basis,
  interpolation: 'linear' | 'log' | 'none' = 'linear',
): Quantity {
  return { kind: 'endpoints', inner: sourced(innerValue, source, basis), outer: sourced(outerValue, source, basis), interpolation };
}

export const UNKNOWN: Quantity = { kind: 'unknown' };

export function sharp(location: Uncertainty | null = null): Boundary {
  return { transition: { kind: 'sharp' }, knowledge: { location, width: null } };
}

export function distributed(widthKm: number, source: string, location: Uncertainty | null = null, width: Uncertainty | null = null): Boundary {
  return { transition: { kind: 'distributed', widthKm: sourced(widthKm, source, 'inferred') }, knowledge: { location, width } };
}

export function unknownBoundary(note: string): Boundary {
  return { transition: { kind: 'unknown' }, knowledge: { location: { kind: 'qualitative', note }, width: null } };
}

export function interval(low: number, high: number, level: number, source: string): Uncertainty {
  return { kind: 'interval', low, high, level, source };
}

export function modelSpread(low: number, high: number, models: string[]): Uncertainty {
  return { kind: 'modelSpread', low, high, models };
}

export function qualitative(note: string): Uncertainty {
  return { kind: 'qualitative', note };
}

export interface RowText {
  observed: string;
  inferred: string;
  assumed: string;
  uncertain: string;
  mission?: string;
  year?: number;
}

export function row(method: EvidenceMethod, relation: EvidenceRelation, source: string, text: RowText): Evidence {
  return { method, relation, source, ...text };
}

export function claim(kind: ClaimKind, evidence: Evidence[], probability?: Claim['probability']): Claim {
  return probability ? { kind, evidence, probability } : { kind, evidence };
}

export function heat(
  generated: { kind: HeatKind; note: string }[],
  received: string | null,
  transport: HeatBudget['transport'],
): HeatBudget {
  return { generated, received, transport };
}
