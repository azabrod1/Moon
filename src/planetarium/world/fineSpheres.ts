/**
 * A body's fine spheres built off the main thread.
 *
 * Building a 256 × 128 sphere and laying out its streamed-ground index is
 * arithmetic over about 33,000 vertices and 65,000 triangles. Built a piece
 * per frame on the main thread (PlanetFactory's silhouette upgrade), each piece
 * measured 1.3–5 ms on an M5 Max under Chrome. The session's first one, on
 * code the engine had not yet optimised, measured 7–13 ms, a 12–21 ms frame
 * and one missed refresh at 120 Hz. A phone pays several times either figure.
 * So the arrays are built in a worker (world/fineSphereWorker) and come back
 * by transfer. What the main thread pays per sphere is wrapping arrays it
 * already owns into a geometry (world/fineSphereArrays `sphereFromArrays`).
 *
 * The worker runs three's own SphereGeometry and groundCull's own layout, so
 * the bytes are the bytes the main thread would have built. The probe checks
 * that on this device before any real sphere is asked for: a small sphere,
 * laid out, built both here and there and compared byte for byte.
 *
 * Fail-open, to the piece-per-frame build on the main thread, which is exact
 * and is what shipped:
 * - no Worker constructor;
 * - `?sphereworker=0`, which works on any build so the A/B can be run on the
 *   device that has the question;
 * - a probe that does not come back identical;
 * - a worker that fails to start or dies, or a reply that cannot be read;
 * - a request unanswered after FINE_SPHERE_TIMEOUT_MS, or after
 *   FINE_SPHERE_PROBE_TIMEOUT_MS for the probe (whose wait includes fetching
 *   and starting the worker).
 * Any failure turns the worker off for the session, settles every request in
 * flight as failed, and stops the worker, so nothing waits on a reply that
 * will not come and nothing asks a broken worker again. A body whose request
 * fails builds the rest of its spheres on the main thread from its next
 * frame. A swap that comes before a reply builds on the spot, as it always
 * has, and the late reply is dropped.
 */
import { debugWarn } from '../../shared/debug';
import { smoothTraceEvent } from '../smoothnessTrace';
import { buildFineSphereArrays, type FineSphereArrays } from './fineSphereArrays';

export interface FineSphereRequest {
  radius: number;
  width: number;
  height: number;
  /** Lay the ground index out for this leaf too. */
  leaf?: number;
}

export type FineSphereReply =
  | { ok: true; arrays: FineSphereArrays; buildMs: number }
  | { ok: false; error: string };

/** How long a sphere may be out before the worker is given up on. A request
 *  is a few milliseconds of work on a desktop and tens on a slow phone, so
 *  this is a hang, not a slow device. */
export const FINE_SPHERE_TIMEOUT_MS = 4000;
/** The probe's wait also covers fetching the worker's script and starting it,
 *  which a slow connection can make seconds long without anything being
 *  wrong. Until it answers, the pre-build waits; a swap in that window builds
 *  on the spot, as it did before the pre-build existed. */
export const FINE_SPHERE_PROBE_TIMEOUT_MS = 15000;

/** The probe's sphere: small, but laid out, on a grid whose leaves are a
 *  power of two each way, as the layout requires. */
const PROBE: FineSphereRequest = { radius: 1.5, width: 16, height: 8, leaf: 4 };

/** `?sphereworker=0` builds every fine sphere on the main thread. Read once,
 *  lazily, so module load stays DOM-free. */
let allowed: boolean | null = null;
function workerPathAllowed(): boolean {
  if (allowed === null) {
    allowed = !(typeof location !== 'undefined'
      && new URLSearchParams(location.search).get('sphereworker') === '0');
  }
  return allowed;
}

// ------------------------------------------------------------------ the worker

interface Pending {
  settle: (reply: FineSphereReply) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function settleAll(error: string): void {
  const waiting = [...pending.values()];
  pending.clear();
  for (const p of waiting) {
    clearTimeout(p.timer);
    p.settle({ ok: false, error });
  }
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker !== 'function') return null;
  try {
    const startedAt = performance.now();
    worker = new Worker(new URL('./fineSphereWorker.ts', import.meta.url), { type: 'module' });
    smoothTraceEvent('warm', 'fine sphere worker', performance.now() - startedAt);
  } catch (err) {
    debugWarn('Fine sphere worker unavailable', { err: String(err) });
    return null;
  }
  worker.onmessage = (event: MessageEvent<{ id: number } & FineSphereReply>) => {
    const p = pending.get(event.data.id);
    if (!p) return;
    pending.delete(event.data.id);
    clearTimeout(p.timer);
    p.settle(event.data);
  };
  // The instance is captured: an error event is a task of its own, and a
  // replacement must never be stopped by its predecessor's. A worker that dies
  // turns the path off for the session, whether or not a request was out:
  // the next request would otherwise start a replacement no probe has checked.
  const dying = worker;
  const abandon = (event: Event) => {
    event.preventDefault?.();
    if (worker !== dying) return;
    giveUp('the fine sphere worker failed');
  };
  worker.onerror = abandon;
  worker.onmessageerror = abandon;
  return worker;
}

function ask(request: FineSphereRequest, timeoutMs: number): Promise<FineSphereReply> {
  const live = ensureWorker();
  if (!live) return Promise.resolve({ ok: false, error: 'no worker' });
  const id = nextId++;
  return new Promise<FineSphereReply>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      resolve({ ok: false, error: `no reply in ${timeoutMs} ms` });
    }, timeoutMs);
    pending.set(id, { settle: resolve, timer });
    try {
      live.postMessage({ ...request, id });
    } catch (err) {
      // A send that throws has no reply coming: answer now, as a failure, so
      // the caller builds the sphere itself rather than wait out the timer.
      pending.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, error: `the request could not be sent: ${String(err)}` });
    }
  });
}

/**
 * The worker round trip, as one replaceable function, so the tests can drive
 * the off-thread path — its wrap, its late replies, its failures — without a
 * real worker. Replacing it forgets the probe's verdict, so an injected round
 * trip is probed itself. Nothing in the app calls this.
 */
let roundTrip: (request: FineSphereRequest, timeoutMs: number) => Promise<FineSphereReply> = ask;
let injected = false;
export function setFineSphereRoundTrip(next: typeof roundTrip | null): void {
  roundTrip = next ?? ask;
  injected = next !== null;
  verdict = null;
  probing = false;
}

// ------------------------------------------------------------------ the verdict

/** true: build off the main thread; false: on it; null: the probe is out. */
let verdict: boolean | null = null;
let probing = false;

/** Turn the worker off for the rest of the session. */
function giveUp(reason: string): void {
  verdict = false;
  debugWarn('Fine spheres build on the main thread', { reason });
  if (worker) {
    const dead = worker;
    worker = null;
    dead.terminate();
  }
  settleAll(reason);
}

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.constructor !== b.constructor || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Whether two builds are the same sphere: parameters, every array, and the
 *  layout's grid and starts. */
export function sameFineSphere(a: FineSphereArrays, b: FineSphereArrays): boolean {
  if (JSON.stringify(a.parameters) !== JSON.stringify(b.parameters)) return false;
  if (!sameBytes(a.position, b.position) || !sameBytes(a.normal, b.normal) || !sameBytes(a.uv, b.uv)) return false;
  if (!sameBytes(a.index, b.index)) return false;
  if (!a.layout || !b.layout) return !a.layout && !b.layout;
  return a.layout.leaf === b.layout.leaf && a.layout.full === b.layout.full
    && a.layout.cols === b.layout.cols && a.layout.rows === b.layout.rows
    && sameBytes(a.layout.index, b.layout.index) && sameBytes(a.layout.start, b.layout.start);
}

function startProbe(): void {
  probing = true;
  const askedAt = performance.now();
  const asked = roundTrip;
  void asked(PROBE, FINE_SPHERE_PROBE_TIMEOUT_MS).then((reply) => {
    if (roundTrip !== asked) return; // replaced while out (tests only)
    probing = false;
    const ok = reply.ok
      && sameFineSphere(reply.arrays, buildFineSphereArrays(PROBE.radius, PROBE.width, PROBE.height, PROBE.leaf));
    smoothTraceEvent('warm', `fine sphere worker probe ${ok}`, performance.now() - askedAt);
    if (ok) verdict = true;
    else giveUp(reply.ok ? 'the probe built different bytes' : reply.error);
  });
}

/**
 * Whether fine spheres are built off the main thread: true, false, or null
 * while the probe is out. The first question starts the probe, if the boot
 * has not already (`warmFineSphereWorker`); a platform with no workers, or
 * `?sphereworker=0`, answers false at once.
 */
export function fineSphereWorkerReady(): boolean | null {
  if (verdict !== null) return verdict;
  if (!workerPathAllowed() || (!injected && typeof Worker !== 'function')) {
    verdict = false;
    return false;
  }
  if (!probing) startProbe();
  return null;
}

/** The verdict as it stands, without asking: never starts the probe. For a
 *  per-frame reader that only needs to know whether the worker is building. */
export function fineSphereWorkerVerdict(): boolean | null {
  return verdict;
}

/** Start the worker and its probe in the boot's idle, so its script fetch and
 *  start are not paid when the first approach asks. */
export function warmFineSphereWorker(): void {
  fineSphereWorkerReady();
}

/**
 * One fine sphere, built off the main thread: its arrays, or null when the
 * worker path failed — in which case it is off for the session and the caller
 * builds on the main thread. Only asked once the verdict is true.
 */
export async function buildFineSphereOffThread(request: FineSphereRequest): Promise<FineSphereArrays | null> {
  if (verdict !== true) return null;
  const reply = await roundTrip(request, FINE_SPHERE_TIMEOUT_MS);
  if (reply.ok) return reply.arrays;
  if (verdict === true) giveUp(reply.error);
  return null;
}
