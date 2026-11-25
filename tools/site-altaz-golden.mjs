// The golden for the site geometry (src/planetarium/siteView.ts): JPL
// Horizons' apparent azimuth and elevation, without refraction (AIRLESS), of
// the Sun and the Moon from two places on Earth (geodetic, WGS 84) and of
// Earth and the Sun from Apollo 11's landing site on the Moon.
//
//   node tools/site-altaz-golden.mjs
//
// Writes src/planetarium/siteView.goldens.json. Network: ssd.jpl.nasa.gov.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITES = [
  { name: 'Greenwich', body: 'Earth', center: 'coord@399', longitudeDeg: -0.0015, latitudeDeg: 51.4778, heightKm: 0.046, targets: { Sun: '10', Moon: '301' } },
  { name: 'Mauna Kea', body: 'Earth', center: 'coord@399', longitudeDeg: -155.4681, latitudeDeg: 19.8207, heightKm: 4.2, targets: { Sun: '10', Moon: '301' } },
  { name: 'Apollo 11', body: 'Moon', center: 'coord@301', longitudeDeg: 23.473, latitudeDeg: 0.6741, heightKm: 0, targets: { Earth: '399', Sun: '10' } },
];
// UT instants: a spread of hours over two dates, so bodies stand at many
// altitudes and azimuths.
const DATES = ['2026-11-30 03:00', '2026-11-30 09:00', '2026-11-30 15:00', '2026-11-30 21:00', '2027-03-21 06:00', '2027-03-21 18:00'];

const rows = [];
for (const site of SITES) {
  for (const [target, command] of Object.entries(site.targets)) {
    const params = {
      format: 'text', COMMAND: `'${command}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'OBSERVER'",
      CENTER: `'${site.center}'`, COORD_TYPE: "'GEODETIC'", SITE_COORD: `'${site.longitudeDeg},${site.latitudeDeg},${site.heightKm}'`,
      TLIST: `'${DATES.map((date) => `${date}`).join("' '")}'`, TIME_TYPE: "'UT'",
      QUANTITIES: "'4'", APPARENT: "'AIRLESS'", CSV_FORMAT: "'YES'", ANG_FORMAT: "'DEG'", EXTRA_PREC: "'YES'",
    };
    const query = Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    const response = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${query}`);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${site.name} ${target}`);
    const text = await response.text();
    if (!text.includes('$$SOE')) throw new Error(`no ephemeris for ${site.name} ${target}: ${text.slice(0, 400)}`);
    const body = text.slice(text.indexOf('$$SOE') + 5, text.indexOf('$$EOE'));
    for (const line of body.trim().split('\n')) {
      const cells = line.split(',').map((cell) => cell.trim());
      rows.push({
        site: site.name, body: site.body, longitudeDeg: site.longitudeDeg, latitudeDeg: site.latitudeDeg, heightKm: site.heightKm,
        target, utc: cells[0], azimuthDeg: Number(cells[3]), elevationDeg: Number(cells[4]),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
const golden = {
  note: 'JPL Horizons apparent azimuth (from north through east) and elevation, AIRLESS, from geodetic sites on Earth (WGS 84) and the Moon. Written by tools/site-altaz-golden.mjs.',
  fetchedUtc: new Date().toISOString().slice(0, 10),
  rows,
};
writeFileSync(path.join(ROOT, 'src/planetarium/siteView.goldens.json'), JSON.stringify(golden, null, 1) + '\n');
console.log(`wrote ${rows.length} rows`);
