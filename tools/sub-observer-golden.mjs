// The golden for the planets' rotation models (planetData's poles and prime
// meridians, computeBodyOrientationQuaternion): JPL Horizons' sub-observer
// longitude and latitude (ObsSub-LON/LAT, planetodetic, light-time corrected)
// of each planet from Earth's centre on dates across the fitted window, with
// the longitude convention and the radii Horizons states for each body. The
// dates are TT: a UT date decades out would test two ΔT forecasts against
// each other (in 2078 the app's runs 76 s past Horizons'), not the models.
//
//   node tools/sub-observer-golden.mjs
//
// Writes src/astronomy/bodyOrientation.goldens.json. Network: ssd.jpl.nasa.gov.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANETS = { Mercury: '199', Venus: '299', Mars: '499', Jupiter: '599', Saturn: '699', Uranus: '799', Neptune: '899' };
// 1950, 2000, 2024, 2026-12, 2051-05, 2078-02 (TT): the rates are tested decades out.
const DATES = [2433282.5, 2451544.5, 2460310.5, 2461375.5, 2470322.5, 2480067.5];

async function horizons(command) {
  const params = {
    format: 'text', COMMAND: `'${command}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'OBSERVER'",
    CENTER: "'500@399'", TLIST: `'${DATES.map((jd) => jd.toFixed(1)).join(' ')}'`, TLIST_TYPE: "'JD'", TIME_TYPE: "'TT'",
    QUANTITIES: "'14'", CSV_FORMAT: "'YES'", ANG_FORMAT: "'DEG'",
  };
  const query = Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  const response = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${query}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${command}`);
  return response.text();
}

const rows = [];
for (const [planet, command] of Object.entries(PLANETS)) {
  const text = await horizons(command);
  const convention = /Target pole\/equ\s*:.*\{(East|West)-longitude positive\}/.exec(text);
  const radii = /Target radii\s*:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*km/.exec(text);
  if (!convention || !radii) throw new Error(`no convention or radii for ${planet}`);
  const body = text.slice(text.indexOf('$$SOE') + 5, text.indexOf('$$EOE'));
  for (const line of body.trim().split('\n')) {
    const cells = line.split(',').map((cell) => cell.trim());
    rows.push({
      planet,
      utc: cells[0],
      lonDeg: Number(cells[3]),
      latDeg: Number(cells[4]),
      eastPositive: convention[1] === 'East',
      equatorialKm: Number(radii[1]),
      polarKm: Number(radii[3]),
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
}
const golden = {
  note: 'JPL Horizons ObsSub-LON/LAT (planetodetic, light-time corrected) from Earth (500@399) at TT dates, with each body\'s stated longitude convention and radii. Written by tools/sub-observer-golden.mjs.',
  fetchedUtc: new Date().toISOString().slice(0, 10),
  rows,
};
writeFileSync(path.join(ROOT, 'src/astronomy/bodyOrientation.goldens.json'), JSON.stringify(golden, null, 1) + '\n');
console.log(`wrote ${rows.length} rows`);
