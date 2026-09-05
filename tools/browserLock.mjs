// The machine-wide browser lock every browser run on this machine takes: one
// Chromium at a time on one GPU. Two headless browsers sharing the GPU process
// crash it, and a capture or a timing taken beside another run measures a
// contended machine.
//
// A holder writes its pid, so a lock left by a run that died is reclaimed
// rather than waited on forever; a lock with no pid file is treated as held,
// because the safe reading of "someone was here" is that they still are.
// Waits print a line at least every 20 s, so a watchdog on a quiet stdout does
// not mistake a wait for a hang.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_DIR = '/tmp/moon-browser.lock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function holderAlive() {
  let pid;
  try { pid = Number(readFileSync(join(LOCK_DIR, 'pid'), 'utf8').trim()); } catch { return true; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A browser that never took the lock is still a browser on this GPU. Matched
 *  on the process NAME: a `pgrep -f` for the browser matches any shell whose
 *  own text mentions it, including the one polling for it to exit. */
function headlessAlive() {
  try {
    return execSync('pgrep -x chrome-headless-shell || true', { encoding: 'utf8' }).trim().length > 0;
  } catch { return false; }
}

/** Take the lock, waiting for a quiet GPU first and then for the lock — the
 *  order every run here takes them in; reversed, two runs each holding one of
 *  the two wait on each other forever. Returns the release function; the lock
 *  is also released on exit and on a signal. */
export async function takeBrowserLock(label = 'run') {
  while (headlessAlive()) {
    process.stdout.write(`[${label}] waiting for another headless browser to exit\n`);
    await sleep(10_000);
  }
  for (;;) {
    try { mkdirSync(LOCK_DIR); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!holderAlive()) { rmSync(LOCK_DIR, { recursive: true, force: true }); continue; }
      process.stdout.write(`[${label}] waiting for the browser lock\n`);
      await sleep(20_000);
    }
  }
  writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
  const release = () => { try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* gone */ } };
  process.on('exit', release);
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { release(); process.exit(130); });
  return release;
}
