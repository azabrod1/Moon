/**
 * Test-only: read the shipped ephemeris and moon corrections off disk and
 * install them, so suites run on the same positions the app draws. The vitest
 * setup file calls these for every suite (fittedEphemerisSetup.ts). Never
 * imported by app code.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FITTED_EPHEMERIS_FILE, parseFittedEphemeris, setFittedEphemeris, type FittedEphemeris } from './fittedEphemeris';
import { MOON_CORRECTIONS_FILE, parseMoonCorrections, type MoonCorrectionSet } from './moonCorrections';
import { installMoonCorrections } from './satellites';

let parsed: FittedEphemeris | null = null;
let parsedMoonCorrections: MoonCorrectionSet | null | undefined;

function readPublic(file: string): ArrayBuffer | null {
  const path = fileURLToPath(new URL('../../public/' + file, import.meta.url));
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function installFittedEphemerisFromDisk(): FittedEphemeris {
  if (!parsed) {
    const bytes = readPublic(FITTED_EPHEMERIS_FILE);
    if (!bytes) throw new Error(`missing public/${FITTED_EPHEMERIS_FILE}`);
    parsed = parseFittedEphemeris(bytes);
  }
  setFittedEphemeris(parsed);
  return parsed;
}

/**
 * Install the shipped moon corrections, if there are any. Never throws: the
 * generator's own export runs under this setup, before its first file exists
 * and after `gen:moons` has changed the elements under an old one. Returns
 * the moons the guard rejected (moonCorrections.test.ts fails on them).
 */
export function installMoonCorrectionsFromDisk(): string[] {
  if (parsedMoonCorrections === undefined) {
    const bytes = readPublic(MOON_CORRECTIONS_FILE);
    parsedMoonCorrections = bytes ? parseMoonCorrections(bytes) : null;
  }
  return installMoonCorrections(parsedMoonCorrections);
}
