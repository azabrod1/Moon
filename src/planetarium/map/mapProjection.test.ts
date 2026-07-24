import { describe, it, expect } from 'vitest';
import {
  compressRadius,
  projectMapPoint,
  mapExtentAU,
  fitDistanceAU,
  MAP_GAMMA_DEFAULT,
  MAP_GAMMA_TRUE,
} from './mapProjection';

// Real semi-major axes (AU) — the ordering the compression must preserve.
const AU = {
  mercury: 0.387,
  venus: 0.723,
  earth: 1.0,
  mars: 1.524,
  jupiter: 5.203,
  saturn: 9.537,
  uranus: 19.19,
  neptune: 30.07,
  pluto: 39.48,
};

describe('compressRadius', () => {
  it('is the identity at true scale (gamma 1)', () => {
    for (const r of Object.values(AU)) {
      expect(compressRadius(r, MAP_GAMMA_TRUE)).toBeCloseTo(r, 12);
    }
  });

  it('pulls the outer planets in at the default gamma', () => {
    expect(compressRadius(AU.mercury, MAP_GAMMA_DEFAULT)).toBeCloseTo(0.6523, 3);
    expect(compressRadius(AU.pluto, MAP_GAMMA_DEFAULT)).toBeCloseTo(5.2284, 3);
  });

  it('is monotonic — radial ordering (incl. Neptune before Pluto) survives', () => {
    const ordered = Object.values(AU); // already sorted ascending
    const compressed = ordered.map((r) => compressRadius(r, MAP_GAMMA_DEFAULT));
    for (let i = 1; i < compressed.length; i++) {
      expect(compressed[i]).toBeGreaterThan(compressed[i - 1]);
    }
  });

  it('maps zero/negative radius to zero', () => {
    expect(compressRadius(0, MAP_GAMMA_DEFAULT)).toBe(0);
    expect(compressRadius(-3, MAP_GAMMA_DEFAULT)).toBe(0);
  });
});

describe('projectMapPoint', () => {
  it('preserves direction and compresses the radius', () => {
    const out = { x: 0, y: 0, z: 0 };
    // A point 4 AU out along a diagonal.
    const x = 3;
    const y = 0;
    const z = 4; // r = 5
    projectMapPoint(x, y, z, MAP_GAMMA_DEFAULT, out);
    const rOut = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
    expect(rOut).toBeCloseTo(Math.pow(5, MAP_GAMMA_DEFAULT), 10);
    // Same unit direction.
    expect(out.x / rOut).toBeCloseTo(3 / 5, 10);
    expect(out.z / rOut).toBeCloseTo(4 / 5, 10);
  });

  it('is the identity direction and magnitude at gamma 1', () => {
    const out = { x: 0, y: 0, z: 0 };
    projectMapPoint(2, -1, 2, MAP_GAMMA_TRUE, out); // r = 3
    expect(out.x).toBeCloseTo(2, 10);
    expect(out.y).toBeCloseTo(-1, 10);
    expect(out.z).toBeCloseTo(2, 10);
  });

  it('collapses the origin to the origin', () => {
    const out = { x: 9, y: 9, z: 9 };
    projectMapPoint(0, 0, 0, MAP_GAMMA_DEFAULT, out);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('mapExtentAU', () => {
  it('returns the largest compressed radius', () => {
    const radii = [AU.earth, AU.jupiter, AU.pluto];
    expect(mapExtentAU(radii, MAP_GAMMA_DEFAULT)).toBeCloseTo(
      compressRadius(AU.pluto, MAP_GAMMA_DEFAULT),
      12,
    );
  });

  it('lets a ship past Pluto set the extent', () => {
    const shipR = 60; // AU, well beyond Pluto
    const withShip = mapExtentAU([AU.pluto, shipR], MAP_GAMMA_DEFAULT);
    const withoutShip = mapExtentAU([AU.pluto], MAP_GAMMA_DEFAULT);
    expect(withShip).toBeGreaterThan(withoutShip);
    expect(withShip).toBeCloseTo(compressRadius(shipR, MAP_GAMMA_DEFAULT), 12);
  });

  it('is empty-safe', () => {
    expect(mapExtentAU([], MAP_GAMMA_DEFAULT)).toBe(0);
  });
});

describe('fitDistanceAU', () => {
  it('frames the extent within the vertical FOV with margin', () => {
    const extent = 5;
    const fov = 50;
    const dist = fitDistanceAU(extent, fov, 1, 1.18);
    // The extent should subtend the margin-inflated half-FOV at that distance.
    const half = (fov * Math.PI) / 180 / 2;
    expect(dist * Math.tan(half)).toBeCloseTo(extent * 1.18, 6);
  });

  it('backs the camera off further on a portrait aspect', () => {
    const landscape = fitDistanceAU(5, 50, 16 / 9);
    const portrait = fitDistanceAU(5, 50, 9 / 16);
    expect(portrait).toBeGreaterThan(landscape);
  });

  it('grows with the extent', () => {
    expect(fitDistanceAU(10, 50, 1)).toBeGreaterThan(fitDistanceAU(5, 50, 1));
  });
});

describe('eccentric-orbit extent', () => {
  // The map's per-orbit reach is the largest projected sample radius (the
  // aphelion), the way recompressOrbits tracks it — NOT the compressed
  // semi-major axis, which an eccentric orbit drawn at true scale overflows.
  it('follows the aphelion sample, not the semi-major axis', () => {
    const a = AU.pluto; // 39.48 — the case that overflows a semi-major fit
    const e = 0.25; // eccentric enough that the aphelion clears the mean radius
    const gamma = MAP_GAMMA_DEFAULT;
    const out = { x: 0, y: 0, z: 0 };
    const N = 180;
    let maxProjected = 0;
    let maxSampleR = 0;
    for (let i = 0; i < N; i++) {
      const theta = (i / N) * Math.PI * 2;
      // Kepler ellipse with the Sun at a focus: r peaks at aphelion (theta=pi).
      const r = (a * (1 - e * e)) / (1 + e * Math.cos(theta));
      projectMapPoint(r * Math.cos(theta), 0, r * Math.sin(theta), gamma, out);
      const projR = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
      if (projR > maxProjected) maxProjected = projR;
      if (r > maxSampleR) maxSampleR = r;
    }
    const aphelion = a * (1 + e);
    expect(maxSampleR).toBeGreaterThan(a);
    expect(maxSampleR).toBeCloseTo(aphelion, 6);
    // The extent equals the aphelion sample compressed — and exceeds what a
    // semi-major-axis extent would have drawn.
    expect(maxProjected).toBeCloseTo(compressRadius(maxSampleR, gamma), 6);
    expect(maxProjected).toBeGreaterThan(compressRadius(a, gamma));
  });
});
