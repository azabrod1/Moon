// The moon-correction generator's second step (run.py): evaluate the app's
// own mean-element model at every Horizons instant fetch.mjs wrote, in ICRF
// km, so the Python fit can difference the two; and at the two guard dates
// the shipped file carries (moonCorrections.ts checks them at install).
//   MOON_CORRECTIONS_EXPORT=1 npx vitest run --dir tools/moon-corrections export
// Writes, under .moon-data-cache/moon-corrections/data: <moon>.<grid>.model.f64,
// rows (x, y, z, nx, ny, nz), the position and the model's unit orbit normal;
// elements.json (the records the model propagates); guard.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  computeMoonOffsetEquatorialAU,
  computeSatelliteOffsetEquatorialAU,
  installMoonCorrections,
} from '../../src/astronomy/satellites';
import { SATELLITE_ELEMENTS } from '../../src/astronomy/satelliteElements';
import { ttJDFromUtcMs } from '../../src/astronomy/planetary';
import { KM_PER_AU } from '../../src/astronomy/constants';

const DATA = path.resolve(__dirname, '../../.moon-data-cache/moon-corrections/data');
const MOONS = 'Phobos Deimos Io Europa Ganymede Callisto Mimas Enceladus Tethys Dione Rhea Titan Iapetus Miranda Ariel Umbriel Titania Oberon Triton Charon'.split(' ');
/** 1913 and 2077: two dates far apart inside the window. */
const GUARD_JD = [2420000.5, 2480000.5];

/** Scene frame (x, y, z) = ICRF (x, z, −y), so ICRF = (x, −z, y). */
function sceneToIcrf(vector: THREE.Vector3, out: Float64Array | number[], at: number, scale: number) {
  out[at] = vector.x * scale;
  out[at + 1] = -vector.z * scale;
  out[at + 2] = vector.y * scale;
}

function utcMsAtTt(jdTT: number): number {
  let utcMs = (jdTT - 2440587.5) * 86_400_000;
  for (let iteration = 0; iteration < 5; iteration++) utcMs += (jdTT - ttJDFromUtcMs(utcMs)) * 86_400_000;
  return utcMs;
}

describe.skipIf(!process.env.MOON_CORRECTIONS_EXPORT)('moon-correction model export', () => {
  it('writes the model at every fetched instant', () => {
    // The fit is against the bare elements; the test setup installs the
    // shipped corrections, which must not reach the seam check below.
    installMoonCorrections(null);
    writeFileSync(path.join(DATA, 'elements.json'), JSON.stringify(Object.fromEntries(MOONS.map((moon) => [moon, SATELLITE_ELEMENTS[moon]])), null, 1));
    const position = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const viaUtc = new THREE.Vector3();
    const guard: { guardJd: number[]; moons: Record<string, number[]> } = { guardJd: GUARD_JD, moons: {} };
    for (const moon of MOONS) {
      const parent = SATELLITE_ELEMENTS[moon].parentPlanet;
      const guardKm: number[] = [];
      GUARD_JD.forEach((jd, index) => {
        computeSatelliteOffsetEquatorialAU(moon, jd, position);
        sceneToIcrf(position, guardKm, index * 3, KM_PER_AU);
      });
      guard.moons[moon] = guardKm;
      for (const grid of ['main', 'fine', 'margin']) {
        const file = path.join(DATA, `${moon}.${grid}.f64`);
        if (!existsSync(file)) throw new Error(`missing ${file}: run fetch.mjs first`);
        const buffer = readFileSync(file);
        const rows = new Float64Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 8);
        const count = rows.length / 4;
        const out = new Float64Array(count * 6);
        let worstSpotKm = 0;
        for (let row = 0; row < count; row++) {
          const jd = rows[4 * row]; // TDB, taken as TT (they differ by < 2 ms)
          computeSatelliteOffsetEquatorialAU(moon, jd, position, normal);
          sceneToIcrf(position, out, 6 * row, KM_PER_AU);
          sceneToIcrf(normal, out, 6 * row + 3, 1);
          if (row % 50_000 === 7) {
            // the public UTC-keyed seam gives the same position
            computeMoonOffsetEquatorialAU(moon, parent, utcMsAtTt(jd), viaUtc);
            worstSpotKm = Math.max(worstSpotKm, viaUtc.distanceTo(position) * KM_PER_AU);
          }
        }
        writeFileSync(path.join(DATA, `${moon}.${grid}.model.f64`), Buffer.from(out.buffer));
        console.log(`${moon} ${grid}: ${count} rows, UTC-seam spot check worst ${worstSpotKm.toFixed(4)} km`);
        expect(worstSpotKm).toBeLessThan(0.05);
      }
    }
    writeFileSync(path.join(DATA, 'guard.json'), JSON.stringify(guard, null, 1));
  }, 600_000);
});
