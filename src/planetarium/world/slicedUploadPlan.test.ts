import { describe, expect, it } from 'vitest';
import {
  COMPRESSED_BLOCK_ROWS,
  MIN_BAND_ROWS,
  mipLevelCount,
  nextBandRows,
  shouldSlice,
  updateRowRate,
} from './slicedUploadPlan';

describe('nextBandRows', () => {
  it('takes a floor-sized band before any rate has been measured', () => {
    expect(nextBandRows({ remainingRows: 4096, msPerRow: null, budgetMs: 3, blockRows: 1 }))
      .toBe(MIN_BAND_ROWS);
  });

  it('sizes the band from the measured rate and the budget', () => {
    // 0.01 ms a row against a 3 ms budget is 300 rows.
    expect(nextBandRows({ remainingRows: 4096, msPerRow: 0.01, budgetMs: 3, blockRows: 1 }))
      .toBe(300);
  });

  it('never returns an empty band, however slow the measured rate', () => {
    expect(nextBandRows({ remainingRows: 4096, msPerRow: 1_000, budgetMs: 3, blockRows: 1 }))
      .toBe(MIN_BAND_ROWS);
  });

  it('takes the whole rest when the budget is unbounded', () => {
    // The arrival veil drains with no budget at all: behind an opaque cover
    // there is no frame to protect, and a band-at-a-time drain would leave
    // the map unfinished when the cover lifted.
    expect(nextBandRows({
      remainingRows: 4088, msPerRow: 0.01, budgetMs: Number.POSITIVE_INFINITY, blockRows: 1,
    })).toBe(4088);
  });

  it('reports nothing left when nothing is left', () => {
    expect(nextBandRows({ remainingRows: 0, msPerRow: 0.01, budgetMs: 3, blockRows: 1 })).toBe(0);
  });

  it('aligns a compressed band to the block grid', () => {
    // 300 rows would be the budget's answer; 300 is not a multiple of 4... it is,
    // so ask for a rate that lands off the grid: 0.011 ms/row -> 272 rows.
    const rows = nextBandRows({
      remainingRows: 4096, msPerRow: 0.011, budgetMs: 3, blockRows: COMPRESSED_BLOCK_ROWS,
    });
    expect(rows % COMPRESSED_BLOCK_ROWS).toBe(0);
    expect(rows).toBe(272);
  });

  it('never returns less than one block row for a compressed texture', () => {
    const rows = nextBandRows({
      remainingRows: 4096, msPerRow: 1_000, budgetMs: 0.001, blockRows: COMPRESSED_BLOCK_ROWS,
    });
    expect(rows).toBe(MIN_BAND_ROWS);
    expect(rows % COMPRESSED_BLOCK_ROWS).toBe(0);
  });

  it('returns the whole remainder rather than strand a sub-block sliver', () => {
    // 10 rows left, block 4: a 8-row band would leave 2, which is not a legal
    // band on its own, so the last band takes all ten.
    expect(nextBandRows({
      remainingRows: 10, msPerRow: 1_000, budgetMs: 0.001, blockRows: COMPRESSED_BLOCK_ROWS,
    })).toBe(10);
  });

  it('hands back the final short band whole, block-aligned or not', () => {
    expect(nextBandRows({ remainingRows: 3, msPerRow: 0.01, budgetMs: 3, blockRows: 4 })).toBe(3);
  });

  it('bands sum to exactly the image height, for both alignments', () => {
    for (const blockRows of [1, COMPRESSED_BLOCK_ROWS]) {
      for (const height of [4096, 8192, 2048, 1000, 4094]) {
        let remaining = height;
        let msPerRow: number | null = null;
        let bands = 0;
        while (remaining > 0) {
          const rows = nextBandRows({ remainingRows: remaining, msPerRow, budgetMs: 3, blockRows });
          expect(rows).toBeGreaterThan(0);
          // Every band but the last sits on the block grid.
          if (remaining - rows > 0) expect(rows % blockRows).toBe(0);
          remaining -= rows;
          msPerRow = updateRowRate(msPerRow, rows, rows * 0.008);
          bands++;
          expect(bands).toBeLessThan(10_000); // must terminate
        }
        expect(remaining).toBe(0);
      }
    }
  });
});

describe('updateRowRate', () => {
  it('takes the first measurement whole', () => {
    expect(updateRowRate(null, 100, 2)).toBeCloseTo(0.02, 6);
  });

  it('eases toward later measurements instead of jumping', () => {
    const next = updateRowRate(0.02, 100, 4)!; // sample 0.04
    expect(next).toBeGreaterThan(0.02);
    expect(next).toBeLessThan(0.04);
  });

  it('ignores a band that measured as free rather than divide by it', () => {
    expect(updateRowRate(0.02, 100, 0)).toBe(0.02);
  });

  it('ignores an empty band', () => {
    expect(updateRowRate(0.02, 0, 5)).toBe(0.02);
  });
});

describe('mipLevelCount', () => {
  it('counts the full chain down to one texel', () => {
    expect(mipLevelCount(8192, 4096)).toBe(14);
    expect(mipLevelCount(4096, 2048)).toBe(13);
    expect(mipLevelCount(1, 1)).toBe(1);
  });
});

describe('shouldSlice', () => {
  it('slices every compressed container, whatever its size', () => {
    expect(shouldSlice({ compressed: true, width: 256, height: 256 })).toBe(true);
  });

  it('slices an uncompressed map at or past four megatexels', () => {
    expect(shouldSlice({ compressed: false, width: 2048, height: 2048 })).toBe(true);
    expect(shouldSlice({ compressed: false, width: 8192, height: 4096 })).toBe(true);
    expect(shouldSlice({ compressed: false, width: 4096, height: 2048 })).toBe(true);
  });

  it('leaves a small map to the single-shot path', () => {
    expect(shouldSlice({ compressed: false, width: 2048, height: 1024 })).toBe(false);
    expect(shouldSlice({ compressed: false, width: 1024, height: 512 })).toBe(false);
  });
});
