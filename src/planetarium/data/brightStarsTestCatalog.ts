/**
 * Test-only: read the shipped catalog sidecar off disk, install it in the
 * brightStars store, and hand the records back — so suites that exercise
 * catalog consumers (starfield, map stars, constellation snap) run against
 * the REAL shipped sky, exactly as they did when the catalog was a TS
 * import. Never imported by app code.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BRIGHT_STAR_BIN_FILE,
  parseBrightStarBin,
  setBrightStarCatalog,
  type StarRecord,
} from './brightStars';

export function loadBrightStarCatalogFromDisk(): StarRecord[] {
  const path = fileURLToPath(new URL('../../../public/' + BRIGHT_STAR_BIN_FILE, import.meta.url));
  const bytes = readFileSync(path);
  const records = parseBrightStarBin(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  setBrightStarCatalog(records);
  return records;
}
