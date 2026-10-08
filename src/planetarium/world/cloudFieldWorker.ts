/**
 * A cloud-field page decoded off the main thread: its two grey WebP files (the
 * opacity A and the premultiplied brightness P, world/cloudField), fetched by
 * the main thread and handed over as Blobs, decoded into one RG8 layer in GL
 * row order, and the layer's whole mip chain built as data. The reply
 * transfers every level, so the main thread only has uploads left to do and
 * this worker holds nothing once a message is answered.
 *
 * The decode is the sector worker's (tilePixelWorker.ts) without its flip
 * transform: a grey WebP has no alpha, so the canvas's premultiply round trip
 * is exact, and the rows are reversed while each file's grey is written into
 * its channel of the layer, a copy that has to happen anyway.
 * `colorSpaceConversion: 'none'` keeps the bytes the bytes: these are data,
 * not a picture, and a profile conversion would move every code.
 *
 * MEMORY. A 2048² file decodes to 16 MiB of RGBA, four times the channel the
 * layer wants, so nothing here ever holds a whole file's readback: the
 * decoded bitmap is drawn into a canvas one band of rows tall, each band is
 * read back and written straight into the 8 MiB layer, and the bitmap is
 * closed before the second file is decoded. What a page holds at its worst is
 * the second file's bitmap beside the layer, one band's canvas and one band's
 * readback (the two Blobs are the main thread's, shared, not copied).
 *
 * One page at a time, for the reason the sector worker gives. A page the main
 * thread gives up on is cancelled by id: the chain checks between its stages
 * (before it starts and after each file's decode, the only points another
 * message can arrive) and drops the page there, unanswered — the main thread
 * stopped listening when it cancelled.
 */
import { buildCloudPageMips, CLOUD_PAGE_SIZE, packCloudPlaneRows } from './cloudField';

interface PageRequest {
  id: number;
  a: Blob;
  p: Blob;
}

interface PageCancel {
  cancel: number;
}

type PageReply =
  | { id: number; ok: true; levels: ArrayBuffer[]; decodeMs: number; mipMs: number }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<PageRequest | PageCancel>) => void) | null;
  postMessage(data: PageReply, transfer?: Transferable[]): void;
};

/** Rows of a file read back at a time: 2 MiB of RGBA for a 2048-wide page. */
const BAND_ROWS = 256;

/** Pages asked for and not yet answered or dropped, and those of them the
 *  main thread has cancelled. */
const queued = new Set<number>();
const cancelled = new Set<number>();

/** One file's grey into its channel of the layer, a band at a time. */
async function readPlane(
  blob: Blob, draw: OffscreenCanvasRenderingContext2D, layer: Uint8Array, channel: 0 | 1,
): Promise<void> {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    if (bitmap.width !== CLOUD_PAGE_SIZE || bitmap.height !== CLOUD_PAGE_SIZE) {
      throw new Error(`page is ${bitmap.width}x${bitmap.height}, not ${CLOUD_PAGE_SIZE}`);
    }
    for (let y0 = 0; y0 < CLOUD_PAGE_SIZE; y0 += BAND_ROWS) {
      draw.drawImage(bitmap, 0, -y0);
      const band = draw.getImageData(0, 0, CLOUD_PAGE_SIZE, BAND_ROWS).data;
      packCloudPlaneRows(layer, band, CLOUD_PAGE_SIZE, channel, y0, BAND_ROWS, 4);
    }
  } finally {
    bitmap.close();
  }
}

async function decodePage(id: number, a: Blob, p: Blob): Promise<void> {
  const live = () => !cancelled.has(id);
  try {
    if (!live()) return;
    const t0 = performance.now();
    const canvas = new OffscreenCanvas(CLOUD_PAGE_SIZE, BAND_ROWS);
    const draw = canvas.getContext('2d', { willReadFrequently: true });
    if (!draw) throw new Error('no 2d context in this worker');
    // A straight copy at whole-pixel offsets: no blend, no filter.
    draw.globalCompositeOperation = 'copy';
    draw.imageSmoothingEnabled = false;
    const layer = new Uint8Array(CLOUD_PAGE_SIZE * CLOUD_PAGE_SIZE * 2);
    await readPlane(a, draw, layer, 0);
    if (!live()) return;
    await readPlane(p, draw, layer, 1);
    if (!live()) return;
    const t1 = performance.now();
    const levels = buildCloudPageMips(layer, CLOUD_PAGE_SIZE, 2);
    const t2 = performance.now();
    const buffers = levels.map((l) => l.buffer as ArrayBuffer);
    ctx.postMessage({ id, ok: true, levels: buffers, decodeMs: t1 - t0, mipMs: t2 - t1 }, buffers);
  } catch (err) {
    if (live()) ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    queued.delete(id);
    cancelled.delete(id);
  }
}

let chain: Promise<void> = Promise.resolve();

ctx.onmessage = (event: MessageEvent<PageRequest | PageCancel>) => {
  const msg = event.data;
  if ('cancel' in msg) {
    // Only a page still to be answered: a cancel that crossed its reply
    // would otherwise sit in the set for the session.
    if (queued.has(msg.cancel)) cancelled.add(msg.cancel);
    return;
  }
  queued.add(msg.id);
  chain = chain.then(() => decodePage(msg.id, msg.a, msg.p));
};

export {};
