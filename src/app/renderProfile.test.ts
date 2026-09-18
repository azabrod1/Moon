import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TONE_MAPPING_BY_MODE, applyRenderProfile, toneMappingFor, toneMappingWord, type AppMode } from './renderProfile';

const MODES: readonly AppMode[] = ['planetarium', 'moonFlight', 'volumeCompare', 'interior'];

describe('the tone curve per mode', () => {
  it('is Neutral for the Look-inside studio and ACES everywhere else', () => {
    expect(toneMappingFor('interior')).toBe(THREE.NeutralToneMapping);
    for (const mode of MODES) {
      if (mode === 'interior') continue;
      expect(toneMappingFor(mode)).toBe(THREE.ACESFilmicToneMapping);
    }
  });

  it('names every mode the app has', () => {
    expect(Object.keys(TONE_MAPPING_BY_MODE).sort()).toEqual([...MODES].sort());
  });
});

describe('applying the profile at a switch', () => {
  it('a visit to the studio and back leaves the planetarium on ACES', () => {
    // The defect this pins: the studio used to set the curve in its constructor
    // and give it back only in dispose, which main never calls.
    const renderer = { toneMapping: THREE.ACESFilmicToneMapping as THREE.ToneMapping };
    expect(applyRenderProfile(renderer, 'interior')).toBe(true);
    expect(renderer.toneMapping).toBe(THREE.NeutralToneMapping);
    expect(applyRenderProfile(renderer, 'planetarium')).toBe(true);
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
  });

  it('re-entering a cached mode reapplies its curve whatever the last one left', () => {
    const renderer = { toneMapping: THREE.NeutralToneMapping as THREE.ToneMapping };
    applyRenderProfile(renderer, 'volumeCompare');
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    applyRenderProfile(renderer, 'interior');
    applyRenderProfile(renderer, 'interior');
    expect(renderer.toneMapping).toBe(THREE.NeutralToneMapping);
  });

  it('writes nothing when the curve is already the mode\'s', () => {
    const renderer = { toneMapping: THREE.ACESFilmicToneMapping as THREE.ToneMapping };
    expect(applyRenderProfile(renderer, 'planetarium')).toBe(false);
    expect(applyRenderProfile(renderer, 'moonFlight')).toBe(false);
  });
});

describe('the curve\'s word', () => {
  it('reads the two the app uses, and falls back to the number', () => {
    expect(toneMappingWord(THREE.ACESFilmicToneMapping)).toBe('aces');
    expect(toneMappingWord(THREE.NeutralToneMapping)).toBe('neutral');
    expect(toneMappingWord(99 as THREE.ToneMapping)).toBe('99');
  });
});
