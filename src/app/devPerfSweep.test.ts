import { describe, expect, it } from 'vitest';
import {
  baselineDriftNote,
  median,
  summarizeFrames,
  throttleVerdict,
  type FrameSample,
} from './devPerfSweep';

/** Frames arriving `gapMs` apart from `startMs`, each `busyMs` long. */
function frames(startMs: number, gapMs: number, count: number, busyMs: number): FrameSample[] {
  return Array.from({ length: count }, (_, i) => ({ atMs: startMs + i * gapMs, busyMs }));
}

describe('median', () => {
  it('is 0 for nothing', () => {
    expect(median([])).toBe(0);
  });

  it('takes the middle of an odd count and the mean of the middle pair', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('ignores a single outlier, which is why the frame cost uses it', () => {
    expect(median([8, 8, 8, 8, 400])).toBe(8);
  });
});

describe('summarizeFrames', () => {
  it('counts gaps, not samples: 61 frames 16.67 ms apart is 60 fps', () => {
    const summary = summarizeFrames(frames(0, 1000 / 60, 61, 5), 0);
    expect(summary.frames).toBe(61);
    expect(summary.fps).toBeCloseTo(60, 6);
    expect(summary.frameMs).toBeCloseTo(1000 / 60, 6);
    expect(summary.busyMs).toBe(5);
  });

  it('drops everything before the settle point', () => {
    const settling = frames(0, 100, 10, 40);
    const held = frames(1000, 1000 / 30, 121, 6);
    const summary = summarizeFrames([...settling, ...held], 1000);
    expect(summary.frames).toBe(121);
    expect(summary.fps).toBeCloseTo(30, 6);
    expect(summary.busyMs).toBe(6);
  });

  it('reports no rate from fewer than two frames', () => {
    expect(summarizeFrames(frames(0, 16, 1, 9), 0)).toEqual({
      frames: 1, fps: 0, frameMs: 0, busyMs: 9,
    });
    expect(summarizeFrames([], 0).fps).toBe(0);
  });
});

describe('throttleVerdict', () => {
  it('calls the rows real costs when the control runs at rate', () => {
    expect(throttleVerdict({ fps: 60, busyMs: 4 })).toMatch(/real costs/);
  });

  it('names an outside cap when the control is slow on an idle main thread', () => {
    // 31 fps is a 32 ms frame; 6 ms of work cannot be what paces it.
    expect(throttleVerdict({ fps: 31, busyMs: 6 })).toMatch(/capped from outside the app/);
  });

  it('blames work the sweep cannot switch off when the thread is busy', () => {
    const verdict = throttleVerdict({ fps: 30, busyMs: 25 });
    expect(verdict).not.toMatch(/capped from outside/);
    expect(verdict).toMatch(/cannot switch off/);
  });

  it('says so when nothing was measured', () => {
    expect(throttleVerdict({ fps: 0, busyMs: 0 })).toMatch(/no frames/);
  });
});

describe('baselineDriftNote', () => {
  it('is silent while the two baselines agree', () => {
    expect(baselineDriftNote(60, 58)).toBe('');
  });

  it('warns once the baseline has moved under the sweep', () => {
    expect(baselineDriftNote(60, 40)).toMatch(/baseline moved from 60 to 40/);
  });

  it('is silent when a baseline measured nothing', () => {
    expect(baselineDriftNote(0, 40)).toBe('');
    expect(baselineDriftNote(60, 0)).toBe('');
  });
});
