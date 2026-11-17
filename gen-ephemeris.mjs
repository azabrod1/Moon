/**
 * gen-ephemeris.mjs — fits the boot ephemeris from JPL Horizons:
 *   public/ephemeris/ephemeris.v1.bin    Chebyshev series, 1900 to mid-2100 (TDB)
 *   src/astronomy/ephemeris.goldens.json Horizons vectors at instants off the
 *                                        fit grid, for the tests
 *
 * Usage: node gen-ephemeris.mjs [--offline]
 *   --offline  use only .moon-data-cache/ (no network)
 *
 * What it fits: the Moon about Earth, and about the Sun's centre the
 * Earth–Moon barycentre and the barycentres of Mercury, Venus, Mars, Jupiter,
 * Saturn, Uranus, Neptune and Pluto (Horizons ids 301@399, then 3, 1, 2, 4, 5,
 * 6, 7, 8, 9 @10). Vectors are geometric, ICRF, km. The app derives Earth
 * from the barycentre and the Moon with the mass ratio below, and draws each
 * other planet at its system's barycentre: Jupiter's centre is within about
 * 250 km of it, Saturn's 300 km, Pluto's 2,100 km (0.1″ from Earth).
 *
 * How it fits: each body's window is cut into equal intervals, and each
 * coordinate in each interval is a Chebyshev series fitted by least squares
 * to the even-numbered Horizons samples, with both ends held to the samples
 * there (again after the coefficients are rounded for storage), so
 * neighbouring intervals meet exactly and the position never steps.
 * The odd-numbered samples, which the fit never saw, score it. For each body
 * the interval length and series length are the smallest pair whose worst
 * held-out error, with the coefficients rounded as the file stores them, is
 * within that body's target. If any body misses its target, nothing is
 * written and the script exits non-zero.
 *
 * File format v1, little-endian:
 *   header      magic 'MEPH' | version u16 = 1 | bodyCount u16
 *   per body    nameLength u8 | name UTF-8 | startJdTdb f64 | intervalDays f64
 *               | intervalCount u32 | coefficientCount u16 | heldOutKm f32
 *               | dataOffset u32
 *   data        per interval, per coordinate (x, y, z): c0 f64, c1 f64,
 *               c2 … c(n−1) f32, in km
 * A format change ships as ephemeris.v2.bin.
 */
import { promises as fs } from 'fs';
import https from 'https';
import path from 'path';

const OFFLINE = process.argv.includes('--offline');
const CACHE_DIR = path.resolve(process.cwd(), '.moon-data-cache', 'horizons-ephemeris');
const BIN_OUT = path.resolve(process.cwd(), 'public/ephemeris/ephemeris.v1.bin');
const GOLDENS_OUT = path.resolve(process.cwd(), 'src/astronomy/ephemeris.goldens.json');

/** 1900-01-01 00:00 TDB, for 143 × 512 days (to 2100-06-16), so that every
 *  interval length tried divides the window exactly. */
const WINDOW_START_JD = 2415020.5;
const WINDOW_END_JD = WINDOW_START_JD + 143 * 512;
/** Horizons refuses more than 90,000 rows a request, and answered 503 to one
 *  of 85,000; 40,000 come back in a couple of seconds. */
const MAX_ROWS_PER_REQUEST = 40_000;
/** From Horizons' physical data for body 301 ("Earth/Moon mass ratio"). */
const EARTH_MOON_MASS_RATIO = 81.3005690769;

/**
 * Targets, as the worst held-out error in km. Moon: 1 km keeps an eclipse's
 * centre line within about 2 km. The barycentre feeds Earth, whose error
 * moves the Sun's direction by error / 1 AU. Planets: about 0.05″ from Earth
 * at closest approach, far below anything visible.
 */
const BODIES = [
  { name: 'Moon', command: '301', center: '500@399', stepHours: 4, targetKm: 1, intervals: [4, 8, 16] },
  { name: 'EarthMoonBarycenter', command: '3', center: '500@10', stepHours: 12, targetKm: 5, intervals: [16, 32, 64] },
  { name: 'Mercury', command: '1', center: '500@10', stepHours: 12, targetKm: 10, intervals: [8, 16, 32] },
  { name: 'Venus', command: '2', center: '500@10', stepHours: 24, targetKm: 10, intervals: [16, 32, 64] },
  { name: 'Mars', command: '4', center: '500@10', stepHours: 24, targetKm: 20, intervals: [16, 32, 64] },
  { name: 'Jupiter', command: '5', center: '500@10', stepHours: 96, targetKm: 50, intervals: [64, 128, 256] },
  { name: 'Saturn', command: '6', center: '500@10', stepHours: 96, targetKm: 50, intervals: [64, 128, 256] },
  { name: 'Uranus', command: '7', center: '500@10', stepHours: 192, targetKm: 100, intervals: [128, 256, 512] },
  { name: 'Neptune', command: '8', center: '500@10', stepHours: 192, targetKm: 100, intervals: [128, 256, 512] },
  { name: 'Pluto', command: '9', center: '500@10', stepHours: 192, targetKm: 100, intervals: [128, 256, 512] },
];
const COEFFICIENT_COUNTS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/** Golden instants: off every fit grid (odd fractions of a day), spread over
 *  the window. Earth (399) is fetched too, for the derived-Earth check. */
const GOLDEN_JDS = [
  2415600.3171, 2421234.7389, 2427777.1234, 2433282.9876, 2439999.4321,
  2444444.6543, 2448888.2109, 2451545.3333, 2455555.5555, 2458849.8765,
  2460676.1111, 2461361.7777, 2462222.4444, 2466666.6666, 2472727.2727,
  2477777.0123, 2483333.3456, 2487777.7654,
];

function fail(message) {
  console.error(`gen-ephemeris: ${message}`);
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

/** A download, retried with backoff when the server is momentarily busy. */
async function downloadWithRetry(url) {
  const backoffMs = [2_000, 10_000, 30_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await download(url);
    } catch (error) {
      if (attempt >= backoffMs.length || !/HTTP 5\d\d|ECONNRESET|ETIMEDOUT/.test(String(error))) throw error;
      console.log(`  retrying after ${String(error).slice(0, 60)}`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
    }
  }
}

async function cached(fileName, fetcher) {
  const filePath = path.join(CACHE_DIR, fileName);
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    if (OFFLINE) fail(`--offline but cache miss: ${filePath}`);
    const text = await fetcher();
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(filePath, text);
    await new Promise((resolve) => setTimeout(resolve, 500));
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

/** Parse a Horizons vector table: [jdTdb, x, y, z] rows, plus the source line. */
function parseVectors(text, what) {
  const start = text.indexOf('$$SOE');
  const end = text.indexOf('$$EOE');
  if (start < 0 || end < 0) fail(`no vector table for ${what}:\n${text.slice(0, 600)}`);
  const rows = [];
  for (const line of text.slice(start + 5, end).split('\n')) {
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length < 5 || !cells[0]) continue;
    rows.push([Number(cells[0]), Number(cells[2]), Number(cells[3]), Number(cells[4])]);
  }
  const source = /Target body name:.*?\{source:\s*([^}]+)\}/.exec(text)?.[1]?.trim() ?? 'unknown';
  return { rows, source };
}

async function fetchSeries(body) {
  const stepDays = body.stepHours / 24;
  const totalRows = Math.round((WINDOW_END_JD - WINDOW_START_JD) / stepDays) + 1;
  const chunkRows = Math.min(MAX_ROWS_PER_REQUEST, totalRows);
  const rows = [];
  let source = '';
  for (let firstRow = 0; firstRow < totalRows - 1; firstRow += chunkRows - 1) {
    const lastRow = Math.min(totalRows - 1, firstRow + chunkRows - 1);
    const startJd = WINDOW_START_JD + firstRow * stepDays;
    const stopJd = WINDOW_START_JD + lastRow * stepDays;
    const fileName = `${body.name}_${startJd}_${stopJd}_${body.stepHours}h.txt`;
    const text = await cached(fileName, () => {
      console.log(`  fetching ${body.name} JD ${startJd}–${stopJd}`);
      return downloadWithRetry(
        horizonsQuery({
          COMMAND: body.command,
          CENTER: body.center,
          START_TIME: `JD${startJd}`,
          STOP_TIME: `JD${stopJd}`,
          STEP_SIZE: `${body.stepHours}h`,
        }),
      );
    });
    const parsed = parseVectors(text, fileName);
    source = parsed.source;
    // Chunks share their boundary row; keep it once.
    rows.push(...(rows.length ? parsed.rows.slice(1) : parsed.rows));
  }
  if (rows.length !== totalRows) fail(`${body.name}: expected ${totalRows} rows, got ${rows.length}`);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const expectedJd = WINDOW_START_JD + rowIndex * stepDays;
    if (Math.abs(rows[rowIndex][0] - expectedJd) > 1e-6) fail(`${body.name}: row ${rowIndex} at JD ${rows[rowIndex][0]}, expected ${expectedJd}`);
  }
  return { rows, source };
}

/** Chebyshev polynomials T0..T(n−1) at x. */
function chebyshevRow(x, count) {
  const row = new Float64Array(count);
  row[0] = 1;
  if (count > 1) row[1] = x;
  for (let degree = 2; degree < count; degree++) row[degree] = 2 * x * row[degree - 1] - row[degree - 2];
  return row;
}

/** Invert a square matrix (array of Float64Array rows) by Gauss–Jordan with
 *  partial pivoting. */
function invert(matrix) {
  const size = matrix.length;
  const work = matrix.map((row, rowIndex) => {
    const extended = new Float64Array(2 * size);
    extended.set(row);
    extended[size + rowIndex] = 1;
    return extended;
  });
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let rowIndex = column + 1; rowIndex < size; rowIndex++) {
      if (Math.abs(work[rowIndex][column]) > Math.abs(work[pivot][column])) pivot = rowIndex;
    }
    if (Math.abs(work[pivot][column]) < 1e-300) fail('singular fit matrix');
    [work[column], work[pivot]] = [work[pivot], work[column]];
    const pivotValue = work[column][column];
    for (let entry = 0; entry < 2 * size; entry++) work[column][entry] /= pivotValue;
    for (let rowIndex = 0; rowIndex < size; rowIndex++) {
      if (rowIndex === column) continue;
      const factor = work[rowIndex][column];
      if (factor === 0) continue;
      for (let entry = 0; entry < 2 * size; entry++) work[rowIndex][entry] -= factor * work[column][entry];
    }
  }
  return work.map((row) => row.slice(size));
}

/**
 * A fitter for one (interval length, series length, sample step): the
 * constrained least-squares solution is linear in the samples, so the KKT
 * matrix is inverted once and every interval is a matrix–vector product.
 */
function makeFitter(intervalSamples, coefficientCount) {
  // Fit samples: every other sample, both ends included (interval sample
  // count is even, so the ends are both even-numbered).
  const fitPositions = [];
  for (let sample = 0; sample <= intervalSamples; sample += 2) fitPositions.push(sample);
  const fitBasis = fitPositions.map((sample) => chebyshevRow((2 * sample) / intervalSamples - 1, coefficientCount));
  const size = coefficientCount + 2;
  const kkt = Array.from({ length: size }, () => new Float64Array(size));
  for (const row of fitBasis) {
    for (let first = 0; first < coefficientCount; first++) {
      for (let second = 0; second < coefficientCount; second++) kkt[first][second] += row[first] * row[second];
    }
  }
  const startConstraint = chebyshevRow(-1, coefficientCount);
  const endConstraint = chebyshevRow(1, coefficientCount);
  for (let degree = 0; degree < coefficientCount; degree++) {
    kkt[coefficientCount][degree] = kkt[degree][coefficientCount] = startConstraint[degree];
    kkt[coefficientCount + 1][degree] = kkt[degree][coefficientCount + 1] = endConstraint[degree];
  }
  const inverse = invert(kkt);
  const heldOutPositions = [];
  for (let sample = 1; sample < intervalSamples; sample += 2) heldOutPositions.push(sample);
  const heldOutBasis = heldOutPositions.map((sample) => chebyshevRow((2 * sample) / intervalSamples - 1, coefficientCount));
  return { fitPositions, fitBasis, inverse, heldOutPositions, heldOutBasis, coefficientCount };
}

const float32Scratch = new Float32Array(1);
/** A coefficient as the file stores it: c0 and c1 as doubles, the rest as floats. */
function stored(value, degree) {
  if (degree < 2) return value;
  float32Scratch[0] = value;
  return float32Scratch[0];
}

/** Fit one coordinate of one interval from its samples. */
function fitInterval(fitter, values) {
  const { fitPositions, fitBasis, inverse, coefficientCount } = fitter;
  const size = coefficientCount + 2;
  const rhs = new Float64Array(size);
  fitPositions.forEach((sample, fitIndex) => {
    const row = fitBasis[fitIndex];
    for (let degree = 0; degree < coefficientCount; degree++) rhs[degree] += row[degree] * values[sample];
  });
  rhs[coefficientCount] = values[0];
  rhs[coefficientCount + 1] = values[values.length - 1];
  const coefficients = new Float64Array(coefficientCount);
  for (let degree = 0; degree < coefficientCount; degree++) {
    let sum = 0;
    for (let entry = 0; entry < size; entry++) sum += inverse[degree][entry] * rhs[entry];
    coefficients[degree] = stored(sum, degree);
  }
  // Rounding c2… to float32 moves the ends by up to half a kilometre on a
  // planet, a step where intervals meet. Re-solve the two double-precision
  // terms so both ends land back on their samples exactly: at x = ±1 the
  // series is c0 ± c1 + Σ c_k (±1)^k.
  let evenSum = 0;
  let oddSum = 0;
  for (let degree = 2; degree < coefficientCount; degree++) {
    if (degree % 2 === 0) evenSum += coefficients[degree];
    else oddSum += coefficients[degree];
  }
  const startValue = values[0];
  const endValue = values[values.length - 1];
  coefficients[0] = (endValue + startValue) / 2 - evenSum;
  coefficients[1] = (endValue - startValue) / 2 - oddSum;
  return coefficients;
}

/** Fit a whole series at one setting: coefficients and worst held-out error. */
function fitSeries(rows, stepHours, intervalDays, coefficientCount) {
  const intervalSamples = Math.round((intervalDays * 24) / stepHours);
  if (intervalSamples % 2 !== 0 || intervalSamples < 2 * coefficientCount) return null;
  const intervalCount = Math.floor((rows.length - 1) / intervalSamples);
  if (intervalCount * intervalSamples !== rows.length - 1) return null;
  const fitter = makeFitter(intervalSamples, coefficientCount);
  const coefficients = new Float64Array(intervalCount * 3 * coefficientCount);
  let worstKm = 0;
  const values = new Float64Array(intervalSamples + 1);
  for (let interval = 0; interval < intervalCount; interval++) {
    const firstRow = interval * intervalSamples;
    const fitted = [];
    for (let coordinate = 0; coordinate < 3; coordinate++) {
      for (let sample = 0; sample <= intervalSamples; sample++) values[sample] = rows[firstRow + sample][1 + coordinate];
      const series = fitInterval(fitter, values);
      coefficients.set(series, (interval * 3 + coordinate) * coefficientCount);
      fitted.push(series);
    }
    fitter.heldOutPositions.forEach((sample, heldOutIndex) => {
      const basis = fitter.heldOutBasis[heldOutIndex];
      let squared = 0;
      for (let coordinate = 0; coordinate < 3; coordinate++) {
        let value = 0;
        for (let degree = 0; degree < coefficientCount; degree++) value += fitted[coordinate][degree] * basis[degree];
        const error = value - rows[firstRow + sample][1 + coordinate];
        squared += error * error;
      }
      worstKm = Math.max(worstKm, Math.sqrt(squared));
    });
  }
  return { intervalDays, coefficientCount, intervalCount, coefficients, worstKm };
}

function bytesFor(intervalCount, coefficientCount) {
  return intervalCount * 3 * (16 + 4 * (coefficientCount - 2));
}

function chooseFit(body, rows) {
  let best = null;
  const tried = [];
  for (const intervalDays of body.intervals) {
    for (const coefficientCount of COEFFICIENT_COUNTS) {
      const fit = fitSeries(rows, body.stepHours, intervalDays, coefficientCount);
      if (!fit) continue;
      tried.push(`${intervalDays} d × ${coefficientCount}: ${fit.worstKm.toFixed(3)} km`);
      if (fit.worstKm > body.targetKm) continue;
      const bytes = bytesFor(fit.intervalCount, coefficientCount);
      if (!best || bytes < best.bytes) best = { ...fit, bytes };
      break; // longer series at this interval only cost more
    }
  }
  if (!best) fail(`${body.name} misses its ${body.targetKm} km target at every setting:\n  ${tried.join('\n  ')}`);
  return best;
}

function encode(fits) {
  const encoder = new TextEncoder();
  const names = fits.map((fit) => encoder.encode(fit.name));
  let headerBytes = 8;
  for (const name of names) headerBytes += 1 + name.length + 8 + 8 + 4 + 2 + 4 + 4;
  let offset = Math.ceil(headerBytes / 8) * 8;
  const offsets = fits.map((fit) => {
    const at = offset;
    offset += bytesFor(fit.intervalCount, fit.coefficientCount);
    return at;
  });
  const buffer = new ArrayBuffer(offset);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(encoder.encode('MEPH'), 0);
  view.setUint16(4, 1, true);
  view.setUint16(6, fits.length, true);
  let cursor = 8;
  fits.forEach((fit, fitIndex) => {
    view.setUint8(cursor, names[fitIndex].length);
    bytes.set(names[fitIndex], cursor + 1);
    cursor += 1 + names[fitIndex].length;
    view.setFloat64(cursor, WINDOW_START_JD, true);
    view.setFloat64(cursor + 8, fit.intervalDays, true);
    view.setUint32(cursor + 16, fit.intervalCount, true);
    view.setUint16(cursor + 20, fit.coefficientCount, true);
    view.setFloat32(cursor + 22, fit.worstKm, true);
    view.setUint32(cursor + 26, offsets[fitIndex], true);
    cursor += 30;
  });
  fits.forEach((fit, fitIndex) => {
    let at = offsets[fitIndex];
    const count = fit.coefficientCount;
    for (let block = 0; block < fit.intervalCount * 3; block++) {
      for (let degree = 0; degree < count; degree++) {
        const value = fit.coefficients[block * count + degree];
        if (degree < 2) {
          view.setFloat64(at, value, true);
          at += 8;
        } else {
          view.setFloat32(at, value, true);
          at += 4;
        }
      }
    }
  });
  return new Uint8Array(buffer);
}

async function fetchGoldens(bodies) {
  const goldenTargets = [
    ...bodies.map((body) => ({ name: body.name, command: body.command, center: body.center })),
    { name: 'Earth', command: '399', center: '500@10' },
  ];
  const goldens = {};
  for (const target of goldenTargets) {
    const text = await cached(`golden_${target.name}.txt`, () => {
      console.log(`  fetching golden instants for ${target.name}`);
      return downloadWithRetry(
        horizonsQuery({
          COMMAND: target.command,
          CENTER: target.center,
          TLIST: GOLDEN_JDS.join(' '),
          TLIST_TYPE: 'JD',
          TIME_TYPE: 'TDB',
        }),
      );
    });
    const { rows } = parseVectors(text, `golden ${target.name}`);
    if (rows.length !== GOLDEN_JDS.length) fail(`golden ${target.name}: expected ${GOLDEN_JDS.length} rows, got ${rows.length}`);
    goldens[target.name] = { center: target.center, command: target.command, rows };
  }
  return goldens;
}

async function main() {
  const fits = [];
  const sources = {};
  for (const body of BODIES) {
    console.log(`${body.name}:`);
    const { rows, source } = await fetchSeries(body);
    sources[body.name] = source;
    const fit = chooseFit(body, rows);
    console.log(
      `  ${fit.intervalDays} d × ${fit.coefficientCount}, held-out worst ${fit.worstKm.toFixed(3)} km` +
        ` (target ${body.targetKm}), ${(fit.bytes / 1024).toFixed(0)} KiB`,
    );
    fits.push({ name: body.name, ...fit });
  }
  const goldens = await fetchGoldens(BODIES);
  const bin = encode(fits);
  await fs.mkdir(path.dirname(BIN_OUT), { recursive: true });
  await fs.writeFile(BIN_OUT, bin);
  const provenance = {
    generator: 'gen-ephemeris.mjs',
    generated: new Date().toISOString().slice(0, 10),
    horizonsQuery:
      "EPHEM_TYPE='VECTORS' REF_PLANE='FRAME' (ICRF) VEC_CORR='NONE' (geometric) OUT_UNITS='KM-S' TLIST_TYPE='JD' TIME_TYPE='TDB'",
    sources,
    earthMoonMassRatio: EARTH_MOON_MASS_RATIO,
    earthMoonMassRatioSource: "Horizons physical data for body 301, 'Earth/Moon mass ratio'",
    window: { startJdTdb: WINDOW_START_JD, endJdTdb: WINDOW_END_JD },
    targetsKm: Object.fromEntries(BODIES.map((body) => [body.name, body.targetKm])),
    heldOutWorstKm: Object.fromEntries(fits.map((fit) => [fit.name, Number(fit.worstKm.toFixed(4))])),
  };
  await fs.writeFile(
    GOLDENS_OUT,
    JSON.stringify({ provenance, instantsJdTdb: GOLDEN_JDS, bodies: goldens }, null, 1) + '\n',
  );
  console.log(`wrote ${BIN_OUT} (${(bin.length / 1024 / 1024).toFixed(2)} MiB) and ${GOLDENS_OUT}`);
}

main().catch((error) => fail(error.stack ?? String(error)));
