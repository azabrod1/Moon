import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SHIP_HULL_MAX_EXTENT_AU, SHIP_REFERENCE_RADIUS_AU } from '../planetarium/cruiseView';
import { bracketBox } from './brackets';
import { retroGrid, retroInterfacePixel, retroSceneRatio } from './grid';
import { RETRO_LOOKUP_STEPS, hexToRgb, retroLookup, retroPalette } from './palette';
import { resolveBootLook } from './setting';
import { createRetroShip } from './ship';
import { retroTypographyCss } from './typography';

describe('the Retro look', () => {
  it('makes a 4:3 window a 320 × 240 screen, and an interface pixel a whole number of device pixels', () => {
    expect(retroGrid(1280, 960, 1)).toEqual({ block: 4, virtual: { width: 320, height: 240 }, cssPixel: 4 });
    expect(retroGrid(2560, 1920, 2)).toEqual({ block: 8, virtual: { width: 320, height: 240 }, cssPixel: 4 });
    // The last big pixels hang off an edge rather than leave a gap.
    const odd = retroGrid(1366, 768, 1);
    expect(odd.virtual.width * odd.block).toBeGreaterThanOrEqual(1366);
    for (const ratio of [1, 1.25, 2, 3]) expect(Number.isInteger(retroInterfacePixel(ratio) * ratio)).toBe(true);
    // The scene under it: three of its pixels per big pixel, never below half the canvas's.
    expect(retroSceneRatio(390, 844, 2)).toBe(2);
    expect(retroSceneRatio(1280, 800, 2)).toBe(1);
  });

  it('takes the URL, then the saved look, then Modern', () => {
    const storage = { getItem: () => 'retro', setItem: () => {} };
    expect(resolveBootLook('?retro=0', storage)).toBe('modern');
    expect(resolveBootLook('', storage)).toBe('retro');
    expect(resolveBootLook('?retro=1', null)).toBe('retro');
  });

  it('cuts to 256 colours, keeping black, white and the interface yellow exact', () => {
    const palette = retroPalette();
    expect(palette).toHaveLength(256);
    const lookup = retroLookup(palette);
    const steps = RETRO_LOOKUP_STEPS;
    const at = (red: number, green: number, blue: number) => Array.from(lookup.subarray(4 * (green * steps * steps + red + steps * blue)).slice(0, 3));
    expect(at(0, 0, 0)).toEqual([0, 0, 0]);
    expect(at(31, 31, 31)).toEqual([255, 255, 255]);
    const [red, green, blue] = hexToRgb('#ffdd22').map((channel) => Math.round((channel / 255) * (steps - 1)));
    expect(at(red, green, blue)).toEqual([255, 221, 34]);
  });

  it('maps type sizes to bitmap faces, family and size together', () => {
    const css = retroTypographyCss([
      { selector: '.note, .a:is(.b, .c)', fontSize: '9.5px', setsFamily: false, media: null },
      { selector: '.mono', fontSize: '', setsFamily: true, media: null },
      { selector: '.tr-clock .t', fontSize: '10.5px', setsFamily: false, media: null },
    ]);
    expect(css).toContain("html.retro .note, html.retro .a:is(.b, .c) { font-family: 'Retro Sans 8', monospace !important; font-size: calc(8 * var(--ui-px)) !important; }");
    expect(css).toContain('html.retro .mono { font-family: inherit !important; }');
    // A region retro.css sets a face for itself is left alone.
    expect(css).not.toContain('.tr-clock');
  });

  it('builds a ship inside the camera-safety extent the app sets for its own', () => {
    // Its farthest solid point (the flames are light, not hull), at the app's
    // half-size ship group: the camera's near plane and zoom floor are set
    // from this extent (planetarium/cruiseView.ts).
    const { model } = createRetroShip(SHIP_REFERENCE_RADIUS_AU);
    model.updateMatrixWorld(true);
    let farthest = 0;
    const point = new THREE.Vector3();
    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || (mesh.material as THREE.Material).blending === THREE.AdditiveBlending) return;
      const positions = mesh.geometry.getAttribute('position');
      for (let index = 0; index < positions.count; index++) {
        farthest = Math.max(farthest, point.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld).length());
      }
    });
    expect(farthest * 0.5).toBeLessThan(SHIP_HULL_MAX_EXTENT_AU);
  });

  it('puts the target brackets on the big-pixel grid, inside the viewport', () => {
    expect(bracketBox({ left: 401.3, top: 150.9, right: 702.2, bottom: 449.5 }, 4, 1280, 800)).toEqual({ left: 392, top: 140, right: 712, bottom: 460 });
    expect(bracketBox({ left: 100, top: 100, right: 110, bottom: 110 }, 4, 1280, 800)).toBeNull();
  });
});
