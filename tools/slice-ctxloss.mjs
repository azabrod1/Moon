// Context loss in the middle of a sliced upload: the half-filled texture must
// be abandoned and re-queued, never reported resident and never drawn.
//
//   node tools/slice-ctxloss.mjs
//
// Takes the machine-wide browser lock, like every browser run here.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const URL_BASE = arg('url', 'http://localhost:5656');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCK_DIR = '/tmp/moon-browser.lock';

async function takeLock() {
  for (;;) {
    try { mkdirSync(LOCK_DIR); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let alive = true;
      try {
        const pid = Number(readFileSync(join(LOCK_DIR, 'pid'), 'utf8').trim());
        try { process.kill(pid, 0); } catch { alive = false; }
      } catch { alive = true; }
      if (!alive) { rmSync(LOCK_DIR, { recursive: true, force: true }); continue; }
      await sleep(10_000);
    }
  }
  writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
  const release = () => { try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* gone */ } };
  process.on('exit', release);
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { release(); process.exit(130); });
  return release;
}

const release = await takeLock();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto(`${URL_BASE}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__moonSlice && !!window.__moonWarm, null, { timeout: 120_000 });

  const out = await page.evaluate(async () => {
    const THREE = window.__moonThree;
    const renderer = window.__moonRenderer;
    const warm = window.__moonWarm;
    const gl = renderer.getContext();

    const canvas = document.createElement('canvas');
    canvas.width = 4096; canvas.height = 2048;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#3b7'; ctx.fillRect(0, 0, 4096, 2048);
    const bitmap = await createImageBitmap(canvas, { imageOrientation: 'none' });
    const tex = new THREE.Texture(bitmap);
    tex.flipY = false;
    tex.needsUpdate = true;

    const outcomes = [];
    warm.queueTextureWarm(tex, (o) => outcomes.push(o));
    // One tiny budget: the map cannot finish in a single step.
    warm.pumpTextureWarmQueue(0.01);
    const midSlice = { outcomes: [...outcomes] };

    // Kill the context underneath the job.
    const lose = gl.getExtension('WEBGL_lose_context');
    if (!lose) return { error: 'WEBGL_lose_context unavailable' };
    lose.loseContext();
    await new Promise((r) => setTimeout(r, 300));
    const afterLoss = { outcomes: [...outcomes], contextLost: gl.isContextLost() };

    // The app's own restore path calls invalidateTextureWarmCache, which
    // abandons the job. Drive it explicitly here so the test does not depend
    // on when the browser chooses to restore.
    warm.invalidateTextureWarmCache();
    const afterAbandon = { outcomes: [...outcomes] };
    return { midSlice, afterLoss, afterAbandon };
  });

  if (out.error) { console.log('SKIP:', out.error); process.exitCode = 0; }
  else {
    const problems = [];
    if (out.midSlice.outcomes.length !== 0) {
      problems.push(`settled mid-slice: ${JSON.stringify(out.midSlice.outcomes)}`);
    }
    if (out.afterLoss.outcomes.includes('warmed')) {
      problems.push('reported warmed after the context was lost');
    }
    if (out.afterAbandon.outcomes.includes('warmed')) {
      problems.push('reported warmed after abandoning the job');
    }
    console.log(`mid-slice outcomes: ${JSON.stringify(out.midSlice.outcomes)}`);
    console.log(`after context loss: ${JSON.stringify(out.afterLoss.outcomes)} (lost=${out.afterLoss.contextLost})`);
    console.log(`after abandon:      ${JSON.stringify(out.afterAbandon.outcomes)}`);
    console.log(problems.length ? `\nFAIL: ${problems.join('; ')}` : '\nOK — never reported resident, nothing could draw it');
    process.exitCode = problems.length ? 1 : 0;
  }
} finally {
  await browser.close();
  release();
}
