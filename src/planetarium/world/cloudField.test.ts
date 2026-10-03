import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  buildCloudPageMips,
  CLOUD_FIELD_EDGE_BAND,
  CLOUD_FIELD_GRID,
  CLOUD_FIELD_GUARD_TEXELS,
  CLOUD_FIELD_LEVEL_WIDTH,
  CLOUD_FIELD_MIX_GLSL,
  CLOUD_PAGE_CONTENT,
  CLOUD_PAGE_GUTTER,
  CLOUD_PAGE_LEVELS,
  CLOUD_PAGE_SIZE,
  CLOUD_FIELD_SAFETY_TEXELS,
  CLOUD_TABLE_CLEAR,
  CLOUD_TABLE_SEE_PARENT,
  cloudFieldGlsl,
  cloudTableCode,
  cloudFieldGuard,
  cloudFieldPoolBytes,
  cloudPageAddress,
  cloudPageEdgeWeight,
  cloudPageKey,
  cloudPageNeighbours,
  packCloudPage,
  parseCloudPageKey,
} from './cloudField';
import { cloudFieldAsked, cloudFieldRequested } from './cloudFieldSlots';
import { sphereEquirectUv } from './cloudDeck';
import { textureBytesPerTexel, textureGpuBytes } from './textureBytes';
import { resolveDefine } from '../testing/glslDefine';

/** The deck-frame direction at a MAP longitude and latitude (degrees): the
 *  inverse of three's SphereGeometry UV, whose u = 0 is the map's −180°. */
function dirAt(lonDeg: number, latDeg: number): [number, number, number] {
  const phi = ((lonDeg + 180) / 360) * 2 * Math.PI;
  const lat = (latDeg * Math.PI) / 180;
  return [-Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat)];
}

/** The direction at the centre of texel (x, y) of the 32k level, x from −180°
 *  eastward and y from +90° southward, as the page cutter lays them out. */
function levelTexelDir(x: number, y: number): [number, number, number] {
  const W = CLOUD_FIELD_LEVEL_WIDTH;
  return dirAt(-180 + (360 * (x + 0.5)) / W, 90 - (180 * (y + 0.5)) / (W / 2));
}

describe('the cloud field\'s grid', () => {
  it('is 16 by 8 pages of 2032 texels inside an 8-texel gutter: a 32512-wide level', () => {
    expect(CLOUD_PAGE_SIZE).toBe(2048);
    expect(CLOUD_PAGE_LEVELS).toBe(12);
    expect(CLOUD_FIELD_LEVEL_WIDTH).toBe(32512);
    expect(CLOUD_FIELD_GRID[1] * CLOUD_PAGE_CONTENT).toBe(CLOUD_FIELD_LEVEL_WIDTH / 2);
    // 0.7526 of the master's 43200, i.e. 1.23 km a texel at the equator.
    expect(CLOUD_FIELD_LEVEL_WIDTH / 43200).toBeCloseTo(0.7526, 4);
  });

  it('agrees with the deck\'s own UV twin', () => {
    for (const [lon, lat] of [[-117.8, -13], [0, 0], [179.99, -20], [-179.99, 45], [90, -89]]) {
      const d = dirAt(lon, lat);
      const [u, v] = sphereEquirectUv(d[0], d[1], d[2]);
      const a = cloudPageAddress(d);
      expect((a.col + a.s[0]) / CLOUD_FIELD_GRID[0]).toBeCloseTo(u, 9);
      expect((CLOUD_FIELD_GRID[1] - 1 - a.row + a.s[1]) / CLOUD_FIELD_GRID[1]).toBeCloseTo(v, 9);
    }
  });
});

describe('a direction\'s page', () => {
  it('names the page by column from −180° and by row from the north', () => {
    // The trades pose's frame centre: map 117.8 W, 13.3 S.
    expect(cloudPageAddress(dirAt(-117.8, -13.3))).toMatchObject({ col: 2, row: 4 });
    expect(cloudPageAddress(dirAt(-112.4, -13.3))).toMatchObject({ col: 3, row: 4 });
    expect(cloudPageAddress(dirAt(-117.8, 0.1))).toMatchObject({ col: 2, row: 3 });
    expect(cloudPageAddress(dirAt(-117.8, -22.6))).toMatchObject({ col: 2, row: 5 });
    // Italy, northern hemisphere east of Greenwich.
    expect(cloudPageAddress(dirAt(12.5, 42))).toMatchObject({ col: 8, row: 2 });
  });

  it('wraps at the date line: just west of it is the last column, just east the first', () => {
    expect(cloudPageAddress(dirAt(179.999, -20)).col).toBe(15);
    expect(cloudPageAddress(dirAt(-179.999, -20)).col).toBe(0);
    expect(cloudPageAddress(dirAt(180, -20)).col).toBeLessThan(16);
  });

  it('keeps the poles on the grid: the top row at the north pole, the bottom at the south', () => {
    expect(cloudPageAddress([0, 1, 0]).row).toBe(0);
    expect(cloudPageAddress([0, -1, 0]).row).toBe(7);
    expect(cloudPageAddress(dirAt(30, 89.99)).row).toBe(0);
    expect(cloudPageAddress(dirAt(30, -89.99)).row).toBe(7);
  });

  it('lands on the texel the cutter wrote there, gutter and row flip included', () => {
    // The cutter: page (c, r) holds level columns c·2032 − 8 … and rows
    // r·2032 − 8 … north-up; the layer is uploaded bottom row first, so the
    // texel row from the bottom is 2047 minus the row from the top.
    const cases = [
      [0, 0], [2031, 2031], [2032, 2032], [5000, 9000], [32511, 16255], [8 * 2032 + 17, 4 * 2032 + 1500],
    ];
    for (const [x, y] of cases) {
      const a = cloudPageAddress(levelTexelDir(x, y));
      expect(a.col).toBe(Math.floor(x / CLOUD_PAGE_CONTENT));
      expect(a.row).toBe(Math.floor(y / CLOUD_PAGE_CONTENT));
      const fromWest = x - a.col * CLOUD_PAGE_CONTENT + CLOUD_PAGE_GUTTER;
      const fromTop = y - a.row * CLOUD_PAGE_CONTENT + CLOUD_PAGE_GUTTER;
      expect(a.local[0] * CLOUD_PAGE_SIZE - 0.5).toBeCloseTo(fromWest, 3);
      expect(a.local[1] * CLOUD_PAGE_SIZE - 0.5).toBeCloseTo(CLOUD_PAGE_SIZE - 1 - fromTop, 3);
    }
  });

  it('never addresses a gutter texel as content: the content spans [8, 2040) of the layer', () => {
    for (const lon of [-135, -134.9999, -112.5001]) {
      const a = cloudPageAddress(dirAt(lon, -10));
      expect(a.local[0] * CLOUD_PAGE_SIZE).toBeGreaterThanOrEqual(CLOUD_PAGE_GUTTER - 1e-6);
      expect(a.local[0] * CLOUD_PAGE_SIZE).toBeLessThanOrEqual(CLOUD_PAGE_SIZE - CLOUD_PAGE_GUTTER + 1e-6);
    }
    // The western content edge sits on the gutter's inner boundary.
    const west = cloudPageAddress(dirAt(-135 + 1e-9, -10));
    expect(west.col).toBe(2);
    expect(west.local[0] * CLOUD_PAGE_SIZE).toBeCloseTo(CLOUD_PAGE_GUTTER, 4);
    // The southern content edge is the BOTTOM of the layer (t = 8/2048).
    const south = cloudPageAddress(dirAt(-120, -22.5 + 1e-9));
    expect(south.row).toBe(4);
    expect(south.local[1] * CLOUD_PAGE_SIZE).toBeCloseTo(CLOUD_PAGE_GUTTER, 4);
  });
});

describe('a page\'s neighbours', () => {
  it('are the pages across the nearer edges, wrapping in longitude', () => {
    expect(cloudPageNeighbours(15, 4, [0.9, 0.5])).toEqual({ x: [0, 4], y: [15, 3], xy: [0, 3] });
    expect(cloudPageNeighbours(0, 4, [0.1, 0.2])).toEqual({ x: [15, 4], y: [0, 5], xy: [15, 5] });
  });

  it('stop at the poles', () => {
    expect(cloudPageNeighbours(3, 0, [0.5, 0.9]).y).toBeNull();
    expect(cloudPageNeighbours(3, 7, [0.5, 0.1]).xy).toBeNull();
    expect(cloudPageNeighbours(3, 7, [0.5, 0.9]).y).toEqual([3, 6]);
  });
});

describe('the weight two pages meet at', () => {
  const band = CLOUD_FIELD_EDGE_BAND;

  it('is the page\'s own fade inside the band', () => {
    expect(cloudPageEdgeWeight([0.5, 0.5], 0.7, 0, 0, 0)).toBe(0.7);
    expect(cloudPageEdgeWeight([band * 1.01, 1 - band * 1.01], 0.7, 0, 0, 0)).toBe(0.7);
  });

  it('is the smaller of the two fades at a shared edge, from both sides', () => {
    // Page A (fade 1) and page B (fade 0.4) share A's eastern edge.
    const y = 0.5;
    const a = cloudPageEdgeWeight([1 - 1e-9, y], 1, 0.4, 1, 1);
    const b = cloudPageEdgeWeight([1e-9, y], 0.4, 1, 1, 1);
    expect(a).toBeCloseTo(0.4, 6);
    expect(b).toBeCloseTo(0.4, 6);
  });

  it('runs on across the edge with no step, at every distance along it', () => {
    // A in the west (fade 1), B in the east (0.4); north of both, C (0.8)
    // over A and nothing over B; the y edge is the northern one.
    for (const y of [0.5, 1 - band * 0.5, 1 - band * 0.1, 1 - 1e-9]) {
      const a = cloudPageEdgeWeight([1 - 1e-9, y], 1, 0.4, 0.8, 0);
      const b = cloudPageEdgeWeight([1e-9, y], 0.4, 1, 0, 0.8);
      expect(a).toBeCloseTo(b, 6);
    }
  });

  it('is the smallest of the four at a corner', () => {
    const fades = { a: 1, b: 0.4, c: 0.8, d: 0.6 };
    // a in the south-west, b south-east, c north-west, d north-east.
    const atA = cloudPageEdgeWeight([1 - 1e-9, 1 - 1e-9], fades.a, fades.b, fades.c, fades.d);
    const atB = cloudPageEdgeWeight([1e-9, 1 - 1e-9], fades.b, fades.a, fades.d, fades.c);
    const atC = cloudPageEdgeWeight([1 - 1e-9, 1e-9], fades.c, fades.d, fades.a, fades.b);
    const atD = cloudPageEdgeWeight([1e-9, 1e-9], fades.d, fades.c, fades.b, fades.a);
    for (const w of [atA, atB, atC, atD]) expect(w).toBeCloseTo(0.4, 6);
  });

  it('goes to the base where the neighbour is missing', () => {
    expect(cloudPageEdgeWeight([1 - 1e-9, 0.5], 1, 0, 1, 1)).toBeCloseTo(0, 6);
    expect(cloudPageEdgeWeight([1 - band / 2, 0.5], 1, 0, 1, 1)).toBeCloseTo(0.5, 6);
  });
});

describe('the hand-over to the base', () => {
  it('is full up to LOD 2 and gone by LOD 3, on the footprint\'s major axis', () => {
    expect(CLOUD_FIELD_GUARD_TEXELS).toEqual([4, 8]);
    expect(cloudFieldGuard(1)).toBe(1);
    expect(cloudFieldGuard(4)).toBe(1);
    expect(cloudFieldGuard(6)).toBeCloseTo(0.5, 9);
    expect(cloudFieldGuard(8)).toBe(0);
    // ...which is the gutter: half a footprint either side, plus a texel.
    expect(CLOUD_FIELD_GUARD_TEXELS[1] / 2 + 1).toBeLessThanOrEqual(CLOUD_PAGE_GUTTER);
  });
});

describe('a page\'s layer', () => {
  it('interleaves A and P and puts the file\'s last row first', () => {
    // 2×2: file rows (north-up) are [a0 a1] / [a2 a3].
    const a = Uint8Array.from([10, 11, 12, 13]);
    const p = Uint8Array.from([20, 21, 22, 23]);
    expect([...packCloudPage(a, p, 2)]).toEqual([12, 22, 13, 23, 10, 20, 11, 21]);
    // RGBA readback: the grey is in every colour channel; only R is read.
    const rgba = (g: number[]) => Uint8Array.from(g.flatMap((v) => [v, v, v, 255]));
    expect([...packCloudPage(rgba([10, 11, 12, 13]), rgba([20, 21, 22, 23]), 2, 4)])
      .toEqual([12, 22, 13, 23, 10, 20, 11, 21]);
  });

  it('builds its mips as data: 2×2 means per channel, rounded half up', () => {
    // A 4×4 RG block: A runs 0..15, P is 255 − A·16 (clamped at 0).
    const base = new Uint8Array(4 * 4 * 2);
    for (let i = 0; i < 16; i++) {
      base[2 * i] = i;
      base[2 * i + 1] = Math.max(0, 255 - i * 16);
    }
    const mips = buildCloudPageMips(base, 4, 2);
    expect(mips.map((m) => m.length)).toEqual([32, 8, 2]);
    expect(mips[0]).toBe(base);
    // Level 1, texel (0, 0): A of 0, 1, 4, 5 = 10 / 4 = 2.5 -> 3;
    // P of 255, 239, 191, 175 = 860 / 4 = 215.
    expect([...mips[1]]).toEqual([
      3, 215, 5, 183,
      11, 87, 13, 55,
    ]);
    // Level 2: the mean of level 1 as stored (each step quantised).
    expect([...mips[2]]).toEqual([8, 135]);
  });

  it('has twelve levels from 2048', () => {
    const mips = buildCloudPageMips(new Uint8Array(CLOUD_PAGE_SIZE * CLOUD_PAGE_SIZE * 2), CLOUD_PAGE_SIZE);
    expect(mips).toHaveLength(CLOUD_PAGE_LEVELS);
    expect(mips[CLOUD_PAGE_LEVELS - 1]).toHaveLength(2);
  });

  it('refuses a base that is not a power of two or not the size it says', () => {
    expect(() => buildCloudPageMips(new Uint8Array(18), 3)).toThrow();
    expect(() => buildCloudPageMips(new Uint8Array(10), 4)).toThrow();
  });
});

describe('the pool\'s bytes', () => {
  it('are RG8 2048² with every level, per layer, allocated whatever is resident', () => {
    // 5 592 405 texels in the chain, two bytes each: 10.67 MiB a layer.
    expect(cloudFieldPoolBytes(1)).toBe(11184810);
    expect(cloudFieldPoolBytes(6)).toBe(6 * 11184810);
    expect(cloudFieldPoolBytes(6) / 1048576).toBeCloseTo(64.0, 1);
  });

  it('are priced the same way by the envelope\'s accounting', () => {
    const pool = new THREE.DataArrayTexture(null, CLOUD_PAGE_SIZE, CLOUD_PAGE_SIZE, 6);
    pool.format = THREE.RGFormat;
    pool.generateMipmaps = false;
    pool.mipmaps = Array.from({ length: CLOUD_PAGE_LEVELS }, () => ({})) as unknown as typeof pool.mipmaps;
    expect(textureBytesPerTexel(pool)).toBe(2);
    // The ledger's 4/3 is the infinite chain, rounded per layer: within a few
    // bytes of the exact twelve-level sum.
    expect(Math.abs(textureGpuBytes(pool) - cloudFieldPoolBytes(6))).toBeLessThan(16);
    // One channel and four are what they were.
    expect(textureBytesPerTexel({ format: THREE.RedFormat })).toBe(1);
    expect(textureBytesPerTexel({ format: THREE.RGBAFormat })).toBe(4);
    const plain = new THREE.DataTexture(new Uint8Array(4 * 64 * 64), 64, 64);
    plain.generateMipmaps = true;
    expect(textureGpuBytes(plain)).toBe(Math.round(64 * 64 * 4 * 4 / 3));
  });
});

describe('the field\'s GLSL', () => {
  const glsl = cloudFieldGlsl([0.7, 1.3]);
  const mix = CLOUD_FIELD_MIX_GLSL('vec3(0.2126, 0.7152, 0.0722)');

  it('is all inside its define, so a program without it is the program it was', () => {
    for (const text of [glsl, mix]) {
      // Its own newline first, so the directive starts a line wherever the
      // chunk is spliced; off, it leaves that one blank line behind.
      expect(text.startsWith('\n#ifdef CLOUD_FIELD\n')).toBe(true);
      expect(text.endsWith('#endif\n')).toBe(true);
      expect(resolveDefine(`a}${text}b`, 'CLOUD_FIELD', false)).toBe('a}\nb');
    }
  });

  it('hands the shader the same numbers the twin uses', () => {
    expect(glsl).toContain(CLOUD_FIELD_EDGE_BAND.toFixed(6));
    expect(glsl).toContain(`smoothstep(${CLOUD_FIELD_GUARD_TEXELS[0].toFixed(6)}, ${CLOUD_FIELD_GUARD_TEXELS[1].toFixed(6)}, major)`);
    expect(glsl).toContain(`vec2 local = (${CLOUD_PAGE_GUTTER}.0 + s * ${CLOUD_PAGE_CONTENT}.0) / ${CLOUD_PAGE_SIZE}.0;`);
    expect(glsl).toContain('ivec2 cell = ivec2(int(cellF.x), 7 - int(cellF.y));');
    expect(glsl).toContain('smoothstep(0.700000, 1.300000, perPixel)');
  });

  it('takes no implicit derivative and no implicit level, so it may sit under a condition', () => {
    expect(glsl).not.toMatch(/dFd[xy]\(|fwidth\(/);
    // Every page read is explicit: texelFetch, textureGrad or textureLod.
    expect(glsl).not.toMatch(/\btexture\(|texture2D\(/);
    expect(glsl.match(/textureGrad\(uCloudPages/g)).toHaveLength(1);
  });

  it('tests the reserved table codes before it forms a layer, and draws the base for both', () => {
    // 254 (see the parent level) and 255 (known clear) are not layers 253 and
    // 254: the code test comes first, and both return the base's weight of 0.
    const codeTest = glsl.indexOf('if (code == 0 || code >= 254) return vec2(0.0);');
    const layerFormed = glsl.indexOf('layer = float(code - 1);');
    expect(codeTest).toBeGreaterThan(-1);
    expect(layerFormed).toBeGreaterThan(codeTest);
    expect(glsl).not.toContain('entry.r * 255.0 + 0.5) - 1.0');
    // A neighbour holding a reserved code meets its edges at a fade of 0.
    expect(glsl).toContain('return code > 0 && code < 254 ? e.g : 0.0;');
    expect(cloudTableCode(0)).toEqual({ kind: 'absent' });
    expect(cloudTableCode(1)).toEqual({ kind: 'layer', layer: 0 });
    expect(cloudTableCode(253)).toEqual({ kind: 'layer', layer: 252 });
    expect(cloudTableCode(CLOUD_TABLE_SEE_PARENT)).toEqual({ kind: 'parent' });
    expect(cloudTableCode(CLOUD_TABLE_CLEAR)).toEqual({ kind: 'clear' });
  });

  it('takes the true major axis, scaled into tile-ratio pixels, with the safety term on the real one', () => {
    expect(glsl).toContain('uniform float uCloudFieldPixelScale;');
    expect(glsl).toContain('float spread = sqrt(max(0.25 * (aa - bb) * (aa - bb) + ab * ab, 0.0));');
    expect(glsl).toContain('return majorScene * uCloudFieldPixelScale;');
    expect(glsl).toContain(`smoothstep(${CLOUD_FIELD_SAFETY_TEXELS[0].toFixed(6)}, ${CLOUD_FIELD_SAFETY_TEXELS[1].toFixed(6)}, majorScene)`);
    // The column-norm reading is gone.
    expect(glsl).not.toContain('max(length(lDx), length(lDy))');
  });

  it('skips the filtered fetch where the smooth filter has the whole weight', () => {
    expect(glsl).toContain('if (smoothW < 1.0) fine = textureGrad(uCloudPages, vec3(local, layer), lDx, lDy).rg;');
    expect(glsl).toContain('fine = smoothW >= 1.0 ? smoothed : mix(fine, smoothed, smoothW);');
  });

  it('reads two-component gradients for the array, the layer being no axis', () => {
    expect(glsl).toContain('textureGrad(uCloudPages, vec3(local, layer), lDx, lDy)');
  });

  it('leaves the base untouched wherever no page is resident', () => {
    // The mix runs only under w > 0; the base path is the block as it was.
    expect(mix).toContain('if (cloudFieldW > 0.0) {');
    expect(mix).toMatch(/mix\(vec2\(cloudAlpha, cloudAlpha \* cloudC0\), cloudFieldAP, cloudFieldW\)/);
  });
});

describe('page keys and the switch', () => {
  it('round-trips', () => {
    expect(cloudPageKey(2, 4)).toBe('2_4');
    expect(parseCloudPageKey('15_4')).toEqual([15, 4]);
    expect(parseCloudPageKey('16_4')).toBeNull();
    expect(parseCloudPageKey('2_8')).toBeNull();
    expect(parseCloudPageKey('x')).toBeNull();
  });

  it('is ?cloudtiles=1 and nothing else, in any build', () => {
    expect(cloudFieldAsked('?cloudtiles=1')).toBe(true);
    expect(cloudFieldAsked('?quality=medium&cloudtiles=1')).toBe(true);
    expect(cloudFieldAsked('?cloudtiles=0')).toBe(false);
    expect(cloudFieldAsked('?cloudtiles')).toBe(false);
    expect(cloudFieldAsked('')).toBe(false);
    // Read once, at boot: the test runner's page asked for nothing.
    expect(cloudFieldRequested()).toBe(false);
  });
});
