/**
 * A body's fine sphere built off the main thread (world/fineSpheres).
 *
 * Three's own SphereGeometry and world/groundCull's own layout, run here
 * (world/fineSphereArrays), and every array handed back by transfer, so the
 * reply copies nothing and this worker holds nothing once it has answered.
 * Requests are answered in the order they arrive, one at a time: each is a
 * few milliseconds of arithmetic with no await in it.
 *
 * A probe is the same build at a small grid. The main thread builds that
 * sphere itself and compares the bytes, so a worker that cannot load three or
 * builds anything other than the main thread would is caught before a real
 * sphere is asked for.
 */
import { buildFineSphereArrays, fineSphereTransfer, type FineSphereArrays } from './fineSphereArrays';

interface BuildRequest {
  id: number;
  radius: number;
  width: number;
  height: number;
  leaf?: number;
}

type BuildReply =
  | { id: number; ok: true; arrays: FineSphereArrays; buildMs: number }
  | { id: number; ok: false; error: string };

/** The worker global, typed by hand: this project's tsconfig carries the DOM
 *  lib (the app is a page), and the WebWorker lib cannot be added beside it. */
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<BuildRequest>) => void) | null;
  postMessage(data: BuildReply, transfer?: Transferable[]): void;
};

ctx.onmessage = (event: MessageEvent<BuildRequest>) => {
  const { id, radius, width, height, leaf } = event.data;
  try {
    const startedAt = performance.now();
    const arrays = buildFineSphereArrays(radius, width, height, leaf);
    const buildMs = performance.now() - startedAt;
    ctx.postMessage({ id, ok: true, arrays, buildMs }, fineSphereTransfer(arrays));
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};

export {};
