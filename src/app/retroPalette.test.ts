import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RETRO_INTERFACE_COLOURS, RETRO_LOOKUP_STEPS, RETRO_RAMPS, hexToRgb, hueRamp, retroLookup, retroPalette, srgbToOklab,
} from './retroPalette';

const palette = retroPalette();

describe('the retro palette', () => {
  it('is 256 colours: black, fifteen ramps of sixteen, and fifteen kept for the interface', () => {
    expect(palette).toHaveLength(256);
    expect(palette[0]).toEqual([0, 0, 0]);
    expect(RETRO_RAMPS).toHaveLength(15);
    expect(RETRO_RAMPS.every((ramp) => ramp[2] === 16)).toBe(true);
    expect(RETRO_INTERFACE_COLOURS).toHaveLength(15);
    expect(palette.slice(241)).toEqual(RETRO_INTERFACE_COLOURS.map(hexToRgb));
    for (const colour of palette) {
      for (const channel of colour) {
        expect(Number.isInteger(channel)).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
  });

  it('runs every ramp from dark to light', () => {
    for (const ramp of RETRO_RAMPS) {
      const lightness = hueRamp(ramp).map(([red, green, blue]) => srgbToOklab(red / 255, green / 255, blue / 255)[0]);
      for (let step = 1; step < lightness.length; step++) expect(lightness[step]).toBeGreaterThan(lightness[step - 1]);
    }
  });

  it('is the palette tuned in the mock', () => {
    // Changes only when a ramp is retuned on purpose; then update this hash.
    const bytes = Uint8Array.from(palette.flat());
    expect(createHash('sha256').update(bytes).digest('hex').slice(0, 16)).toMatchInlineSnapshot(`"45c89357c7ec77c4"`);
  });
});

describe('the lookup', () => {
  const lookup = retroLookup(palette);
  const steps = RETRO_LOOKUP_STEPS;
  const at = (red: number, green: number, blue: number) => {
    const offset = (green * steps * steps + red + steps * blue) * 4;
    return [lookup[offset], lookup[offset + 1], lookup[offset + 2], lookup[offset + 3]];
  };
  const inPalette = new Set(palette.map((colour) => colour.join(',')));

  it('is a 1024 × 32 texture of opaque palette colours', () => {
    expect(lookup).toHaveLength(steps * steps * steps * 4);
    for (let offset = 0; offset < lookup.length; offset += 4) {
      expect(inPalette.has(`${lookup[offset]},${lookup[offset + 1]},${lookup[offset + 2]}`)).toBe(true);
      expect(lookup[offset + 3]).toBe(255);
    }
  });

  it('keeps black, white and the interface yellow exact', () => {
    expect(at(0, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(at(31, 31, 31)).toEqual([255, 255, 255, 255]);
    const [red, green, blue] = hexToRgb('#ffdd22').map((channel) => Math.round((channel / 255) * (steps - 1)));
    expect(at(red, green, blue).slice(0, 3)).toEqual([255, 221, 34]);
  });

  it('picks the nearest colour in OKLab, checked by brute force at spread points', () => {
    const labs = palette.map(([red, green, blue]) => srgbToOklab(red / 255, green / 255, blue / 255));
    for (let sample = 0; sample < 400; sample++) {
      const red = (sample * 7) % steps, green = (sample * 13) % steps, blue = (sample * 23) % steps;
      const lab = srgbToOklab(red / (steps - 1), green / (steps - 1), blue / (steps - 1));
      const distances = labs.map((entry) => (entry[0] - lab[0]) ** 2 + (entry[1] - lab[1]) ** 2 + (entry[2] - lab[2]) ** 2);
      const chosen = at(red, green, blue).slice(0, 3).join(',');
      const chosenDistance = Math.min(...palette.map((colour, index) => (colour.join(',') === chosen ? distances[index] : Infinity)));
      expect(chosenDistance).toBeCloseTo(Math.min(...distances), 12);
    }
  });
});
