import { afterEach, describe, expect, it } from 'vitest';
import {
  causeNames,
  inWindows,
  percentile,
  SMOOTH_CAUSES,
  smoothTraceClear,
  smoothTraceEvent,
  smoothTraceFrameStart,
  smoothTraceSnapshot,
  smoothTraceStart,
  smoothTraceStop,
  smoothTraceVeil,
  summarizeFrames,
  veilWindows,
} from './smoothnessTrace';

const bit = (cause: (typeof SMOOTH_CAUSES)[number]): number => 1 << SMOOTH_CAUSES.indexOf(cause);

afterEach(() => {
  smoothTraceClear();
});

describe('cause tags', () => {
  it('round-trips a mask back to its one-word names', () => {
    expect(causeNames(bit('tile') | bit('upload'))).toEqual(['tile', 'upload']);
    expect(causeNames(0)).toEqual([]);
  });
});

describe('percentile', () => {
  it('takes the nearest rank, so p99 of 100 samples is the second worst', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 0.5)).toBe(50);
    expect(percentile(sorted, 0.95)).toBe(95);
    expect(percentile(sorted, 0.99)).toBe(99);
  });

  it('answers 0 for an empty sample rather than NaN', () => {
    expect(percentile([], 0.99)).toBe(0);
  });
});

describe('veilWindows', () => {
  it('dilates each run by the straddling frame on either side', () => {
    const veil = bit('veil');
    const mask = [0, 0, veil, veil, 0, 0];
    expect(veilWindows(mask)).toEqual([{ from: 1, to: 4 }]);
  });

  it('clamps a run that starts at the first frame', () => {
    const veil = bit('veil');
    expect(veilWindows([veil, veil, 0])).toEqual([{ from: 0, to: 2 }]);
  });

  it('closes a run still open at the last frame', () => {
    const veil = bit('veil');
    expect(veilWindows([0, veil, veil])).toEqual([{ from: 0, to: 2 }]);
  });

  it('keeps separate runs separate', () => {
    const veil = bit('veil');
    expect(veilWindows([veil, 0, 0, 0, veil])).toEqual([
      { from: 0, to: 1 },
      { from: 3, to: 4 },
    ]);
  });

  it('reports none when nothing was veiled', () => {
    expect(veilWindows([0, bit('tile'), 0])).toEqual([]);
    expect(inWindows(1, [])).toBe(false);
  });
});

describe('summarizeFrames', () => {
  it('scores only the frames that were on screen', () => {
    const veil = bit('veil');
    // Frames 2..3 are veiled; 1 and 4 straddle the transitions. The 500 ms
    // hitch inside the cut must not count against the run.
    const gaps = [16, 16, 500, 16, 16, 16, 16];
    const mask = [0, 0, veil, veil, 0, 0, 0];
    const summary = summarizeFrames(gaps, mask);
    expect(summary.frames).toBe(7);
    expect(summary.scored).toBe(3);
    expect(summary.maxMs).toBe(16);
    expect(summary.over33).toBe(0);
  });

  it('counts the frames over one and two extra vsyncs', () => {
    const gaps = [16, 34, 16, 60, 16];
    const summary = summarizeFrames(gaps, [0, 0, 0, 0, 0]);
    expect(summary.over33).toBe(2);
    expect(summary.over50).toBe(1);
    expect(summary.maxMs).toBe(60);
    expect(summary.meanMs).toBe(28.4);
  });

  it('ignores the first frame, which has no predecessor to measure against', () => {
    const summary = summarizeFrames([null, 16, 16], [0, 0, 0]);
    expect(summary.scored).toBe(2);
  });
});

describe('recorder', () => {
  it('records a gap per frame and tags the open frame', () => {
    expect(smoothTraceStart({ armedBy: 'test' })).toBe(true);
    smoothTraceFrameStart(1_000);
    smoothTraceFrameStart(1_016);
    smoothTraceEvent('tile', 'Earth sector 3_1');
    smoothTraceVeil(true);
    smoothTraceFrameStart(1_100);
    const trace = smoothTraceStop();
    expect(trace?.frames).toBe(3);
    expect(trace?.gapMs).toEqual([null, 16, 84]);
    expect(causeNames(trace!.causeMask[1])).toEqual(['veil', 'tile']);
    expect(trace?.events[0]).toMatchObject({ frame: 1, kind: 'tile', name: 'Earth sector 3_1' });
  });

  it('stops recording at the ring end instead of growing or wrapping', () => {
    smoothTraceStart({}, 2);
    smoothTraceFrameStart(0);
    smoothTraceFrameStart(16);
    smoothTraceFrameStart(32);
    const trace = smoothTraceSnapshot();
    expect(trace?.frames).toBe(2);
    expect(trace?.dropped).toBe(1);
  });

  it('reads nothing before it is armed', () => {
    expect(smoothTraceSnapshot()).toBeNull();
    expect(smoothTraceStop()).toBeNull();
  });
});
