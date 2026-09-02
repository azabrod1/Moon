/**
 * Sector-tile decode, off the main thread.
 *
 * A 2048² tile handed to the GPU as an ImageBitmap makes the driver convert
 * that source inside the upload call, which measured 7.3 ms on throttled phone
 * silicon against 1.4 ms for the same picture as raw bytes. This worker is
 * where those bytes come from, and it runs off the main thread because the two
 * steps that produce them — a full-size draw and a full-size readback — would
 * each cost more than the upload they exist to cheapen.
 *
 * The vertical flip is the canvas transform below, not `imageOrientation`:
 * the bytes must land in exactly the order the ImageBitmap path produces (it
 * bakes the flip into the bitmap, and sectorTileTransform's offsetY assumes
 * it), and a transform is defined by the 2D canvas spec on every engine while
 * the bitmap option can be quietly ignored.
 *
 * Tiles are opaque — the pipeline cuts them as lossy VP8 with no alpha
 * channel, which the caller checks before sending one here — so the 2D
 * canvas's premultiply/un-premultiply round trip is exact. It would not be for
 * a map with real transparency.
 *
 * The reply transfers the pixel buffer, so nothing here is copied on the way
 * out and this worker holds no memory once a message is answered.
 */

interface DecodeRequest {
  id: number;
  /** The tile's bytes. Absent on a probe. */
  blob?: Blob;
  /** Run the round trip on a known 1×2 image and report what came back. */
  probe?: boolean;
}

type DecodeReply =
  | { id: number; ok: true; width: number; height: number; buffer: ArrayBuffer }
  | { id: number; ok: true; probe: true; flipped: boolean }
  | { id: number; ok: false; error: string };

/** The worker global, typed by hand: this project's tsconfig carries the DOM
 *  lib (the app is a page), and the WebWorker lib cannot be added beside it. */
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(data: DecodeReply, transfer?: Transferable[]): void;
};

/** Decode a source into flipped, tightly packed RGBA bytes. */
async function toPixels(source: Blob | ImageData): Promise<ImageData> {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    // willReadFrequently keeps the surface on the CPU: the whole point here is
    // the readback, and a GPU-backed canvas would pay a stall for every one.
    const draw = canvas.getContext('2d', { willReadFrequently: true });
    if (!draw) throw new Error('no 2d context in this worker');
    draw.translate(0, bitmap.height);
    draw.scale(1, -1);
    draw.drawImage(bitmap, 0, 0);
    return draw.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

ctx.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const { id, blob, probe } = event.data;
  void (async () => {
    try {
      if (probe) {
        // White over black, which must come back black over white. A silently
        // failed draw reads back transparent zeros, so opacity is checked too
        // rather than letting "dark first row" pass for a working flip.
        const sample = new ImageData(1, 2);
        sample.data.set([255, 255, 255, 255, 0, 0, 0, 255]);
        const out = await toPixels(sample);
        const px = out.data;
        ctx.postMessage({
          id,
          ok: true,
          probe: true,
          flipped: px[0] < 128 && px[3] > 128 && px[4] > 128 && px[7] > 128,
        });
        return;
      }
      if (!blob) throw new Error('no bytes to decode');
      const image = await toPixels(blob);
      const buffer = image.data.buffer as ArrayBuffer;
      ctx.postMessage(
        { id, ok: true, width: image.width, height: image.height, buffer },
        [buffer],
      );
    } catch (err) {
      ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
};

export {};
