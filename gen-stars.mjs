import { promises as fs } from 'fs';
import https from 'https';
import path from 'path';
import { gunzipSync } from 'zlib';
import { catalogFixture, encodeBrightStarBin } from './tools/starBinCodec.mjs';

const DEFAULT_MAGNITUDE = 7.5;
const HYG_V37_URL = 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/v3/hyg_v37.csv.gz';
// The catalog ships as a binary sidecar (format: tools/starBinCodec.mjs;
// parser: src/planetarium/data/brightStars.ts). The golden fixture is
// regenerated WITH it — the two must always move together, the way gen:moons
// owns its goldens: a regen that changes values is a deliberate fixture
// update, and brightStars.test.ts goes red on any mismatch between them.
const BIN_PATH = path.resolve(process.cwd(), 'public/stardata/bright-stars.v1.bin');
const GOLDEN_PATH = path.resolve(process.cwd(), 'src/planetarium/data/brightStarsGolden.json');

function parseMagnitudeArg(rawValue) {
  if (rawValue === undefined) return DEFAULT_MAGNITUDE;

  const magnitude = Number.parseFloat(rawValue);
  if (!Number.isFinite(magnitude)) {
    throw new Error(`Invalid magnitude threshold "${rawValue}".`);
  }

  return magnitude;
}

function download(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': 'orbital-sim-star-generator',
          Accept: '*/*',
        },
      },
      (response) => {
        const { statusCode = 0, headers } = response;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume();
          const redirectUrl = new URL(headers.location, url).toString();
          resolve(download(redirectUrl));
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`Failed to download HYG catalog (${statusCode}).`));
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
    if (row.length === 0 && field === '') {
      row = [];
      field = '';
      return;
    }

    row.push(field);
    onRow(row, rowIndex);
    rowIndex += 1;
    row = [];
    field = '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      emitRow();
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    emitRow();
  }
}

function roundNumber(value, decimals) {
  return Number(value.toFixed(decimals));
}


async function generateCatalog(magnitudeThreshold) {
  const compressedCatalog = await download(HYG_V37_URL);
  const csvText = gunzipSync(compressedCatalog).toString('utf8');
  const stars = [];
  let indexes = null;

  processCsvRows(csvText, (row, rowIndex) => {
    if (rowIndex === 0) {
      indexes = {
        ra: row.indexOf('ra'),
        dec: row.indexOf('dec'),
        mag: row.indexOf('mag'),
        ci: row.indexOf('ci'),
        proper: row.indexOf('proper'),
      };

      for (const [key, index] of Object.entries(indexes)) {
        if (index === -1) {
          throw new Error(`Missing "${key}" column in HYG catalog.`);
        }
      }
      return;
    }

    const magnitude = Number.parseFloat(row[indexes.mag]);
    if (!Number.isFinite(magnitude) || magnitude > magnitudeThreshold) {
      return;
    }

    const raHours = Number.parseFloat(row[indexes.ra]);
    const decDeg = Number.parseFloat(row[indexes.dec]);
    if (!Number.isFinite(raHours) || !Number.isFinite(decDeg)) {
      return;
    }

    const colorIndexValue = Number.parseFloat(row[indexes.ci]);
    const properName = (row[indexes.proper] || '').trim();
    if (properName === 'Sol') {
      return;
    }

    stars.push({
      raDeg: roundNumber(raHours * 15, 4),
      decDeg: roundNumber(decDeg, 4),
      magnitude: roundNumber(magnitude, 2),
      colorIndex: Number.isFinite(colorIndexValue) ? roundNumber(colorIndexValue, 2) : 0.65,
      name: properName || undefined,
    });
  });

  stars.push({
    raDeg: 0,
    decDeg: 0,
    magnitude: -26.7,
    colorIndex: 0.66,
    name: 'Sol',
  });

  stars.sort((left, right) => left.magnitude - right.magnitude);
  await fs.mkdir(path.dirname(BIN_PATH), { recursive: true });
  await fs.writeFile(BIN_PATH, encodeBrightStarBin(stars));
  await fs.writeFile(GOLDEN_PATH, JSON.stringify(catalogFixture(stars), null, 2) + '\n', 'utf8');

  return stars.length;
}

async function main() {
  const magnitudeThreshold = parseMagnitudeArg(process.argv[2]);
  const count = await generateCatalog(magnitudeThreshold);
  console.log(`Generated ${count.toLocaleString()} stars at magnitude <= ${magnitudeThreshold}.`);
  console.log(`Wrote ${BIN_PATH}`);
  console.log(`Wrote ${GOLDEN_PATH} — deliberate fixture update; run npm test.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
