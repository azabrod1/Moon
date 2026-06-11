/**
 * Terrain "plates" for the mockups — raster ground layers that actually look
 * like the Moon, rendered with the same recipe TECH.md §4 specs for the real
 * mode: heightfield = fBm regolith + power-law crater stamps (+ rocks at low
 * altitude), hillshaded with a marched cast-shadow term under a frozen sun,
 * projected through a ray-sphere camera (true horizon curvature per altitude).
 * Mockup 01 samples the repo's real `public/textures/moon.jpg` for albedo.
 *
 * Deps (ad hoc, not project deps): npm i --no-save pngjs jpeg-js
 * Run: node terrainPlate.mjs            → writes plate-01/02/03/04.png here.
 * generate.mjs embeds them when present (vector fallback otherwise).
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

const HERE = dirname(fileURLToPath(import.meta.url));
const W = 1920, H = 1080;
const R = 1_737_400;                       // Moon radius, meters
const DEG = Math.PI / 180;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- value-noise fBm (deterministic) --------------------------------------
function hash2(ix, iz, seed) {
  let h = (ix * 374761393 + iz * 668265263 + seed * 974711) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296);
}
const sstep = (t) => t * t * (3 - 2 * t);
function vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = sstep(x - ix), fz = sstep(z - iz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz;
}
function fbm(x, z, seed, oct) {
  let v = 0, amp = 0.5, f = 1;
  for (let o = 0; o < oct; o++) { v += amp * vnoise(x * f, z * f, seed + o * 7); amp *= 0.5; f *= 2.1; }
  return v;                                 // ~0..1
}

// ---- scene definitions -----------------------------------------------------
// sunDir given as horizontal screen-frame direction (x right, z forward) + elevation.
const SCENES = {
  '01': {
    alt: 450_000, horizonRow: 700, f: 960 / Math.tan(22.5 * DEG),       // hfov 45°
    sun: { hx: +1, hz: 0.02, el: 8 },                                   // terminator enters frame-left
    extent: 1_100_000, grid: 1400, seed: 11,
    craters: { n: 2600, rmin: 2_000, rmax: 70_000 }, rocks: null,
    reliefAmp: 1200, mariaScale: 1 / 600_000, fbmReps: 5, exposure: 2.0,
    albedo: 'moonjpg', lat0: 2, lon0: 33,                               // Tranquillitatis-ish
    nightFloor: 0.012,
  },
  '02': {
    alt: 180_000, horizonRow: 286, f: 960 / Math.tan(30 * DEG),         // hfov 60°
    sun: { hx: -0.96, hz: 0.28, el: 19 },                               // from screen-left
    extent: 800_000, grid: 1500, seed: 23,
    craters: { n: 3400, rmin: 800, rmax: 40_000 }, rocks: null,
    reliefAmp: 900, mariaScale: 1 / 300_000, fbmReps: 6, exposure: 1.7,
    albedo: 'maria', nightFloor: 0.012,
  },
  '03': {
    alt: 31, horizonRow: 150, f: 960 / Math.tan(30 * DEG),
    sun: { hx: -0.97, hz: 0.24, el: 10.3 },
    extent: 1_600, grid: 1500, seed: 37,
    craters: { n: 1700, rmin: 0.7, rmax: 70 }, rocks: { n: 950, rmin: 0.10, rmax: 1.6 },
    reliefAmp: 2.4, mariaScale: 1 / 700, fbmReps: 14, exposure: 3.1,
    albedo: 'maria', nightFloor: 0.012,
  },
  '04': {
    alt: 2, horizonRow: 1004, f: 540 / Math.tan(37.5 * DEG),            // vfov 75° (looking up)
    sun: { hx: +0.35, hz: -0.94, el: 10.3 },                            // low, behind-right
    extent: 320, grid: 1400, seed: 53,
    craters: { n: 900, rmin: 0.3, rmax: 16 }, rocks: { n: 1000, rmin: 0.05, rmax: 0.9 },
    reliefAmp: 0.8, mariaScale: 1 / 150, fbmReps: 16, exposure: 3.1,
    albedo: 'maria', nightFloor: 0.012,
  },
};

// ---- heightfield -----------------------------------------------------------
function buildField(S) {
  const rng = mulberry32(S.seed);
  const { grid: N, extent } = S;
  const cell = extent / N;
  const half = extent / 2;

  // crater list: truncated-Pareto sizes (N(>D) ∝ D⁻²), mostly degraded
  const margin = S.craters.rmax * 2;
  const list = [];
  const ratio2 = (S.craters.rmin / S.craters.rmax) ** 2;
  for (let i = 0; i < S.craters.n; i++) {
    const u = rng();
    const r = S.craters.rmin / Math.sqrt(1 - u * (1 - ratio2));
    list.push({
      x: -half - margin + rng() * (extent + 2 * margin),
      z: -half - margin + rng() * (extent + 2 * margin),
      r, age: Math.pow(rng(), 0.55),
    });
  }
  list.sort((a, b) => b.r - a.r);            // big first (small overprint big)
  // bucket by max radius for O(1) lookup
  const bs = S.craters.rmax * 1.05, bn = Math.ceil((extent + 2 * margin) / bs);
  const buckets = Array.from({ length: bn * bn }, () => []);
  const bIdx = (x, z) => {
    const bx = Math.min(bn - 1, Math.max(0, Math.floor((x + half + margin) / bs)));
    const bz = Math.min(bn - 1, Math.max(0, Math.floor((z + half + margin) / bs)));
    return bz * bn + bx;
  };
  for (const c of list) {
    const reach = c.r * 2.4;
    for (let bx = Math.floor((c.x - reach + half + margin) / bs); bx <= Math.floor((c.x + reach + half + margin) / bs); bx++)
      for (let bz = Math.floor((c.z - reach + half + margin) / bs); bz <= Math.floor((c.z + reach + half + margin) / bs); bz++)
        if (bx >= 0 && bx < bn && bz >= 0 && bz < bn) buckets[bz * bn + bx].push(c);
  }
  const rocks = [];
  if (S.rocks) {
    for (let i = 0; i < S.rocks.n; i++) {
      const r = S.rocks.rmin + Math.pow(rng(), 2.2) * (S.rocks.rmax - S.rocks.rmin);
      rocks.push({ x: -half + rng() * extent, z: -half + rng() * extent, r });
    }
  }

  const Hf = new Float32Array(N * N);
  const noiseScale = (S.fbmReps ?? 5) / extent;   // fbm reps across the plate
  for (let j = 0; j < N; j++) {
    const z = -half + (j + 0.5) * cell;
    for (let i = 0; i < N; i++) {
      const x = -half + (i + 0.5) * cell;
      let h = (fbm(x * noiseScale * 3, z * noiseScale * 3, S.seed, 5) - 0.5) * 2 * S.reliefAmp;
      for (const c of buckets[bIdx(x, z)]) {
        const d = Math.hypot(x - c.x, z - c.z) / c.r;
        if (d > 2.4) continue;
        const depth = 0.16 * c.r * (1 - c.age * 0.75);
        const rim = 0.05 * c.r * (1 - c.age * 0.8);
        if (d < 1) h += depth * (d * d - 1) + rim * Math.exp(-(((d - 1) / 0.16) ** 2));
        else h += rim * Math.exp(-(((d - 1) / (0.22 + c.age * 0.35)) ** 2));
      }
      Hf[j * N + i] = h;
    }
  }
  for (const rk of rocks) {                  // sharp positive bumps
    const reach = Math.ceil(rk.r / cell) + 1;
    const ci = Math.round((rk.x + half) / cell), cj = Math.round((rk.z + half) / cell);
    for (let j = cj - reach; j <= cj + reach; j++) for (let i = ci - reach; i <= ci + reach; i++) {
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const x = -half + (i + 0.5) * cell, z = -half + (j + 0.5) * cell;
      const d = Math.hypot(x - rk.x, z - rk.z) / rk.r;
      if (d < 1) Hf[j * N + i] += rk.r * 0.85 * Math.pow(1 - d * d, 1.5);
    }
  }
  return { Hf, cell, half, N };
}

// ---- shading: Lambert + marched cast shadows (TECH §4.3 in miniature) ------
function shadeField(S, F, albedoAt) {
  const { Hf, cell, N } = F;
  const el = S.sun.el * DEG;
  const sl = Math.hypot(S.sun.hx, S.sun.hz);
  const sx = S.sun.hx / sl, sz = S.sun.hz / sl;
  const sunY = Math.tan(el);
  const sun = [sx * Math.cos(el), Math.sin(el), sz * Math.cos(el)];
  const shaded = new Float32Array(N * N);
  const hAt = (x, z) => {                    // bilinear, clamped (grid coords)
    const cx = Math.min(N - 1.001, Math.max(0, x)), cz = Math.min(N - 1.001, Math.max(0, z));
    const i = Math.floor(cx), j = Math.floor(cz), fx = cx - i, fz = cz - j;
    const a = Hf[j * N + i], b = Hf[j * N + i + 1], c = Hf[(j + 1) * N + i], d = Hf[(j + 1) * N + i + 1];
    return a + (b - a) * fx + (c + (d - c) * fx - (a + (b - a) * fx)) * fz;
  };
  const maxRelief = 0.18 * S.craters.rmax;
  const maxLen = Math.min(N * 0.45, (maxRelief * 2.2) / sunY / cell);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const h = Hf[j * N + i];
      const gx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * cell);
      const gz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * cell);
      const inv = 1 / Math.hypot(gx, 1, gz);
      let L = Math.max(0, (-gx * sun[0] + sun[1] - gz * sun[2]) * inv);
      if (L > 0.004) {                       // cast-shadow march toward the sun
        let lit = 1;
        for (let t = 1.6; t < maxLen; t *= 1.22) {
          const hh = hAt(i + sx * t, j + sz * t);
          const clear = (h + t * cell * sunY) - hh;
          if (clear < 0) { lit = 0; break; }
          const pen = clear / (t * cell * 0.10);
          if (pen < lit) lit = pen;
        }
        L *= 0.06 + 0.94 * Math.max(0, Math.min(1, lit));
      }
      shaded[j * N + i] = albedoAt(i, j) * (L * S.exposure + S.nightFloor);
    }
  }
  return shaded;
}

// ---- projection ------------------------------------------------------------
function renderPlate(name, S, moonTex) {
  console.time('plate-' + name);
  const F = buildField(S);
  const { cell, half, N } = F;

  // albedo per grid cell
  let albedoAt;
  if (S.albedo === 'moonjpg' && moonTex) {
    const { data, width, height } = moonTex;
    albedoAt = (i, j) => {
      const x = -half + (i + 0.5) * cell, z = -half + (j + 0.5) * cell;
      const lon = S.lon0 + (x / (R * Math.cos(S.lat0 * DEG))) / DEG;
      const lat = S.lat0 + (z / R) / DEG;
      const u = Math.min(width - 1, Math.max(0, Math.round((lon + 180) / 360 * width)));
      const v = Math.min(height - 1, Math.max(0, Math.round((90 - lat) / 180 * height)));
      return Math.pow(data[(v * width + u) * 4] / 255, 1.25) * 1.12 + 0.05;
    };
  } else {
    albedoAt = (i, j) => {
      const x = -half + (i + 0.5) * cell, z = -half + (j + 0.5) * cell;
      const maria = fbm(x * S.mariaScale, z * S.mariaScale, S.seed + 99, 3);
      const grain = fbm(x / cell * 0.31, z / cell * 0.31, S.seed + 7, 2);
      return (maria < 0.46 ? 0.40 : 0.62) * (0.9 + grain * 0.2);
    };
  }
  const shaded = shadeField(S, F, albedoAt);

  // camera
  const delta = Math.acos(R / (R + S.alt));
  const pitch = delta - Math.atan((S.horizonRow - H / 2) / S.f);        // >0 = down
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const Cy = R + S.alt;
  const el = S.sun.el * DEG;
  const sunW = [S.sun.hx, Math.tan(el), S.sun.hz];                      // for far-field
  const sN = Math.hypot(...sunW); sunW[0] /= sN; sunW[1] /= sN; sunW[2] /= sN;

  const png = new PNG({ width: W, height: H });
  const sample = (px, py) => {
    let dx = px / S.f, dy = -py / S.f, dz = 1;
    const wy = dy * cp - dz * sp, wz = dy * sp + dz * cp;
    const n = Math.hypot(dx, wy, wz); dx /= n; const wyn = wy / n, wzn = wz / n;
    const b = Cy * wyn, disc = b * b - (Cy * Cy - R * R);
    if (disc < 0) return -1;                                            // sky
    const t = -b - Math.sqrt(disc);
    if (t <= 0) return -1;
    const Px = dx * t, Py = Cy + wyn * t, Pz = wzn * t;
    const gi = (Px + half) / cell, gj = (Pz + half) / cell;
    if (gi > 1 && gj > 1 && gi < N - 2 && gj < N - 2) {
      const fade = Math.min(1, (Math.min(gi, gj, N - gi, N - gj) / (N * 0.10)));
      const i0 = Math.floor(gi), j0 = Math.floor(gj), fx = gi - i0, fz = gj - j0;
      const a = shaded[j0 * N + i0], bq = shaded[j0 * N + i0 + 1];
      const c = shaded[(j0 + 1) * N + i0], d = shaded[(j0 + 1) * N + i0 + 1];
      const sv = a + (bq - a) * fx + (c + (d - c) * fx - (a + (bq - a) * fx)) * fz;
      if (fade >= 1) return sv;
      // blend toward far-field sphere shading near the grid edge
      const ns = [Px / R, Py / R, Pz / R];
      const L0 = Math.max(0, ns[0] * sunW[0] + ns[1] * sunW[1] + ns[2] * sunW[2]);
      const alb = albedoAt(Math.min(N - 1, Math.max(0, Math.round(gi))), Math.min(N - 1, Math.max(0, Math.round(gj))));
      return sv * fade + (alb * (L0 * S.exposure + S.nightFloor)) * (1 - fade);
    }
    // beyond the detail grid: real albedo (01) or flat tone × sphere Lambert
    const ns = [Px / R, Py / R, Pz / R];
    const L0 = Math.max(0, ns[0] * sunW[0] + ns[1] * sunW[1] + ns[2] * sunW[2]);
    let alb = 0.55 * (0.82 + 0.36 * fbm(Px * S.mariaScale, Pz * S.mariaScale, S.seed + 99, 3));
    if (S.albedo === 'moonjpg' && moonTex) {
      const { data, width, height } = moonTex;
      const lon = S.lon0 + Math.atan2(Px, R) / DEG, lat = S.lat0 + Math.asin(Math.max(-1, Math.min(1, Pz / R))) / DEG;
      const u = ((Math.round((lon + 180) / 360 * width) % width) + width) % width;
      const v = Math.min(height - 1, Math.max(0, Math.round((90 - lat) / 180 * height)));
      alb = Math.pow(data[(v * width + u) * 4] / 255, 1.25) * 1.12 + 0.05;
    }
    return alb * (L0 * S.exposure + S.nightFloor);
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 2×2 supersample
      let acc = 0, hits = 0;
      for (const [ox, oy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
        const v = sample(x - W / 2 + ox, y - H / 2 + oy);
        if (v >= 0) { acc += v; hits++; }
      }
      const k = (y * W + x) * 4;
      if (!hits) { png.data[k + 3] = 0; continue; }
      const tone = Math.pow(Math.min(1, (acc / hits)), 1 / 1.75) * 255;
      png.data[k] = Math.round(tone);
      png.data[k + 1] = Math.round(tone * 0.985);
      png.data[k + 2] = Math.round(tone * 0.962);
      png.data[k + 3] = Math.round(255 * (hits / 4));
    }
  }
  writeFileSync(join(HERE, `plate-${name}.png`), PNG.sync.write(png));
  console.timeEnd('plate-' + name);
}

let moonTex = null;
try {
  moonTex = jpeg.decode(readFileSync(join(HERE, '../../../public/textures/moon.jpg')), { useTArray: true });
} catch { console.warn('moon.jpg not found — plate 01 falls back to procedural albedo'); }

for (const [name, S] of Object.entries(SCENES)) renderPlate(name, S, moonTex);
