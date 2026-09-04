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
