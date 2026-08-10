/**
 * The upload-friendly texture decode path, shared by every streamed map: the
 * boot set through the durable-fetch seam (textureRetry) and the colour-tier
 * ladder (PlanetFactory). Honouring `flipY` on an HTMLImageElement texture
 * costs a synchronous CPU repack of the entire decoded image INSIDE
 * `texSubImage2D`; `createImageBitmap` with the flip baked in decodes off
 * this thread and uploads without that pass. (The other half of the upload
 * bill — the driver's sRGB conversion into an immutable texStorage2D
 * allocation — is paid by BOTH decode paths, and is what texturePolicy's
 * `mutableStorage` opt-out plus patches/three removes.)
 *
 * Guarded by observation, not feature sniffing: a 1x2 readback probe must
 * come back actually inverted before any real image takes this path. Anything
 * else — API missing, option ignored, draw failed — falls closed to the
 * shared `textureLoader`, whose worst case is the old slower upload, never a
 * flipped map.
 *
 * Failure taxonomy: transport errors (HTTP status, network, stream) surface
 * to the caller's onError, so retry ladders and tier cooldowns behave exactly
 * as they always did. A decode failure on a real image is different — the
 * probe passed on a sample, but this platform balked at the full-size decode
 * (size limits, memory pressure) — so one fallback load through the
 * HTMLImageElement path is spent before surfacing the error.
 */
import * as THREE from 'three';

/** The app's texture loader. Shared so every fetch carries the same settings
 *  (and so the fallback here, the retry seam, and the tier queue stand behind
 *  one loader). */
export const textureLoader = new THREE.TextureLoader();
textureLoader.crossOrigin = 'anonymous';

export type TextureLoad = (
  url: string,
  onLoad: (tex: THREE.Texture) => void,
  onError: (err: unknown) => void,
  /** Consulted between the fetch landing and the decode: a caller whose
   *  interest can lapse mid-flight (a superseded tier attempt) declines the
   *  decode here, sparing a full-size bitmap nobody will draw. The image
   *  path never needed this — its decode was always deferred to the apply
   *  callback, behind the caller's own staleness guard. */
  stillWanted?: () => boolean,
) => void;

/** Thrown for transport failures — the cases where re-fetching through
 *  another decoder cannot help. */
export class TextureTransportError extends Error {}

/**
 * Whether this platform can bake the vertical flip into `createImageBitmap`.
 * A 1x2 white-over-black bitmap is created with `imageOrientation: 'flipY'`
 * and read back — only the full inverted image (opaque black over opaque
 * white) counts as support: a silently failed draw reads back blank
 * [0,0,0,0], and "red < 128" alone would call that a pass. Probed lazily on
 * the first load: module load must stay DOM-free for the tests.
 */
let bitmapFlipProbe: Promise<boolean> | null = null;
function bitmapUploadUsable(): Promise<boolean> {
  bitmapFlipProbe ??= (async () => {
    try {
      if (typeof createImageBitmap !== 'function') return false;
      const sample = new ImageData(1, 2);
      sample.data.set([255, 255, 255, 255, 0, 0, 0, 255]);
      const bitmap = await createImageBitmap(sample, { imageOrientation: 'flipY' });
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 2;
        const ctx = canvas.getContext('2d');
        if (!ctx) return false;
        ctx.drawImage(bitmap, 0, 0);
        const px = ctx.getImageData(0, 0, 1, 2).data;
        return px[0] < 128 && px[3] > 128 && px[4] > 128 && px[7] > 128;
      } finally {
        bitmap.close();
      }
    } catch {
      return false;
    }
  })();
  return bitmapFlipProbe;
}

/** Fetch a map as an ImageBitmap with the flip baked in, wrapped in a texture
 *  that knows not to flip again. */
async function loadBitmapTexture(url: string, stillWanted?: () => boolean): Promise<THREE.Texture> {
  let blob: Blob;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    blob = await response.blob();
  } catch (err) {
    throw new TextureTransportError(err instanceof Error ? err.message : String(err));
  }
  // The fetch itself cannot be recalled, but the decode can be declined: an
  // attempt superseded while its bytes were in the air stops here, before a
  // full-size bitmap (~128MB at 8K) is created for nobody. Reported as a
  // transport error: the caller's own staleness guard makes it a no-op.
  if (stillWanted && !stillWanted()) {
    throw new TextureTransportError(`superseded: ${url}`);
  }
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: 'flipY',
    premultiplyAlpha: 'none',
  });
  const tex = new THREE.Texture(bitmap);
  tex.flipY = false; // baked into the bitmap above
  tex.needsUpdate = true;
  // ImageBitmaps carry no src, so stamp the texture for the perf/debug
  // telemetry that identifies uploads by their image's URL — and mark the
  // baked flip for any consumer that reads the pixels back on the CPU.
  tex.name = url.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? url;
  tex.userData.sourceUrl = url;
  tex.userData.bitmapPreFlipped = true;
  // The GPU copy made at upload is independent of the bitmap, and an applied
  // texture must KEEP its image (three re-uploads from it after a context
  // loss) — but a disposed texture is done for good, and without this the
  // decoded bitmap (~128MB at 8K) lingers until GC notices.
  tex.addEventListener('dispose', () => bitmap.close());
  return tex;
}

/**
 * Load a texture through the bitmap path when the probe allows it, the shared
 * `textureLoader` otherwise. The seam both the durable fetch and the tier
 * ladder call.
 */
export const loadStreamedTexture: TextureLoad = (url, onLoad, onError, stillWanted) => {
  // No API means no probe to wait for: fall back synchronously, preserving
  // the bare-loader timing (three's own loader also dispatches sync). This is
  // also the path the DOM-free tests drive their injected loaders through.
  if (typeof createImageBitmap !== 'function') {
    textureLoader.load(url, onLoad, undefined, onError);
    return;
  }
  bitmapUploadUsable().then((usable) => {
    // Interest can lapse while the one-time probe is still resolving; don't
    // even start the fetch for an attempt already superseded.
    if (stillWanted && !stillWanted()) {
      onError(new TextureTransportError(`superseded: ${url}`));
      return;
    }
    if (!usable) {
      textureLoader.load(url, onLoad, undefined, onError);
      return;
    }
    loadBitmapTexture(url, stillWanted).then(onLoad, (err) => {
      if (err instanceof TextureTransportError) onError(err);
      // A decode failure spends one fallback load — but not for a caller
      // whose interest lapsed mid-decode: that would re-fetch for nobody.
      else if (stillWanted && !stillWanted()) onError(err);
      else textureLoader.load(url, onLoad, undefined, onError);
    });
  });
};

/** Test seam: force the probe verdict (pass null to restore the real probe). */
export function setBitmapProbeForTests(result: boolean | null): void {
  bitmapFlipProbe = result === null ? null : Promise.resolve(result);
}
