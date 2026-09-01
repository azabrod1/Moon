/**
 * Dev-only sector-tile fallback. The levels too big to live in public/ are
 * staged in the main checkout's .moon-data-cache/tiles-staging (gen:tiles
 * --root writes them there); this middleware serves that root on the dev
 * server's own origin, so a plain dev URL streams every staged level — no
 * `?tiles=` override, no separate tile host, and the phone reaches them
 * through the same LAN URL as the app. public/ still answers first for the
 * sets it ships (identical bytes either way — the folder name is the set's
 * content hash — but the fallthrough keeps dev serving from where a build
 * would). `?tiles=` keeps working as the override for a root elsewhere.
 *
 * MOON_TILES_ROOT overrides the staging path. Worktrees resolve the MAIN
 * checkout's root through git, so every planning/.wt-* dev server sees the
 * same staged levels without a per-tree copy. Never part of a build: prod
 * tiles come from the VITE_TILE_ORIGIN host (.env.production).
 */
import { execSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const TYPES = { '.webp': 'image/webp', '.json': 'application/json' };

function stagingRoot(configRoot) {
  if (process.env.MOON_TILES_ROOT) return path.resolve(process.env.MOON_TILES_ROOT);
  let repoRoot = configRoot;
  try {
    const gitDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      cwd: configRoot, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    repoRoot = path.dirname(gitDir);
  } catch { /* not a git checkout: fall back to the config root itself */ }
  return path.join(repoRoot, '.moon-data-cache', 'tiles-staging');
}

export default function devTilesPlugin() {
  return {
    name: 'dev-tiles',
    apply: 'serve',
    configureServer(server) {
      const root = stagingRoot(server.config.root);
      const publicTiles = path.join(server.config.publicDir, 'textures', 'tiles');
      if (!existsSync(root)) {
        server.config.logger.info(`dev tiles: no staged root at ${root} — serving public/ sets only`);
        return;
      }
      server.config.logger.info(`dev tiles: staged levels from ${root}`);
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const pathname = decodeURIComponent((req.url ?? '').split('?')[0]);
        if (!pathname.startsWith('/textures/tiles/')) return next();
        const rel = pathname.slice('/textures/tiles/'.length);
        // public/ answers first; the staging root only fills what it lacks.
        if (existsSync(path.join(publicTiles, rel))) return next();
        const file = path.resolve(root, rel);
        if (!file.startsWith(root + path.sep)) return next();
        let size;
        try {
          const s = statSync(file);
          if (!s.isFile()) return next();
          size = s.size;
        } catch {
          return next();
        }
        res.writeHead(200, {
          'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
          'content-length': size,
          // Content-hashed folder names make tile bytes immutable even in dev.
          'cache-control': 'public, max-age=31536000, immutable',
        });
        if (req.method === 'HEAD') { res.end(); return; }
        createReadStream(file).pipe(res);
      });
    },
  };
}
