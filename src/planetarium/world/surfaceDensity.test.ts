import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  densityRelevantDiameterPx,
  equirectTexelLength,
  measureSurfaceDensity,
  pixelsPerTexel,
  surfaceMagnifiedWeight,
  texelsPerPixel,
  SURFACE_TEXEL_FADE,
} from './surfaceDensity';
import {
  bindKtx2TierLoader,
  bindTierAdmission,
  ladderDrawnMapWidth,
  ladderMapReferenceWidth,
} from './textureLadder';
import { TIER_MAP_WIDTH } from './texturePolicy';
import { estimateSphereScreenDiameterPx, projectSphereToScreen } from '../../shared/three/projectToScreen';
import { disposeTrackedMaterials, ladderHandle, withMaxTextureSize } from '../testing/upgradeHarness';

/** A camera looking down -Z at the origin from `dist`, with its matrices ready
 *  for the projection seams (which read them and never refresh them). */
function cameraAt(dist: number, fovDeg = 45, width = 1600, height = 1000): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(fovDeg, width / height, 1e-6, 1e6);
  camera.position.set(0, 0, dist);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

const VIEW_W = 1600;
const VIEW_H = 1000;

/** Focal length in pixels of that camera: the pixels one world unit covers at
 *  unit distance on the view axis. */
function focalPx(fovDeg: number, height = VIEW_H): number {
  return (height / 2) / Math.tan(THREE.MathUtils.degToRad(fovDeg / 2));
}

describe('the drawn texel density of a surface', () => {
  it('states one texel as an equator arc, the way the sector streamer does', () => {
    // 2048 texels around a unit sphere's equator.
    expect(equirectTexelLength(1, 2048)).toBeCloseTo((2 * Math.PI) / 2048, 12);
    // A body with no radius or no map has no texel to measure.
    expect(equirectTexelLength(0, 2048)).toBe(0);
    expect(equirectTexelLength(1, 0)).toBe(0);
  });

  it('reads the same density either way up', () => {
    const px = pixelsPerTexel(1000, 1, 2048);
    expect(px).toBeCloseTo(1000 * (2 * Math.PI) / 2048, 9);
    expect(texelsPerPixel(1000, 1, 2048)).toBeCloseTo(1 / px, 9);
    // No screen scale at all is infinitely minified, not a divide by zero.
    expect(texelsPerPixel(0, 1, 2048)).toBe(Number.POSITIVE_INFINITY);
  });

  it('hands over across one band, the same one the shader smooths on', () => {
    const [lo, hi] = SURFACE_TEXEL_FADE;
    expect(surfaceMagnifiedWeight(lo - 0.01)).toBe(1);
    expect(surfaceMagnifiedWeight(hi + 0.01)).toBe(0);
    expect(surfaceMagnifiedWeight((lo + hi) / 2)).toBeCloseTo(0.5, 6);
    expect(surfaceMagnifiedWeight(Number.POSITIVE_INFINITY)).toBe(0);
    // Monotone across the band: a surface never gains the term back as it
    // minifies.
    let previous = 1;
    for (let t = 0; t <= 2; t += 0.05) {
      const w = surfaceMagnifiedWeight(t);
      expect(w).toBeLessThanOrEqual(previous + 1e-12);
      previous = w;
    }
  });

  it('measures the sub-camera point against the projection it is drawn through', () => {
    const camera = cameraAt(1.5);
    const density = measureSurfaceDensity(
      new THREE.Vector3(), 1, 2048, camera, VIEW_W, VIEW_H, 1,
    );
    expect(density).not.toBeNull();
    // The sub-camera point sits at (d - R) on the view axis, so one world unit
    // there covers f / (d - R) pixels.
    const expected = (focalPx(45) / 0.5) * ((2 * Math.PI) / 2048);
    expect(density!.pixelsPerTexel).toBeCloseTo(expected, 2);
    expect(density!.texelsPerPixel).toBeCloseTo(1 / expected, 6);
    expect(density!.magnified).toBe(1);
    expect(density!.mapWidth).toBe(2048);
  });

  it('says where on the body it measured, once told which way the body faces', () => {
    // A density on its own cannot tell a pose over a pole from one over the
    // equator, nor either from a pose on a body-frame diagonal — and all three
    // are different questions of a surface term that draws its own ground.
    const camera = cameraAt(1.5);
    const basis = (y: THREE.Vector3, x = new THREE.Vector3(1, 0, 0)) => {
      const yy = y.clone().normalize();
      const xx = x.clone().sub(yy.clone().multiplyScalar(yy.dot(x))).normalize();
      return { x: xx, y: yy, z: new THREE.Vector3().crossVectors(xx, yy) };
    };
    const at = (y: THREE.Vector3) => measureSurfaceDensity(
      new THREE.Vector3(), 1, 2048, camera, VIEW_W, VIEW_H, 1, basis(y),
    )!;
    // The camera looks down −Z, so the point it magnifies most is the +Z one.
    expect(at(new THREE.Vector3(0, 0, 1)).subCameraLatDeg).toBeCloseTo(90, 6);
    expect(at(new THREE.Vector3(0, 0, -1)).subCameraLatDeg).toBeCloseTo(-90, 6);
    expect(at(new THREE.Vector3(0, 1, 0)).subCameraLatDeg).toBeCloseTo(0, 6);
    expect(at(new THREE.Vector3(0, 1, 1)).subCameraLatDeg).toBeCloseTo(45, 6);
    // The same point in the body's own frame, which is where the term's charts
    // live: a pose with all three components equal sits on a diagonal, where
    // three charts are drawn instead of one.
    const dir = at(new THREE.Vector3(0, 1, 0)).subCameraBodyDir!;
    expect(Math.hypot(...dir)).toBeCloseTo(1, 9);
    const diagonal = at(new THREE.Vector3(1, 1, 1)).subCameraBodyDir!;
    expect(Math.abs(diagonal[1])).toBeCloseTo(1 / Math.sqrt(3), 6);
    // And says nothing rather than guessing where it was not told.
    const untold = measureSurfaceDensity(new THREE.Vector3(), 1, 2048, camera, VIEW_W, VIEW_H, 1)!;
    expect(untold.subCameraLatDeg).toBeNull();
    expect(untold.subCameraBodyDir).toBeNull();
  });

  it('writes its direction into the record it was handed, not a fresh one', () => {
    // The measurement runs for every measurable body against ONE scratch
    // record, so a caller that kept the array it hands back would give every
    // body the last one's direction. It has to be safe to copy out of.
    const camera = cameraAt(1.5);
    const basis = {
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1),
    };
    const scratch = {
      mapWidth: 0, pixelsPerTexel: 0, texelsPerPixel: 0, magnified: 0, pxPerUnit: 0,
      subCameraLatDeg: null as number | null, subCameraBodyDir: null as [number, number, number] | null,
    };
    const first = measureSurfaceDensity(
      new THREE.Vector3(), 1, 2048, camera, VIEW_W, VIEW_H, 1, basis, scratch,
    )!;
    const held = first.subCameraBodyDir!;
    const second = measureSurfaceDensity(
      new THREE.Vector3(0, 0.4, 0), 1, 2048, camera, VIEW_W, VIEW_H, 1, basis, scratch,
    )!;
    // Same array, new numbers — which is the whole point, and the trap.
    expect(second.subCameraBodyDir).toBe(held);
    expect(second.subCameraBodyDir![1]).not.toBeCloseTo(0, 3);
  });

  it('reports a device-pixel density, not a CSS one', () => {
    const camera = cameraAt(1.5);
    const one = measureSurfaceDensity(new THREE.Vector3(), 1, 2048, camera, VIEW_W, VIEW_H, 1)!;
    const two = measureSurfaceDensity(new THREE.Vector3(), 1, 2048, camera, VIEW_W, VIEW_H, 2)!;
    expect(two.pixelsPerTexel).toBeCloseTo(one.pixelsPerTexel * 2, 6);
  });

  it('has nothing honest to report from inside the body or with no map', () => {
    const camera = cameraAt(0.5);
    expect(measureSurfaceDensity(new THREE.Vector3(), 1, 2048, camera, VIEW_W, VIEW_H, 1)).toBeNull();
    const far = cameraAt(10);
    expect(measureSurfaceDensity(new THREE.Vector3(), 1, 0, far, VIEW_W, VIEW_H, 1)).toBeNull();
    expect(measureSurfaceDensity(new THREE.Vector3(), 0, 2048, far, VIEW_W, VIEW_H, 1)).toBeNull();
  });

  it('scales with the drawn map: four times the texels, a quarter the pixels each', () => {
    const camera = cameraAt(2);
    const boot = measureSurfaceDensity(new THREE.Vector3(), 1, 2048, camera, VIEW_W, VIEW_H, 1)!;
    const rung = measureSurfaceDensity(new THREE.Vector3(), 1, 8192, camera, VIEW_W, VIEW_H, 1)!;
    expect(rung.pixelsPerTexel).toBeCloseTo(boot.pixelsPerTexel / 4, 6);
  });

  it('is skipped only where the skip cannot miss a magnified body', () => {
    // The pre-filter is read against the LOD walk's conservative diameter
    // OVERestimate. Sweep distance and map width: wherever the estimate is
    // under the threshold, the real measurement must agree there is nothing
    // to fade in.
    for (const mapWidth of [512, 2048, 4096, 8192, 16384]) {
      const gate = densityRelevantDiameterPx(mapWidth);
      for (let d = 1.02; d < 400; d *= 1.15) {
        const camera = cameraAt(d);
        const est = estimateSphereScreenDiameterPx(
          new THREE.Vector3(), 1, camera, VIEW_W, VIEW_H,
        );
        if (est > gate) continue;
        const density = measureSurfaceDensity(
          new THREE.Vector3(), 1, mapWidth, camera, VIEW_W, VIEW_H, 2,
        );
        expect(density?.magnified ?? 0).toBe(0);
      }
    }
  });

  it('holds the analytic relation the pre-filter is derived from', () => {
    // pixelsPerTexel = diameterPx · (pi / mapWidth) · sqrt((d + R) / (d - R)),
    // which is why a screen diameter alone cannot prove a body unmagnified.
    for (const d of [1.5, 2, 4, 20, 200]) {
      const camera = cameraAt(d);
      const footprint = projectSphereToScreen(
        new THREE.Vector3(), 1, camera, VIEW_W, VIEW_H,
      );
      const density = measureSurfaceDensity(
        new THREE.Vector3(), 1, 4096, camera, VIEW_W, VIEW_H, 1,
      )!;
      const predicted = footprint.diameterPx * (Math.PI / 4096) * Math.sqrt((d + 1) / (d - 1));
      // The footprint carries a secant pad for its 32 rim samples, so it reads
      // a fraction of a percent large; the relation itself is exact.
      expect(density.pixelsPerTexel).toBeGreaterThan(predicted * 0.985);
      expect(density.pixelsPerTexel).toBeLessThan(predicted * 1.005);
    }
  });
});

describe('the drawn map width against the width tiles are sized by', () => {
  beforeEach(() => {
    // A device that can hold the top of every ladder, so the two widths are
    // free to disagree by the ladder's full height; and the KTX2 loader bound,
    // because the rungs that ship as containers alone are not part of a
    // session's ladder without one.
    withMaxTextureSize(16384);
    bindKtx2TierLoader(() => {}, true);
  });

  afterEach(() => {
    bindTierAdmission(null);
    bindKtx2TierLoader(null);
    disposeTrackedMaterials();
  });

  it('differs by the whole height of the ladder on an untouched handle', () => {
    const up = ladderHandle('moon');
    // Nothing applied: the surface is drawing its boot map while the tiles are
    // already being sized against the 8K rung the ladder can reach.
    expect(ladderDrawnMapWidth(up)).toBe(TIER_MAP_WIDTH['2k']);
    expect(ladderMapReferenceWidth(up)).toBe(TIER_MAP_WIDTH['8k']);

    // At a pose where that matters, the two widths are two different pictures
    // of the same frame: the drawn map is magnified past the band and the
    // reference width says the surface is comfortably minified.
    const camera = cameraAt(3);
    const drawn = measureSurfaceDensity(
      new THREE.Vector3(), 1, ladderDrawnMapWidth(up), camera, VIEW_W, VIEW_H, 1,
    )!;
    const reference = measureSurfaceDensity(
      new THREE.Vector3(), 1, ladderMapReferenceWidth(up), camera, VIEW_W, VIEW_H, 1,
    )!;
    expect(drawn.magnified).toBe(1);
    expect(reference.magnified).toBe(0);
    expect(drawn.pixelsPerTexel).toBeCloseTo(reference.pixelsPerTexel * 4, 6);
  });

  it('agrees once the ladder has nothing left above the rung on the body', () => {
    const up = ladderHandle('moon');
    up.appliedTier = '8k';
    expect(ladderDrawnMapWidth(up)).toBe(TIER_MAP_WIDTH['8k']);
    expect(ladderMapReferenceWidth(up)).toBe(TIER_MAP_WIDTH['8k']);
  });

  it('follows the rung down under a squeeze while the reference width does not', () => {
    const up = ladderHandle('moon');
    up.appliedTier = '4k';
    // The 8K rung is still reachable, so the tiles keep being sized against
    // it; the surface is drawing 4096 and that is what a fade must read.
    expect(ladderMapReferenceWidth(up)).toBe(TIER_MAP_WIDTH['8k']);
    expect(ladderDrawnMapWidth(up)).toBe(TIER_MAP_WIDTH['4k']);
    // Given back under memory pressure: the drawn width halves again, and the
    // surface really is coarser than it was a frame ago.
    up.appliedTier = '2k';
    expect(ladderDrawnMapWidth(up)).toBe(TIER_MAP_WIDTH['2k']);
  });

  it('floors on the map a body really boots with, not on the tier name', () => {
    // Earth's globe ships 4096 as its first-paint map under a 2K tier name;
    // a fade reading the tier would report the surface twice as starved as it
    // is.
    const up = ladderHandle('earthDay');
    expect(up.appliedTier).toBeNull();
    expect(ladderDrawnMapWidth(up)).toBe(4096);
  });
});
