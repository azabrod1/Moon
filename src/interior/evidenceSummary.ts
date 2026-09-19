/**
 * What a claim rests on, in one phrase (plan §8). The KIND of evidence
 * decides the words and nothing is scored: a reader who asks how we know is
 * answered with the method that knows — "Observed by seismology", "Inferred
 * from the gravity field", "Contested by the magnetic field" — rather than
 * with a number no source publishes. Seismic waves crossing Earth's outer
 * core and an induced field over Callisto's ocean are different kinds of
 * knowing, and that difference is the whole message; a points total
 * flattened the two onto one axis and then had to explain the arithmetic
 * that flattened them.
 *
 * The precedence below is the order the standings are read in. A published
 * challenge comes first, because a contested claim is contested however well
 * supported it otherwise is, and a reader should meet the argument before
 * the agreement. Then a method that reaches the region itself, then one that
 * reads it from outside the body, then the laboratory, the bulk density and
 * a bare model — each a step further from the region. A claim with no
 * supporting row at all, whether it carries rows that only narrow it or none
 * at all, is a hypothesis. Rows tagged 'constrains' never decide a standing:
 * narrowing a claim is not supporting it.
 *
 * Pure: no DOM, no three. The phrases are product copy, so they are pinned
 * in evidenceSummary.test.ts, including three readings off shipped models.
 */
import type { Claim, Evidence, EvidenceMethod, Region } from './data/interiorTypes';

export type EvidenceStanding = 'observed' | 'inferred' | 'laboratory' | 'density' | 'model' | 'contested' | 'hypothesis';

export interface EvidenceSummary {
  standing: EvidenceStanding;
  /** The phrase a legend row or a group heading shows, e.g. "Observed by seismology". */
  phrase: string;
  /** The methods that decided the phrase, at most two, in the order named in the phrase. */
  methods: EvidenceMethod[];
}

/** The method in the reader's words, for the phrases and the group headings. */
export function methodLabel(method: EvidenceMethod): string {
  switch (method) {
    case 'seismology': return 'seismology';
    case 'ringSeismology': return 'ring seismology';
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

/** Methods that reach the region itself: the measurement is taken of it or inside it. */
const DIRECT_METHOD_LIST = ['seismology', 'ringSeismology', 'helioseismology', 'sample', 'inSitu', 'neutrinos'] as const satisfies readonly EvidenceMethod[];
type DirectMethod = (typeof DIRECT_METHOD_LIST)[number];
const DIRECT_METHODS: ReadonlySet<EvidenceMethod> = new Set<EvidenceMethod>(DIRECT_METHOD_LIST);

function isDirectMethod(method: EvidenceMethod): method is DirectMethod {
  return DIRECT_METHODS.has(method);
}

/** Methods that read a region from outside the whole body: how it pulls, spins, flexes or conducts. */
const INDIRECT_METHODS: ReadonlySet<EvidenceMethod> = new Set(['gravity', 'momentOfInertia', 'magnetic', 'tides', 'libration', 'normalModes']);

/** The three labels that name one singular property of the body and so read as "the …";
 *  samples, tides, libration, seismology and the rest are plurals or proper things and take none. */
const LABELS_TAKING_THE: ReadonlySet<string> = new Set(['gravity field', 'moment of inertia', 'magnetic field']);

/** A method label as it reads after "by" or "from": "the gravity field", but "seismology". */
export function withArticle(label: string): string {
  return LABELS_TAKING_THE.has(label) ? `the ${label}` : label;
}

/** Each direct method's own phrase: a returned sample and a seismometer both reach the
 *  region, but not in the same way, so neither borrows the other's words. Typed over the
 *  direct set, so a method added there without its phrase is a compile error, never a
 *  generic line on screen. */
const OBSERVED_PHRASE: Readonly<Record<DirectMethod, string>> = {
  seismology: 'Observed by seismology',
  // A gas giant has no seismometer: the rings are the instrument, and the phrase says so, or
  // "seismology" on Saturn reads as a mistake.
  ringSeismology: 'Observed by ring seismology',
  helioseismology: 'Observed by helioseismology',
  neutrinos: 'Observed by neutrinos',
  sample: 'Seen in returned samples',
  inSitu: 'Measured in place',
};

/** One line per standing, for the title attribute beside the phrase. */
export const STANDING_READS_AS: Readonly<Record<EvidenceStanding, string>> = {
  observed: 'A measurement reaches this region itself',
  inferred: 'Nothing reaches it; measurements of the whole body point to it',
  laboratory: 'The material has been reproduced at these conditions in a laboratory',
  density: 'Only the body\'s mass and size support it',
  model: 'A model predicts it; no measurement has looked',
  contested: 'Published work argues against it',
  hypothesis: 'Plausible, but nothing published supports it yet',
};

function hypothesisSummary(): EvidenceSummary {
  return { standing: 'hypothesis', phrase: 'Hypothesis', methods: [] };
}

/** The distinct methods of these rows, in the order they are authored in. */
function distinctMethods(rows: Evidence[]): EvidenceMethod[] {
  const methods: EvidenceMethod[] = [];
  for (const row of rows) {
    if (!methods.includes(row.method)) methods.push(row.method);
  }
  return methods;
}

/** The one phrase a claim's evidence earns, by the precedence in the header. */
export function claimEvidenceSummary(claim: Claim): EvidenceSummary {
  const challengingRow = claim.evidence.find((row) => row.relation === 'challenges');
  if (challengingRow) {
    return {
      standing: 'contested',
      phrase: `Contested by ${withArticle(methodLabel(challengingRow.method))}`,
      methods: [challengingRow.method],
    };
  }

  const supporting = claim.evidence.filter((row) => row.relation === 'supports');

  for (const row of supporting) {
    const method = row.method;
    if (!isDirectMethod(method)) continue;
    return { standing: 'observed', phrase: OBSERVED_PHRASE[method], methods: [method] };
  }

  const indirectMethods = distinctMethods(supporting.filter((row) => INDIRECT_METHODS.has(row.method)));
  if (indirectMethods.length > 0) {
    // Two independent methods are worth naming together; a third adds a name, not a kind.
    const namedMethods = indirectMethods.slice(0, 2);
    return {
      standing: 'inferred',
      phrase: `Inferred from ${namedMethods.map((method) => withArticle(methodLabel(method))).join(' and ')}`,
      methods: namedMethods,
    };
  }

  const laboratoryRow = supporting.find((row) => row.method === 'labHighPressure');
  if (laboratoryRow) {
    return { standing: 'laboratory', phrase: 'Supported by laboratory experiments', methods: [laboratoryRow.method] };
  }

  const densityRow = supporting.find((row) => row.method === 'density');
  if (densityRow) {
    return { standing: 'density', phrase: 'From the bulk density alone', methods: [densityRow.method] };
  }

  const modelRow = supporting.find((row) => row.method === 'model');
  if (modelRow) {
    return { standing: 'model', phrase: 'A model\'s prediction', methods: [modelRow.method] };
  }

  return hypothesisSummary();
}

/** The region's existence claim's summary; a region with no existence claim reads as a hypothesis. */
export function regionEvidenceSummary(region: Region): EvidenceSummary {
  const existenceClaim = region.claims.find((claim) => claim.kind === 'existence');
  return existenceClaim ? claimEvidenceSummary(existenceClaim) : hypothesisSummary();
}
