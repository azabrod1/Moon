import { describe, expect, it } from 'vitest';
import { ToolChunkLoadFailure, describeModeSwitchFailure, loadToolChunk } from './modeSwitchFailure';

describe('loadToolChunk', () => {
  it('passes a chunk that arrives straight through', async () => {
    const chunkModule = { InteriorMode: class {} };
    await expect(loadToolChunk('Look inside', Promise.resolve(chunkModule))).resolves.toBe(chunkModule);
  });

  it('wraps a chunk that will not load, keeping the cause', async () => {
    const fetchError = new TypeError('Failed to fetch dynamically imported module');
    const failure = await loadToolChunk('Look inside', Promise.reject(fetchError)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolChunkLoadFailure);
    expect((failure as ToolChunkLoadFailure).toolName).toBe('Look inside');
    expect((failure as ToolChunkLoadFailure).cause).toBe(fetchError);
  });
});

describe('describeModeSwitchFailure', () => {
  it('a missing chunk is a connection or stale-tab problem, and offers a reload', () => {
    const notice = describeModeSwitchFailure(new ToolChunkLoadFailure('Look inside', new TypeError('404')), 'Look inside');
    expect(notice.action).toBe('reload');
    expect(notice.text).toMatch(/^Look inside could not be downloaded/);
    expect(notice.text).toMatch(/Reload to try again/);
  });

  it('anything else is a fault in the app, and does not blame the connection', () => {
    for (const thrown of [new Error('applyRawShaderCut: the shader changed shape'), new TypeError('x is not a function'), 'a string', undefined]) {
      const notice = describeModeSwitchFailure(thrown, 'How many fit?');
      expect(notice.action).toBeNull();
      expect(notice.text).toMatch(/^How many fit\? hit a problem/);
      expect(notice.text).not.toMatch(/Reload/);
    }
  });
});
