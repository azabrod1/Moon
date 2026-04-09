import { promises as fs } from 'fs';
import https from 'https';
import path from 'path';
import { gunzipSync } from 'zlib';

const HYG_V37_URL = 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/v3/hyg_v37.csv.gz';
const STELLARIUM_INDEX_URL = 'https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/modern/index.json';
const OUTPUT_PATH = path.resolve(process.cwd(), 'src/explore/data/constellations.ts');

/** Full names for IAU constellation abbreviations. */
const CONSTELLATION_NAMES = {
  And: 'Andromeda', Ant: 'Antlia', Aps: 'Apus', Aqr: 'Aquarius', Aql: 'Aquila',
  Ara: 'Ara', Ari: 'Aries', Aur: 'Auriga', Boo: 'Boötes', Cae: 'Caelum',
  Cam: 'Camelopardalis', Cnc: 'Cancer', CVn: 'Canes Venatici', CMa: 'Canis Major',
  CMi: 'Canis Minor', Cap: 'Capricornus', Car: 'Carina', Cas: 'Cassiopeia',
  Cen: 'Centaurus', Cep: 'Cepheus', Cet: 'Cetus', Cha: 'Chamaeleon',
  Cir: 'Circinus', Col: 'Columba', Com: 'Coma Berenices', CrA: 'Corona Australis',
  CrB: 'Corona Borealis', Crv: 'Corvus', Crt: 'Crater', Cru: 'Crux',
  Cyg: 'Cygnus', Del: 'Delphinus', Dor: 'Dorado', Dra: 'Draco',
  Equ: 'Equuleus', Eri: 'Eridanus', For: 'Fornax', Gem: 'Gemini',
  Gru: 'Grus', Her: 'Hercules', Hor: 'Horologium', Hya: 'Hydra',
  Hyi: 'Hydrus', Ind: 'Indus', Lac: 'Lacerta', Leo: 'Leo',
  LMi: 'Leo Minor', Lep: 'Lepus', Lib: 'Libra', Lup: 'Lupus',
  Lyn: 'Lynx', Lyr: 'Lyra', Men: 'Mensa', Mic: 'Microscopium',
  Mon: 'Monoceros', Mus: 'Musca', Nor: 'Norma', Oct: 'Octans',
  Oph: 'Ophiuchus', Ori: 'Orion', Pav: 'Pavo', Peg: 'Pegasus',
  Per: 'Perseus', Phe: 'Phoenix', Pic: 'Pictor', Psc: 'Pisces',
  PsA: 'Piscis Austrinus', Pup: 'Puppis', Pyx: 'Pyxis', Ret: 'Reticulum',
  Sge: 'Sagitta', Sgr: 'Sagittarius', Sco: 'Scorpius', Scl: 'Sculptor',
  Sct: 'Scutum', Ser: 'Serpens', Sex: 'Sextans', Tau: 'Taurus',
  Tel: 'Telescopium', Tri: 'Triangulum', TrA: 'Triangulum Australe', Tuc: 'Tucana',
  UMa: 'Ursa Major', UMi: 'Ursa Minor', Vel: 'Vela', Vir: 'Virgo',
  Vol: 'Volans', Vul: 'Vulpecula',
};

function download(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'orbital-sim-constellation-generator', Accept: '*/*' } },
      (response) => {
        const { statusCode = 0, headers } = response;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume();
          resolve(download(new URL(headers.location, url).toString()));
          return;
        }
        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${statusCode} from ${url}`));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    request.on('error', reject);
  });
}

function processCsvRows(text, onRow) {
  let field = '';
  let row = [];
  let inQuotes = false;
  let rowIndex = 0;

  const emitRow = () => {
    if (row.length === 0 && field === '') { row = []; field = ''; return; }
    row.push(field);
    onRow(row, rowIndex);
    rowIndex += 1;
    row = [];
    field = '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = !inQuotes; }
      continue;
    }
    if (!inQuotes && char === ',') { row.push(field); field = ''; continue; }
    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      emitRow();
      continue;
    }
    field += char;
  }
  if (field.length > 0 || row.length > 0) emitRow();
}

/**
 * Parse Stellarium modern/index.json format.
 * Constellations have "lines" as arrays of polylines (sequences of HIP IDs).
 * E.g. [[98036, 97649, 97278], [97649, 95501]] means two polylines.
 * We convert each polyline into consecutive pairs: (98036,97649), (97649,97278), etc.
 */
function parseIndexJson(jsonText) {
  const data = JSON.parse(jsonText);
  const constellations = [];

  for (const entry of (data.constellations || [])) {
    // id is like "CON modern Aql"
    const abbr = (entry.id || '').replace(/^CON\s+modern\s+/, '');
    if (!abbr) continue;

    // Extract English name from common_name
    let englishName = '';
    if (entry.common_name) {
      const en = entry.common_name.english;
      if (typeof en === 'string') {
        englishName = en;
      } else if (en && typeof en === 'object' && en.native) {
        englishName = en.native;
      }
    }

    const hipPairs = [];
    for (const polyline of (entry.lines || [])) {
      if (!Array.isArray(polyline) || polyline.length < 2) continue;
      for (let i = 0; i < polyline.length - 1; i++) {
        hipPairs.push([polyline[i], polyline[i + 1]]);
      }
    }

    if (hipPairs.length > 0) {
      constellations.push({ abbr, englishName, hipPairs });
    }
  }
  return constellations;
}

function roundNum(v, d) { return Number(v.toFixed(d)); }

async function main() {
  console.log('Downloading HYG catalog...');
  const compressedCatalog = await download(HYG_V37_URL);
  const csvText = gunzipSync(compressedCatalog).toString('utf8');

  // Build HIP → {ra, dec} map
  const hipMap = new Map();
  let colIndexes = null;

  processCsvRows(csvText, (row, rowIndex) => {
    if (rowIndex === 0) {
      colIndexes = {
        hip: row.indexOf('hip'),
        ra: row.indexOf('ra'),
        dec: row.indexOf('dec'),
      };
      for (const [key, idx] of Object.entries(colIndexes)) {
        if (idx === -1) throw new Error(`Missing "${key}" column in HYG catalog.`);
      }
      return;
    }

    const hip = parseInt(row[colIndexes.hip], 10);
    if (!Number.isFinite(hip) || hip <= 0) return;

    const raHours = parseFloat(row[colIndexes.ra]);
    const decDeg = parseFloat(row[colIndexes.dec]);
    if (!Number.isFinite(raHours) || !Number.isFinite(decDeg)) return;

    hipMap.set(hip, { raDeg: roundNum(raHours * 15, 4), decDeg: roundNum(decDeg, 4) });
  });

  console.log(`Built HIP map with ${hipMap.size} entries.`);

  console.log('Downloading Stellarium constellation data (index.json)...');
  const indexBuf = await download(STELLARIUM_INDEX_URL);
  const rawConstellations = parseIndexJson(indexBuf.toString('utf8'));

  console.log(`Parsed ${rawConstellations.length} constellations from Stellarium.`);

  // Convert HIP pairs to RA/Dec line segments
  const output = [];
  let totalSegments = 0;
  let missingHips = 0;

  for (const { abbr, englishName, hipPairs } of rawConstellations) {
    const name = CONSTELLATION_NAMES[abbr] || englishName || abbr;
    const lines = [];

    for (const [h1, h2] of hipPairs) {
      const s1 = hipMap.get(h1);
      const s2 = hipMap.get(h2);
      if (!s1 || !s2) {
        missingHips++;
        continue;
      }
      lines.push([s1.raDeg, s1.decDeg, s2.raDeg, s2.decDeg]);
    }

    if (lines.length > 0) {
      output.push({ name, abbr, lines });
      totalSegments += lines.length;
    }
  }

  console.log(`Converted ${output.length} constellations with ${totalSegments} line segments.`);
  if (missingHips > 0) console.log(`  (${missingHips} segments skipped due to missing HIP entries)`);

  // Generate TypeScript
  const tsLines = [
    'export interface ConstellationData {',
    '  name: string;',
    '  abbr: string;',
    '  lines: [number, number, number, number][];  // [ra1, dec1, ra2, dec2] in degrees',
    '}',
    '',
    '// Generated from Stellarium modern/index.json + HYG Database v3.7',
    'export const CONSTELLATIONS: ConstellationData[] = [',
  ];

  for (const c of output) {
    tsLines.push(`  { name: ${JSON.stringify(c.name)}, abbr: ${JSON.stringify(c.abbr)}, lines: [`);
    for (const seg of c.lines) {
      tsLines.push(`    [${seg.join(', ')}],`);
    }
    tsLines.push('  ] },');
  }

  tsLines.push('];', '');

  await fs.writeFile(OUTPUT_PATH, tsLines.join('\n'), 'utf8');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
