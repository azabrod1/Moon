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
 * allowlist before the worker will touch it at all. The sets come from the
 * table gen-tiles generates and the origin from VITE_TILE_ORIGIN — the same
 * two sources the app resolves its tile URLs through, so the worker cannot
 * end up allowing a different host or a different set than the app fetches.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIRS = ['textures', 'stardata', 'fonts', 'models', 'historic'];
const MIN_WARM_TEXTURES = 21;
const TILE_ROOT = 'textures/tiles';
const TEMPLATE_PATH = fileURLToPath(new URL('./sw.template.js', import.meta.url));
const GENERATED_SETS_PATH = fileURLToPath(new URL('../src/planetarium/world/sectorSets.generated.ts', import.meta.url));
const TABLE_BEGIN = '/* table:begin */';
const TABLE_END = '/* table:end */';

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/** Where tiles are served from, read out of Vite's resolved `config.env` —
 *  the very object that backs `import.meta.env` in the app
 *  (world/texturePolicy.ts). It has to be that object and not process.env:
 *  Vite merges `.env` files into config.env and never writes them back to
 *  process.env, so a VITE_TILE_ORIGIN set in .env.production would leave the
 *  app fetching from the host while the worker allowed nothing — tiles
 *  uncached, no error. Empty is the app's own origin.
 *
 *  Exported for swContract.test.ts, which drives the plugin with a fake
 *  config.env to pin exactly that. */
export function tileOriginFrom(env) {
  const raw = (env?.VITE_TILE_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    new URL(raw);
  } catch {
    throw new Error(`sw: VITE_TILE_ORIGIN "${raw}" is not an absolute URL`);
  }
  return raw;
}

/** The tile sets the app names, read out of the table gen-tiles generates —
 *  the same table the app resolves its tile URLs through, so the worker
 *  cannot end up allowing a set nothing fetches or refusing one it does. That
 *  file emits its literal as JSON between markers for exactly this reason. */
function generatedTileSets() {
  const source = readFileSync(GENERATED_SETS_PATH, 'utf8');
  const begin = source.indexOf(TABLE_BEGIN);
  const end = source.indexOf(TABLE_END);
  if (begin < 0 || end < 0) throw new Error('sw: sectorSets.generated.ts has no table markers');
  const table = JSON.parse(source.slice(begin + TABLE_BEGIN.length, end));
  return Object.entries(table).map(([id, set]) => {
    const [key, tier] = id.split('/');
    return { id, dir: `${TILE_ROOT}/${key}/${tier}.${set.setHash8}/` };
  });
}

export default function swPlugin() {
  let outDir = '';
  let base = '/';
  let origin = '';
  return {
    name: 'moon-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      base = config.base;
      origin = tileOriginFrom(config.env);
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
      const sets = generatedTileSets();
      if (sets.length === 0) throw new Error('sw: the generated tile-set table names no sets');
      // Tiles fail open to the base map, so a build that names sets nothing
      // will serve produces a plausible-looking app with soft hero bodies and
      // no error anywhere. Fail here instead.
      if (!origin) {
        for (const set of sets) {
          if (!existsSync(path.join(outDir, set.dir))) {
            throw new Error(
              `sw: tile set ${set.id} is not in dist under ${set.dir} and VITE_TILE_ORIGIN is unset — ` +
                'ship the tiles or point the build at the host that has them',
            );
          }
        }
      }
      const tileSets = sets.map((set) => (origin ? `${origin}/` : base) + set.dir);
      // The worker touches a cross-origin request only for an origin named
      // here; empty means tiles are the app's own, like every other texture.
      const tileOrigins = origin ? [new URL(origin).origin] : [];

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
