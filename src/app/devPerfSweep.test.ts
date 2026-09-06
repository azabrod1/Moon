import { describe, expect, it } from 'vitest';
import {
  bracketFrameMs,
  median,
  shuffled,
  summarizeFrames,
  thermalDriftLine,
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

  it('splits the frame into the main thread and everything else', () => {
    // 30 fps frames with 6 ms of app work: 27.3 ms is somewhere else.
    const summary = summarizeFrames(frames(0, 1000 / 30, 61, 6), 0);
    expect(summary.busyMs).toBe(6);
    expect(summary.offMainMs).toBeCloseTo(1000 / 30 - 6, 6);
  });

  it('never reports negative time off the main thread', () => {
    // Busy longer than the gap (overlapping probe spans) must not go below 0.
    const summary = summarizeFrames(frames(0, 8, 20, 40), 0);
    expect(summary.offMainMs).toBe(0);
  });

  it('drops everything before the settle point', () => {
    const settling = frames(0, 100, 10, 40);
    const held = frames(1000, 1000 / 30, 61, 6);
    const summary = summarizeFrames([...settling, ...held], 1000);
    expect(summary.frames).toBe(61);
    expect(summary.fps).toBeCloseTo(30, 6);
    expect(summary.busyMs).toBe(6);
  });

  it('reports no rate from fewer than two frames', () => {
    expect(summarizeFrames(frames(0, 16, 1, 9), 0)).toEqual({
      frames: 1, fps: 0, frameMs: 0, busyMs: 9, offMainMs: 0,
    });
    expect(summarizeFrames([], 0).fps).toBe(0);
  });
});

describe('bracketFrameMs', () => {
  it('averages the baselines either side, so a steady slide cancels', () => {
    // A device sliding 16 -> 20 ms; the row between them is charged 18.
    expect(bracketFrameMs({ frameMs: 16 }, { frameMs: 20 })).toBe(18);
  });

  it('falls back to whichever neighbour it has', () => {
    expect(bracketFrameMs({ frameMs: 16 }, undefined)).toBe(16);
    expect(bracketFrameMs(undefined, { frameMs: 20 })).toBe(20);
    expect(bracketFrameMs({ frameMs: 0 }, { frameMs: 20 })).toBe(20);
  });

  it('is 0 when neither neighbour measured anything', () => {
    expect(bracketFrameMs(undefined, undefined)).toBe(0);
    expect(bracketFrameMs({ frameMs: 0 }, { frameMs: 0 })).toBe(0);
  });
});

describe('shuffled', () => {
  it('returns a permutation and leaves the input alone', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    const out = shuffled(input, () => 0.5);
    expect([...out].sort()).toEqual([...input].sort());
    expect(input).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('really reorders: a fixed draw of 0 rotates the list', () => {
    expect(shuffled(['a', 'b', 'c'], () => 0)).not.toEqual(['a', 'b', 'c']);
  });

  it('handles the empty and single cases', () => {
    expect(shuffled([])).toEqual([]);
    expect(shuffled(['only'])).toEqual(['only']);
  });
});

describe('throttleVerdict', () => {
  it('calls the rows real costs when the control runs at rate', () => {
    expect(throttleVerdict({ fps: 60, busyMs: 4 })).toMatch(/real costs/);
  });

  it('names an outside cap when the control is slow on an idle main thread', () => {
    // The phone's own control: 60 fps was reached, but at 31 fps with 2 ms of
    // work the frame is not the app's.
    expect(throttleVerdict({ fps: 31, busyMs: 2 })).toMatch(/capped from outside the app/);
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

describe('thermalDriftLine', () => {
  it('lists every baseline in the order it was taken', () => {
    expect(thermalDriftLine([{ fps: 54 }, { fps: 53 }, { fps: 54 }]))
      .toBe('Baselines: 54 → 53 → 54 fps — steady.');
  });

  it('names the loss once the device has slid under the run', () => {
    const line = thermalDriftLine([{ fps: 54 }, { fps: 48 }, { fps: 40 }, { fps: 44 }]);
    expect(line).toMatch(/54 → 48 → 40 → 44 fps/);
    expect(line).toMatch(/lost 26%/);
    expect(line).toMatch(/against its own two baselines/);
  });

  it('measures the fall against the worst reading, not the last', () => {
    // A device that dipped and recovered still measured its rows while low.
    expect(thermalDriftLine([{ fps: 60 }, { fps: 30 }, { fps: 59 }])).toMatch(/lost 50%/);
  });

  it('is silent with nothing to compare', () => {
    expect(thermalDriftLine([])).toBe('');
    expect(thermalDriftLine([{ fps: 60 }])).toBe('');
  });
});
