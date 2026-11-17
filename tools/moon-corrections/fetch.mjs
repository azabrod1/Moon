/**
 * The moon-correction generator's first step (run.py): dense planetocentric
 * Horizons vectors for the major moons over the fitted-ephemeris window
 * (1900-01-01 .. 2100-06-16 TDB), as gen-ephemeris.mjs fetches them
 * (geometric, ICRF, km; <= 40,000 rows a request; cached so reruns are
 * offline).
 *
 *   node tools/moon-corrections/fetch.mjs [--offline] [moon ...]
 *
 * Cache:  .moon-data-cache/horizons-moons/<moon>_<grid>_<startJd>_<stopJd>_<step>m.txt.gz
 * Output, under .moon-data-cache/moon-corrections/data:
 *         <moon>.main.f64    rows (jdTdb, x, y, z) on the main grid
 *         <moon>.fine.f64    an independent finer, offset grid over three
 *                            test years (scoring only)
 *         <moon>.margin.f64  the main grid two years past each end (fit only)
 *         grids.json         steps, row counts, sources
 */
import { promises as fs } from 'fs';
import https from 'https';
import path from 'path';
import zlib from 'zlib';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OFFLINE = process.argv.includes('--offline');
const ONLY = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const CACHE_DIR = path.join(ROOT, '.moon-data-cache', 'horizons-moons');
const OUT_DIR = path.join(ROOT, '.moon-data-cache', 'moon-corrections', 'data');

export const WINDOW_START_JD = 2415020.5;
export const WINDOW_END_JD = WINDOW_START_JD + 143 * 512;
const MAX_ROWS_PER_REQUEST = 40_000;

/** Main-grid step in whole minutes, 0.0871 P (about P/11.5; Phobos P/7.7;
 *  Iapetus P/46, since its 920 orbits give few samples otherwise; Callisto
 *  P/46, since Jupiter's reflex to Io, 0.51 c/d in Callisto's rotating frame,
 *  aliased on a P/11.5 grid and was found only by the fine-grid test),
 *  chosen to sit between the rationals 1/11 and 1/12 so that step/P, 2 step/P
 *  and 4 step/P stay clear of p/q with q <= 12 (printed when run). */
export const MOONS = [
  { name: 'Phobos', command: '401', center: '500@499', stepMin: 60 },
  { name: 'Deimos', command: '402', center: '500@499', stepMin: 158 },
  { name: 'Io', command: '501', center: '500@599', stepMin: 222 },
  { name: 'Europa', command: '502', center: '500@599', stepMin: 445 },
  { name: 'Ganymede', command: '503', center: '500@599', stepMin: 897 },
  { name: 'Callisto', command: '504', center: '500@599', stepMin: 523 },
  { name: 'Mimas', command: '601', center: '500@699', stepMin: 118 },
  { name: 'Enceladus', command: '602', center: '500@699', stepMin: 172 },
  { name: 'Tethys', command: '603', center: '500@699', stepMin: 237 },
  { name: 'Dione', command: '604', center: '500@699', stepMin: 343 },
  { name: 'Rhea', command: '605', center: '500@699', stepMin: 567 },
  { name: 'Titan', command: '606', center: '500@699', stepMin: 2000 },
  { name: 'Iapetus', command: '608', center: '500@699', stepMin: 2489 },
  { name: 'Miranda', command: '705', center: '500@799', stepMin: 177 },
  { name: 'Ariel', command: '701', center: '500@799', stepMin: 316 },
  { name: 'Umbriel', command: '702', center: '500@799', stepMin: 520 },
  { name: 'Titania', command: '703', center: '500@799', stepMin: 1092 },
  { name: 'Oberon', command: '704', center: '500@799', stepMin: 1689 },
  { name: 'Triton', command: '801', center: '500@899', stepMin: 737 },
  { name: 'Charon', command: '901', center: '500@999', stepMin: 801 },
];
/** Approximate periods (h) from satelliteElements.ts' summed longitude rates,
 *  for the commensurability check only. */
const PERIOD_H = {
  Phobos: 7.6538, Deimos: 30.2986, Io: 42.4593, Europa: 85.2285, Ganymede: 171.7093, Callisto: 400.5364,
  Mimas: 22.6184, Enceladus: 32.8852, Tethys: 45.3072, Dione: 65.686, Rhea: 108.4201, Titan: 382.6908,
  Iapetus: 1903.944, Miranda: 33.9235, Ariel: 60.4891, Umbriel: 99.4602, Titania: 208.9409, Oberon: 323.1177,
  Triton: 141.0387, Charon: 153.2933,
};
/** Test years (every fifth year from 1902 is held out); three of them are
 *  also fetched on an independent grid. */
export const FINE_YEARS = [1912, 2007, 2087];
const MARGIN_DAYS = 730.5;

function fail(message) {
  console.error(`fetch: ${message}`);
  process.exit(1);
}

function download(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
          response.resume();
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

async function downloadWithRetry(url) {
  const backoffMs = [2_000, 10_000, 30_000, 60_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await download(url);
    } catch (error) {
      if (attempt >= backoffMs.length || !/HTTP 5\d\d|ECONNRESET|ETIMEDOUT|socket hang up/.test(String(error))) throw error;
      console.log(`  retrying after ${String(error).slice(0, 60)}`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
    }
  }
}

async function cached(fileName, fetcher) {
  const filePath = path.join(CACHE_DIR, fileName);
  try {
    return zlib.gunzipSync(await fs.readFile(filePath)).toString('utf8');
  } catch {
    if (OFFLINE) fail(`--offline but cache miss: ${filePath}`);
    const text = await fetcher();
    if (!text.includes('$$EOE')) fail(`no vector table in ${fileName}:\n${text.slice(0, 800)}`);
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(filePath, zlib.gzipSync(text, { level: 6 }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    return text;
  }
}

function horizonsQuery(params) {
  const query = Object.entries({
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    REF_PLANE: 'FRAME',
    VEC_TABLE: '1',
    VEC_CORR: 'NONE',
    OUT_UNITS: 'KM-S',
    CSV_FORMAT: 'YES',
    ...params,
  })
    .map(([key, value]) => `${key}=${encodeURIComponent(`'${value}'`)}`)
    .join('&');
  return `https://ssd.jpl.nasa.gov/api/horizons.api?format=text&${query}`;
}

function parseVectors(text, what) {
  const start = text.indexOf('$$SOE');
  const end = text.indexOf('$$EOE');
  if (start < 0 || end < 0) fail(`no vector table for ${what}`);
  const rows = [];
  for (const line of text.slice(start + 5, end).split('\n')) {
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length < 5 || !cells[0]) continue;
    rows.push([Number(cells[0]), Number(cells[2]), Number(cells[3]), Number(cells[4])]);
  }
  const source = /Target body name:.*?\{source:\s*([^}]+)\}/.exec(text)?.[1]?.trim() ?? 'unknown';
  return { rows, source };
}

/** Rows start + k*step (k = 0..count-1), fetched in <= 40,000-row chunks. */
async function fetchGrid(moon, startJd, stepMin, count, tag) {
  const stepDays = stepMin / 1440;
  const rows = [];
  let source = '';
  for (let firstRow = 0; firstRow < count; firstRow += MAX_ROWS_PER_REQUEST) {
    const lastRow = Math.min(count - 1, firstRow + MAX_ROWS_PER_REQUEST - 1);
    const a = startJd + firstRow * stepDays;
    const b = startJd + lastRow * stepDays;
    const fileName = `${moon.name}_${tag}_${a.toFixed(6)}_${b.toFixed(6)}_${stepMin}m.txt.gz`;
    const text = await cached(fileName, () => {
      console.log(`  fetching ${moon.name} ${tag} JD ${a.toFixed(3)}-${b.toFixed(3)} (${lastRow - firstRow + 1} rows)`);
      return downloadWithRetry(
        horizonsQuery({
          COMMAND: moon.command,
          CENTER: moon.center,
          START_TIME: `JD${a.toFixed(9)}`,
          STOP_TIME: `JD${b.toFixed(9)}`,
          STEP_SIZE: `${stepMin}m`,
        }),
      );
    });
    const parsed = parseVectors(text, fileName);
    source = parsed.source;
    if (parsed.rows.length !== lastRow - firstRow + 1) fail(`${fileName}: expected ${lastRow - firstRow + 1} rows, got ${parsed.rows.length}`);
    rows.push(...parsed.rows);
  }
  for (let k = 0; k < rows.length; k++) {
    const expected = startJd + k * stepDays;
    if (Math.abs(rows[k][0] - expected) > 2e-8) fail(`${moon.name} ${tag}: row ${k} at JD ${rows[k][0]}, expected ${expected}`);
  }
  return { rows, source };
}

function toF64(rows) {
  const out = new Float64Array(rows.length * 4);
  rows.forEach((row, index) => out.set(row, index * 4));
  return Buffer.from(out.buffer);
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

/** Distance of x (mod 1) from the nearest p/q with q <= qMax, and that q. */
function nearestRational(x, qMax) {
  const f = x - Math.floor(x);
  let best = [1, 1];
  for (let q = 1; q <= qMax; q++) {
    const p = Math.round(f * q);
    const d = Math.abs(f - p / q);
    if (d < best[0]) best = [d, q];
  }
  return best;
}

function jdOfYear(year) {
  return 2440587.5 + Date.UTC(year, 0, 1) / 86_400_000;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  let grids = {};
  try {
    grids = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'grids.json'), 'utf8'));
  } catch {}
  for (const moon of MOONS) {
    if (ONLY.length && !ONLY.includes(moon.name)) continue;
    const ratio = (moon.stepMin / 60) / PERIOD_H[moon.name];
    const checks = [1, 2, 4].map((k) => nearestRational(k * ratio, 6));
    console.log(
      `${moon.name}: step ${moon.stepMin} min = P/${(1 / ratio).toFixed(2)};` +
        ` k*step/P nearest p/q (q<=6) for k=1,2,4: ${checks.map(([d, q]) => `${d.toFixed(4)} (q=${q})`).join(', ')}`,
    );
    const count = Math.floor(((WINDOW_END_JD - WINDOW_START_JD) * 1440) / moon.stepMin) + 1;
    const main = await fetchGrid(moon, WINDOW_START_JD, moon.stepMin, count, 'main');
    await fs.writeFile(path.join(OUT_DIR, `${moon.name}.main.f64`), toF64(main.rows));
    // Independent grid: a co-prime step near 0.37 of the main one, offset by 7 min.
    let fineStep = Math.max(7, Math.round(moon.stepMin * 0.37));
    while (gcd(fineStep, moon.stepMin) !== 1 || gcd(fineStep, 7) !== 1) fineStep++;
    const fineRows = [];
    for (const year of FINE_YEARS) {
      const a = jdOfYear(year) + 7 / 1440;
      const n = Math.floor(((jdOfYear(year + 1) - a) * 1440) / fineStep) + 1;
      const fine = await fetchGrid(moon, a, fineStep, n, `fine${year}`);
      fineRows.push(...fine.rows);
    }
    await fs.writeFile(path.join(OUT_DIR, `${moon.name}.fine.f64`), toF64(fineRows));
    // Fit-only margins: the main grid continued two years past each end, so
    // the splines are as well held at 1900 and 2100 as inside. Never scored.
    const stepDays = moon.stepMin / 1440;
    const marginRows = Math.ceil(MARGIN_DAYS / stepDays);
    const before = await fetchGrid(moon, WINDOW_START_JD - marginRows * stepDays, moon.stepMin, marginRows, 'pre');
    const after = await fetchGrid(moon, WINDOW_START_JD + count * stepDays, moon.stepMin, marginRows, 'post');
    await fs.writeFile(path.join(OUT_DIR, `${moon.name}.margin.f64`), toF64([...before.rows, ...after.rows]));
    grids[moon.name] = {
      marginRows: 2 * marginRows,
      command: moon.command,
      center: moon.center,
      source: main.source,
      stepMin: moon.stepMin,
      rows: main.rows.length,
      fineStepMin: fineStep,
      fineYears: FINE_YEARS,
      fineRows: fineRows.length,
    };
    console.log(`  ${main.rows.length} main rows (${main.source}), ${fineRows.length} fine rows at ${fineStep} min`);
    await fs.writeFile(path.join(OUT_DIR, 'grids.json'), JSON.stringify(grids, null, 1));
  }
}

main().catch((error) => fail(error.stack ?? String(error)));
