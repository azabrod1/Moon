// The golden for src/astronomy/planetMagnitude.ts: JPL Horizons' observer
// table from Earth's centre — APmag, the distances r and Δ, the phase angle
// (S-T-O) and the planetographic sub-observer and sub-solar latitudes — for
// each planet on dates that sweep Mercury and Venus through their phases.
// Horizons computes Mallama & Hilton (2018) too, Saturn with its rings, and
// prints "n.a." outside a curve's observed phase range (those rows are left
// out).
//
//   node tools/planet-magnitudes-golden.mjs
//
// Writes src/astronomy/planetMagnitude.goldens.json. Network: ssd.jpl.nasa.gov.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANETS = { Mercury: '199', Venus: '299', Mars: '499', Jupiter: '599', Saturn: '699', Uranus: '799', Neptune: '899' };
// Every 47 days from 2024-01-01: Mercury's and Venus's phases spread wide.
const DATES = Array.from({ length: 16 }, (_, index) => 2460310.5 + 47 * index);

async function horizons(command) {
  const params = {
    format: 'text', COMMAND: `'${command}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'OBSERVER'",
    CENTER: "'500@399'", TLIST: `'${DATES.map((jd) => jd.toFixed(1)).join(' ')}'`, TLIST_TYPE: "'JD'",
    QUANTITIES: "'9,14,15,19,20,24'", CSV_FORMAT: "'YES'", ANG_FORMAT: "'DEG'",
  };
  const query = Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  const response = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${query}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${command}`);
  return response.text();
}

const rows = [];
for (const [planet, command] of Object.entries(PLANETS)) {
  const text = await horizons(command);
  const body = text.slice(text.indexOf('$$SOE') + 5, text.indexOf('$$EOE'));
  const header = text.slice(0, text.indexOf('$$SOE')).split('\n').reverse().find((line) => line.includes('APmag'));
  if (!header) throw new Error(`no header for ${planet}`);
  const names = header.split(',').map((cell) => cell.trim());
  const at = (label) => {
    const index = names.indexOf(label);
    if (index < 0) throw new Error(`no ${label} column for ${planet}: ${names.join('|')}`);
    return index;
  };
  for (const line of body.split('\n')) {
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length < names.length || cells[at('APmag')] === 'n.a.') continue;
    rows.push({
      planet,
      utc: cells[0],
      apmag: Number(cells[at('APmag')]),
      r: Number(cells[at('r')]),
      delta: Number(cells[at('delta')]),
      phaseDeg: Number(cells[at('S-T-O')]),
      observerLatDeg: Number(cells[at('ObsSub-LAT')]),
      sunLatDeg: Number(cells[at('SunSub-LAT')]),
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
}
const golden = {
  note: 'JPL Horizons observer tables from Earth (500@399): APmag, r, delta (AU), S-T-O (deg), planetographic sub-observer and sub-solar latitudes (deg). Written by tools/planet-magnitudes-golden.mjs.',
  fetchedUtc: new Date().toISOString().slice(0, 10),
  rows,
};
writeFileSync(path.join(ROOT, 'src/astronomy/planetMagnitude.goldens.json'), JSON.stringify(golden, null, 1) + '\n');
console.log(`wrote ${rows.length} rows`);
