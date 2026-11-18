// The Retro look's bitmap fonts, as web fonts of square pixels (tools/pixelFont.mjs).
//
//   npm run gen:fonts
//
// Sources: the X.Org releases of the Adobe 75 dpi bitmaps (the bold and regular
// Helvetica-style sizes) and the misc fixed fonts (5 × 7), in the Unicode BDF
// edition by Markus Kuhn. Downloaded once into .moon-data-cache/pixel-fonts and
// checked against the hashes below, then read straight out of the archives
// (`tar` with xz, as on any Linux or macOS machine).
//
// Output: public/fonts/Retro*.woff and RETRO-FONTS.txt, the copyright and
// permission notices the Adobe and DEC licence asks to be kept with the files.
// The fonts are given generic names: the licence lets the images be used, not
// the names of the companies or of the original typeface.
//
// The files are data the service worker caches by name (CLAUDE.md): a change
// to what a font holds ships as a new file name, never over an old one.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildTrueType, parseBdf, wrapWoff } from './pixelFont.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cache = path.join(root, '.moon-data-cache', 'pixel-fonts');
const output = path.join(root, 'public', 'fonts');

const ARCHIVES = {
  adobe: {
    url: 'https://xorg.freedesktop.org/releases/individual/font/font-adobe-75dpi-1.0.4.tar.xz',
    sha256: '1281a62dbeded169e495cae1a5b487e1f336f2b4d971d92911c59c103999b911',
    folder: 'font-adobe-75dpi-1.0.4',
  },
  misc: {
    url: 'https://xorg.freedesktop.org/releases/individual/font/font-misc-misc-1.1.3.tar.xz',
    sha256: '79abe361f58bb21ade9f565898e486300ce1cc621d5285bec26e14b6a8618fed',
    folder: 'font-misc-misc-1.1.3',
  },
};

/** Each output: its source, its file, and the family and style it is named by in CSS. */
export const RETRO_FONTS = [
  { archive: 'adobe', source: 'helvB08', file: 'RetroSans-Bold8', family: 'Retro Sans 8', style: 'Bold', bold: true },
  { archive: 'adobe', source: 'helvB10', file: 'RetroSans-Bold10', family: 'Retro Sans 10', style: 'Bold', bold: true },
  { archive: 'adobe', source: 'helvR10', file: 'RetroSans-Regular10', family: 'Retro Sans 10', style: 'Regular', bold: false },
  { archive: 'adobe', source: 'helvB12', file: 'RetroSans-Bold12', family: 'Retro Sans 12', style: 'Bold', bold: true },
  { archive: 'adobe', source: 'helvB14', file: 'RetroSans-Bold14', family: 'Retro Sans 14', style: 'Bold', bold: true },
  { archive: 'adobe', source: 'helvB18', file: 'RetroSans-Bold18', family: 'Retro Sans 18', style: 'Bold', bold: true },
  { archive: 'misc', source: '5x7', file: 'RetroMono-7', family: 'Retro Mono 7', style: 'Regular', bold: false, monospace: true },
];

/** What the interface shows: Basic Latin, Latin-1, and the punctuation and
 *  arrows its text uses (dashes, quotes, the ellipsis, ‹ ›, ← → ↑ ↓, −, ≤ ≥ ≈). */
const EXTRA = new Set([0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x2039, 0x203a,
  0x2190, 0x2191, 0x2192, 0x2193, 0x2212, 0x2248, 0x2264, 0x2265]);
export function keepCode(code) {
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || EXTRA.has(code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function archivePath(key) {
  const archive = ARCHIVES[key];
  const file = path.join(cache, path.basename(archive.url));
  if (!existsSync(file)) {
    mkdirSync(cache, { recursive: true });
    console.log(`[gen:fonts] downloading ${archive.url}`);
    const response = await fetch(archive.url);
    if (!response.ok) throw new Error(`${archive.url}: ${response.status}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  const actual = sha256(readFileSync(file));
  if (actual !== archive.sha256) throw new Error(`${file}: sha256 ${actual}, expected ${archive.sha256}`);
  return file;
}

function readFromArchive(archiveFile, member) {
  return execFileSync('tar', ['-xJOf', archiveFile, member], { maxBuffer: 64 * 1024 * 1024 }).toString('latin1');
}

async function main() {
  mkdirSync(output, { recursive: true });
  const notices = new Map();
  for (const spec of RETRO_FONTS) {
    const archive = ARCHIVES[spec.archive];
    const archiveFile = await archivePath(spec.archive);
    const font = parseBdf(readFromArchive(archiveFile, `${archive.folder}/${spec.source}.bdf`));
    const woff = wrapWoff(buildTrueType(font, {
      familyName: spec.family, styleName: spec.style, bold: spec.bold, monospace: spec.monospace ?? false, keep: keepCode,
    }));
    const target = path.join(output, `${spec.file}.woff`);
    writeFileSync(target, woff);
    console.log(`[gen:fonts] ${spec.file}.woff  ${woff.length} bytes  from ${spec.source}.bdf  (pixel size ${font.pixelSize}, ascent ${font.ascent}, descent ${font.descent})`);
    if (!notices.has(spec.archive)) notices.set(spec.archive, readFromArchive(archiveFile, `${archive.folder}/COPYING`));
  }
  const text = [
    'The Retro look\'s bitmap fonts (public/fonts/Retro*.woff), made by tools/gen-pixel-fonts.mjs.',
    '',
    'Retro Sans 8, 10, 12, 14 and 18 are the bold and regular 75 dpi bitmaps of the X.Org',
    'font-adobe-75dpi release (the Unicode edition by Markus Kuhn), drawn as square pixels.',
    'Retro Mono 7 is the 5x7 bitmap of the X.Org font-misc-misc release, likewise.',
    'Their licences follow, as the X.Org releases carry them.',
    '',
    '==== font-adobe-75dpi: COPYING ====',
    notices.get('adobe').trim(),
    '',
    '==== font-misc-misc: COPYING ====',
    notices.get('misc').trim(),
    '',
  ].join('\n');
  writeFileSync(path.join(output, 'RETRO-FONTS.txt'), text);
  console.log('[gen:fonts] RETRO-FONTS.txt');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}
