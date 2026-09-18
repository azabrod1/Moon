import { describe, expect, it } from 'vitest';
import { projectedRadiusPx } from './interiorGeometry';
import { fitDistance, framingDistance, stageViewOffset, visibleStageRect, zoomRatio, type StageObstacles } from './interiorLayout';

const NO_OBSTACLES: StageObstacles = { top: 0, bottom: 0, left: 0, right: 0 };

// The phone: 390 x 844, a 60 px header strip, the sheet at its resting height.
const PHONE = { width: 390, height: 844, marginPx: 12, minSizePx: 160 };
const PHONE_SHEET_PX = 282;
const phoneObstacles = (sheetPx: number): StageObstacles => ({ ...NO_OBSTACLES, top: 60, bottom: sheetPx });

// The desktop: the inspector panel (300 px) with its margins on the right.
const DESKTOP = { width: 1400, height: 800, marginPx: 12, minSizePx: 160 };
const DESKTOP_OBSTACLES: StageObstacles = { top: 60, bottom: 0, left: 0, right: 332 };

describe('visibleStageRect and stageViewOffset on a phone', () => {
  it('centres the stage in the band between the header and the sheet, and shifts the picture up', () => {
    const stage = visibleStageRect(PHONE.width, PHONE.height, phoneObstacles(PHONE_SHEET_PX), PHONE.marginPx, PHONE.minSizePx);
    // The margin is symmetric, so the band's centre survives the inset.
    const bandCentreY = (60 + (PHONE.height - PHONE_SHEET_PX)) / 2;
    expect(bandCentreY).toBe(311);
    expect(stage.y + stage.height / 2).toBe(bandCentreY);
    expect(stage.y).toBe(72);
    expect(stage.height).toBe(478);
    expect(stage.x).toBe(12);
    expect(stage.width).toBe(366);

    const offset = stageViewOffset(stage, PHONE.width, PHONE.height);
    // Positive y moves the picture UP, which is what a bottom sheet asks for.
    expect(offset.y).toBe(PHONE.height / 2 - bandCentreY);
    expect(offset.y).toBe(111);
    expect(offset.y).toBeGreaterThan(0);
    // Nothing takes the sides, so the body stays horizontally centred.
    expect(offset.x).toBe(0);
  });

  it('frames a taller sheet farther away rather than only shifting the same disc', () => {
    const resting = visibleStageRect(PHONE.width, PHONE.height, phoneObstacles(PHONE_SHEET_PX), PHONE.marginPx, PHONE.minSizePx);
    const raised = visibleStageRect(PHONE.width, PHONE.height, phoneObstacles(560), PHONE.marginPx, PHONE.minSizePx);
    expect(raised.height).toBeLessThan(resting.height);
    const restingDistance = fitDistance(resting, PHONE.height, 40, 1, 0.9);
    const raisedDistance = fitDistance(raised, PHONE.height, 40, 1, 0.9);
    expect(raisedDistance).toBeGreaterThan(restingDistance);
    // ...and the disc it draws really does fit inside the raised stage.
    const discPx = 2 * projectedRadiusPx(1, raisedDistance, 40, PHONE.height);
    expect(discPx).toBeLessThanOrEqual(raised.height + 1e-9);
    expect(discPx).toBeLessThanOrEqual(raised.width + 1e-9);
  });
});

describe('visibleStageRect and stageViewOffset on desktop', () => {
  it('moves the picture left of the panel, by half of what the panel took', () => {
    const stage = visibleStageRect(DESKTOP.width, DESKTOP.height, DESKTOP_OBSTACLES, DESKTOP.marginPx, DESKTOP.minSizePx);
    expect(stage.x).toBe(12);
    expect(stage.width).toBe(1056 - 12);

    const offset = stageViewOffset(stage, DESKTOP.width, DESKTOP.height);
    const stageCentreX = stage.x + stage.width / 2;
    const stageCentreY = stage.y + stage.height / 2;
    expect(offset.x).toBe(Math.round(DESKTOP.width / 2 - stageCentreX));
    expect(offset.x).toBe(166);
    expect(offset.x).toBeGreaterThan(0); // positive x moves the picture LEFT
    // The header strip is the only vertical obstacle, so the body drops a little.
    expect(offset.y).toBe(Math.round(DESKTOP.height / 2 - stageCentreY));
    expect(offset.y).toBe(-30);
  });
});

describe('visibleStageRect min-size clamp', () => {
  it('keeps a sane stage under a sheet that leaves no band at all', () => {
    // 800 px of sheet under a 60 px header on an 844 px viewport: the band is
    // gone (it is inverted), so the minimum stands and is nudged onto screen.
    const stage = visibleStageRect(PHONE.width, PHONE.height, phoneObstacles(800), PHONE.marginPx, PHONE.minSizePx);
    expect(stage.height).toBe(PHONE.minSizePx);
    expect(stage.y).toBe(0);
    expect(stage.width).toBe(366); // the free axis is untouched by the clamp
    // A stage is still a stage: the fit is finite and farther than the resting one.
    const clampedDistance = fitDistance(stage, PHONE.height, 40, 1, 0.9);
    const restingStage = visibleStageRect(PHONE.width, PHONE.height, phoneObstacles(PHONE_SHEET_PX), PHONE.marginPx, PHONE.minSizePx);
    expect(Number.isFinite(clampedDistance)).toBe(true);
    expect(clampedDistance).toBeGreaterThan(fitDistance(restingStage, PHONE.height, 40, 1, 0.9));
  });

  it('centres the minimum on what the obstacles left when that still fits on screen', () => {
    const stage = visibleStageRect(PHONE.width, PHONE.height, phoneObstacles(700), PHONE.marginPx, PHONE.minSizePx);
    const bandCentreY = (60 + (PHONE.height - 700)) / 2;
    expect(stage.height).toBe(PHONE.minSizePx);
    expect(stage.y + stage.height / 2).toBe(bandCentreY);
    expect(stage.y).toBe(22);
  });

  it('centres a minimum larger than the viewport on the viewport', () => {
    const stage = visibleStageRect(300, 300, NO_OBSTACLES, 12, 400);
    expect(stage.width).toBe(400);
    expect(stage.height).toBe(400);
    expect(stage.x).toBe(-50);
    expect(stageViewOffset(stage, 300, 300)).toEqual({ x: 0, y: 0 });
  });
});

describe('fitDistance', () => {
  it('is the exact inverse of projectedRadiusPx', () => {
    const stage = { x: 12, y: 72, width: 366, height: 478 };
    for (const fovDeg of [40, 62]) {
      for (const fill of [0.55, 0.8, 1]) {
        for (const boundRadius of [1, 2.5]) {
          const distance = fitDistance(stage, PHONE.height, fovDeg, boundRadius, fill);
          const wantedRadiusPx = (fill * Math.min(stage.width, stage.height)) / 2;
          const drawnRadiusPx = projectedRadiusPx(boundRadius, distance, fovDeg, PHONE.height);
          expect(Math.abs(drawnRadiusPx - wantedRadiusPx)).toBeLessThan(1e-9);
          expect(distance).toBeGreaterThan(boundRadius);
        }
      }
    }
  });

  it('fits to the width when the stage is taller than wide, and to the height when it is wider', () => {
    const tall = { x: 0, y: 0, width: 300, height: 600 };
    const wide = { x: 0, y: 0, width: 600, height: 300 };
    const square = { x: 0, y: 0, width: 600, height: 600 };
    const fill = 0.9;
    const tallDistance = fitDistance(tall, 900, 40, 1, fill);
    const wideDistance = fitDistance(wide, 900, 40, 1, fill);
    // Both are fitted to their 300 px side, so both stand at the same distance.
    expect(tallDistance).toBeCloseTo(wideDistance, 12);
    for (const [stage, distance] of [[tall, tallDistance], [wide, wideDistance]] as const) {
      const discPx = 2 * projectedRadiusPx(1, distance, 40, 900);
      expect(discPx).toBeCloseTo(fill * 300, 9);
      expect(discPx).toBeLessThanOrEqual(stage.width + 1e-9);
      expect(discPx).toBeLessThanOrEqual(stage.height + 1e-9);
    }
    // A stage with room on both axes takes the body nearer.
    expect(fitDistance(square, 900, 40, 1, fill)).toBeLessThan(tallDistance);
  });

  it('has no finite answer for a stage, a fill or a body of nothing', () => {
    expect(fitDistance({ x: 0, y: 0, width: 0, height: 400 }, 844, 40, 1, 0.9)).toBe(Number.POSITIVE_INFINITY);
    expect(fitDistance({ x: 0, y: 0, width: 366, height: 478 }, 844, 40, 1, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(fitDistance({ x: 0, y: 0, width: 366, height: 478 }, 0, 40, 1, 0.9)).toBe(Number.POSITIVE_INFINITY);
    // A radius of nothing is refused too: a fit of 0 would park the camera inside the body.
    expect(fitDistance({ x: 0, y: 0, width: 366, height: 478 }, 844, 40, 0, 0.9)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('framingDistance', () => {
  const MIN_DISTANCE = 1.55;
  const MAX_DISTANCE = 9;

  it('asks for the same distance twice when nothing changed between the calls', () => {
    // The first framing: the fit grows from 7.11 to 9 with the camera at the old fit (no reader zoom).
    const first = framingDistance(9, 7.11, 7.11, MIN_DISTANCE, MAX_DISTANCE);
    expect(first).toBeCloseTo(9, 10);
    // The second, before the glide has moved the camera: handed the distance the first asked for.
    expect(framingDistance(9, 9, first, MIN_DISTANCE, MAX_DISTANCE)).toBeCloseTo(first, 10);
  });

  it('keeps a glide on course: the pending target is the zoom to read, never the mid-glide position', () => {
    // Mid-glide the camera sits at 7.4737 on its way to 9. A re-framing handed the target still asks
    // for 9; one handed the position would have stopped the glide there and read 0.83 as a reader zoom.
    expect(framingDistance(9, 9, 9, MIN_DISTANCE, MAX_DISTANCE)).toBe(9);
    expect(framingDistance(9, 9, 7.4737, MIN_DISTANCE, MAX_DISTANCE)).toBeCloseTo(7.4737, 6);
  });

  it('carries a real reader zoom across a change of fit, inside the camera range', () => {
    // The reader zoomed to half the fit: the new fit keeps that ratio.
    expect(framingDistance(8, 6, 3, MIN_DISTANCE, MAX_DISTANCE)).toBeCloseTo(4, 10);
    // ...never closer than the camera's floor, nor farther than its ceiling.
    expect(framingDistance(2, 6, 3, MIN_DISTANCE, MAX_DISTANCE)).toBe(MIN_DISTANCE);
    expect(framingDistance(8, 6, 12, MIN_DISTANCE, MAX_DISTANCE)).toBe(MAX_DISTANCE);
  });

  it('reads as the fit itself before there is a fit or a distance to compare with', () => {
    expect(framingDistance(5, 0, 0, MIN_DISTANCE, MAX_DISTANCE)).toBe(5);
    expect(framingDistance(5, 0, 7, MIN_DISTANCE, MAX_DISTANCE)).toBe(5);
    expect(framingDistance(5, 6, 0, MIN_DISTANCE, MAX_DISTANCE)).toBe(5);
  });
});

describe('zoomRatio', () => {
  it('reports the reader zoom as a multiple of the fit and clamps it', () => {
    expect(zoomRatio(10, 5, 0.4, 2.5)).toBeCloseTo(2, 12);
    expect(zoomRatio(5, 5, 0.4, 2.5)).toBeCloseTo(1, 12);
    expect(zoomRatio(100, 5, 0.4, 2.5)).toBe(2.5);
    expect(zoomRatio(0.1, 5, 0.4, 2.5)).toBe(0.4);
  });

  it('reads as the fit itself when there is no fit yet', () => {
    expect(zoomRatio(4, Number.POSITIVE_INFINITY, 0.4, 2.5)).toBe(1);
    expect(zoomRatio(4, 0, 0.4, 2.5)).toBe(1);
    expect(zoomRatio(Number.NaN, 5, 0.4, 2.5)).toBe(1);
    expect(zoomRatio(4, 5, 1.2, 2.5)).toBe(1.2); // the clamp holds for the fallback too
  });

  it('carries the reader zoom across a layout change', () => {
    const stage = visibleStageRect(PHONE.width, PHONE.height, phoneObstacles(PHONE_SHEET_PX), PHONE.marginPx, PHONE.minSizePx);
    const fit = fitDistance(stage, PHONE.height, 40, 1, 0.9);
    const readerDistance = fit * 0.7; // zoomed in
    const ratio = zoomRatio(readerDistance, fit, 0.4, 2.5);
    const raised = visibleStageRect(PHONE.width, PHONE.height, phoneObstacles(560), PHONE.marginPx, PHONE.minSizePx);
    const newFit = fitDistance(raised, PHONE.height, 40, 1, 0.9);
    expect(newFit * ratio).toBeCloseTo(newFit * 0.7, 12);
    expect(newFit * ratio).toBeGreaterThan(readerDistance); // the taller sheet pulls back
  });
});
