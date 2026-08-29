/**
 * Band arithmetic for the sliced texture upload.
 *
 * A GPU texture upload is one synchronous call that cannot be interrupted, so
 * a big map lands its whole cost on whichever frame pays it: measured at
 * 120 Hz, any upload past about 3 ms costs a dropped frame, and an 8K map
 * costs several. Splitting the base level into row bands across frames is the
 * only way to keep a big map off a single frame's budget.
 *
 * This module is the arithmetic alone — no GL, no three — so the rules that
 * actually matter can be asserted directly:
 *
 *  - A compressed format uploads whole blocks. A band that starts or ends
 *    mid-block is not a legal compressedTexSubImage2D, so every band boundary
 *    is a multiple of the block height, with only the final band allowed to
 *    run short (the image's own height need not be block-aligned; the format
 *    pads the last block row, and the driver expects exactly that remainder).
 *  - A band must never be empty, or the upload cannot finish. Progress is
 *    guaranteed by a floor, even when the measured rate says a single row is
 *    already over budget.
 *  - The rate is measured, not assumed: bytes per row vary by format and the
 *    same map uploads at different speeds on different GPUs, so the plan reads
 *    an EMA of the bands already paid and never a constant.
 */

/** Block height in rows for the compressed formats a KTX2 rung transcodes to.
 *  Every format the app can target is 4×4; anything else is treated as
 *  uncompressed rather than guessed at. */
export const COMPRESSED_BLOCK_ROWS = 4;

/** Smallest band worth a frame. Below this the per-call overhead dominates
 *  and a big map would take more frames than the stutter it is avoiding. */
export const MIN_BAND_ROWS = 8;

/** How fast the row-rate estimate follows the bands actually paid. */
export const ROW_RATE_EMA_ALPHA = 0.35;

export interface BandPlanInput {
  /** Rows of the base level still to upload. */
  remainingRows: number;
  /** Measured milliseconds per row, or null before the first band is paid. */
  msPerRow: number | null;
  /** What this frame may spend. */
  budgetMs: number;
  /** 1 for an uncompressed texture, COMPRESSED_BLOCK_ROWS for a compressed one. */
  blockRows: number;
}

/**
 * How many rows to upload next.
 *
 * Returns 0 only when there is nothing left. Otherwise at least one band's
 * floor, aligned down to the block grid, except for a final short band which
 * is returned whole — the remainder rows are a legal last block row and
 * withholding them would leave the upload unable to finish.
 */
export function nextBandRows(input: BandPlanInput): number {
  const { remainingRows, msPerRow, budgetMs, blockRows } = input;
  if (remainingRows <= 0) return 0;
  const quantum = Math.max(1, Math.floor(blockRows));
  // Before anything is measured, take one floor-sized band and learn from it
  // rather than guess a rate that varies by format and by GPU.
  const wanted = msPerRow === null || !(msPerRow > 0)
    ? MIN_BAND_ROWS
    : Math.floor(budgetMs / msPerRow);
  const floored = Math.max(MIN_BAND_ROWS, wanted);
  if (floored >= remainingRows) return remainingRows;
  const aligned = Math.floor(floored / quantum) * quantum;
  // One block row is the smallest legal band; the floor may be below it.
  const rows = Math.max(quantum, aligned);
  // Leaving a sliver smaller than a block behind would strand the upload, so
  // absorb a short tail into this band instead.
  return remainingRows - rows < quantum ? remainingRows : rows;
}

/** Fold a paid band into the rate estimate. */
export function updateRowRate(
  previous: number | null,
  rows: number,
  elapsedMs: number,
): number | null {
  if (rows <= 0 || !(elapsedMs >= 0)) return previous;
  // A band that measured as free tells us nothing usable; keep the old rate
  // rather than let a zero divide the next band into the whole image.
  const sample = elapsedMs / rows;
  if (!(sample > 0)) return previous;
  return previous === null ? sample : previous + (sample - previous) * ROW_RATE_EMA_ALPHA;
}

/** Mip levels a full chain has for an image this size — three's own rule. */
export function mipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/**
 * Whether a map is big enough that a single-shot upload would blow a frame.
 *
 * Uncompressed maps are charged their real cost: four bytes a texel, which is
 * what the driver moves. A compressed container is always sliced — its
 * transcoded blocks are the largest single allocation the app makes, and its
 * cost is not predictable from its file size.
 */
export function shouldSlice(input: {
  compressed: boolean;
  width: number;
  height: number;
}): boolean {
  if (input.compressed) return true;
  return input.width * input.height >= 2048 * 2048;
}
