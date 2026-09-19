import { describe, expect, it } from 'vitest';
import type { Claim, ClaimKind, Evidence, EvidenceMethod, EvidenceRelation, InteriorModel, Region } from './data/interiorTypes';
import { STANDING_READS_AS, claimEvidenceSummary, methodLabel, regionEvidenceSummary, withArticle, type EvidenceStanding } from './evidenceSummary';
import { EARTH_MODEL } from './data/models/earth';
import { IO_MODEL } from './data/models/io';
import { CALLISTO_PARTIAL_MODEL } from './data/models/callisto';

function row(method: EvidenceMethod, relation: EvidenceRelation = 'supports'): Evidence {
  return { method, relation, observed: 'o', inferred: 'i', assumed: 'a', uncertain: 'u', source: 'test' };
}

function claim(...evidence: Evidence[]): Claim {
  return { kind: 'existence', evidence };
}

/** A shipped model's claim, found the way the inspector finds it. */
function shippedClaim(model: InteriorModel, regionKey: string, kind: ClaimKind): Claim {
  const region = model.regions.find((candidate) => candidate.key === regionKey)!;
  return region.claims.find((candidate) => candidate.kind === kind)!;
}

/** Every method the schema names. It is a record rather than a list so a new
 *  method fails to compile here until it is given a label of its own. */
const EVERY_METHOD: Readonly<Record<EvidenceMethod, true>> = {
  seismology: true,
  ringSeismology: true,
  normalModes: true,
  helioseismology: true,
  neutrinos: true,
  gravity: true,
  momentOfInertia: true,
  magnetic: true,
  tides: true,
  libration: true,
  labHighPressure: true,
  sample: true,
  inSitu: true,
  density: true,
  model: true,
};

describe('methodLabel', () => {
  it('has words for every method in the schema, so no reader meets a blank', () => {
    const methods = Object.keys(EVERY_METHOD) as EvidenceMethod[];
    for (const method of methods) {
      const label = methodLabel(method);
      expect(typeof label, method).toBe('string');
      expect(label.length, method).toBeGreaterThan(0);
    }
  });
});

describe('withArticle', () => {
  it('gives the three singular properties their article and leaves the rest alone', () => {
    expect(withArticle(methodLabel('gravity'))).toBe('the gravity field');
    expect(withArticle(methodLabel('momentOfInertia'))).toBe('the moment of inertia');
    expect(withArticle(methodLabel('magnetic'))).toBe('the magnetic field');
    for (const method of ['sample', 'neutrinos', 'tides', 'libration', 'seismology', 'ringSeismology', 'helioseismology', 'normalModes', 'inSitu', 'labHighPressure', 'density', 'model'] as const) {
      expect(withArticle(methodLabel(method))).toBe(methodLabel(method));
    }
  });
});

describe('claimEvidenceSummary: one rule at a time', () => {
  it('reads a challenging row as contested, whatever else supports it', () => {
    const contested = claimEvidenceSummary(claim(row('seismology'), row('magnetic', 'challenges')));
    expect(contested.standing).toBe('contested');
    expect(contested.phrase).toBe('Contested by the magnetic field');
    expect(contested.methods).toEqual(['magnetic']);
    // The article follows the label, not the relation: a plural challenger takes none.
    expect(claimEvidenceSummary(claim(row('sample', 'challenges'))).phrase).toBe('Contested by samples');
    // The first challenging row names it, even where a second one follows.
    expect(claimEvidenceSummary(claim(row('tides', 'challenges'), row('model', 'challenges'))).phrase).toBe('Contested by tides');
  });

  it('is contested even where nothing supports it: the challenge is read before the support', () => {
    // Only a constraining row and a challenge: the claim has no support at all,
    // yet it is the argument against it a reader should meet, not "Hypothesis".
    const contested = claimEvidenceSummary(claim(row('model', 'constrains'), row('gravity', 'challenges')));
    expect(contested.standing).toBe('contested');
    expect(contested.phrase).toBe('Contested by the gravity field');
    expect(contested.methods).toEqual(['gravity']);
  });

  it('gives each direct method its own observed phrase', () => {
    expect(claimEvidenceSummary(claim(row('seismology'))).phrase).toBe('Observed by seismology');
    expect(claimEvidenceSummary(claim(row('helioseismology'))).phrase).toBe('Observed by helioseismology');
    expect(claimEvidenceSummary(claim(row('neutrinos'))).phrase).toBe('Observed by neutrinos');
    expect(claimEvidenceSummary(claim(row('sample'))).phrase).toBe('Seen in returned samples');
    expect(claimEvidenceSummary(claim(row('inSitu'))).phrase).toBe('Measured in place');
    const observed = claimEvidenceSummary(claim(row('gravity'), row('inSitu')));
    expect(observed.standing).toBe('observed');
    expect(observed.methods).toEqual(['inSitu']);
  });

  it('reads indirect support as inferred, naming at most two distinct methods', () => {
    const one = claimEvidenceSummary(claim(row('gravity')));
    expect(one.standing).toBe('inferred');
    expect(one.phrase).toBe('Inferred from the gravity field');
    expect(one.methods).toEqual(['gravity']);

    const two = claimEvidenceSummary(claim(row('momentOfInertia'), row('tides')));
    expect(two.phrase).toBe('Inferred from the moment of inertia and tides');
    expect(two.methods).toEqual(['momentOfInertia', 'tides']);

    // The first two DISTINCT methods in row order; a repeat and a third are not named.
    const many = claimEvidenceSummary(claim(row('libration'), row('libration'), row('magnetic'), row('gravity')));
    expect(many.phrase).toBe('Inferred from libration and the magnetic field');
    expect(many.methods).toEqual(['libration', 'magnetic']);
  });

  it('reads a laboratory row, a density row and a model row when nothing measures the body', () => {
    const laboratory = claimEvidenceSummary(claim(row('labHighPressure')));
    expect(laboratory.standing).toBe('laboratory');
    expect(laboratory.phrase).toBe('Supported by laboratory experiments');
    expect(laboratory.methods).toEqual(['labHighPressure']);

    const density = claimEvidenceSummary(claim(row('density'), row('model')));
    expect(density.standing).toBe('density');
    expect(density.phrase).toBe('From the bulk density alone');
    expect(density.methods).toEqual(['density']);

    const model = claimEvidenceSummary(claim(row('model')));
    expect(model.standing).toBe('model');
    expect(model.phrase).toBe('A model\'s prediction');
    expect(model.methods).toEqual(['model']);
  });

  it('reads nothing supporting as a hypothesis, and never lets a constraining row decide', () => {
    const nothing = claimEvidenceSummary(claim());
    expect(nothing.standing).toBe('hypothesis');
    expect(nothing.phrase).toBe('Hypothesis');
    expect(nothing.methods).toEqual([]);

    // Seismology that only NARROWS the claim does not make it observed.
    expect(claimEvidenceSummary(claim(row('seismology', 'constrains'))).standing).toBe('hypothesis');
    const constrainedModel = claimEvidenceSummary(claim(row('gravity', 'constrains'), row('model')));
    expect(constrainedModel.standing).toBe('model');
    expect(constrainedModel.phrase).toBe('A model\'s prediction');
  });

  it('follows the precedence: a challenged seismic claim is contested, not observed', () => {
    const summary = claimEvidenceSummary(claim(
      row('seismology'), row('normalModes'), row('labHighPressure'), row('model', 'challenges'),
    ));
    expect(summary.standing).toBe('contested');
    expect(summary.phrase).toBe('Contested by interior model');
    // And the same rows without the challenge read as the direct method.
    expect(claimEvidenceSummary(claim(row('seismology'), row('normalModes'), row('labHighPressure'))).phrase)
      .toBe('Observed by seismology');
  });

  it('has a line for every standing', () => {
    const standings: EvidenceStanding[] = ['observed', 'inferred', 'laboratory', 'density', 'model', 'contested', 'hypothesis'];
    for (const standing of standings) expect(STANDING_READS_AS[standing].length).toBeGreaterThan(10);
  });
});

describe('regionEvidenceSummary', () => {
  it('summarises the existence claim, and reads a region without one as a hypothesis', () => {
    // earth.ts: the crust's existence claim opens with a seismology row (the Moho).
    const crust = EARTH_MODEL.regions[4];
    expect(crust.key).toBe('crust');
    expect(regionEvidenceSummary(crust).phrase).toBe('Observed by seismology');

    const claimless: Region = { ...crust, claims: [] };
    expect(regionEvidenceSummary(claimless)).toEqual({ standing: 'hypothesis', phrase: 'Hypothesis', methods: [] });

    // A region whose only claim is about something else still reads as a hypothesis.
    const stateOnly: Region = { ...crust, claims: [{ kind: 'state', evidence: [row('seismology')] }] };
    expect(regionEvidenceSummary(stateOnly).standing).toBe('hypothesis');
  });
});

describe('claimEvidenceSummary: pinned readings on the shipped models', () => {
  it("Earth's outer core exists because seismology crosses it", () => {
    // earth.ts, region 'outerCore', existence: Oldham's S-wave shadow (seismology,
    // supports), then normal modes, the magnetic field and the laboratory.
    const summary = claimEvidenceSummary(shippedClaim(EARTH_MODEL, 'outerCore', 'existence'));
    expect(summary).toEqual({ standing: 'observed', phrase: 'Observed by seismology', methods: ['seismology'] });
  });

  it("Io's mantle state is contested: the magma-ocean induction argues against a stiff mantle", () => {
    // io.ts, region 'mantle', state: Juno's tidal Love number supports a mostly solid
    // mantle (tides, Park 2024); Galileo's induced field challenges it (magnetic,
    // Khurana 2011), read as a shallow global magma ocean.
    const summary = claimEvidenceSummary(shippedClaim(IO_MODEL, 'mantle', 'state'));
    expect(summary).toEqual({ standing: 'contested', phrase: 'Contested by the magnetic field', methods: ['magnetic'] });
  });

  it("Callisto's ocean is inferred from the induced field alone", () => {
    // callisto.ts, the OCEAN region shared by both models, existence: one row,
    // Zimmer 2000's induced dipole (magnetic, supports). Nothing reaches it.
    const summary = claimEvidenceSummary(shippedClaim(CALLISTO_PARTIAL_MODEL, 'ocean', 'existence'));
    expect(summary).toEqual({ standing: 'inferred', phrase: 'Inferred from the magnetic field', methods: ['magnetic'] });
  });
});
