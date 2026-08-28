/**
 * Vite build plugin: generates dist/sw.js from tools/sw.template.js at
 * closeBundle, injecting a content-hash manifest of the DATA directories and
 * the boot-set precache list. Lives inside `vite build` because that is the
 * only step CI runs (`npx vite build --base=/Moon/`) — a separate script
 * would silently not ship.
 *
 * Manifest invariant (what makes the worker's one-deploy-old skew harmless):
 * DATA_DIRS may hold only format-stable opaque assets (images, fonts, GLB)
 * or pathname-versioned structured data (bright-stars.v1.bin — a format
 * break ships as .v2.bin). Never add a directory whose files new app code
 * parses format-incompatibly under an unchanged name.
 *
 * The precache list is read out of the BUILT index.html's boot-texture-warm
 * script — the same single source of truth the boot itself runs — and the
 * build FAILS if the script is missing, a warm file doesn't exist in dist,
 * or the texture count collapses (the gen-maps "loud missing source"
 * convention).
 *
 * Sector tile sets are injected separately from the manifest: their folder
 * names carry a hash of their own contents, so the worker caches them with
 * no digest and no expiry, and an off-origin set needs its origin on an
 * allowlist before the worker will touch it at all. Both lists are emitted
 * here so there is one build-time source for what the app fetches and what
 * the worker is allowed to keep.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIRS = ['textures', 'stardata', 'fonts', 'models', 'historic'];
const MIN_WARM_TEXTURES = 21;
const TILE_ROOT = 'textures/tiles';
const TEMPLATE_PATH = fileURLToPath(new URL('./sw.template.js', import.meta.url));

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/** URL prefixes of the shipped tile sets — one per <key>/<tier> folder under
 *  textures/tiles/. The worker matches cached tiles against these, so a set
 *  that leaves the app is pruned off devices that hold it. */
function tileSetPrefixes(outDir, base) {
  const root = path.join(outDir, TILE_ROOT);
  if (!existsSync(root)) return [];
  const prefixes = [];
  for (const key of readdirSync(root)) {
    const keyDir = path.join(root, key);
    if (!statSync(keyDir).isDirectory()) continue;
    for (const tier of readdirSync(keyDir)) {
      if (statSync(path.join(keyDir, tier)).isDirectory()) {
        prefixes.push(`${base}${TILE_ROOT}/${key}/${tier}/`);
      }
    }
  }
  return prefixes.sort();
}

export default function swPlugin() {
  let outDir = '';
  let base = '/';
  return {
    name: 'moon-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      base = config.base;
      if (!base.startsWith('/')) {
        // Manifest keys are absolute pathnames because the worker matches on
        // url.pathname; a relative base ('./') would emit keys no request
        // ever matches — a worker that installs and then serves nothing.
        throw new Error(`sw: relative Vite base "${base}" unsupported — build with an absolute base`);
      }
    },
    closeBundle() {
      const manifest = {};
      for (const dir of DATA_DIRS) {
        const abs = path.join(outDir, dir);
        if (!existsSync(abs)) {
          throw new Error(`sw: expected data directory missing from dist: ${dir}/`);
        }
        for (const file of walkFiles(abs)) {
          const urlPath = base + path.relative(outDir, file).split(path.sep).join('/');
          manifest[urlPath] = createHash('sha256').update(readFileSync(file)).digest('hex');
        }
      }

      const html = readFileSync(path.join(outDir, 'index.html'), 'utf8');
      const script = html.match(/<script id="boot-texture-warm">([\s\S]*?)<\/script>/)?.[1];
      if (!script) throw new Error('sw: boot-texture-warm script not found in built index.html');
      const texPrefix = script.match(/'([^']*textures\/)' \+ files\[i\]/)?.[1];
      const starPath = script.match(/'([^']+\.bin)'/)?.[1];
      if (!texPrefix || !starPath) {
        throw new Error('sw: could not read the warm script\'s texture prefix or star bin path');
      }
      const textures = [...script.matchAll(/'([^']+\.webp)'/g)].map((m) => texPrefix + m[1]);
      if (textures.length < MIN_WARM_TEXTURES) {
        throw new Error(`sw: only ${textures.length} warm textures found (expected >= ${MIN_WARM_TEXTURES})`);
      }
      // Fonts join the precache so the SECOND visit is already fully
      // data-silent — they load too early in the boot for the runtime fetch
      // handler to have stored them on visit one otherwise.
      const fonts = Object.keys(manifest).filter(
        (p) => p.startsWith(base + 'fonts/') && p.endsWith('.woff2'),
      );
      const precache = [starPath, ...textures, ...fonts];
      for (const p of precache) {
        if (!(p in manifest)) {
          throw new Error(`sw: warm-script file is not in dist: ${p}`);
        }
      }
      // The precache IS the second-visit win — these throws are its test
      // harness, and they run on every build including CI's pre-deploy one.
      // A refactor that quietly emits an empty or gutted list must not ship.
      if (!precache.includes(starPath)) throw new Error('sw: star bin missing from precache');
      if (fonts.length < 2) throw new Error(`sw: expected the two boot fonts, found ${fonts.length}`);
      if (precache.length < MIN_WARM_TEXTURES + 3) {
        throw new Error(`sw: precache collapsed to ${precache.length} entries`);
      }

      // The tile list is the worker's whole picture of what tile bytes are
      // legitimate: an empty one silently turns tile caching off and lets the
      // activate prune delete every tile a device holds. Loud, like the
      // precache checks above.
      const tileSets = tileSetPrefixes(outDir, base);
      if (tileSets.length === 0) throw new Error(`sw: no tile sets found under dist/${TILE_ROOT}/`);
      // Off-origin tile hosts, empty while the tiles ship with the app: the
      // worker touches a cross-origin request only for an origin named here.
      const tileOrigins = [];

      const template = readFileSync(TEMPLATE_PATH, 'utf8');
      const marker = '/* __INJECT_MANIFEST__ */';
      if (!template.includes(marker)) throw new Error('sw: template inject marker missing');
      const sw = template.replace(
        marker,
        `const MANIFEST = ${JSON.stringify(manifest)};\nconst PRECACHE = ${JSON.stringify(precache)};\n` +
          `const TILE_ORIGINS = ${JSON.stringify(tileOrigins)};\nconst TILE_SETS = ${JSON.stringify(tileSets)};`,
      );
      writeFileSync(path.join(outDir, 'sw.js'), sw);
      console.log(
        `sw.js: ${Object.keys(manifest).length} manifest entries, ${precache.length} precached, ` +
          `${tileSets.length} tile sets${tileOrigins.length ? ` from ${tileOrigins.join(' ')}` : ''}`,
      );
    },
  };
}
