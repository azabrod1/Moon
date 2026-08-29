import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishTiles } from '../../tools/publish-tiles.mjs';
import { setHash8, tileNames } from '../../tools/tileSetHash.mjs';

// tools/publish-tiles.mjs copies cut tile sets into the repository they are
// served from. It is the only place the promise a tile pathname makes — those
// exact bytes at tiles/<key>/<tier>.<setHash8>/ or a 404 — is checked against
// real bytes before anything is cached forever behind it, so this suite runs
// the tool for real against a temporary tiles root and a temporary `git init`
// checkout rather than pinning strings.
//
// The hashes here are the tool's own (tools/tileSetHash.mjs): a fixture with a
// typed-in hash would pass while the two disagreed, which is the one failure
// the caching model cannot survive.

const REMOTE = 'git@github.com:azabrod1/moon-tiles.git';
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

/** A set folder named by the hash of its own bytes, the way gen-tiles leaves
 *  one: written under a working name, hashed, renamed. */
async function writeSet(root: string, key: string, tier: string, tiles: Record<string, string>) {
  const staging = join(root, key, `${tier}.staging`);
  mkdirSync(staging, { recursive: true });
  for (const [name, body] of Object.entries(tiles)) writeFileSync(join(staging, name), body);
  const files = tileNames(Object.keys(tiles));
  const hash = await setHash8(staging, files);
  renameSync(staging, join(root, key, `${tier}.${hash}`));
  return {
    id: `${key}/${tier}`,
    folder: `${tier}.${hash}`,
    entry: {
      setHash8: hash,
      grid: { cols: files.length, rows: 1 },
      content: 8,
      gutter: 8,
      tileWidth: 24,
      tileHeight: 24,
      baseWidth: 8 * files.length,
      spanU: 1,
      fileCount: files.length,
    },
  };
}

/** A tiles root holding two small sets and the table gen-tiles --index writes. */
async function fakeRoot(): Promise<string> {
  const root = temp('moon-tiles-root-');
  const table: Record<string, unknown> = {};
  for (const [key, tier, seed] of [['earth-day.v2', '16k', 'day'], ['moon', '16k', 'moon']]) {
    const set = await writeSet(root, key, tier, {
      '0_0.webp': `${seed}-0-0`,
      '1_0.webp': `${seed}-1-0`,
      'notes.txt': 'not a tile',
    });
    table[set.id] = set.entry;
  }
  writeFileSync(join(root, 'sets.v1.json'), `${JSON.stringify(table, null, 2)}\n`);
  return root;
}

function fakeRepo(remote = REMOTE): string {
  const repo = temp('moon-tiles-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'tiles@example.test');
  git(repo, 'config', 'user.name', 'Tiles Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  if (remote) git(repo, 'remote', 'add', 'origin', remote);
  return repo;
}

const quiet = () => {};

describe('publish-tiles', () => {
  it('copies every set the table names and commits them, pushing nothing', async () => {
    const root = await fakeRoot();
    const repo = fakeRepo();
    const lines: string[] = [];
    const result = await publishTiles({ root, repo, log: (l: string) => lines.push(l) });

    expect(result.added).toHaveLength(2);
    for (const set of result.sets) {
      expect(existsSync(join(repo, 'tiles', set.key, set.folder, '0_0.webp'))).toBe(true);
      // Followed, not linked: what lands in the repo has to be bytes.
      expect(readFileSync(join(repo, 'tiles', set.key, set.folder, '1_0.webp'), 'utf8')).toMatch(/-1-0$/);
    }
    expect(JSON.parse(readFileSync(join(repo, 'tiles', 'sets.v1.json'), 'utf8')))
      .toEqual(JSON.parse(readFileSync(join(root, 'sets.v1.json'), 'utf8')));
    // The README has to carry the rule the whole cache model rests on.
    const readme = readFileSync(join(repo, 'README.md'), 'utf8');
    expect(readme).toContain('Moon');
    expect(readme).toMatch(/never (edit, move or overwrite|moves)/);

    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(repo, 'log', '-1', '--pretty=%B')).toContain('earth-day.v2/16k');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    // Nothing left over from the copy-then-rename, and nothing pushed.
    expect(existsSync(join(repo, 'tiles', 'earth-day.v2', `.${result.sets[0].folder}.incoming`))).toBe(false);
    expect(lines.join('\n')).toContain('nothing was pushed');
  });

  it('prints the CDN origin the app is built against', async () => {
    const root = await fakeRoot();
    const repo = fakeRepo();
    const lines: string[] = [];
    const result = await publishTiles({ root, repo, log: (l: string) => lines.push(l) });
    expect(result.origin).toBe('https://cdn.jsdelivr.net/gh/azabrod1/moon-tiles@main');
    expect(lines).toContain('VITE_TILE_ORIGIN=https://cdn.jsdelivr.net/gh/azabrod1/moon-tiles@main');
  });

  it('is a no-op the second time: a published set is never re-copied or deleted', async () => {
    const root = await fakeRoot();
    const repo = fakeRepo();
    const first = await publishTiles({ root, repo, log: quiet });
    const tile = join(repo, 'tiles', first.sets[0].key, first.sets[0].folder, '0_0.webp');
    const second = await publishTiles({ root, repo, log: quiet });

    expect(second.added).toHaveLength(0);
    expect(second.present).toHaveLength(2);
    expect(second.commit).toBeNull();
    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(existsSync(tile)).toBe(true);
  });

  it('refuses a set whose tiles no longer hash to the name they are published under', async () => {
    const root = await fakeRoot();
    const repo = fakeRepo();
    const table = JSON.parse(readFileSync(join(root, 'sets.v1.json'), 'utf8'));
    const folder = `16k.${table['moon/16k'].setHash8}`;
    writeFileSync(join(root, 'moon', folder, '1_0.webp'), 'different-pixels');

    await expect(publishTiles({ root, repo, log: quiet })).rejects.toThrow(/moon\/16k: the tiles in .* hash to/);
    expect(existsSync(join(repo, 'tiles'))).toBe(false);
  });

  it('refuses a table that names a set which is not on disk', async () => {
    const root = await fakeRoot();
    const repo = fakeRepo();
    const table = JSON.parse(readFileSync(join(root, 'sets.v1.json'), 'utf8'));
    rmSync(join(root, 'moon', `16k.${table['moon/16k'].setHash8}`), { recursive: true });

    await expect(publishTiles({ root, repo, log: quiet })).rejects.toThrow(/moon\/16k: the table names/);
    expect(existsSync(join(repo, 'tiles'))).toBe(false);
  });

  it('refuses a checkout with uncommitted changes, and one that is not a checkout at all', async () => {
    const root = await fakeRoot();
    const repo = fakeRepo();
    writeFileSync(join(repo, 'stray.txt'), 'mine');
    await expect(publishTiles({ root, repo, log: quiet })).rejects.toThrow(/uncommitted changes/);
    rmSync(join(repo, 'stray.txt'));

    await expect(publishTiles({ root, repo: temp('moon-not-a-repo-'), log: quiet }))
      .rejects.toThrow(/not a git checkout/);
  });

  it('follows a level-0 link into the app tiles directory and refuses any other escape', async () => {
    const root = await fakeRoot();
    const repo = fakeRepo();
    const table = JSON.parse(readFileSync(join(root, 'sets.v1.json'), 'utf8'));
    const folder = `16k.${table['moon/16k'].setHash8}`;

    // A staging root links its already-published sets into the app's own
    // public/textures/tiles instead of duplicating them.
    const app = temp('moon-app-');
    const published = join(app, 'public', 'textures', 'tiles', 'moon');
    mkdirSync(published, { recursive: true });
    renameSync(join(root, 'moon', folder), join(published, folder));
    symlinkSync(join(published, folder), join(root, 'moon', folder));
    const ok = await publishTiles({ root, repo, log: quiet });
    expect(ok.added).toHaveLength(2);
    expect(readFileSync(join(repo, 'tiles', 'moon', folder, '0_0.webp'), 'utf8')).toBe('moon-0-0');

    // The same set anywhere else is bytes nobody looked at, published under a
    // hash taken over bytes somewhere else.
    const elsewhere = temp('moon-elsewhere-');
    renameSync(join(published, folder), join(elsewhere, folder));
    rmSync(join(root, 'moon', folder));
    symlinkSync(join(elsewhere, folder), join(root, 'moon', folder));
    await expect(publishTiles({ root, repo: fakeRepo(), log: quiet }))
      .rejects.toThrow(/moon\/16k: .* outside the tiles root/);
  });

  it('--dry-run reports the same plan and writes nothing', async () => {
    const root = await fakeRoot();
    const repo = fakeRepo();
    const lines: string[] = [];
    const plan = await publishTiles({ root, repo, dryRun: true, log: (l: string) => lines.push(l) });

    expect(plan.added).toHaveLength(2);
    expect(plan.commit).toBeNull();
    expect(existsSync(join(repo, 'tiles'))).toBe(false);
    expect(existsSync(join(repo, 'README.md'))).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(lines.join('\n')).toContain('--dry-run: nothing written');
  });

  it('--verify-only checks the root against its own table without a checkout', async () => {
    const root = await fakeRoot();
    const report = await publishTiles({ root, verifyOnly: true, log: quiet });
    expect(report.sets.map((s) => s.id)).toEqual(['earth-day.v2/16k', 'moon/16k']);
    expect(report.totalBytes).toBeGreaterThan(0);

    const table = JSON.parse(readFileSync(join(root, 'sets.v1.json'), 'utf8'));
    writeFileSync(join(root, 'moon', `16k.${table['moon/16k'].setHash8}`, '0_0.webp'), 'changed');
    await expect(publishTiles({ root, verifyOnly: true, log: quiet })).rejects.toThrow(/moon\/16k/);
  });

  it('falls back to --origin when the checkout has no GitHub remote, and refuses a disagreement', async () => {
    const root = await fakeRoot();
    const noRemote = temp('moon-tiles-bare-');
    git(noRemote, 'init', '-q', '-b', 'main');
    git(noRemote, 'config', 'user.email', 'tiles@example.test');
    git(noRemote, 'config', 'user.name', 'Tiles Test');
    const result = await publishTiles({ root, repo: noRemote, origin: 'someone/moon-tiles', ref: 'v1', log: quiet });
    expect(result.origin).toBe('https://cdn.jsdelivr.net/gh/someone/moon-tiles@v1');

    await expect(publishTiles({ root, repo: fakeRepo(), origin: 'someone-else/moon-tiles', log: quiet }))
      .rejects.toThrow(/is not the checkout's origin azabrod1\/moon-tiles/);
    await expect(publishTiles({ root, repo: fakeRepo(''), log: quiet }))
      .rejects.toThrow(/no GitHub "origin" remote/);
  });
});
