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
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIRS = ['textures', 'stardata', 'fonts', 'models', 'historic'];
const MIN_WARM_TEXTURES = 21;
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

export default function swPlugin() {
  let outDir = '';
  let base = '/';
  return {
    name: 'moon-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      base = config.base;
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
      const precache = [starPath, ...textures];
      for (const p of precache) {
        if (!(p in manifest)) {
          throw new Error(`sw: warm-script file is not in dist: ${p}`);
        }
      }

      const template = readFileSync(TEMPLATE_PATH, 'utf8');
      const marker = '/* __INJECT_MANIFEST__ */';
      if (!template.includes(marker)) throw new Error('sw: template inject marker missing');
      const sw = template.replace(
        marker,
        `const MANIFEST = ${JSON.stringify(manifest)};\nconst PRECACHE = ${JSON.stringify(precache)};`,
      );
      writeFileSync(path.join(outDir, 'sw.js'), sw);
      console.log(`sw.js: ${Object.keys(manifest).length} manifest entries, ${precache.length} precached`);
    },
  };
}
