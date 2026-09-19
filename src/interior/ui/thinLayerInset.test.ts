import { describe, expect, it } from 'vitest';
import { EARTH_MODEL } from '../data/models/earth';
import { EUROPA_MODEL } from '../data/models/europa';
import { drawnFromModel, type DrawnModel, type DrawnRegion } from '../drawnModel';
import { formatKm } from './inspectorText';
import {
  CENTRE_LABEL,
  INSET_CAPTION,
  INSET_HEIGHT,
  INSET_TITLE,
  INSET_WIDTH,
  LAYER_BAND_PX,
  SURFACE_LABEL,
  THIN_LAYER_FRACTION,
  isThinLayer,
  thinLayerInset,
} from './thinLayerInset';

// ---- fixtures ---------------------------------------------------------------

function region(key: string, innerRadiusKm: number, outerRadiusKm: number, transitionKm = 0): DrawnRegion {
  return {
    key,
    name: key,
    family: 'silicate',
    phase: 'solid',
    outerRadiusKm,
    innerRadiusKm,
    temperatureK: null,
    composition: 'test',
    transitionKm,
    region: null,
  };
}

function handBuilt(referenceRadiusKm: number, regionsInsideOut: DrawnRegion[]): DrawnModel {
  return { bodyId: 'Test', modelId: 'test', referenceRadiusKm, regionsInsideOut, illustrative: false, model: null };
}

/** A distinct swatch per region, so a fill can be traced back to the region it came from. */
function swatches(count: number): number[] {
  return Array.from({ length: count }, (_, index) => 0x0a0b0c + index);
}

const earth = drawnFromModel(EARTH_MODEL);
const earthSwatches = swatches(earth.regionsInsideOut.length);
const crustIndex = earth.regionsInsideOut.findIndex((entry) => entry.key === 'crust');
const lowerMantleIndex = earth.regionsInsideOut.findIndex((entry) => entry.key === 'lowerMantle');
const crust = earth.regionsInsideOut[crustIndex];
const upperMantle = earth.regionsInsideOut[crustIndex - 1];
const crustThicknessKm = crust.outerRadiusKm - crust.innerRadiusKm;

const europa = drawnFromModel(EUROPA_MODEL);
const europaSwatches = swatches(europa.regionsInsideOut.length);

// ---- which layers get one ---------------------------------------------------

describe('isThinLayer', () => {
  it('is true for Earth\'s crust and false for its lower mantle', () => {
    expect(isThinLayer(earth, crustIndex)).toBe(true);
    expect(isThinLayer(earth, lowerMantleIndex)).toBe(false);
  });

  it('is false at exactly the threshold fraction: the test is strict', () => {
    const exactly = handBuilt(1000, [region('inner', 0, 970), region('skin', 970, 1000)]);
    expect(exactly.regionsInsideOut[1].outerRadiusKm - exactly.regionsInsideOut[1].innerRadiusKm).toBe(THIN_LAYER_FRACTION * 1000);
    expect(isThinLayer(exactly, 1)).toBe(false);
    const hair = handBuilt(1000, [region('inner', 0, 971), region('skin', 971, 1000)]);
    expect(isThinLayer(hair, 1)).toBe(true);
  });

  it('is false off the ends of the model and for a layer with no thickness', () => {
    expect(isThinLayer(earth, -1)).toBe(false);
    expect(isThinLayer(earth, earth.regionsInsideOut.length)).toBe(false);
    const flat = handBuilt(1000, [region('inner', 0, 1000), region('nothing', 1000, 1000)]);
    expect(isThinLayer(flat, 1)).toBe(false);
  });
});

// ---- the real case the inset exists for -------------------------------------

describe('thinLayerInset on Earth\'s crust', () => {
  const layout = thinLayerInset(earth, crustIndex, earthSwatches)!;

  it('draws the crust at its own scale, 44 px tall', () => {
    expect(layout).not.toBeNull();
    const band = layout.bands[layout.selectedIndex];
    expect(band.key).toBe('crust');
    expect(band.selected).toBe(true);
    expect(band.bottom - band.top).toBeCloseTo(LAYER_BAND_PX, 10);
    expect(layout.scalePxPerKm).toBeCloseTo(LAYER_BAND_PX / crustThicknessKm, 12);
    expect(band.thicknessText).toBe(`${formatKm(crustThicknessKm)} km thick`);
    expect(band.thicknessText).toBe('35 km thick');
  });

  it('has the surface above it and nothing drawn beyond', () => {
    expect(layout.selectedIndex).toBe(0);
    const top = layout.boundaries[0];
    expect(top.label).toBe(SURFACE_LABEL);
    expect(top.depthKm).toBe(0);
    expect(top.y).toBe(layout.bands[layout.selectedIndex].top);
    // The crust's own outer boundary is sharp: the surface is a line, not a fade.
    expect(top.transitionPx).toBe(0);
  });

  it('marks the bottom boundary at the crust\'s own depth', () => {
    const bottom = layout.boundaries[1];
    expect(bottom.depthKm).toBeCloseTo(crustThicknessKm, 10);
    expect(bottom.label).toBe(`${formatKm(crustThicknessKm)} km`);
    expect(bottom.y).toBe(layout.bands[layout.selectedIndex].bottom);
    // The Moho is distributed in the model, so it is drawn as wide as it is.
    expect(upperMantle.transitionKm).toBeGreaterThan(0);
    expect(bottom.transitionPx).toBeCloseTo(upperMantle.transitionKm * layout.scalePxPerKm, 10);
  });

  it('runs the upper mantle off the bottom of the strip and says so', () => {
    expect(layout.bands).toHaveLength(2);
    const below = layout.bands[1];
    expect(below.key).toBe('upperMantle');
    expect(below.selected).toBe(false);
    expect(below.continues).toBe(true);
    expect(below.bottom).toBe(INSET_HEIGHT);
    // A clipped edge is not a boundary: only the two the crust really has.
    expect(layout.boundaries).toHaveLength(2);
  });

  it('takes its fills from the swatches it was given', () => {
    expect(layout.bands[0].fill).toBe('#0a0b10');
    expect(layout.bands[1].fill).toBe('#0a0b0f');
    const black = thinLayerInset(earth, crustIndex, [0, 0, 0, 0, 0])!;
    expect(black.bands[0].fill).toBe('#000000');
  });

  it('reads itself out in words', () => {
    expect(layout.ariaLabel).toBe('Magnified section: Crust, 35 km thick, drawn at its own scale. Above it: the surface. Below it: Upper mantle.');
  });
});

// ---- the two ends of the profile --------------------------------------------

describe('thinLayerInset at the ends of the profile', () => {
  it('ends an innermost thin layer at the centre', () => {
    const drawn = handBuilt(1000, [region('seed', 0, 20), region('bulk', 20, 1000)]);
    const layout = thinLayerInset(drawn, 0, swatches(2))!;
    const selected = layout.bands[layout.selectedIndex];
    expect(selected.key).toBe('seed');
    const bottom = layout.boundaries[layout.boundaries.length - 1];
    expect(bottom.label).toBe(CENTRE_LABEL);
    expect(bottom.depthKm).toBe(1000);
    expect(bottom.y).toBe(selected.bottom);
    // Nothing is drawn below the centre; the bulk above runs off the top.
    expect(layout.bands).toHaveLength(2);
    expect(layout.bands[0].key).toBe('bulk');
    expect(layout.bands[0].continues).toBe(true);
    expect(layout.bands[0].top).toBe(0);
    expect(layout.ariaLabel).toContain('Below it: the centre.');
  });

  it('draws both neighbours whole when both fit, and marks their far boundaries', () => {
    // 25 km thick at 44 px is 1.76 px/km, so a neighbour under ~23.8 km fits the 42 px of room.
    const drawn = handBuilt(1000, [
      region('core', 0, 280),
      region('below', 280, 300),
      region('target', 300, 325),
      region('above', 325, 340),
      region('shell', 340, 1000),
    ]);
    const layout = thinLayerInset(drawn, 2, swatches(5))!;
    expect(layout.scalePxPerKm).toBeCloseTo(LAYER_BAND_PX / 25, 12);
    expect(layout.bands.map((band) => band.key)).toEqual(['above', 'target', 'below']);
    expect(layout.bands.some((band) => band.continues)).toBe(false);

    expect(layout.boundaries).toHaveLength(4);
    const [aboveFar, top, bottom, belowFar] = layout.boundaries;
    expect(aboveFar.depthKm).toBe(660);
    expect(aboveFar.label).toBe('660 km');
    expect(aboveFar.y).toBeCloseTo(layout.bands[0].top, 10);
    expect(top.depthKm).toBe(675);
    expect(bottom.depthKm).toBe(700);
    expect(belowFar.depthKm).toBe(720);
    expect(belowFar.y).toBeCloseTo(layout.bands[2].bottom, 10);
    expect(layout.ariaLabel).toBe('Magnified section: target, 25 km thick, drawn at its own scale. Above it: above. Below it: below.');
  });

  it('calls an inner neighbour\'s far side the centre when it is the innermost region', () => {
    const drawn = handBuilt(1000, [region('core', 0, 15), region('target', 15, 40), region('shell', 40, 1000)]);
    const layout = thinLayerInset(drawn, 1, swatches(3))!;
    const inner = layout.bands[layout.bands.length - 1];
    expect(inner.key).toBe('core');
    expect(inner.continues).toBe(false);
    const far = layout.boundaries[layout.boundaries.length - 1];
    expect(far.label).toBe(CENTRE_LABEL);
    expect(far.depthKm).toBe(1000);
    expect(far.y).toBeCloseTo(inner.bottom, 10);
  });
});

// ---- the boundaries ---------------------------------------------------------

describe('thinLayerInset boundaries', () => {
  it('gives a distributed boundary its own width and a sharp one none', () => {
    // The boundary between region k and region k+1 is region k's outer boundary,
    // so it carries region k's transition width.
    const drawn = handBuilt(1000, [
      region('core', 0, 500, 40),
      region('target', 500, 520, 0),
      region('shell', 520, 1000, 0),
    ]);
    const layout = thinLayerInset(drawn, 1, swatches(3))!;
    const scale = LAYER_BAND_PX / 20;
    expect(layout.scalePxPerKm).toBeCloseTo(scale, 12);
    const [top, bottom] = layout.boundaries;
    expect(top.transitionPx).toBe(0);
    expect(bottom.transitionPx).toBeCloseTo(40 * scale, 10);
  });
});

// ---- invariants -------------------------------------------------------------

describe('thinLayerInset invariants', () => {
  const cases: { what: string; drawn: DrawnModel; swatches: number[] }[] = [
    { what: 'Earth', drawn: earth, swatches: earthSwatches },
    { what: 'Europa', drawn: europa, swatches: europaSwatches },
    {
      what: 'a hand-built stack',
      drawn: handBuilt(1000, [region('core', 0, 15), region('target', 15, 40), region('shell', 40, 1000)]),
      swatches: swatches(3),
    },
  ];

  for (const { what, drawn, swatches: colours } of cases) {
    it(`stacks ${what}'s thin layers outer to inner, contiguous and inside the viewBox`, () => {
      let seen = 0;
      drawn.regionsInsideOut.forEach((_, index) => {
        const layout = thinLayerInset(drawn, index, colours);
        if (!layout) return;
        seen++;
        expect(layout.width).toBe(INSET_WIDTH);
        expect(layout.height).toBe(INSET_HEIGHT);
        for (const band of layout.bands) {
          expect(band.top).toBeGreaterThanOrEqual(0);
          expect(band.bottom).toBeLessThanOrEqual(INSET_HEIGHT);
          expect(band.bottom).toBeGreaterThan(band.top);
          expect(band.fill).toMatch(/^#[0-9a-f]{6}$/);
        }
        for (let position = 1; position < layout.bands.length; position++) {
          expect(layout.bands[position].top).toBeCloseTo(layout.bands[position - 1].bottom, 10);
        }
        // Outer to inner: each band's region sits below the one before it.
        const outerRadii = layout.bands.map((band) => drawn.regionsInsideOut.find((entry) => entry.key === band.key)!.outerRadiusKm);
        expect(outerRadii).toEqual([...outerRadii].sort((a, b) => b - a));
        for (let position = 1; position < layout.boundaries.length; position++) {
          expect(layout.boundaries[position].y).toBeGreaterThan(layout.boundaries[position - 1].y);
        }
        for (const boundary of layout.boundaries) {
          expect(boundary.y).toBeGreaterThanOrEqual(0);
          expect(boundary.y).toBeLessThanOrEqual(INSET_HEIGHT);
          expect(boundary.depthKm).toBeGreaterThanOrEqual(0);
          expect(boundary.depthKm).toBeLessThanOrEqual(drawn.referenceRadiusKm);
          expect(boundary.transitionPx).toBeGreaterThanOrEqual(0);
        }
        expect(layout.bands.filter((band) => band.selected)).toHaveLength(1);
        expect(layout.bands[layout.selectedIndex].selected).toBe(true);
        expect(layout.bands.filter((band) => band.thicknessText !== null)).toHaveLength(1);
      });
      expect(seen).toBeGreaterThan(0);
    });
  }

  it('is null for a layer the globe can already show, and off the ends of the model', () => {
    expect(thinLayerInset(earth, lowerMantleIndex, earthSwatches)).toBeNull();
    expect(thinLayerInset(earth, -1, earthSwatches)).toBeNull();
    expect(thinLayerInset(earth, earth.regionsInsideOut.length, earthSwatches)).toBeNull();
  });

  it('says what it is and how honestly it is drawn', () => {
    const layout = thinLayerInset(earth, crustIndex, earthSwatches)!;
    expect(INSET_TITLE).toBe('Magnified section');
    expect(INSET_CAPTION).toBe('Drawn to this layer\'s own scale: on the globe it is too thin to see at this size.');
    expect(layout.title).toBe(INSET_TITLE);
    expect(layout.caption).toBe(INSET_CAPTION);
    // Where the globe does show the layer, the caption must not say it is too thin to see.
    expect(thinLayerInset(earth, crustIndex, earthSwatches, false)!.caption).toBe('Drawn to this layer\'s own scale.');
    // No magnification factor anywhere: the globe's scale moves with the camera.
    expect(`${layout.title} ${layout.caption} ${layout.ariaLabel}`).not.toMatch(/×|\bx\s*\d/);
  });
});
