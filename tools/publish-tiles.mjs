// Publish cut sector tile sets to the repository the tiles are served from.
//
// Tiles are data, not app code: they ship from their own repo through a CDN
// (jsDelivr over GitHub) so the app's checkout, its CI and its Pages artifact
// never carry hundreds of megabytes of WebP. This is the one step between the
// two — it takes a tiles root gen-tiles wrote and lays it into a checkout of
// the host repo, ready for its owner to push.
//
// The whole caching model rests on one promise: a tile pathname,
// tiles/<key>/<tier>.<setHash8>/<c>_<r>.webp, means those exact bytes or a
// 404. A CDN, the service worker and the browser all keep such a tile forever
// without revalidating, so bytes published under a hash that is not their own
// are a wrong image no cache can be told to drop. Hence:
//   - every set named by the root's sets.v1.json is re-hashed from the bytes
//     about to be copied (tools/tileSetHash.mjs, the same function gen-tiles
//     stamped the folder name with) and a mismatch refuses the whole run;
//   - a set folder already in the repo is left exactly as it is;
//   - nothing is ever deleted from the repo — a browser or worker running an
//     older build still asks for the sets that build named, and those have to
//     keep answering. Pruning is a deliberate hand operation.
// A set is copied through a temporary folder and renamed into place, so an
// interrupted run cannot leave a half-copied set under a name that promises a
// whole one.
//
// Nothing is pushed. The commit is made locally and the push line printed:
// publishing is the owner's call, and the ref the app is built against is a
// live promise to every client already holding it.
//
// Usage:
//   node tools/publish-tiles.mjs --root=<tiles root> --repo=<tiles checkout>
//   --ref=main       the jsDelivr ref the app will be built against
//   --dry-run        print the plan, touch nothing
//   --verify-only    check the root against its own table, touch nothing
//   --origin=<user/repo>   used when the checkout has no GitHub `origin`
import { readdir, readFile, writeFile, stat, realpath, mkdir, cp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setHash8, tileNames } from './tileSetHash.mjs';

const SETS_JSON = 'sets.v1.json';
/** Where the sets sit inside the host repo. The app appends the same
 *  textures/tiles/… path to its origin, so an origin ending in this repo's
 *  root plus `textures` resolves here. */
const REPO_TILES = 'tiles';
const CDN = 'https://cdn.jsdelivr.net/gh';

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

function git(repo, args) {
  // stderr piped rather than inherited: every git call here is one whose
  // failure this file turns into a sentence of its own, and git's version of
  // it printed alongside reads as a second, unexplained error.
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** `<user>/<repo>` out of a git remote URL, in any of the shapes GitHub
 *  hands out. Null for a host jsDelivr's /gh/ route cannot serve. */
export function ownerRepoFromRemote(url) {
  const trimmed = url.trim();
  if (!/github\.com/i.test(trimmed)) return null;
  const m = trimmed.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The set folder a level-0 link is allowed to point at, as a path relative
 *  to the app's own tiles directory — or null for anything else. A staging
 *  root links the already-published sets straight into public/textures/tiles
 *  instead of duplicating gigabytes, and those links have to be followed and
 *  published like the real folders they name. Every other escape from the
 *  root is refused: a link is the one way bytes from somewhere nobody looked
 *  at could be published under a hash taken over bytes somewhere else. */
function appTilesRelative(real) {
  const marker = `${path.sep}public${path.sep}textures${path.sep}tiles${path.sep}`;
  const at = real.indexOf(marker);
  return at < 0 ? null : real.slice(at + marker.length);
}

/** Every path in a set folder resolves inside the root, or into the app's own
 *  copy of that same set under that same name. */
async function checkLinks(rootReal, dir, id, key, folder) {
  const inside = (real) => real === rootReal || real.startsWith(rootReal + path.sep);
  const want = `${key}${path.sep}${folder}`;
  const check = async (p, label) => {
    const real = await realpath(p);
    if (inside(real)) return;
    const rel = appTilesRelative(real);
    if (rel === want || (rel && rel.startsWith(want + path.sep))) return;
    throw new Error(
      `${id}: ${label} resolves to ${real}, outside the tiles root — a set may only link to public/textures/tiles/${key}/${folder}`,
    );
  };
  await check(dir, folder);
  for (const name of await readdir(dir)) await check(path.join(dir, name), name);
}

/**
 * Read the root's table and prove every set it names is on disk with the
 * bytes its folder name promises. Refuses the whole run on the first failure:
 * a table and a tree that disagree is a question about which one is right,
 * and publishing half of it answers it wrongly.
 */
export async function verifyRoot(root) {
  const rootReal = await realpath(root);
  const tablePath = path.join(root, SETS_JSON);
  let table;
  try {
    table = JSON.parse(await readFile(tablePath, 'utf8'));
  } catch (err) {
    throw new Error(`${tablePath}: no readable set table — run gen-tiles --index on this root first (${err.message})`);
  }
  const ids = Object.keys(table);
  if (ids.length === 0) throw new Error(`${tablePath}: names no sets`);
  const sets = [];
  for (const id of ids.sort()) {
    const entry = table[id];
    const [key, tier] = id.split('/');
    if (!key || !tier || !entry?.setHash8) throw new Error(`${tablePath}: "${id}" is not a <key>/<tier> entry with a hash`);
    const folder = `${tier}.${entry.setHash8}`;
    const dir = path.join(root, key, folder);
    let st;
    try {
      st = await stat(dir);
    } catch {
      throw new Error(`${id}: the table names ${path.join(key, folder)}, which is not in ${root} — cut it, or re-run gen-tiles --index on this root`);
    }
    if (!st.isDirectory()) throw new Error(`${id}: ${path.join(key, folder)} is not a directory`);
    await checkLinks(rootReal, dir, id, key, folder);
    const files = tileNames(await readdir(dir));
    if (files.length !== entry.fileCount) {
      throw new Error(`${id}: ${files.length} tiles in ${folder}, ${entry.fileCount} in the table`);
    }
    const hash = await setHash8(dir, files);
    if (hash !== entry.setHash8) {
      throw new Error(`${id}: the tiles in ${folder} hash to ${hash}, not the ${entry.setHash8} their folder name promises — the bytes changed under a published name; re-run gen-tiles --index on this root`);
    }
    let bytes = 0;
    for (const name of files) bytes += (await stat(path.join(dir, name))).size;
    sets.push({ id, key, tier, folder, dir, files, bytes });
  }
  return { table, sets };
}

/** The checkout has to be a git repo with nothing of its own outstanding, so
 *  the commit this makes holds the sets it copied and nothing else. */
function checkRepo(repo) {
  let top;
  try {
    top = git(repo, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error(`${repo}: not a git checkout — publishing commits into the tiles repository`);
  }
  const dirty = git(repo, ['status', '--porcelain']);
  if (dirty) {
    throw new Error(`${repo}: uncommitted changes — commit or clean them first so the publish commit holds only the sets it copied:\n${dirty}`);
  }
  return top;
}

/** `<user>/<repo>` for the CDN URL: the checkout's own GitHub `origin`, else
 *  what the caller passed. Both, disagreeing, is refused — the printed origin
 *  would send the app to a repository these sets were not put in. */
export function resolveOwnerRepo(remoteUrl, flag) {
  const fromRemote = remoteUrl ? ownerRepoFromRemote(remoteUrl) : null;
  if (flag && !/^[^/\s]+\/[^/\s]+$/.test(flag)) {
    throw new Error(`--origin=${flag} is not <user>/<repo>`);
  }
  if (fromRemote && flag && fromRemote !== flag) {
    throw new Error(`--origin=${flag} is not the checkout's origin ${fromRemote} — the printed URL would point the app at a repository these sets are not in`);
  }
  const chosen = fromRemote ?? flag;
  if (!chosen) {
    throw new Error(`the checkout has no GitHub "origin" remote — pass --origin=<user>/<repo> for the CDN URL`);
  }
  return chosen;
}

function readmeText(ownerRepo) {
  const name = ownerRepo.split('/')[1];
  return `# ${name}

Sector surface tiles for **Moon**, a Three.js planetarium — the streamed
detail its hero bodies (Earth, the Moon, Mars) draw close up. Data only:
no code, nothing to build or run here. Written by \`tools/publish-tiles.mjs\`
in the app repo; not edited by hand.

## The rule: a published path never moves

A set lives at \`${REPO_TILES}/<key>/<tier>.<setHash8>/<c>_<r>.webp\`, and that
folder name is a hash over the set's own bytes. The app is built against a
stable ref — \`VITE_TILE_ORIGIN=${CDN}/${ownerRepo}@<ref>\` — and every layer
between it and here (jsDelivr, the app's service worker, the browser cache)
keeps a tile forever without revalidating it. That is only safe while a
pathname means those exact bytes or a 404.

So: never edit, move or overwrite a set folder that is already here — a re-cut
set has a different hash and arrives as a new folder beside the old one; never
rewrite the history of the ref the app is built against; and leave old sets in
place after the app stops naming them, because a browser still running the
older build keeps asking for them. Pruning is deliberate and by hand, and a
pruned set 404s those clients (the app falls back to its whole-body map).

\`${REPO_TILES}/${SETS_JSON}\` is the table of what is here, copied from the cut.
`;
}

/**
 * Copy every set the root names into the repo, write the table and README,
 * and commit. Returns the plan either way, so --dry-run and the real run
 * report the same thing.
 */
export async function publishTiles({
  root,
  repo = '',
  ref = 'main',
  dryRun = false,
  verifyOnly = false,
  origin = '',
  log = console.log,
} = {}) {
  if (!root) throw new Error('--root=<tiles root> is required');
  const rootAbs = path.resolve(root);
  const { table, sets } = await verifyRoot(rootAbs);
  const totalBytes = sets.reduce((n, s) => n + s.bytes, 0);
  const totalTiles = sets.reduce((n, s) => n + s.files.length, 0);

  log(`${rootAbs}: ${sets.length} sets verified, ${totalTiles} tiles, ${mb(totalBytes)}`);
  for (const set of sets) log(`  ${set.id} -> ${REPO_TILES}/${set.key}/${set.folder}  ${set.files.length} tiles, ${mb(set.bytes)}`);
  if (verifyOnly) return { sets, added: [], present: [], totalBytes, origin: '', commit: null };

  const repoAbs = repo ? path.resolve(repo) : '';
  let ownerRepo = '';
  let branch = '';
  if (repoAbs) {
    checkRepo(repoAbs);
    let remote = '';
    try {
      remote = git(repoAbs, ['remote', 'get-url', 'origin']);
    } catch {
      remote = '';
    }
    ownerRepo = resolveOwnerRepo(remote, origin);
    // --show-current, not rev-parse HEAD: a checkout that has never been
    // committed to has an unborn HEAD, and that is exactly the state a freshly
    // created tiles repo is in on its first publish.
    branch = git(repoAbs, ['branch', '--show-current']);
  } else {
    if (!dryRun) throw new Error('--repo=<tiles checkout> is required');
    ownerRepo = origin ? resolveOwnerRepo('', origin) : '';
  }

  const added = [];
  const present = [];
  for (const set of sets) {
    const dest = repoAbs ? path.join(repoAbs, REPO_TILES, set.key, set.folder) : '';
    if (dest && (await exists(dest))) present.push(set);
    else added.push({ ...set, dest });
  }

  const addedBytes = added.reduce((n, s) => n + s.bytes, 0);
  log(
    `${repoAbs || '(no checkout)'}: ${added.length} sets to copy (${mb(addedBytes)}), ${present.length} already there`,
  );
  if (dryRun) {
    log('--dry-run: nothing written');
    if (ownerRepo) log(`VITE_TILE_ORIGIN=${CDN}/${ownerRepo}@${ref}`);
    return { sets, added, present, totalBytes, origin: ownerRepo ? `${CDN}/${ownerRepo}@${ref}` : '', commit: null };
  }

  for (const set of added) {
    // Into a temporary folder and renamed, so a run cut short never leaves a
    // partial set under a name that promises the whole one. Links are
    // followed: what lands in the repo is bytes.
    const incoming = path.join(repoAbs, REPO_TILES, set.key, `.${set.folder}.incoming`);
    await mkdir(path.dirname(incoming), { recursive: true });
    await rm(incoming, { recursive: true, force: true });
    await cp(set.dir, incoming, { recursive: true, dereference: true });
    await rename(incoming, set.dest);
    log(`  + ${set.id} (${set.files.length} tiles, ${mb(set.bytes)})`);
  }

  await writeFile(path.join(repoAbs, REPO_TILES, SETS_JSON), `${JSON.stringify(table, null, 2)}\n`);
  await writeFile(path.join(repoAbs, 'README.md'), readmeText(ownerRepo));

  const paths = ['README.md', `${REPO_TILES}/${SETS_JSON}`, ...added.map((s) => `${REPO_TILES}/${s.key}/${s.folder}`)];
  git(repoAbs, ['add', '--', ...paths]);
  const staged = git(repoAbs, ['status', '--porcelain']);
  let commit = null;
  if (!staged) {
    log('nothing changed in the checkout — no commit made');
  } else {
    const message = added.length
      ? `Publish ${added.length} tile set${added.length === 1 ? '' : 's'}\n\n${added
          .map((s) => `${s.id} -> ${REPO_TILES}/${s.key}/${s.folder} (${s.files.length} tiles, ${mb(s.bytes)})`)
          .join('\n')}\n`
      : 'Refresh the set table\n';
    git(repoAbs, ['commit', '-m', message]);
    commit = git(repoAbs, ['rev-parse', 'HEAD']);
    log(`committed ${commit.slice(0, 8)} in ${repoAbs}`);
  }

  const originUrl = `${CDN}/${ownerRepo}@${ref}`;
  log(`total published: ${sets.length} sets, ${totalTiles} tiles, ${mb(totalBytes)}`);
  log(`VITE_TILE_ORIGIN=${originUrl}`);
  log('nothing was pushed. To publish:');
  log(`  git -C ${repoAbs} push origin ${branch}`);
  if (ref !== branch) log(`  and move the ${ref} ref the app is built against onto that commit`);
  return { sets, added, present, totalBytes, origin: originUrl, commit };
}

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await publishTiles({
      root: opt('root', ''),
      repo: opt('repo', ''),
      ref: opt('ref', 'main'),
      origin: opt('origin', ''),
      dryRun: flag('dry-run'),
      verifyOnly: flag('verify-only'),
    });
  } catch (err) {
    console.error(`publish-tiles: ${err.message}`);
    process.exitCode = 1;
  }
}
