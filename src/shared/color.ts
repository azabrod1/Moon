/**
 * Color helpers shared across modes. Framework-free.
 */

/**
 * A 0xRRGGBB catalog tint as a CSS hex string. The single definition of the
 * idiom — it was hand-rolled at seven call sites, some masking to 24 bits and
 * some not, a latent divergence for any value with high bits set. The mask is
 * unconditional here: a catalog tint is 24-bit by contract, and anything
 * above must not leak into the string.
 */
export function cssHexColor(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}
