import { describe, expect, it } from 'vitest';
import { EARTH_MODEL } from './data/models/earth';
import { EUROPA_MODEL } from './data/models/europa';
import { JUPITER_DILUTE_MODEL } from './data/models/jupiter';
import { coverageFor } from './data/interiorRegistry';
import { drawnFromModel, drawnUnresolved, outerFractionsInsideOut } from './drawnModel';
import { IDENTITY_REMAP, readableRemap, toDisplayFraction, toPhysicalFraction } from './interiorGeometry';
import {
  CUT_ANIMATION_S,
  advanceCutTween,
  advanceEmphasis,
  captionFor,
  createCutTween,
  createEmphasisState,
  cutTweenSettled,
  emphasisTarget,
  regionArtInsideOut,
  regionLooks,
  setCutTarget,
  stepToward,
  thicknessNoteText,
  unresolvedComposition,
} from './interiorLogic';
import { bodyTemperatureRange } from './temperatureScale';

describe('the cut tween', () => {
  it('sets at once when not animated and remembers the chosen opening', () => {
    const tween = createCutTween(0);
    expect(cutTweenSettled(tween)).toBe(true);
    setCutTarget(tween, 90, false);
    expect(tween.angleDeg).toBe(90);
    expect(tween.chosenDeg).toBe(90);
    expect(cutTweenSettled(tween)).toBe(true);
    // A ceremony's close is not a chosen view: the chosen opening survives it.
    setCutTarget(tween, 0, false, false);
    expect(tween.angleDeg).toBe(0);
    expect(tween.chosenDeg).toBe(90);
    // Out-of-range requests clamp.
    setCutTarget(tween, 400, false);
    expect(tween.angleDeg).toBe(180);
    setCutTarget(tween, -5, false);
    expect(tween.angleDeg).toBe(0);
  });

  it('eases monotonically from where it is to the target over CUT_ANIMATION_S and lands exactly', () => {
    const tween = createCutTween(0);
    setCutTarget(tween, 180, true);
    expect(cutTweenSettled(tween)).toBe(false);
    expect(tween.angleDeg).toBe(0);
    let previous = 0;
    let frames = 0;
    while (!cutTweenSettled(tween)) {
      const progress = advanceCutTween(tween, 1 / 60);
      expect(tween.angleDeg).toBeGreaterThanOrEqual(previous);
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThanOrEqual(1);
      previous = tween.angleDeg;
      frames++;
    }
    expect(tween.angleDeg).toBe(180);
    expect(frames).toBe(Math.ceil(CUT_ANIMATION_S * 60));
    // At rest the tween holds its target whatever dt is handed to it.
    expect(advanceCutTween(tween, 5)).toBe(1);
    expect(tween.angleDeg).toBe(180);
  });

  it('retargets mid-flight from the angle it has reached', () => {
    const tween = createCutTween(0);
    setCutTarget(tween, 180, true);
    for (let frame = 0; frame < 20; frame++) advanceCutTween(tween, 1 / 60);
    const reached = tween.angleDeg;
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThan(180);
    setCutTarget(tween, 0, true);
    expect(tween.fromDeg).toBe(reached);
    expect(tween.angleDeg).toBe(reached);
    advanceCutTween(tween, 1 / 60);
    expect(tween.angleDeg).toBeLessThan(reached);
  });

  it('steps a value toward a target without overshooting', () => {
    expect(stepToward(0, 1, 0.3)).toBeCloseTo(0.3, 12);
    expect(stepToward(0.9, 1, 0.3)).toBe(1);
    expect(stepToward(1, 0, 0.3)).toBeCloseTo(0.7, 12);
    expect(stepToward(0.1, 0, 0.3)).toBe(0);
    expect(stepToward(0.5, 0.5, 0.3)).toBe(0.5);
  });
});

describe('the look mapping', () => {
  const europa = drawnFromModel(EUROPA_MODEL);
  const europaArt = regionArtInsideOut(europa);
  const europaRange = bodyTemperatureRange(EUROPA_MODEL.regions.map((region) => region.temperatureK));

  it("keeps a boundary's uncertainty band straddling it in display space at every blend", () => {
    // Europa's core boundary is a model spread that brackets its radius (the validator's rule).
    const fractions = outerFractionsInsideOut(europa);
    for (const blend of [0, 0.5, 1]) {
      const remap = readableRemap(fractions, 0.08, blend);
      const looks = regionLooks(europa, remap, europaArt, europaRange);
      expect(looks).toHaveLength(europa.regionsInsideOut.length);
      const core = looks[0];
      expect(core.bandDisplay).not.toBeNull();
      expect(core.bandDisplay!.low).toBeLessThanOrEqual(core.outerDisplay);
      expect(core.bandDisplay!.high).toBeGreaterThanOrEqual(core.outerDisplay);
      // Every boundary is where the remap puts it, and the drawn radii stay in order up to the rim.
      looks.forEach((look, index) => {
        expect(look.outerDisplay).toBeCloseTo(toDisplayFraction(remap, fractions[index]), 12);
        if (index > 0) expect(look.outerDisplay).toBeGreaterThan(looks[index - 1].outerDisplay);
      });
      expect(looks[looks.length - 1].outerDisplay).toBe(1);
    }
  });

  it('widens a physical transition through the same remap as its boundary and leaves a sharp one at zero', () => {
    const jupiter = drawnFromModel(JUPITER_DILUTE_MODEL);
    const fractions = outerFractionsInsideOut(jupiter);
    const identity = regionLooks(jupiter, IDENTITY_REMAP, regionArtInsideOut(jupiter), null);
    const core = jupiter.regionsInsideOut[0];
    expect(core.transitionKm).toBeGreaterThan(0);
    expect(identity[0].blendDisplay).toBeCloseTo(core.transitionKm / (2 * jupiter.referenceRadiusKm), 12);
    // Through a remap the transition's two edges go where the boundary goes, so the physical width
    // reads back (to within the mean of the two slopes the knot at the boundary puts on its halves).
    const remap = readableRemap(fractions, 0.3, 1);
    const readable = regionLooks(jupiter, remap, regionArtInsideOut(jupiter), null);
    const edgeLow = toPhysicalFraction(remap, readable[0].outerDisplay - readable[0].blendDisplay);
    const edgeHigh = toPhysicalFraction(remap, readable[0].outerDisplay + readable[0].blendDisplay);
    const physicalWidth = core.transitionKm / jupiter.referenceRadiusKm;
    expect(Math.abs(edgeHigh - edgeLow - physicalWidth)).toBeLessThan(physicalWidth * 0.02);
    const halfPhysical = physicalWidth / 2;
    expect(readable[0].blendDisplay).toBeCloseTo(
      (toDisplayFraction(remap, fractions[0] + halfPhysical) - toDisplayFraction(remap, fractions[0] - halfPhysical)) / 2, 12);
    const earth = drawnFromModel(EARTH_MODEL);
    const sharp = regionLooks(earth, IDENTITY_REMAP, regionArtInsideOut(earth), null);
    expect(sharp[0].blendDisplay).toBe(0);
  });

  it('draws every temperature as unknown when the body has no scale, and the endpoints when it has one', () => {
    const withScale = regionLooks(europa, IDENTITY_REMAP, europaArt, europaRange);
    expect(withScale[3].temperature).not.toBeNull(); // the ice shell's temperature is known
    expect(withScale[0].temperature).toBeNull(); // the core's is not
    const withoutScale = regionLooks(europa, IDENTITY_REMAP, europaArt, null);
    for (const look of withoutScale) expect(look.temperature).toBeNull();
    // The unresolved whole: one region, no band, no temperature, cold.
    const unresolved = drawnUnresolved('Nix', 20, 'Not yet modelled here');
    const looks = regionLooks(unresolved, IDENTITY_REMAP, regionArtInsideOut(unresolved), null);
    expect(looks).toHaveLength(1);
    expect(looks[0].outerDisplay).toBe(1);
    expect(looks[0].bandDisplay).toBeNull();
    expect(looks[0].heat.strength).toBe(0);
  });

  it('tints each region by the depth of its middle', () => {
    const earth = drawnFromModel(EARTH_MODEL);
    const art = regionArtInsideOut(earth);
    expect(art).toHaveLength(earth.regionsInsideOut.length);
    for (const params of art) expect(params.colorA).toBeGreaterThanOrEqual(0);
  });
});

describe('the caption', () => {
  it('says what is drawn and how much to trust it', () => {
    const earth = coverageFor('Earth');
    expect(captionFor(earth, drawnFromModel(EARTH_MODEL))).toBe('Provisional model · radius 6,371 km');
    const jupiter = coverageFor('Jupiter');
    expect(captionFor(jupiter, drawnFromModel(JUPITER_DILUTE_MODEL))).toBe('Provisional model, one of 2 · radius 69,911 km');
    const phobos = coverageFor('Phobos');
    if (phobos.state !== 'poorlyConstrained' || !phobos.illustrative) throw new Error('Phobos carries an illustrative model');
    expect(captionFor(phobos, drawnFromModel(phobos.illustrative))).toMatch(/^Illustrative scenario, not a measurement · radius /);
    expect(captionFor(phobos, drawnUnresolved('Phobos', 11.1, unresolvedComposition(phobos)))).toBe('Interior unresolved · bulk density 1,860 kg/m³');
    const nix = coverageFor('Nix');
    expect(captionFor(nix, drawnUnresolved('Nix', 20, unresolvedComposition(nix)))).toBe('Not yet modelled here · no measured density');
    expect(unresolvedComposition(nix)).toBe('Not yet modelled here');
    expect(unresolvedComposition(phobos)).toBe('Not measured');
  });
});

describe('the emphasis', () => {
  it('prefers a hovered legend row, then the hovered region, then the pinned one', () => {
    expect(emphasisTarget(2, 1, 0)).toBe(2);
    expect(emphasisTarget(-1, 1, 0)).toBe(1);
    expect(emphasisTarget(-1, -1, 0)).toBe(0);
    expect(emphasisTarget(-1, -1, -1)).toBe(-1);
  });

  it('eases in, re-eases from half way on a switch, and fades out before forgetting the region', () => {
    const state = createEmphasisState();
    advanceEmphasis(state, 1, 0.4);
    expect(state).toEqual({ index: 1, amount: 0.4 });
    advanceEmphasis(state, 1, 0.4);
    advanceEmphasis(state, 1, 0.4);
    expect(state).toEqual({ index: 1, amount: 1 });
    advanceEmphasis(state, 2, 0.1);
    expect(state.index).toBe(2);
    expect(state.amount).toBeCloseTo(0.6, 12);
    advanceEmphasis(state, -1, 0.5);
    expect(state).toEqual({ index: 2, amount: 0.09999999999999998 });
    advanceEmphasis(state, -1, 0.5);
    expect(state).toEqual({ index: -1, amount: 0 });
    // Reduced motion lands at once.
    advanceEmphasis(state, 3, 1);
    expect(state).toEqual({ index: 3, amount: 1 });
  });
});

describe('thicknessNoteText', () => {
  it('says what the reader is looking at, and how many layers the true scale hides', () => {
    expect(thicknessNoteText(true, 0)).toBe('Thin layers widened so you can see them');
    expect(thicknessNoteText(true, 3)).toBe('Thin layers widened so you can see them');
    expect(thicknessNoteText(false, 0)).toBe('Layers at their true thickness');
    expect(thicknessNoteText(false, 1)).toBe('Layers at their true thickness · 1 too thin to see');
    expect(thicknessNoteText(false, 2)).toBe('Layers at their true thickness · 2 too thin to see');
  });
});
