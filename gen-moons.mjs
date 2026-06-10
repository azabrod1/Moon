/**
 * gen-moons.mjs — regenerates the satellite (moon) ephemeris data:
 *   src/astronomy/satelliteElements.ts   (element records + calibrated rates)
 *   src/astronomy/satellites.goldens.json (Horizons vector fixtures for tests)
 *
 * Usage: node gen-moons.mjs [--offline]
 *   --offline  use only .moon-data-cache/ (no network)
 *
 * Sources:
 *  - https://ssd.jpl.nasa.gov/sats/elem/  — orbit geometry (a, e, i, w0, node0),
 *    reference frame (ecliptic / equatorial / Laplace pole), precession periods,
 *    sidereal-ish period P, per-row epoch. Transcribed verbatim into `source`.
 *  - JPL Horizons API — planetocentric vectors (ecliptic J2000, TDB) used to
 *    (a) anchor each moon's mean anomaly at its row epoch (the page's in-plane
 *        phase columns are internally inconsistent across ephemerides and
 *        unrecoverable per-row — see the M3 plan receipts),
 *    (b) calibrate rate semantics + precession signs (Tier V) or fit rates
 *        outright where the page's rates fail (Tier F, e.g. Triton whose quoted
 *        nodal period is ~half the real one),
 *    (c) emit golden fixtures (anchor + 6 calibration epochs + 2026 holdout).
 *
 * Calibration epochs are deliberately non-commensurate with the element epochs
 * (the original 5-Julian-year grid aliased rate errors near multiples of
 * 72 deg/yr — measured: a fitted Amalthea hit 3 deg on the grid but 107 deg at
 * the held-out epoch).
 */
import { promises as fs } from 'fs';
import https from 'https';
import path from 'path';

const OFFLINE = process.argv.includes('--offline');
const CACHE_DIR = path.resolve(process.cwd(), '.moon-data-cache');
const HORIZONS_CACHE = path.join(CACHE_DIR, 'horizons');
const PAGE_CACHE = path.join(CACHE_DIR, 'sats_elem.html');
const PAGE_URL = 'https://ssd.jpl.nasa.gov/sats/elem/';
const ELEMENTS_OUT = path.resolve(process.cwd(), 'src/astronomy/satelliteElements.ts');
const GOLDENS_OUT = path.resolve(process.cwd(), 'src/astronomy/satellites.goldens.json');
const MOON_DATA_PATH = path.resolve(process.cwd(), 'src/planetarium/planets/moonData.ts');

const DEG = Math.PI / 180;
const OBLIQUITY_DEG = 23.4392911; // must match src/astronomy/constants.ts
const EPS = OBLIQUITY_DEG * DEG;
const KM_PER_AU = 149_597_870.7;

const EPOCH_JD = {
  '2000-01-01.5': 2451545.0,
  '2020-01-01.0': 2458849.5,
  '2025-01-01.0': 2460676.5,
};
const CAL_JDS = [2447892.5, 2453371.5, 2454500.5, 2458849.5, 2464000.5, 2466154.5];
// Dense pass for moons whose fit stays poor on the 6-epoch grid: short-period
// moons with low-precision quoted P carry whole-revolution ambiguity across
// 15-year gaps (Phobos: +-4.7 rev over 26 yr). ~3-yr spacing + a mean-motion
// scan locks the true rate where one exists.
const DENSE_JDS = [
  2449061.5, // 1993-03-15
  2450284.5, // 1996-07-20
  2451493.5, // 1999-11-11
  2452526.5, // 2002-09-09
  2455686.5, // 2011-05-05
  2456891.5, // 2014-08-22
  2458099.5, // 2017-12-12
  2459673.5, // 2022-04-04
  2462408.5, // 2029-09-29
  2463189.5, // 2031-11-19
  2464850.5, // 2036-06-06
  2465706.5, // 2038-10-10
];
const HOLDOUT_JD = 2461202.5; // 2026-06-11 — never used for calibration/fitting
const TIER_V_MAX_DEG = 6;
const DENSE_REFIT_DEG = 8; // fitted residual above this triggers the dense pass
// Resonant librators: no linear mean-element model can track their longitude
// (Mimas-Tethys 71-yr libration, Janus/Epimetheus co-orbital swaps, trojan
// libration, Hyperion-Titan resonance). Best-effort rates + honest tolerances.
const LIBRATORS = new Set(['Mimas', 'Janus', 'Epimetheus', 'Hyperion', 'Helene', 'Calypso', 'Telesto']);

const PLANET_CENTER = { Mars: '499', Jupiter: '599', Saturn: '699', Uranus: '799', Neptune: '899', Pluto: '999' };
// Pole of the `equatorial`-frame rows, resolved empirically against Horizons:
// Uranus rows use the orbital angular-momentum pole — the ANTI-IAU pole
// (Miranda at epoch: 1.1 deg with this pole, 116 deg with the IAU pole).
// Pluto rows use the IAU pole as-is (Charon 0.08 deg at every probed epoch).
const EQUATORIAL_FRAME_POLE = {
  Uranus: { raDeg: 77.311, decDeg: 15.175 },
  Pluto: { raDeg: 132.993, decDeg: -6.163 },
};

// --- small helpers -----------------------------------------------------------

function fail(msg) {
  console.error(`gen-moons: ${msg}`);
  process.exit(1);
}

function download(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'orbital-sim-moon-generator', Accept: '*/*' } }, (response) => {
      const { statusCode = 0, headers } = response;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        resolve(download(new URL(headers.location, url).toString()));
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('error', reject);
  });
}

async function cached(filePath, fetcher) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    if (OFFLINE) fail(`--offline but cache miss: ${filePath}`);
    const text = await fetcher();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text);
    return text;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- catalog -----------------------------------------------------------------

async function readCatalog() {
  const src = await fs.readFile(MOON_DATA_PATH, 'utf8');
  const moons = [...src.matchAll(/moon\('([^']+)', '([^']+)'/g)].map((m) => ({ name: m[1], parent: m[2] }));
  if (moons.length < 60) fail(`parsed only ${moons.length} moons from moonData.ts — regex/format drift?`);
  const names = moons.map((m) => m.name);
  if (new Set(names).size !== names.length) fail('duplicate moon names in moonData.ts — bare-name keying breaks');
  return moons.filter((m) => m.parent !== 'Earth'); // Earth's Moon stays on Meeus
}

// --- JPL page parse ----------------------------------------------------------

const EXPECTED_HEADER = ['ID', 'Planet', 'Satellite', 'Code', 'Ephemeris', 'Frame', 'Epoch(TDB)', 'a(km)', 'e', 'ω(deg)', 'M(deg)', 'i(deg)', 'node(deg)', 'P(days)', 'Papsis(yr)', 'Pnode(yr)', 'R.A.(deg)', 'Dec.(deg)', 'Tilt(deg)', 'Ref.'];

function decodeEntities(s) {
  return s.replace(/&omega;/g, 'ω').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&times;/g, 'x');
}

function parseSatElemTable(html) {
  const tableStart = html.indexOf('<table id="sat_elem"');
  if (tableStart < 0) fail('no #sat_elem table found in page');
  const tableEnd = html.indexOf('</table>', tableStart);
  const tableHtml = html.slice(tableStart, tableEnd);
  const rows = [];
  for (const tr of tableHtml.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) =>
      decodeEntities(c[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
    );
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) fail('#sat_elem table parsed to zero rows');
  const header = rows.shift().map((h) => h.replace(/\s/g, ''));
  if (JSON.stringify(header) !== JSON.stringify(EXPECTED_HEADER.map((h) => h.replace(/\s/g, '')))) {
    fail(`#sat_elem header changed:\n  got      ${JSON.stringify(header)}\n  expected ${JSON.stringify(EXPECTED_HEADER)}`);
  }
  return rows.map((c) => ({
    planet: c[1], satellite: c[2], code: c[3], ephemeris: c[4], frame: c[5], epoch: c[6],
    a: c[7], e: c[8], omega: c[9], m: c[10], i: c[11], node: c[12],
    period: c[13], apsisYr: c[14], nodeYr: c[15], poleRa: c[16], poleDec: c[17], tilt: c[18],
  }));
}

function pickRow(rowsByMoon, parent, name) {
  const candidates = rowsByMoon.get(`${parent}/${name}`);
  if (!candidates) fail(`no JPL row for ${parent}/${name}`);
  for (const r of candidates) {
    if (!(r.epoch in EPOCH_JD)) fail(`unknown epoch '${r.epoch}' for ${name}`);
  }
  // newest epoch wins (e.g. Puck: URA184 Laplace@2025 over URA182 equatorial@2000)
  return candidates.slice().sort((x, y) => EPOCH_JD[x.epoch] - EPOCH_JD[y.epoch]).at(-1);
}

// numeric value of a table cell; '-' and '' mean "not available".
// Number() (unlike parseFloat) rejects trailing garbage, so a formatting
// change on the page fails loudly instead of silently truncating.
function num(s) {
  const t = s.trim();
  if (t === '' || t === '-') return null;
  const v = Number(t);
  if (!Number.isFinite(v)) fail(`unparseable number '${s}'`);
  return v;
}

// --- Horizons ----------------------------------------------------------------

function horizonsUrl(code, center, jd) {
  const q = [
    "format=text", `COMMAND='${code}'`, "OBJ_DATA='NO'", "MAKE_EPHEM='YES'", "EPHEM_TYPE='VECTORS'",
    `CENTER='500@${center}'`, "REF_PLANE='ECLIPTIC'", "REF_SYSTEM='J2000'", "VEC_TABLE='1'",
    "OUT_UNITS='AU-D'", `TLIST='${jd}'`,
  ].join('&');
  return `https://ssd.jpl.nasa.gov/api/horizons.api?${q}`;
}

async function horizonsVector(name, code, center, jd) {
  const file = path.join(HORIZONS_CACHE, `${name}_${jd.toFixed(1)}.txt`);
  const text = await cached(file, async () => {
    await sleep(400); // be polite to the API
    return download(horizonsUrl(code, center, jd));
  });
  const block = text.match(/\$\$SOE([\s\S]*?)\$\$EOE/);
  if (!block) fail(`no $$SOE block for ${name} @ ${jd} (${file})`);
  const xyz = block[1].match(/X\s*=\s*([-\d.E+]+)\s*Y\s*=\s*([-\d.E+]+)\s*Z\s*=\s*([-\d.E+]+)/);
  if (!xyz) fail(`no vector line for ${name} @ ${jd}`);
  return { raw: [xyz[1], xyz[2], xyz[3]], km: xyz.slice(1, 4).map((s) => Number.parseFloat(s) * KM_PER_AU) };
}

// --- real-frame math (right-handed ICRF/ecliptic; NOT the scene frame) -------

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
const unitFromRaDec = (raDeg, decDeg) => {
  const ra = raDeg * DEG, dec = decDeg * DEG;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
};
const eclToEq = (v) => [v[0], Math.cos(EPS) * v[1] - Math.sin(EPS) * v[2], Math.sin(EPS) * v[1] + Math.cos(EPS) * v[2]];
const sepDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b))))) / DEG;

function solveKepler(meanAnomalyRad, e) {
  let E = e < 0.8 ? meanAnomalyRad : Math.PI;
  for (let i = 0; i < 80; i++) {
    const d = (E - e * Math.sin(E) - meanAnomalyRad) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return E;
}

/** Frame basis: X = ascending node of the reference plane on the ICRF equator
 *  (= z-hat cross pole, at RA pole+90), Z = pole. Ecliptic rows degenerate to
 *  the equinox. Returns vectors in ECLIPTIC J2000 coords for direct comparison
 *  with Horizons vectors. */
function frameBasisEcliptic(frame) {
  if (frame.type === 'ecliptic') {
    return { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
  }
  const pEq = unitFromRaDec(frame.poleRaDeg, frame.poleDecDeg);
  const xEq = normalize(cross([0, 0, 1], pEq));
  const yEq = cross(pEq, xEq);
  const eqToEcl = (v) => [v[0], Math.cos(EPS) * v[1] + Math.sin(EPS) * v[2], -Math.sin(EPS) * v[1] + Math.cos(EPS) * v[2]];
  return { X: eqToEcl(xEq), Y: eqToEcl(yEq), Z: eqToEcl(pEq) };
}

/** Position in ecliptic km for propagated elements in the given basis. */
function positionEcliptic(geom, basis, omegaDeg, nodeDeg, mDeg) {
  const e = geom.e;
  const E = solveKepler(((mDeg % 360) + 360) % 360 * DEG, e);
  const nu = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(E), Math.cos(E) - e);
  const r = geom.aKm * (1 - e * Math.cos(E));
  const u = omegaDeg * DEG + nu;
  const nd = nodeDeg * DEG;
  const ir = geom.iDeg * DEG;
  const x = r * (Math.cos(nd) * Math.cos(u) - Math.sin(nd) * Math.sin(u) * Math.cos(ir));
  const y = r * (Math.sin(nd) * Math.cos(u) + Math.cos(nd) * Math.sin(u) * Math.cos(ir));
  const z = r * Math.sin(u) * Math.sin(ir);
  const { X, Y, Z } = basis;
  return [X[0] * x + Y[0] * y + Z[0] * z, X[1] * x + Y[1] * y + Z[1] * z, X[2] * x + Y[2] * y + Z[2] * z];
}

/** Invert the anchor vector to the mean anomaly at epoch (exact). */
function anchorM0(geom, basis, anchorKmEcl) {
  const { X, Y, Z } = basis;
  const g = [dot(anchorKmEcl, X), dot(anchorKmEcl, Y), dot(anchorKmEcl, Z)];
  const nd = geom.node0Deg * DEG;
  const ir = geom.iDeg * DEG;
  const e1 = [Math.cos(nd), Math.sin(nd), 0];
  const e2 = [-Math.sin(nd) * Math.cos(ir), Math.cos(nd) * Math.cos(ir), Math.sin(ir)];
  const u = Math.atan2(dot(g, e2), dot(g, e1));
  const nu = u - geom.omega0Deg * DEG;
  const e = geom.e;
  const E = Math.atan2(Math.sin(nu) * Math.sqrt(1 - e * e), e + Math.cos(nu));
  return ((((E - e * Math.sin(E)) / DEG) % 360) + 360) % 360;
}

// --- calibration -------------------------------------------------------------

function residuals(geom, basis, m0Deg, rates, golds) {
  return golds.map(({ jd, km }) => {
    const dt = jd - geom.epochJdTdb;
    const v = positionEcliptic(
      geom, basis,
      geom.omega0Deg + rates.omegaDot * dt,
      geom.node0Deg + rates.nodeDot * dt,
      m0Deg + rates.mDot * dt,
    );
    return sepDeg(v, km);
  });
}

function tierVCandidates(geom) {
  const wRate = geom.apsisYr ? 360 / (geom.apsisYr * 365.25) : 0;
  const nRate = geom.nodeYr ? 360 / (geom.nodeYr * 365.25) : 0;
  const out = [];
  const seen = new Set();
  // Ordered so the plan's tie default — lam with (sω,sΩ)=(+1,−1) — comes
  // first: selection keeps the earliest candidate on equal residuals.
  for (const model of ['lam', 'anom']) {
    for (const sw of [1, -1]) {
      for (const sn of [-1, 1]) {
        const omegaDot = sw * wRate;
        const nodeDot = sn * nRate;
        const mDot = model === 'anom' ? 360 / geom.periodDays : 360 / geom.periodDays - omegaDot - nodeDot;
        const key = `${mDot}|${omegaDot}|${nodeDot}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ model, omegaSign: sw, nodeSign: sn, rates: { mDot, omegaDot, nodeDot } });
      }
    }
  }
  return out;
}

/** Deterministic coarse-to-fine descent on (mDot, omegaDot, nodeDot).
 *  scanMDot additionally grid-scans the mean motion +-0.5% before descending —
 *  needed on the dense grid to escape whole-revolution aliases. */
function fitRates(geom, basis, m0Deg, seedRates, golds, scanMDot = false) {
  const cost = (rates) => Math.max(...residuals(geom, basis, m0Deg, rates, golds));
  // extra seeds help escape wrong-sign/wrong-multiple basins (Triton's node
  // period is quoted at ~half its real value)
  const seeds = [seedRates];
  for (const f of [0, 0.5, -0.5, 1, -1]) {
    seeds.push({ ...seedRates, nodeDot: f * Math.abs(seedRates.nodeDot || 0.001) });
    seeds.push({ ...seedRates, omegaDot: f * Math.abs(seedRates.omegaDot || 0.001) });
  }
  let best = null;
  for (const s of seeds) {
    const c = cost(s);
    if (!best || c < best.cost) best = { cost: c, rates: { ...s } };
  }
  if (scanMDot) {
    const span = Math.abs(seedRates.mDot) * 0.005;
    const step = Math.max(span / 1200, 1e-9);
    for (let mDot = seedRates.mDot - span; mDot <= seedRates.mDot + span; mDot += step) {
      const trial = { ...best.rates, mDot };
      const c = cost(trial);
      if (c < best.cost) best = { cost: c, rates: trial };
    }
  }
  const keys = ['mDot', 'omegaDot', 'nodeDot'];
  for (const scale of [1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7]) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const k of keys) {
        const step = scale * Math.max(Math.abs(best.rates[k]), k === 'mDot' ? Math.abs(seedRates.mDot) : 1e-3);
        for (const sgn of [1, -1]) {
          const trial = { ...best.rates, [k]: best.rates[k] + sgn * step };
          const c = cost(trial);
          if (c < best.cost - 1e-9) {
            best = { cost: c, rates: trial };
            improved = true;
          }
        }
      }
    }
  }
  return best;
}

// --- main --------------------------------------------------------------------

async function main() {
  const catalog = await readCatalog();
  const pageHtml = await cached(PAGE_CACHE, () => download(PAGE_URL));
  const allRows = parseSatElemTable(pageHtml);
  const rowsByMoon = new Map();
  for (const r of allRows) {
    const key = `${r.planet}/${r.satellite}`;
    if (!rowsByMoon.has(key)) rowsByMoon.set(key, []);
    rowsByMoon.get(key).push(r);
  }

  const records = [];
  const goldens = {};
  for (const { name, parent } of catalog) {
    const row = pickRow(rowsByMoon, parent, name);
    const center = PLANET_CENTER[parent] ?? fail(`no Horizons center for ${parent}`);

    let frame;
    if (row.frame === 'ecliptic') frame = { type: 'ecliptic' };
    else if (row.frame === 'Laplace') frame = { type: 'pole', poleRaDeg: num(row.poleRa), poleDecDeg: num(row.poleDec) };
    else if (row.frame === 'equatorial') {
      const pole = EQUATORIAL_FRAME_POLE[parent] ?? fail(`equatorial-frame row for ${parent} but no resolved pole`);
      frame = { type: 'pole', poleRaDeg: pole.raDeg, poleDecDeg: pole.decDeg };
    } else fail(`unknown frame '${row.frame}' for ${name}`);

    const geom = {
      aKm: num(row.a), e: num(row.e), iDeg: num(row.i),
      omega0Deg: num(row.omega), node0Deg: num(row.node),
      periodDays: num(row.period), apsisYr: num(row.apsisYr), nodeYr: num(row.nodeYr),
      epochJdTdb: EPOCH_JD[row.epoch],
    };

    const epochs = [...new Set([geom.epochJdTdb, ...CAL_JDS, HOLDOUT_JD])].sort((a, b) => a - b);
    const vectors = {};
    for (const jd of epochs) vectors[jd.toFixed(1)] = await horizonsVector(name, row.code, center, jd);

    const basis = frameBasisEcliptic(frame);
    const anchorVec = vectors[geom.epochJdTdb.toFixed(1)];
    const m0 = anchorM0(geom, basis, anchorVec.km);
    const calGolds = CAL_JDS.filter((jd) => jd !== geom.epochJdTdb).map((jd) => ({ jd, km: vectors[jd.toFixed(1)].km }));
    const holdGold = [{ jd: HOLDOUT_JD, km: vectors[HOLDOUT_JD.toFixed(1)].km }];

    let bestV = null;
    for (const cand of tierVCandidates(geom)) {
      const maxCal = Math.max(...residuals(geom, basis, m0, cand.rates, calGolds));
      if (!bestV || maxCal < bestV.maxCal) bestV = { ...cand, maxCal };
    }

    let tier, rates, model = bestV.model, omegaSign = bestV.omegaSign, nodeSign = bestV.nodeSign, maxCal;
    let dense = false;
    if (bestV.maxCal <= TIER_V_MAX_DEG && !LIBRATORS.has(name)) {
      tier = 'verbatim';
      rates = bestV.rates;
      maxCal = bestV.maxCal;
    } else {
      let fit = fitRates(geom, basis, m0, bestV.rates, calGolds);
      tier = LIBRATORS.has(name) ? 'librator' : 'fitted';
      if (tier === 'fitted' && fit.cost > DENSE_REFIT_DEG) {
        dense = true;
        for (const jd of DENSE_JDS) vectors[jd.toFixed(1)] = await horizonsVector(name, row.code, center, jd);
        const denseGolds = [...calGolds, ...DENSE_JDS.map((jd) => ({ jd, km: vectors[jd.toFixed(1)].km }))];
        fit = fitRates(geom, basis, m0, bestV.rates, denseGolds, true);
      }
      rates = fit.rates;
      maxCal = fit.cost;
    }
    const holdout = residuals(geom, basis, m0, rates, holdGold)[0];

    records.push({
      name, parent, frame, geom, m0, rates, tier, model, omegaSign, nodeSign, dense,
      maxCal, holdout,
      source: {
        ephemeris: row.ephemeris, frame: row.frame, epoch: row.epoch,
        a: row.a, e: row.e, omega: row.omega, m: row.m, i: row.i, node: row.node,
        period: row.period, apsisYr: row.apsisYr, nodeYr: row.nodeYr,
        poleRa: row.poleRa, poleDec: row.poleDec, tilt: row.tilt,
      },
    });
    goldens[name] = {
      center: `500@${center}`,
      anchorJdTdb: geom.epochJdTdb,
      vectorsAuEclipticJ2000: Object.fromEntries(Object.entries(vectors).map(([jd, v]) => [jd, v.raw])),
    };
    console.log(`${name.padEnd(12)} tier=${tier.padEnd(8)} maxCal=${maxCal.toFixed(2).padStart(7)} holdout=${holdout.toFixed(2).padStart(7)}`);
  }

  await emitElements(records);
  await emitGoldens(records, goldens);
  const counts = records.reduce((m, r) => ((m[r.tier] = (m[r.tier] ?? 0) + 1), m), {});
  console.log(`\nwrote ${records.length} records (${JSON.stringify(counts)})`);
  console.log(`  ${path.relative(process.cwd(), ELEMENTS_OUT)}`);
  console.log(`  ${path.relative(process.cwd(), GOLDENS_OUT)}`);
}

function fmt(n, digits = 12) {
  // shortest representation that round-trips at the given precision
  const s = Number(n.toPrecision(digits)).toString();
  return s;
}

async function emitElements(records) {
  const generatedAt = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push('/**');
  lines.push(' * AUTO-GENERATED by gen-moons.mjs — DO NOT EDIT (run `npm run gen:moons`).');
  lines.push(` * Generated ${generatedAt} from ${PAGE_URL} (geometry, frames, quoted`);
  lines.push(' * periods; the quoted source strings are preserved verbatim in each');
  lines.push(' * record\'s comment) and JPL Horizons vectors (anchored mean anomaly at');
  lines.push(' * epoch; calibrated/fitted rates).');
  lines.push(' *');
  lines.push(' * Model: omega(t) = omega0 + omegaDot*dt, node(t) = node0 + nodeDot*dt,');
  lines.push(' * M(t) = anchoredM0 + mDot*dt; dt in days TT from epochJdTdb (TT~TDB).');
  lines.push(' *');
  lines.push(' * Tiers (each record\'s comment carries its quoted source values and the');
  lines.push(' * selected model/signs so calibration choices stay reviewable):');
  lines.push(' *  - verbatim: rates derive from the quoted periods via the selected');
  lines.push(' *    semantics (the page is inconsistent about what P means).');
  lines.push(' *  - fitted: quoted rates failed against Horizons (>6 deg max over the six');
  lines.push(' *    base calibration epochs); rates least-squares fitted to those epochs,');
  lines.push(' *    plus 12 dense ~3-yr-spaced epochs for moons flagged "dense" below');
  lines.push(' *    (whole-revolution rate ambiguity). Geometry stays verbatim; residuals');
  lines.push(' *    are maxima over the epochs each moon was actually fit on.');
  lines.push(' *  - librator: resonant longitude libration (Mimas-Tethys, co-orbitals,');
  lines.push(' *    trojans, Hyperion); no linear model can track it. Best-effort rates;');
  lines.push(' *    expect tens of degrees of in-plane error.');
  lines.push(' *');
  lines.push(' * The `equatorial`-frame pole for Uranus rows is the ANTI-IAU pole');
  lines.push(' * (angular-momentum pole, empirically resolved: Miranda 1.1 deg vs 116 deg).');
  lines.push(' *');
  lines.push(' * Validity: anchored/calibrated over 1990-2040; linear extrapolation');
  lines.push(' * degrades gracefully outside (plane/ellipse stay sane, phase drifts).');
  lines.push(' *');
  lines.push(' * Per-moon max calibration / holdout-2026 residuals (deg):');
  for (const r of records) {
    const tierLabel = r.dense ? `${r.tier}+dense` : r.tier;
    lines.push(` *   ${r.name.padEnd(12)} ${tierLabel.padEnd(14)} cal=${r.maxCal.toFixed(2).padStart(7)} holdout=${r.holdout.toFixed(2).padStart(7)}`);
  }
  lines.push(' */');
  lines.push('');
  lines.push('export interface SatelliteElementsRecord {');
  lines.push('  parentPlanet: string;');
  lines.push("  /** 'ecliptic' rows use the J2000 ecliptic; pole rows give the reference-plane pole (ICRF RA/Dec). */");
  lines.push('  poleRaDeg: number | null;');
  lines.push('  poleDecDeg: number | null;');
  lines.push('  epochJdTdb: number;');
  lines.push('  aKm: number;');
  lines.push('  eccentricity: number;');
  lines.push('  inclinationDeg: number;');
  lines.push('  argPeriapsisAtEpochDeg: number;');
  lines.push('  ascendingNodeAtEpochDeg: number;');
  lines.push('  /** Horizons-anchored mean anomaly at epoch (the page phase columns are unreliable). */');
  lines.push('  meanAnomalyAtEpochDeg: number;');
  lines.push('  meanAnomalyRateDegPerDay: number;');
  lines.push('  argPeriapsisRateDegPerDay: number;');
  lines.push('  ascendingNodeRateDegPerDay: number;');
  lines.push("  tier: 'verbatim' | 'fitted' | 'librator';");
  lines.push('  /** Measured max angular separation vs Horizons over the calibration epochs (deg). */');
  lines.push('  maxCalibrationSeparationDeg: number;');
  lines.push('  /** Measured separation at the held-out 2026-06-11 epoch (deg). */');
  lines.push('  holdoutSeparationDeg: number;');
  lines.push('}');
  lines.push('');
  lines.push('export const SATELLITE_ELEMENTS: Record<string, SatelliteElementsRecord> = {');
  for (const r of records) {
    const f = r.frame;
    lines.push(`  // ${r.source.ephemeris} ${r.source.frame} @ ${r.source.epoch}; quoted: a=${r.source.a} e=${r.source.e} ω=${r.source.omega} M=${r.source.m} i=${r.source.i} node=${r.source.node} P=${r.source.period} Pap=${r.source.apsisYr} Pnode=${r.source.nodeYr} pole=(${r.source.poleRa || '—'},${r.source.poleDec || '—'}) tilt=${r.source.tilt || '—'}`);
    lines.push(`  // calibration: ${r.tier === 'verbatim' ? 'model' : 'seed'}=${r.model} signs=(${r.omegaSign > 0 ? '+1' : '-1'},${r.nodeSign > 0 ? '+1' : '-1'})${r.dense ? ' dense-epochs' : ''}`);
    lines.push(`  ${JSON.stringify(r.name)}: {`);
    lines.push(`    parentPlanet: ${JSON.stringify(r.parent)},`);
    lines.push(`    poleRaDeg: ${f.type === 'pole' ? fmt(f.poleRaDeg) : 'null'}, poleDecDeg: ${f.type === 'pole' ? fmt(f.poleDecDeg) : 'null'},`);
    lines.push(`    epochJdTdb: ${fmt(r.geom.epochJdTdb)},`);
    lines.push(`    aKm: ${fmt(r.geom.aKm)}, eccentricity: ${fmt(r.geom.e)}, inclinationDeg: ${fmt(r.geom.iDeg)},`);
    lines.push(`    argPeriapsisAtEpochDeg: ${fmt(r.geom.omega0Deg)}, ascendingNodeAtEpochDeg: ${fmt(r.geom.node0Deg)},`);
    lines.push(`    meanAnomalyAtEpochDeg: ${fmt(r.m0)},`);
    lines.push(`    meanAnomalyRateDegPerDay: ${fmt(r.rates.mDot, 15)},`);
    lines.push(`    argPeriapsisRateDegPerDay: ${fmt(r.rates.omegaDot, 15)},`);
    lines.push(`    ascendingNodeRateDegPerDay: ${fmt(r.rates.nodeDot, 15)},`);
    lines.push(`    tier: ${JSON.stringify(r.tier)},`);
    lines.push(`    maxCalibrationSeparationDeg: ${fmt(r.maxCal, 4)},`);
    lines.push(`    holdoutSeparationDeg: ${fmt(r.holdout, 4)},`);
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');
  await fs.writeFile(ELEMENTS_OUT, lines.join('\n'));
}

async function emitGoldens(records, goldens) {
  const out = {
    provenance: {
      generator: 'gen-moons.mjs',
      generatedAt: new Date().toISOString().slice(0, 10),
      horizonsQuery: "EPHEM_TYPE='VECTORS' VEC_TABLE='1' REF_PLANE='ECLIPTIC' REF_SYSTEM='J2000' OUT_UNITS='AU-D' CENTER='500@<parent body>' TLIST in TDB",
      note: 'Coordinates are verbatim Horizons output strings (AU, ecliptic J2000, planetocentric). anchorJdTdb is the element epoch used for the M0 anchor; the 2461202.5 epoch is the calibration holdout. Moons whose rate fit needed the dense pass also carry vectors at the dense epochs.',
      calibrationJdTdb: CAL_JDS,
      denseCalibrationJdTdb: DENSE_JDS,
      denseMoons: records.filter((r) => r.dense).map((r) => r.name),
      holdoutJdTdb: HOLDOUT_JD,
    },
    moons: goldens,
  };
  await fs.writeFile(GOLDENS_OUT, JSON.stringify(out, null, 1) + '\n');
}

main().catch((err) => fail(err.stack ?? String(err)));
