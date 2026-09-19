/**
 * The evidence a reader opens, grouped (plan §8): one group per claim —
 * what the claim is about, how it stands, and the rows underneath it, each
 * already in the words the panel prints. The UI renders this and decides
 * nothing: which phrase a claim earns comes from evidenceSummary, and every
 * string is built here, where a test can pin it, rather than inside a DOM
 * builder where it cannot.
 *
 * Two authoring habits are absorbed here rather than left to the renderer.
 * A row's `assumed` and `uncertain` are notes, not sentences, and are often
 * a placeholder — '—', 'As above', '' — so they are dropped, punctuated and
 * joined into one line about what the row rests on; a dash rendered under a
 * heading tells the reader nothing and costs a line. And a published
 * probability is rare: only a few claims anywhere carry one, so it is a
 * nullable line the panel adds when it exists, not a field it reserves room
 * for on every claim.
 *
 * Pure: it builds strings and plain objects, no DOM.
 */
import type { Claim, ClaimKind, Evidence, EvidenceRelation, Region } from '../data/interiorTypes';
import { claimEvidenceSummary, methodLabel, type EvidenceSummary } from '../evidenceSummary';
import { RELATION_WORD, provenanceText } from './inspectorText';

/** What each claim is about, as the group's heading. */
export const CLAIM_TITLE: Readonly<Record<ClaimKind, string>> = {
  existence: 'Structure',
  extent: 'Size',
  state: 'Physical state',
  composition: 'Composition',
  temperature: 'Temperature',
};

export interface EvidenceEntryView {
  /** methodLabel, capitalised for a heading: "Seismology", "Gravity field". */
  method: string;
  relation: EvidenceRelation;
  relationWord: string;
  /** "Mission, year", "year" or '' when the row names neither. */
  provenance: string;
  /** What was measured, '' when the row leaves it as a placeholder. */
  observation: string;
  /** What it was read to mean. */
  interpretation: string;
  /** What the reading assumes, and what it leaves open, each as a sentence under its own
   *  label; '' where the author left a placeholder. Two labelled lines, because the two
   *  run together read as one broken sentence ("Shear waves need a solid. The precise
   *  radius from this alone."). */
  assumed: string;
  uncertain: string;
  source: string;
}

export interface EvidenceGroupView {
  kind: ClaimKind;
  title: string;
  summary: EvidenceSummary;
  /** "Published: 88% that <proposition> (<source>)", or null when the claim carries none. */
  probability: string | null;
  entries: EvidenceEntryView[];
}

/** The words an author writes where there is nothing to say; none of them is content. */
const PLACEHOLDER_TEXTS: ReadonlySet<string> = new Set(['', '—', '-', 'as above', 'n/a', 'none']);

export function isPlaceholder(text: string | undefined): boolean {
  if (text === undefined) return true;
  return PLACEHOLDER_TEXTS.has(text.trim().toLowerCase());
}

/** A note as a sentence. An ellipsis, a question mark or an exclamation mark is an ending already. */
function asSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** The parts worth reading, each ended with a full stop, joined with a space. */
export function sentenceJoin(parts: (string | undefined)[]): string {
  return parts
    .filter((part): part is string => !isPlaceholder(part))
    .map((part) => asSentence(part.trim()))
    .join(' ');
}

/** A field's text, or '' where the author left a placeholder. */
function readable(text: string | undefined): string {
  if (text === undefined || isPlaceholder(text)) return '';
  return text.trim();
}

/** A method label as a heading: "in-situ measurement" → "In-situ measurement". */
function headingCase(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function entryView(row: Evidence): EvidenceEntryView {
  return {
    method: headingCase(methodLabel(row.method)),
    relation: row.relation,
    relationWord: RELATION_WORD[row.relation],
    provenance: provenanceText(row.mission, row.year),
    observation: readable(row.observed),
    interpretation: readable(row.inferred),
    assumed: sentenceJoin([row.assumed]),
    uncertain: sentenceJoin([row.uncertain]),
    source: readable(row.source),
  };
}

/** The published probability as its line, or null: a percentage, its proposition and its source. */
function probabilityLine(claim: Claim): string | null {
  const published = claim.probability;
  if (!published) return null;
  return `Published: ${Math.round(published.value * 100)}% that ${published.proposition} (${published.source})`;
}

/** The region's claims as the reader's groups, in the order the model authors them. */
export function evidenceGroups(region: Region): EvidenceGroupView[] {
  return region.claims.map((claim) => ({
    kind: claim.kind,
    title: CLAIM_TITLE[claim.kind],
    summary: claimEvidenceSummary(claim),
    probability: probabilityLine(claim),
    entries: claim.evidence.map(entryView),
  }));
}
