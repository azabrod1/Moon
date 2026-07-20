import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSurfacePerf,
  installSurfacePerfInputTracing,
  startSurfacePerf,
  surfacePerfBeginRender,
  surfacePerfBeginSpan,
  surfacePerfBeginTextureUpload,
  surfacePerfEndRender,
  surfacePerfEndSpan,
  surfacePerfEndTextureUpload,
  surfacePerfFrameStart,
  surfacePerfSnapshot,
} from './surfacePerf';

afterEach(() => {
  clearSurfacePerf();
  vi.unstubAllGlobals();
});

describe('surfacePerf DEV trace', () => {
  it('summarizes bounded render, program, texture and upload measurements', () => {
    startSurfacePerf({ programs: 3, textures: 2 });
    const span = surfacePerfBeginSpan('enterSurfaceView');
    surfacePerfEndSpan(span);
    surfacePerfFrameStart(performance.now());
    const render = surfacePerfBeginRender(3, 2);
    surfacePerfEndRender(render, 4, 3);
    const upload = surfacePerfBeginTextureUpload({
      name: 'Moon albedo',
      image: { width: 4096, height: 2048 },
    });
    surfacePerfEndTextureUpload(upload);

    const snapshot = surfacePerfSnapshot() as {
      summary: Record<string, number>;
      samples: { spans: unknown[]; renders: unknown[]; uploads: Array<{ width: number; height: number }> };
    };
    expect(snapshot.summary.programDelta).toBe(1);
    expect(snapshot.summary.textureDelta).toBe(1);
    expect(snapshot.summary.renderCount).toBe(1);
    expect(snapshot.summary.textureUploads).toBe(1);
    expect(snapshot.samples.spans).toHaveLength(1);
    expect(snapshot.samples.renders).toHaveLength(1);
    expect(snapshot.samples.uploads[0]).toMatchObject({ width: 4096, height: 2048 });
  });

  it('keeps the true following frame after the bounded frame ring rolls over', () => {
    const listeners = new Map<string, (event: { target: unknown; timeStamp: number }) => void>();
    class FakeElement {
      id = 'surface-swap';
      closest() { return this; }
    }
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      hasFocus: () => true,
      addEventListener: (phase: string, listener: (event: { target: unknown; timeStamp: number }) => void) => {
        listeners.set(phase, listener);
      },
    });
    installSurfacePerfInputTracing();
    startSurfacePerf({ programs: 0, textures: 0 });
    const inputAtMs = performance.now();
    listeners.get('pointerup')!({ target: new FakeElement(), timeStamp: inputAtMs });
    listeners.get('pointerup')!({ target: new FakeElement(), timeStamp: inputAtMs + 1 });
    // Model the WebKit failure the trace diagnosed: both pointer gestures
    // arrived, but only one produced the synthetic click.
    listeners.get('click')!({ target: new FakeElement(), timeStamp: inputAtMs + 2 });

    const firstFrameMs = performance.now() + 5;
    surfacePerfFrameStart(firstFrameMs);
    for (let i = 1; i <= 300; i++) surfacePerfFrameStart(firstFrameMs + i * 8);

    const snapshot = surfacePerfSnapshot() as {
      summary: {
        clicksMissingAfterPointerUp: number;
        followingFrames: Array<{ clickToFrameMs: number | null; frameGapMs: number | null }>;
        pointerUpFollowingFrames: Array<{ pointerUpToFrameMs: number | null }>;
      };
    };
    expect(snapshot.summary.clicksMissingAfterPointerUp).toBe(1);
    expect(snapshot.summary.pointerUpFollowingFrames).toHaveLength(2);
    expect(snapshot.summary.followingFrames).toHaveLength(1);
    expect(snapshot.summary.followingFrames[0].clickToFrameMs).not.toBeNull();
    expect(snapshot.summary.followingFrames[0].clickToFrameMs!).toBeLessThan(20);
  });
});
