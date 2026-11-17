/**
 * Test-only: read the shipped ephemeris off disk and install it, so suites
 * run on the same positions the app draws. The vitest setup file calls it for
 * every suite (test/setupEphemeris.ts). Never imported by app code.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FITTED_EPHEMERIS_FILE, parseFittedEphemeris, setFittedEphemeris, type FittedEphemeris } from './fittedEphemeris';

let parsed: FittedEphemeris | null = null;

export function installFittedEphemerisFromDisk(): FittedEphemeris {
  if (!parsed) {
    const path = fileURLToPath(new URL('../../public/' + FITTED_EPHEMERIS_FILE, import.meta.url));
    const bytes = readFileSync(path);
    parsed = parseFittedEphemeris(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  setFittedEphemeris(parsed);
  return parsed;
}
