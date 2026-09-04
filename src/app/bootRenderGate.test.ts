import { describe, expect, it } from 'vitest';
import { BootRenderGate } from './bootRenderGate';

describe('BootRenderGate', () => {
  it('draws nothing under the cover until a render is requested', () => {
    const gate = new BootRenderGate();
    expect(gate.current).toBe('covered');
    expect(gate.shouldRender()).toBe(false);
    expect(gate.shouldRender()).toBe(false);
    expect(gate.coveredRenders).toBe(0);
  });

  it('draws exactly one frame per request under the cover', () => {
    const gate = new BootRenderGate();
    gate.requestCoveredRender();
    gate.requestCoveredRender();
    expect(gate.shouldRender()).toBe(true);
    expect(gate.shouldRender()).toBe(false);
    expect(gate.coveredRenders).toBe(1);
    gate.requestCoveredRender();
    expect(gate.shouldRender()).toBe(true);
    expect(gate.coveredRenders).toBe(2);
  });

  it('draws every frame once live, and a stale request does not count', () => {
    const gate = new BootRenderGate();
    gate.requestCoveredRender();
    gate.markLive();
    expect(gate.current).toBe('live');
    for (let i = 0; i < 5; i++) expect(gate.shouldRender()).toBe(true);
    expect(gate.coveredRenders).toBe(0);
  });

  it('ignores requests once live (they are for the cover)', () => {
    const gate = new BootRenderGate();
    gate.markLive();
    gate.requestCoveredRender();
    expect(gate.shouldRender()).toBe(true);
    expect(gate.coveredRenders).toBe(0);
  });

  it('counts the reveal draw with the covered ones and satisfies a pending request', () => {
    const gate = new BootRenderGate();
    gate.requestCoveredRender();
    expect(gate.shouldRender()).toBe(true);
    gate.requestCoveredRender();
    expect(gate.revealRender()).toBe(true);
    expect(gate.coveredRenders).toBe(2);
    gate.markLive();
    // Live: the reveal draw is just a frame, not a covered one.
    expect(gate.revealRender()).toBe(true);
    expect(gate.coveredRenders).toBe(2);
  });

  it('keeps a failed boot failed: no reveal draw, and markLive does not revive it', () => {
    const gate = new BootRenderGate();
    gate.markFailed();
    expect(gate.revealRender()).toBe(false);
    gate.markLive();
    expect(gate.current).toBe('failed');
    expect(gate.shouldRender()).toBe(false);
    expect(gate.coveredRenders).toBe(0);
  });

  it('draws nothing at all once the boot has failed, even after a request or from live', () => {
    const gate = new BootRenderGate();
    gate.requestCoveredRender();
    gate.markFailed();
    expect(gate.current).toBe('failed');
    expect(gate.shouldRender()).toBe(false);
    gate.requestCoveredRender();
    expect(gate.shouldRender()).toBe(false);
    const live = new BootRenderGate();
    live.markLive();
    live.markFailed();
    expect(live.shouldRender()).toBe(false);
  });
});
