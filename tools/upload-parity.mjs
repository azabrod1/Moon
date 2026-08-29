// Proof that the sliced upload puts the same bytes on the GPU as the one-shot
// upload it replaces.
//
//   node tools/upload-parity.mjs                 # Chromium
//   node tools/upload-parity.mjs --engine=webkit # Safari's engine
//
// Both paths upload the same source into two textures, then the SAME shader
// samples eight tiles spread across each and the result is read back through
// an 8-bit RGBA render target. Byte-identical means every sampled channel
// matches exactly. A mip check samples at a forced LOD so a missing chain
// shows up as a mismatch rather than passing unnoticed.
//
// Takes the machine-wide browser lock, like every browser run here.
import { chromium, webkit } from 'playwright';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const URL_BASE = arg('url', 'http://localhost:5656');
const ENGINE = arg('engine', 'chromium');
const OUT = arg('out', '/tmp/moon-shots/smooth/parity');
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

// Runs in the page. Builds both textures from one source, samples both, and
// reports per-tile bytes plus a verdict.
const PARITY = async ({ width, height, budgetMs, mutable, srgb }) => {
  const THREE = window.__moonThree;
  if (!THREE) return { error: 'three not exposed on window.__moonThree' };
  const renderer = window.__moonRenderer;
  const gl = renderer.getContext();

  // A deterministic source with structure in both axes, so a band landing at
  // the wrong offset cannot coincidentally match.
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const img = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      img.data[i] = (x * 7 + y * 13) & 255;
      img.data[i + 1] = (x ^ y) & 255;
      img.data[i + 2] = (y >> 3) & 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const bitmap = await createImageBitmap(canvas, { imageOrientation: 'none', premultiplyAlpha: 'none' });

  // Count what actually reaches GL. A whole-image upload of the real bitmap
  // must happen exactly once on the one-shot texture and never on the sliced
  // one — if three uploads the map behind the slicer's back, slicing has
  // bought nothing and this is where it shows.
  const calls = { wholeImage: 0, bands: 0 };
  const realTexImage2D = gl.texImage2D.bind(gl);
  const realTexSubImage2D = gl.texSubImage2D.bind(gl);
  gl.texImage2D = function (...args) {
    if (args[args.length - 1] === bitmap) calls.wholeImage++;
    return realTexImage2D(...args);
  };
  gl.texSubImage2D = function (...args) {
    if (args[args.length - 1] === bitmap) calls.bands++;
    return realTexSubImage2D(...args);
  };

  const makeTexture = () => {
    const t = new THREE.Texture(bitmap);
    t.flipY = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (mutable) t.userData.mutableStorage = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.NearestFilter;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  };

  const oneShot = makeTexture();
  const oneShotStart = performance.now();
  renderer.initTexture(oneShot);
  gl.finish();
  const oneShotMs = performance.now() - oneShotStart;
  const afterOneShot = { ...calls };

  const sliced = makeTexture();
  const job = window.__moonSlice.begin(renderer, sliced);
  if (!job) return { error: 'the slicer refused a texture it should have taken' };
  const slicedStart = performance.now();
  let bands = 0;
  for (;;) {
    const r = window.__moonSlice.step(job, budgetMs);
    bands++;
    if (r === 'done') break;
    if (r === 'failed') return { error: 'slice step failed' };
    if (bands > 5000) return { error: 'slice never finished' };
  }
  gl.finish();
  const slicedMs = performance.now() - slicedStart;

  // Sample both through one shader into an 8-bit target and read back.
  const target = new THREE.WebGLRenderTarget(64, 64, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace, generateMipmaps: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const uniforms = { map: { value: null }, uvMin: { value: new THREE.Vector2() }, lod: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      precision highp float; uniform sampler2D map; uniform vec2 uvMin; uniform float lod;
      varying vec2 vUv;
      void main(){ gl_FragColor = textureLod(map, uvMin + vUv * 0.02, lod); }`,
    glslVersion: THREE.GLSL3,
  });
  mat.fragmentShader = mat.fragmentShader.replace('gl_FragColor', 'pc_fragColor');
  mat.fragmentShader = 'out vec4 pc_fragColor;\n' + mat.fragmentShader;
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));

  const readTile = (tex, uvMin, lod) => {
    uniforms.map.value = tex;
    uniforms.uvMin.value.set(uvMin[0], uvMin[1]);
    uniforms.lod.value = lod;
    mat.needsUpdate = true;
    renderer.setRenderTarget(target);
    renderer.render(scene, cam);
    const buf = new Uint8Array(64 * 64 * 4);
    renderer.readRenderTargetPixels(target, 0, 0, 64, 64, buf);
    renderer.setRenderTarget(null);
    return buf;
  };

  const tiles = [
    [0.01, 0.01], [0.48, 0.01], [0.95, 0.01], [0.01, 0.48],
    [0.48, 0.48], [0.95, 0.48], [0.01, 0.95], [0.48, 0.95],
  ];
  const results = [];
  for (const [i, uv] of tiles.entries()) {
    for (const lod of [0, 4]) {
      const a = readTile(oneShot, uv, lod);
      const b = readTile(sliced, uv, lod);
      let diff = 0; let firstAt = -1;
      for (let k = 0; k < a.length; k++) {
        if (a[k] !== b[k]) { diff++; if (firstAt < 0) firstAt = k; }
      }
      // A tile that is uniformly zero would match trivially; record the ink so
      // a blank readback cannot pass as agreement.
      let ink = 0;
      for (let k = 0; k < a.length; k += 4) ink += a[k] + a[k + 1] + a[k + 2];
      results.push({ tile: i, uv, lod, diffBytes: diff, firstAt, ink });
    }
  }
  const glInfo = (() => {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  })();
  target.dispose(); oneShot.dispose(); sliced.dispose();
  gl.texImage2D = realTexImage2D;
  gl.texSubImage2D = realTexSubImage2D;
  const slicedCalls = {
    wholeImage: calls.wholeImage - afterOneShot.wholeImage,
    bands: calls.bands - afterOneShot.bands,
  };
  return {
    bands, results, renderer: glInfo, width, height, mutable, srgb,
    oneShotCalls: afterOneShot, slicedCalls,
    oneShotMs: Math.round(oneShotMs * 10) / 10,
    slicedMs: Math.round(slicedMs * 10) / 10,
  };
};

const release = await takeLock();
const browserType = ENGINE === 'webkit' ? webkit : chromium;
const browser = await browserType.launch({
  headless: true,
  args: ENGINE === 'webkit' ? [] : [
    '--use-gl=angle', '--use-angle=metal', '--enable-gpu',
    '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
  ],
});
mkdirSync(OUT, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 160)); });
  await page.goto(`${URL_BASE}/?auto=planetarium&parity=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__moonSlice && !!window.__moonRenderer, null, { timeout: 120_000 });

  const all = [];
  // The two shapes the app really streams: an sRGB colour map on the mutable
  // path, and a sector tile; each also run on the immutable path.
  const cases = [
    { w: 4096, h: 2048, mutable: true, srgb: true },
    { w: 4096, h: 2048, mutable: true, srgb: false },
    { w: 4096, h: 2048, mutable: false, srgb: true },
    { w: 4096, h: 2048, mutable: false, srgb: false },
    { w: 2048, h: 2048, mutable: true, srgb: true },
    { w: 2048, h: 2048, mutable: false, srgb: false },
  ];
  for (const c of cases) {
    const out = await page.evaluate(PARITY, {
      width: c.w, height: c.h, mutable: c.mutable, srgb: c.srgb,
      budgetMs: Number(arg('budget', '0.02')),
    });
    const label = `${c.w}x${c.h} ${c.mutable ? 'mutable' : 'immutable'}/${c.srgb ? 'sRGB' : 'linear'}`;
    if (out.error) { console.log(`FAIL ${label}: ${out.error}`); all.push({ ...c, ...out }); continue; }
    const bad = out.results.filter((r) => r.diffBytes > 0);
    const blank = out.results.filter((r) => r.ink === 0);
    console.log(`${label}: ${out.bands} bands, ${out.results.length} samples, `
      + `${bad.length} mismatched, ${blank.length} blank; `
      + `one-shot whole-image uploads ${out.oneShotCalls.wholeImage}, `
      + `sliced whole-image ${out.slicedCalls.wholeImage} bands ${out.slicedCalls.bands}; `
      + `one-shot ${out.oneShotMs} ms vs sliced ${out.slicedMs} ms `
      + `(x${(out.slicedMs / Math.max(0.1, out.oneShotMs)).toFixed(1)})`);
    for (const r of bad.slice(0, 4)) {
      console.log(`   tile ${r.tile} lod ${r.lod}: ${r.diffBytes} bytes differ (first at ${r.firstAt})`);
    }
    all.push({ ...c, ...out });
  }
  writeFileSync(join(OUT, `${ENGINE}.json`), JSON.stringify(all, null, 1));
  const failed = all.some((a) => a.error
    || a.results.some((r) => r.diffBytes > 0 || r.ink === 0)
    // Three must never upload a sliced map itself, and the bands must be real.
    || a.slicedCalls.wholeImage !== 0
    || a.slicedCalls.bands === 0);
  console.log(failed ? `\nPARITY FAILED (${ENGINE})` : `\nPARITY OK (${ENGINE}) — byte-identical at every sample`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await browser.close();
  release();
}
