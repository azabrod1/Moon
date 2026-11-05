// The fine-sphere worker's client: the probe, the timeouts and a dying worker,
// driven through a stand-in Worker class. Each test loads the module afresh, as
// its verdict and its worker are per session. The worker file itself
// (fineSphereWorker.ts) is not run here — vitest has no Worker — so its
// message protocol is covered only at run time, by the boot probe, which turns
// the path off on any mismatch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFineSphereArrays } from './fineSphereArrays';

type Mod = typeof import('./fineSpheres');

interface Posted { id: number; radius: number; width: number; height: number; leaf?: number }

class FakeWorker {
  static made: FakeWorker[] = [];
  /** Answer each message as the worker would, on the next task. */
  static autoAnswer = true;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessageerror: ((e: Event) => void) | null = null;
  posted: Posted[] = [];
  terminated = false;
  constructor() { FakeWorker.made.push(this); }
  postMessage(message: Posted): void {
    this.posted.push(message);
    if (FakeWorker.autoAnswer) setTimeout(() => this.answer(message), 0);
  }
  answer(message: Posted): void {
    if (this.terminated) return;
    const arrays = buildFineSphereArrays(message.radius, message.width, message.height, message.leaf);
    this.onmessage?.({ data: { id: message.id, ok: true, arrays, buildMs: 0 } });
  }
  terminate(): void { this.terminated = true; }
}

async function load(search = ''): Promise<Mod> {
  vi.resetModules();
  vi.stubGlobal('location', { search });
  return import('./fineSpheres');
}

const SPHERE = { radius: 4.26e-5, width: 256, height: 128, leaf: 8 };

beforeEach(() => {
  FakeWorker.made = [];
  FakeWorker.autoAnswer = true;
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the fine-sphere worker', () => {
  it('is used once its probe has come back with the main thread\'s bytes', async () => {
    const m = await load();
    expect(m.fineSphereWorkerReady()).toBeNull();
    expect(FakeWorker.made).toHaveLength(1);
    expect(FakeWorker.made[0].posted[0]).toMatchObject({ radius: 1.5, width: 16, height: 8, leaf: 4 });
    await vi.waitFor(() => expect(m.fineSphereWorkerReady()).toBe(true));
    const arrays = await m.buildFineSphereOffThread(SPHERE);
    expect(arrays).not.toBeNull();
    expect(m.sameFineSphere(arrays!, buildFineSphereArrays(SPHERE.radius, SPHERE.width, SPHERE.height, SPHERE.leaf))).toBe(true);
    expect(FakeWorker.made).toHaveLength(1); // one worker for the session
  });

  it('a request unanswered past the timeout turns the worker off and stops it', async () => {
    const m = await load();
    m.fineSphereWorkerReady();
    await vi.waitFor(() => expect(m.fineSphereWorkerReady()).toBe(true));
    vi.useFakeTimers();
    FakeWorker.autoAnswer = false;
    const out = m.buildFineSphereOffThread(SPHERE);
    vi.advanceTimersByTime(m.FINE_SPHERE_TIMEOUT_MS + 1);
    expect(await out).toBeNull();
    expect(m.fineSphereWorkerReady()).toBe(false);
    expect(FakeWorker.made[0].terminated).toBe(true);
    // Asked again, nothing is sent.
    const posted = FakeWorker.made[0].posted.length;
    expect(await m.buildFineSphereOffThread(SPHERE)).toBeNull();
    expect(FakeWorker.made[0].posted.length).toBe(posted);
  });

  it('a worker that dies settles every request out as failed', async () => {
    const m = await load();
    m.fineSphereWorkerReady();
    await vi.waitFor(() => expect(m.fineSphereWorkerReady()).toBe(true));
    FakeWorker.autoAnswer = false;
    const a = m.buildFineSphereOffThread(SPHERE);
    const b = m.buildFineSphereOffThread({ ...SPHERE, leaf: undefined });
    FakeWorker.made[0].onerror!(new Event('error'));
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(m.fineSphereWorkerReady()).toBe(false);
  });

  it('a worker that dies with nothing out turns the path off, and no unprobed replacement starts', async () => {
    const m = await load();
    m.fineSphereWorkerReady();
    await vi.waitFor(() => expect(m.fineSphereWorkerReady()).toBe(true));
    FakeWorker.made[0].onerror?.(new Event('error'));
    expect(m.fineSphereWorkerReady()).toBe(false);
    expect(m.fineSphereWorkerVerdict()).toBe(false);
    expect(FakeWorker.made[0].terminated).toBe(true);
    expect(await m.buildFineSphereOffThread(SPHERE)).toBeNull();
    expect(FakeWorker.made).toHaveLength(1);
  });

  it('a send that throws is answered at once as a failure, not left to its timer', async () => {
    const m = await load();
    m.fineSphereWorkerReady();
    await vi.waitFor(() => expect(m.fineSphereWorkerReady()).toBe(true));
    vi.useFakeTimers();
    FakeWorker.made[0].postMessage = () => { throw new DOMException('could not clone', 'DataCloneError'); };
    expect(await m.buildFineSphereOffThread(SPHERE)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(m.fineSphereWorkerReady()).toBe(false);
  });

  it('reads its verdict without starting the probe', async () => {
    const m = await load();
    expect(m.fineSphereWorkerVerdict()).toBeNull();
    expect(FakeWorker.made).toHaveLength(0);
  });

  it('a probe that never answers turns the worker off after its own, longer wait', async () => {
    vi.useFakeTimers();
    FakeWorker.autoAnswer = false;
    const m = await load();
    expect(m.fineSphereWorkerReady()).toBeNull();
    await vi.advanceTimersByTimeAsync(m.FINE_SPHERE_TIMEOUT_MS + 1);
    expect(m.fineSphereWorkerReady()).toBeNull(); // still waiting: a slow start is not a hang
    await vi.advanceTimersByTimeAsync(m.FINE_SPHERE_PROBE_TIMEOUT_MS);
    expect(m.fineSphereWorkerReady()).toBe(false);
    expect(FakeWorker.made[0].terminated).toBe(true);
  });

  it('?sphereworker=0, or no Worker at all, answers false at once and starts nothing', async () => {
    const off = await load('?sphereworker=0');
    expect(off.fineSphereWorkerReady()).toBe(false);
    expect(FakeWorker.made).toHaveLength(0);
    vi.stubGlobal('Worker', undefined);
    const none = await load();
    expect(none.fineSphereWorkerReady()).toBe(false);
  });
});

describe('the worker\'s arrays', () => {
  it('make a SphereGeometry byte for byte as three builds it, laid out as groundCull lays it', async () => {
    const THREE = await import('three');
    const { sphereFromArrays } = await import('./fineSphereArrays');
    const { groundIndexOf, layGroundIndex } = await import('./groundCull');
    for (const leaf of [undefined, 8]) {
      const { geometry, ground } = sphereFromArrays(buildFineSphereArrays(SPHERE.radius, 256, 128, leaf));
      const fresh = new THREE.SphereGeometry(SPHERE.radius, 256, 128);
      const freshGround = leaf === undefined ? undefined : layGroundIndex(fresh, leaf);
      expect(geometry).toBeInstanceOf(THREE.SphereGeometry);
      expect(geometry.parameters).toEqual(fresh.parameters);
      for (const name of ['position', 'normal', 'uv'] as const) {
        const a = geometry.getAttribute(name);
        const b = fresh.getAttribute(name);
        expect([a.itemSize, a.normalized, a.count]).toEqual([b.itemSize, b.normalized, b.count]);
        expect(Buffer.from((a.array as Float32Array).buffer).equals(Buffer.from((b.array as Float32Array).buffer))).toBe(true);
      }
      const ia = geometry.index!.array as Uint16Array;
      const ib = fresh.index!.array as Uint16Array;
      expect(ia.constructor).toBe(ib.constructor);
      expect(Buffer.from(ia.buffer, ia.byteOffset, ia.byteLength).equals(Buffer.from(ib.buffer, ib.byteOffset, ib.byteLength))).toBe(true);
      expect(geometry.drawRange).toEqual(fresh.drawRange);
      expect(geometry.groups).toEqual(fresh.groups);
      if (leaf === undefined) {
        expect(ground).toBeUndefined();
      } else {
        expect(groundIndexOf(geometry)).toBe(ground);
        expect([ground!.full, ground!.cols, ground!.rows]).toEqual([freshGround!.full, freshGround!.cols, freshGround!.rows]);
        expect(Buffer.from(ground!.start.buffer).equals(Buffer.from(freshGround!.start.buffer))).toBe(true);
      }
    }
  });
});
