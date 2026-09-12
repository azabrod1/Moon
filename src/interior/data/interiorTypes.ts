/**
 * The interior model schema (plan §7): what the Look-inside tool draws and
 * what it says about how we know. One non-overlapping radial partition per
 * model; anything scientifically named that overlaps the partition (the
 * lithosphere, the transition zone, D″) is an annotation, a bracket, not a
 * shell. Provenance is on values: every displayed number is a Sourced value
 * or a profile sample with a basis, so an author can always answer which
 * source supports it and whether interpolation was added. Unknown is a valid
 * state — an unresolved family, an unknown quantity, a null bulk density —
 * and renders as its no-data treatment, never as a plausible default.
 *
 * A claim stores evidence only: its level and score are computed by
 * evidenceScore(), never authored, so the number on screen is always the
 * rubric applied to the rows the reader can open.
 */

export type MaterialFamily =
  | 'metal'
  | 'silicate'
  | 'ice'
  | 'water'
  | 'hydrogen'
  | 'metallicHydrogen'
  | 'ionicFluid'
  | 'plasma'
  | 'mixed'
  | 'unresolved';

export type Phase =
  | 'solid'
  | 'partialMelt'
  | 'liquid'
  | 'supercriticalFluid'
  | 'liquidMetal'
  | 'superionic'
  | 'gas'
  | 'plasma'
  | 'unresolved';

export type EvidenceMethod =
  | 'seismology'
  | 'normalModes'
  | 'helioseismology'
  | 'neutrinos'
  | 'gravity'
  | 'momentOfInertia'
  | 'magnetic'
  | 'tides'
  | 'libration'
  | 'labHighPressure'
  | 'sample'
  | 'inSitu'
  | 'density'
  | 'model';

export type Basis = 'measured' | 'inferred' | 'modelled' | 'interpolated';

/** A value with its provenance. `basis` says what the number is, not only where it came from. */
export interface Sourced<T> {
  value: T;
  source: string;
  basis: Basis;
  note?: string;
}

/** A quantity the renderer may sample. 'unknown' renders as no-data, never as
 *  a default. The faces draw a temperature by interpolating its endpoints (or
 *  its profile, samples in ascending radius), linear or log; 'none' is for a
 *  quantity that is one number across the region and is never drawn as a ramp,
 *  so the validator refuses it on a temperature. */
export type Quantity =
  | { kind: 'endpoints'; inner: Sourced<number>; outer: Sourced<number>; interpolation: 'linear' | 'log' | 'none' }
  | {
      kind: 'profile';
      /** Ascending in radiusKm: the first sample is the deepest. */
      samples: { radiusKm: number; value: number }[];
      interpolation: 'linear' | 'log' | 'none';
      source: string;
      basis: 'measured' | 'inferred' | 'modelled';
    }
  | { kind: 'unknown' };

/** Uncertainty is typed. An anonymous min/max would flatten four different meanings. */
export type Uncertainty =
  | { kind: 'spatialRange'; note: string }
  | { kind: 'interval'; low: number; high: number; level: number; source: string }
  | { kind: 'modelSpread'; low: number; high: number; models: string[] }
  | { kind: 'qualitative'; note: string };

/** Physical structure and knowledge of it are two questions. */
export interface Boundary {
  transition: { kind: 'sharp' } | { kind: 'distributed'; widthKm: Sourced<number> } | { kind: 'unknown' };
  knowledge: { location: Uncertainty | null; width: Uncertainty | null };
}

export type EvidenceRelation = 'supports' | 'challenges' | 'constrains';

export interface Evidence {
  method: EvidenceMethod;
  relation: EvidenceRelation;
  observed: string;
  inferred: string;
  assumed: string;
  uncertain: string;
  mission?: string;
  year?: number;
  source: string;
}

export type ClaimKind = 'existence' | 'extent' | 'state' | 'composition' | 'temperature';

/** A claim stores evidence only. Its level and score are computed by evidenceScore(), never authored. */
export interface Claim {
  kind: ClaimKind;
  evidence: Evidence[];
  /** Only when published: a credible interval or probability with its proposition. */
  probability?: { value: number; proposition: string; source: string };
}

export type HeatKind =
  | 'radiogenicDecay'
  | 'primordial'
  | 'latentCrystallisation'
  | 'tidal'
  | 'gravitationalContraction'
  | 'heliumRain'
  | 'fusion'
  | 'none';

export interface HeatBudget {
  generated: { kind: HeatKind; note: string }[];
  /** What warms the region from outside, or null when nothing worth naming does. */
  received: string | null;
  transport: 'conduction' | 'convection' | 'radiation' | 'mixed' | 'unresolved';
}

/** One shell of the non-overlapping radial partition the renderer draws. */
export interface Region {
  key: string;
  name: string;
  family: MaterialFamily;
  phase: Phase;
  rheology?: string;
  /** Exact; the inner radius is the previous region's outer radius. */
  outerRadiusKm: number;
  /** This region's outer boundary. */
  boundary: Boundary;
  composition: Sourced<string>;
  temperatureK: Quantity;
  pressureGPa: Quantity;
  densityKgM3: Quantity;
  heat: HeatBudget;
  /** 'existence' is required. */
  claims: Claim[];
}

/** Named overlapping descriptions (lithosphere, transition zone, D″, tachocline): brackets, not shells. */
export interface Annotation {
  name: string;
  innerRadiusKm: number;
  outerRadiusKm: number;
  note: string;
  source: string;
}

/** The most regions a model may draw: the section shader's uniform arrays, the
 *  studio's face pairs and shells are sized to it, and the validator refuses more. */
export const MAX_REGIONS = 8;

export interface InteriorModel {
  body: string;
  modelId: string;
  /** Two to four words for the model switch: "Dilute core", "Basal molten layer". */
  title: string;
  version: string;
  /** Provisional models carry the author's date and say so; a reviewed one names its review. */
  review: 'provisional' | 'reviewed';
  reviewedOn: string;
  epoch: string;
  radiusConvention: 'volumetricMean' | 'equatorial';
  referenceRadiusKm: number;
  overview: string;
  heatFlowTW?: Sourced<number>;
  /** Inside-out; the last outerRadiusKm equals referenceRadiusKm exactly. */
  regions: Region[];
  annotations: Annotation[];
  sources: string[];
  /** A poorly constrained body's optional scenario, drawn only on request and labelled. */
  illustrative?: boolean;
}

export interface Interpretation {
  modelId: string;
  status: 'current' | 'superseded' | 'disfavoured';
  note: string;
  year?: number;
}

export type Coverage =
  | { state: 'constrained'; model: InteriorModel; history: Interpretation[] }
  | {
      state: 'competing';
      models: InteriorModel[];
      defaultModelId: string;
      /** The one sentence that says what would tell the models apart. */
      distinguishedBy: string;
      history: Interpretation[];
    }
  | {
      state: 'poorlyConstrained';
      bulk: { densityKgM3: Sourced<number> | null; note: string };
      illustrative?: InteriorModel;
      history: Interpretation[];
    }
  | {
      /** Not authored here yet, whatever the science says: the bulk line and nothing drawn. */
      state: 'notYetModelled';
      bulk: { densityKgM3: Sourced<number> | null; note: string };
      history: Interpretation[];
    };

export type CoverageState = Coverage['state'];

export interface BulkLine {
  densityKgM3: Sourced<number> | null;
  note: string;
}

/** The bulk line of an entry that carries one (nothing drawn by default), or null. */
export function coverageBulk(coverage: Coverage): BulkLine | null {
  return coverage.state === 'poorlyConstrained' || coverage.state === 'notYetModelled' ? coverage.bulk : null;
}

/** The models a coverage entry can draw, the default first. */
export function coverageModels(coverage: Coverage): InteriorModel[] {
  switch (coverage.state) {
    case 'constrained':
      return [coverage.model];
    case 'competing': {
      const models = coverage.models.slice();
      const defaultIndex = models.findIndex((model) => model.modelId === coverage.defaultModelId);
      if (defaultIndex > 0) {
        const [defaultModel] = models.splice(defaultIndex, 1);
        models.unshift(defaultModel);
      }
      return models;
    }
    case 'poorlyConstrained':
      return coverage.illustrative ? [coverage.illustrative] : [];
    case 'notYetModelled':
      return [];
  }
}

/** A representative temperature for a region, K, or null when unknown: the
 *  mean of its endpoints, or the mean of its profile samples. */
export function representativeTemperatureK(quantity: Quantity): number | null {
  if (quantity.kind === 'endpoints') return (quantity.inner.value + quantity.outer.value) / 2;
  if (quantity.kind === 'profile' && quantity.samples.length > 0) {
    return quantity.samples.reduce((sum, sample) => sum + sample.value, 0) / quantity.samples.length;
  }
  return null;
}
