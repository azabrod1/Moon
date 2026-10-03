/**
 * A cloud-field page off the main thread: fetch its two grey WebP files (the
 * opacity A and the premultiplied brightness P, world/cloudField), decode
 * them, lay them side by side as one RG8 layer in GL row order, and build the
 * layer's whole mip chain as data. The reply transfers every level, so the
 * main thread only has uploads left to do and this worker holds nothing once
 * a message is answered.
 *
 * The decode is the sector worker's (tilePixelWorker.ts) without its flip
 * transform: a grey WebP has no alpha, so the canvas's premultiply round trip
 * is exact, and the rows are reversed by `packCloudPage` while the two
 * channels are interleaved, which is a copy that has to happen anyway.
 * `colorSpaceConversion: 'none'` keeps the bytes the bytes: these are data,
 * not a picture, and a profile conversion would move every code.
 *
 * One page at a time, for the reason the sector worker gives: each holds two
 * full-size decodes and a canvas.
 */
import { buildCloudPageMips, CLOUD_PAGE_SIZE, packCloudPage } from './cloudField';

interface PageRequest {
  id: number;
  urlA: string;
  urlP: string;
}

type PageReply =
  | { id: number; ok: true; levels: ArrayBuffer[]; fetchMs: number; decodeMs: number; mipMs: number; fileBytes: number }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<PageRequest>) => void) | null;
  postMessage(data: PageReply, transfer?: Transferable[]): void;
};

async function greyPixels(blob: Blob): Promise<Uint8ClampedArray> {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    if (bitmap.width !== CLOUD_PAGE_SIZE || bitmap.height !== CLOUD_PAGE_SIZE) {
      throw new Error(`page is ${bitmap.width}x${bitmap.height}, not ${CLOUD_PAGE_SIZE}`);
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const draw = canvas.getContext('2d', { willReadFrequently: true });
    if (!draw) throw new Error('no 2d context in this worker');
    draw.drawImage(bitmap, 0, 0);
    return draw.getImageData(0, 0, bitmap.width, bitmap.height).data;
  } finally {
    bitmap.close();
  }
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.blob();
}

let chain: Promise<void> = Promise.resolve();

ctx.onmessage = (event: MessageEvent<PageRequest>) => {
  const { id, urlA, urlP } = event.data;
  chain = chain.then(async () => {
    try {
      const t0 = performance.now();
      const [blobA, blobP] = await Promise.all([fetchBlob(urlA), fetchBlob(urlP)]);
      const t1 = performance.now();
      const a = await greyPixels(blobA);
      const p = await greyPixels(blobP);
      const t2 = performance.now();
      const levels = buildCloudPageMips(packCloudPage(a, p, CLOUD_PAGE_SIZE, 4), CLOUD_PAGE_SIZE, 2);
      const t3 = performance.now();
      const buffers = levels.map((l) => l.buffer as ArrayBuffer);
      ctx.postMessage({
        id, ok: true, levels: buffers,
        fetchMs: t1 - t0, decodeMs: t2 - t1, mipMs: t3 - t2, fileBytes: blobA.size + blobP.size,
      }, buffers);
    } catch (err) {
      ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
};

export {};
