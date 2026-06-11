/**
 * Moon Landing mode — design-phase mockup generator.
 *
 * Paints the key beats of the descent (DESIGN.md §1.2) as deterministic SVGs:
 *   00-preflight        pre-flight board / loading screen
 *   01-arrival          orbit + Earthrise, HUD booting (Glass)
 *   02-long-fall        mid-descent, full Glass HUD
 *   02b-long-fall-heritage  same frame, Heritage skin (art-direction B)
 *   03-final-approach   low gate / dust / hazard map (Glass)
 *   04-stillness        post-landing (Glass, minimal HUD)
 *
 * Zero dependencies. `node generate.mjs` writes the SVGs next to this file.
 * Render PNGs with render.mjs (needs @resvg/resvg-js, see README).
 *
 * These are MOCKUPS: hand-tuned theatrical lighting, but every HUD number is
 * physically consistent with DESIGN.md Appendix A.
 */
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
const W = 1920;
const H = 1080;
const MONO = 'DejaVu Sans Mono, Liberation Mono, monospace';

/**
 * Raster terrain plate (see terrainPlate.mjs) — referenced by filename;
 * render.mjs inlines it as base64 for resvg. Returns null if not generated,
 * letting scenes fall back to the vector painters.
 */
function plate(name) {
  return existsSync(join(OUT, name))
    ? `<image x="0" y="0" width="${W}" height="${H}" href="${name}"/>`
    : null;
}

// ---------------------------------------------------------------- utilities

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const fx = (n, d = 1) => n.toFixed(d);
const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------- themes

const GLASS = {
  name: 'glass',
  ink: '#BFE7FF', dim: 'rgba(191,231,255,0.55)', faint: 'rgba(191,231,255,0.30)',
  amber: '#FFB75C', green: '#7CE0A2', red: '#FF6B5C',
  panel: 'rgba(8,14,22,0.50)', stroke: 1.5,
};
const HERITAGE = {
  name: 'heritage',
  ink: '#FFB000', dim: 'rgba(255,176,0,0.55)', faint: 'rgba(255,176,0,0.30)',
  amber: '#FFD24D', green: '#33FF66', red: '#FF5533',
  panel: 'rgba(16,12,2,0.62)', stroke: 2,
};

// ---------------------------------------------------------------- SVG bits

function svgOpen(defsExtra = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <filter id="b2"><feGaussianBlur stdDeviation="2"/></filter>
  <filter id="b4"><feGaussianBlur stdDeviation="4"/></filter>
  <filter id="b9"><feGaussianBlur stdDeviation="9"/></filter>
  <filter id="b18"><feGaussianBlur stdDeviation="18"/></filter>
  <filter id="b40" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="40"/></filter>
  <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="1.4" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="regolith" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="5" seed="11" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.62  0 0 0 0 0.61  0 0 0 0 0.60  0 0 0 0.9 0"/>
  </filter>
  <filter id="regolithFine" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="4" seed="29" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.62  0 0 0 0 0.61  0 0 0 0 0.60  0 0 0 0.9 0"/>
  </filter>
  ${defsExtra}
</defs>
<rect width="${W}" height="${H}" fill="#000204"/>`;
}
const svgClose = '</svg>';

function text(x, y, s, { size = 18, fill = GLASS.ink, anchor = 'start', bold = false, opacity = 1, glow = false, spacing = null } = {}) {
  const esc = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<text x="${x}" y="${y}" font-family="${MONO}" font-size="${size}"${bold ? ' font-weight="bold"' : ''} fill="${fill}" text-anchor="${anchor}" opacity="${opacity}"${glow ? ' filter="url(#glow)"' : ''}${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc}</text>`;
}

// ------------------------------------------------------------ sky painters

function starField(seed, count, { yMax = H, yMin = 0, dimming = 1 } = {}) {
  const r = mulberry32(seed);
  let s = '<g>';
  for (let i = 0; i < count; i++) {
    const x = r() * W, y = yMin + r() * (yMax - yMin);
    const m = Math.pow(r(), 2.6);                      // few bright, many faint
    const rad = 0.5 + m * 1.7;
    const o = (0.18 + m * 0.8) * dimming;
    const c = r() < 0.08 ? '#BFD4FF' : r() < 0.13 ? '#FFE9C9' : '#EAF2FF';
    s += `<circle cx="${fx(x)}" cy="${fx(y)}" r="${fx(rad, 2)}" fill="${c}" opacity="${fx(o, 2)}"/>`;
    if (m > 0.82) {                                    // cross glint on the brightest
      const g = rad * 5;
      s += `<path d="M ${fx(x - g)} ${fx(y)} H ${fx(x + g)} M ${fx(x)} ${fx(y - g)} V ${fx(y + g)}" stroke="${c}" stroke-width="0.7" opacity="${fx(o * 0.5, 2)}"/>`;
    }
  }
  return s + '</g>';
}

function milkyWay(cx, cy, angleDeg, len, width, seed, dimming = 1) {
  const r = mulberry32(seed);
  let s = `<g transform="rotate(${angleDeg} ${cx} ${cy})">`;
  s += `<ellipse cx="${cx}" cy="${cy}" rx="${len / 2}" ry="${width}" fill="#9FB4D8" opacity="${fx(0.05 * dimming, 3)}" filter="url(#b40)"/>`;
  s += `<ellipse cx="${cx}" cy="${cy}" rx="${len / 2.4}" ry="${width * 0.45}" fill="#C8D6EE" opacity="${fx(0.06 * dimming, 3)}" filter="url(#b40)"/>`;
  for (let i = 0; i < 320; i++) {                      // grain along the band
    const t = (r() - 0.5) * len, dv = (r() - 0.5) * width * 2.2 * Math.pow(r(), 1.5);
    s += `<circle cx="${fx(cx + t)}" cy="${fx(cy + dv)}" r="${fx(0.4 + r() * 0.8, 2)}" fill="#DCE7FA" opacity="${fx((0.08 + r() * 0.25) * dimming, 2)}"/>`;
  }
  return s + '</g>';
}

/**
 * Earth disc. r is the disc radius in px. `lit` = illuminated fraction
 * (phase complement of the Moon's: sun 10.3° morning at Tranquility ⇒
 * Moon 39% ⇒ Earth 61% gibbous — see DESIGN App. A).
 */
function earth(cx, cy, r, { darkSide = 'left', seed = 5, lit = 0.61 } = {}) {
  const rng = mulberry32(seed);
  const sgn = darkSide === 'left' ? -1 : 1;
  let s = `<g>`;
  s += `<circle cx="${cx}" cy="${cy}" r="${fx(r * 1.45)}" fill="#7FB4FF" opacity="0.10" filter="url(#b18)"/>`; // halo
  s += `<clipPath id="earthClip${seed}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>`;
  s += `<g clip-path="url(#earthClip${seed})">`;
  s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#2E6FD8"/>`;
  s += `<circle cx="${fx(cx - sgn * r * 0.25)}" cy="${fx(cy - r * 0.25)}" r="${fx(r * 0.95)}" fill="#5FA8F0" opacity="0.5" filter="url(#b9)"/>`;
  for (let i = 0; i < 3; i++) {                        // land masses, muted
    const a = rng() * Math.PI * 2, d = rng() * r * 0.55;
    s += `<ellipse cx="${fx(cx + Math.cos(a) * d)}" cy="${fx(cy + Math.sin(a) * d)}" rx="${fx(r * (0.22 + rng() * 0.2))}" ry="${fx(r * (0.14 + rng() * 0.12))}" fill="#7A8C5A" opacity="0.55" filter="url(#b4)" transform="rotate(${fx(rng() * 90)} ${cx} ${cy})"/>`;
  }
  for (let i = 0; i < 6; i++) {                        // cloud swirls
    const a = rng() * Math.PI * 2, d = rng() * r * 0.75;
    s += `<ellipse cx="${fx(cx + Math.cos(a) * d)}" cy="${fx(cy + Math.sin(a) * d)}" rx="${fx(r * (0.3 + rng() * 0.3))}" ry="${fx(r * (0.07 + rng() * 0.06))}" fill="#FFFFFF" opacity="${fx(0.5 + rng() * 0.3, 2)}" filter="url(#b2)" transform="rotate(${fx(-25 + rng() * 50)} ${fx(cx + Math.cos(a) * d)} ${fx(cy + Math.sin(a) * d)})"/>`;
  }
  // phase shadow: offset dark disc carves the terminator (offset tuned to `lit`)
  const off = Math.max(0.2, Math.min(1.8, 0.45 + 1.45 * lit));
  s += `<circle cx="${fx(cx + sgn * r * off)}" cy="${cy}" r="${fx(r * 1.42)}" fill="#000208" opacity="0.96" filter="url(#b2)"/>`;
  s += `</g>`;
  s += `<circle cx="${cx}" cy="${cy}" r="${fx(r + 0.8)}" fill="none" stroke="#9FD0FF" stroke-width="1.2" opacity="0.45" filter="url(#b2)"/>`; // thin atmosphere rim
  return s + '</g>';
}

// --------------------------------------------------------- terrain painters

/**
 * One crater under a low sun. sunDx: +1 = light from the right. With sun on
 * the right, the RIGHT inner wall is shadowed (rim blocks the skimming rays),
 * the LEFT inner wall is lit, the sun-side outer rim catches light, and the
 * exterior cast shadow runs anti-sun. `shadowK` ≈ 1/tan(sun elevation);
 * `fresh` 0..1 scales contrast (fresh craters are crisper).
 */
function crater(cx, cy, rx, ry, sunDx, { shadowK = 2.2, fresh = 0.5, id } = {}) {
  let s = '';
  const sx = sunDx;
  const big = rx > 5;
  // exterior cast shadow, anchored to the anti-sun rim
  if (shadowK > 1.1 && rx > 3.5) {
    const L = Math.min(rx * shadowK * 0.55, rx * 3.1);
    s += `<ellipse cx="${fx(cx - sx * (rx * 0.72 + L / 2))}" cy="${fx(cy)}" rx="${fx(L / 2 + rx * 0.18)}" ry="${fx(ry * 0.52)}" fill="#000" opacity="${fx(0.20 + fresh * 0.18, 2)}"${rx > 36 ? ' filter="url(#b2)"' : ''}/>`;
  }
  s += `<clipPath id="cr${id}"><ellipse cx="${fx(cx)}" cy="${fx(cy)}" rx="${fx(rx)}" ry="${fx(ry)}"/></clipPath>`;
  s += `<g clip-path="url(#cr${id})">`;
  // interior shadow crescent on the sun-side wall (covers ~52% of the bowl)
  const f = 0.46 + fresh * 0.14;
  s += `<ellipse cx="${fx(cx + sx * 2 * rx * (1 - f))}" cy="${fx(cy)}" rx="${fx(rx)}" ry="${fx(ry)}" fill="#0a0a0c" opacity="${fx(0.5 + fresh * 0.3, 2)}"/>`;
  // lit inner wall hugging the anti-sun edge
  s += `<ellipse cx="${fx(cx - sx * 2 * rx * 0.8)}" cy="${fx(cy)}" rx="${fx(rx)}" ry="${fx(ry)}" fill="#F2EEE6" opacity="${fx(0.22 + fresh * 0.2, 2)}"/>`;
  s += `</g>`;
  if (big) {
    // bright outer rim arc on the sun side, faint dark arc anti-sun
    const sweep = sx > 0 ? 1 : 0;
    s += `<path d="M ${fx(cx)} ${fx(cy - ry)} A ${fx(rx)} ${fx(ry)} 0 0 ${sweep} ${fx(cx)} ${fx(cy + ry)}" stroke="#EDE9E0" stroke-width="${fx(Math.max(1, rx * 0.055), 2)}" fill="none" opacity="${fx(0.3 + fresh * 0.2, 2)}"/>`;
    s += `<path d="M ${fx(cx)} ${fx(cy - ry)} A ${fx(rx)} ${fx(ry)} 0 0 ${1 - sweep} ${fx(cx)} ${fx(cy + ry)}" stroke="#1c1c20" stroke-width="${fx(Math.max(0.8, rx * 0.04), 2)}" fill="none" opacity="${fx(0.18 + fresh * 0.12, 2)}"/>`;
  }
  return s;
}

function wobblyBlob(cx, cy, r0, seed, points = 11) {
  const rng = mulberry32(seed);
  let d = '';
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * Math.PI * 2;
    const rr = r0 * (0.62 + rng() * 0.65);
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.72;
    d += (i ? 'L' : 'M') + `${fx(x)} ${fx(y)} `;
  }
  return d + 'Z';
}

/**
 * The Moon seen from ~450 km: a huge sphere arc with maria, craters and a
 * terminator. horizonY = apex of the limb on screen.
 */
function moonFromOrbit(horizonY, seed) {
  const R = 2600, cx = W / 2, cy = horizonY + R;
  const rng = mulberry32(seed);
  let s = `<clipPath id="moonSphere"><circle cx="${cx}" cy="${cy}" r="${R}"/></clipPath>`;
  s += `<g clip-path="url(#moonSphere)">`;
  s += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="#8E8E92"/>`;
  s += `<rect x="0" y="${horizonY}" width="${W}" height="${H - horizonY}" filter="url(#regolith)" opacity="0.5"/>`;
  // maria
  const maria = [[480, horizonY + 270, 300, 21], [900, horizonY + 180, 230, 22], [1240, horizonY + 330, 330, 23], [180, horizonY + 160, 170, 24]];
  for (const [mx, my, mr, sd] of maria) {
    s += `<path d="${wobblyBlob(mx, my, mr, sd)}" fill="#54565E" opacity="0.62" filter="url(#b18)"/>`;
    s += `<path d="${wobblyBlob(mx + 30, my + 18, mr * 0.6, sd + 50)}" fill="#4A4C55" opacity="0.4" filter="url(#b18)"/>`;
  }
  // Sun is screen-right: night side and the terminator sit at frame-left
  // (the farside darkness we just emerged from), crater shadows point left
  // (anti-sun, toward the night side), Earth's lit limb faces right.
  const termX = W * 0.28;
  for (let i = 0; i < 260; i++) {
    const x = rng() * W, y = horizonY + Math.pow(rng(), 0.7) * (H - horizonY) * 1.05;
    const depth = (y - horizonY) / (H - horizonY);
    const rx = (1.6 + Math.pow(rng(), 3.1) * 30) * lerp(0.45, 1, depth);
    const ry = rx * lerp(0.3, 0.78, depth);
    const prox = Math.max(0, 1 - Math.abs(x - termX) / 560);
    const k = 0.9 + prox * 6.5;
    s += crater(x, y, rx, ry, +1, { shadowK: k, fresh: 0.25 + rng() * 0.5, id: 'o' + i });
  }
  // terminator: night→day across a soft band, night kept a breath above black (earthshine)
  s += `<linearGradient id="term" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#000" stop-opacity="0.97"/><stop offset="0.16" stop-color="#000" stop-opacity="0.95"/>
    <stop offset="0.28" stop-color="#000" stop-opacity="0.55"/><stop offset="0.42" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>`;
  s += `<rect x="0" y="${horizonY - 4}" width="${W}" height="${H - horizonY + 4}" fill="url(#term)"/>`;
  s += `<rect x="0" y="${horizonY - 4}" width="${Math.max(0, termX - 170)}" height="${H - horizonY + 4}" fill="#0E1219" opacity="0.5"/>`;
  s += `</g>`;
  // knife-sharp limb (no atmosphere — no glow)
  const yEdge = cy - Math.sqrt(R * R - (W / 2) ** 2);
  s += `<path d="M 0 ${fx(yEdge)} A ${R} ${R} 0 0 1 ${W} ${fx(yEdge)}" stroke="#C9C9CE" stroke-width="1.2" fill="none" opacity="0.8"/>`;
  return s;
}

/**
 * Perspective ground for the descent frames. Camera pitched down; horizon at
 * horizonY with subtle curvature. Sun low from the left ⇒ long shadows right.
 */
function groundPerspective(horizonY, seed, { sunDx = -1, shadowK = 4.5, craters = 120, boulders = 0, RR = 9000 } = {}) {
  const rng = mulberry32(seed);
  const cx = W / 2, cy = horizonY + RR;
  let s = `<clipPath id="gnd${seed}"><circle cx="${cx}" cy="${cy}" r="${RR}"/></clipPath>`;
  s += `<g clip-path="url(#gnd${seed})">`;
  s += `<linearGradient id="gfade${seed}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#77777C"/><stop offset="0.25" stop-color="#8B8B90"/><stop offset="1" stop-color="#97969B"/></linearGradient>`;
  s += `<rect x="0" y="${horizonY}" width="${W}" height="${H - horizonY}" fill="url(#gfade${seed})"/>`;
  s += `<rect x="0" y="${horizonY}" width="${W}" height="${H - horizonY}" filter="url(#regolith)" opacity="0.42"/>`;
  s += `<rect x="0" y="${fx(horizonY + (H - horizonY) * 0.45)}" width="${W}" height="${fx((H - horizonY) * 0.55)}" filter="url(#regolithFine)" opacity="0.30"/>`;
  // a couple of large mare-tone patches
  s += `<path d="${wobblyBlob(W * 0.68, horizonY + 90, 260, seed + 7)}" fill="#5E5F66" opacity="0.5" filter="url(#b18)"/>`;
  s += `<path d="${wobblyBlob(W * 0.2, horizonY + 40, 180, seed + 8)}" fill="#66676E" opacity="0.45" filter="url(#b18)"/>`;
  for (let i = 0; i < craters; i++) {
    const t = Math.pow(rng(), 3.0);                            // overwhelmingly small
    const depth = Math.pow(rng(), 0.8);                        // 0 horizon → 1 near
    const y = horizonY + 3 + depth * (H - horizonY) * 1.04;
    const x = rng() * W;
    const rx = lerp(2, 95, t * depth) + rng() * 4;
    const ry = rx * lerp(0.22, 0.6, depth);
    s += crater(x, y, rx, ry, sunDx, { shadowK: shadowK * (0.7 + rng() * 0.6), fresh: 0.2 + rng() * 0.5, id: `${seed}g${i}` });
  }
  for (let i = 0; i < boulders; i++) {
    const depth = 0.45 + Math.pow(rng(), 0.8) * 0.55;
    const y = horizonY + depth * (H - horizonY) * 1.02, x = rng() * W;
    const r = lerp(1.2, 6, Math.pow(rng(), 2) * depth);
    s += `<ellipse cx="${fx(x - sunDx * r * 1.5)}" cy="${fx(y + r * 0.3)}" rx="${fx(r * (1.3 + shadowK * 0.28))}" ry="${fx(r * 0.45)}" fill="#000" opacity="0.34"/>`;
    s += `<circle cx="${fx(x)}" cy="${fx(y)}" r="${fx(r)}" fill="#6E6E73"/>`;
    s += `<circle cx="${fx(x + sunDx * r * 0.35)}" cy="${fx(y - r * 0.35)}" r="${fx(r * 0.45)}" fill="#D9D2C8" opacity="0.8"/>`;
  }
  s += `</g>`;
  s += `<path d="M 0 ${fx(horizonY + (W / 2) ** 2 / (2 * RR))} A ${RR} ${RR} 0 0 1 ${W} ${fx(horizonY + (W / 2) ** 2 / (2 * RR))}" stroke="#D6D6DA" stroke-width="1" fill="none" opacity="0.9"/>`;
  return s;
}

// --------------------------------------------------------------- HUD pieces

function bracketFrame(x, y, w, h, t, len = 16, opacity = 0.9) {
  const p = (d) => `<path d="${d}" stroke="${t.ink}" stroke-width="${t.stroke}" fill="none" opacity="${opacity}"/>`;
  return p(`M ${x} ${y + len} V ${y} H ${x + len}`) + p(`M ${x + w - len} ${y} H ${x + w} V ${y + len}`)
    + p(`M ${x + w} ${y + h - len} V ${y + h} H ${x + w - len}`) + p(`M ${x + len} ${y + h} H ${x} V ${y + h - len}`);
}

function panel(x, y, w, h, t) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${t.panel}" rx="3"/>` + bracketFrame(x, y, w, h, t, 14, 0.7);
}

/**
 * Journey tape — ONE left-edge vertical instrument (design review merged the
 * old descent-ribbon + altitude tape: on a log scale they were near-duplicates).
 * Log altitude 500 km → 1 m with phase ticks on the flank and a "you" marker.
 * dotFrac 0 = top (orbit) → 1 = ground; phaseIdx highlights the active phase.
 */
function journeyTape(t, { x = 96, value, unit, source, ticks, dotFrac, phaseIdx }) {
  const yTop = 220, yBot = 880;
  const phases = ['ORBIT', 'BURN', 'FALL', 'APPROACH', 'FINAL'];
  let s = `<g opacity="0.95">`;
  s += text(x, yTop - 24, `ALTITUDE · ${source}`, { size: 14, fill: t.faint });
  s += `<line x1="${x}" y1="${yTop}" x2="${x}" y2="${yBot}" stroke="${t.dim}" stroke-width="${t.stroke}"/>`;
  for (const [frac, label] of ticks) {
    const y = lerp(yTop, yBot, frac);
    s += `<line x1="${x}" y1="${fx(y)}" x2="${x + 12}" y2="${fx(y)}" stroke="${t.dim}" stroke-width="${t.stroke}"/>`;
    s += text(x + 18, y + 5, label, { size: 13, fill: t.faint });
  }
  phases.forEach((p, i) => {
    const y = lerp(yTop + 6, yBot - 6, i / (phases.length - 1));
    const on = i === phaseIdx;
    s += `<line x1="${x - 16}" y1="${fx(y)}" x2="${x - 6}" y2="${fx(y)}" stroke="${on ? t.ink : t.dim}" stroke-width="${t.stroke}"/>`;
    s += text(x - 22, y + 4, p, { size: 12, fill: on ? t.ink : t.faint, bold: on, anchor: 'end' });
  });
  const dy = lerp(yTop, yBot, dotFrac);
  s += `<circle cx="${x}" cy="${fx(dy)}" r="6.5" fill="${t.ink}" filter="url(#glow)"/>`;
  s += panel(x + 56, dy - 26, 168, 52, t);
  s += text(x + 196, dy + 9, value, { size: 30, fill: t.ink, anchor: 'end', bold: true, glow: true });
  s += text(x + 200, dy + 7, unit, { size: 14, fill: t.dim });
  return s + '</g>';
}

/** Low morning sun just off frame-left: glare + horizon streak (honest replacement
 *  for stars over a sunlit scene — the sky stays black, the Sun announces itself). */
function sunGlare(t, y, edge = 'left') {
  const x = edge === 'left' ? -40 : W + 40;
  let s = `<radialGradient id="sgl${edge}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#FFF6E8" stop-opacity="0.9"/><stop offset="0.25" stop-color="#FFE9C4" stop-opacity="0.35"/><stop offset="1" stop-color="#FFE9C4" stop-opacity="0"/></radialGradient>`;
  s += `<circle cx="${x}" cy="${y}" r="250" fill="url(#sgl${edge})"/>`;
  s += `<rect x="${edge === 'left' ? -40 : W - 560}" y="${y - 2}" width="600" height="4" fill="#FFF2DC" opacity="0.25" filter="url(#b4)"/>`;
  return s;
}

/** Speed block + V/H split bars, right side. */
function speedBlock(t, { x = W - 332, y = 282, spd, kmh, vspd, hspd, vSafe = false }) {
  let s = panel(x, y, 268, 168, t);
  s += text(x + 16, y + 30, 'VELOCITY', { size: 14, fill: t.faint });
  s += text(x + 250, y + 66, spd, { size: 38, fill: t.ink, anchor: 'end', bold: true, glow: true });
  s += text(x + 250, y + 90, kmh, { size: 14, fill: t.dim, anchor: 'end' });
  const bar = (yy, label, val, frac, color) => {
    let b = text(x + 16, yy + 5, label, { size: 14, fill: t.faint });
    b += `<rect x="${x + 78}" y="${yy - 7}" width="120" height="13" fill="none" stroke="${t.dim}" stroke-width="1"/>`;
    b += `<rect x="${x + 78}" y="${yy - 7}" width="${fx(120 * Math.min(1, frac))}" height="13" fill="${color}" opacity="0.85"/>`;
    b += text(x + 250, yy + 5, val, { size: 16, fill: color, anchor: 'end', bold: true });
    return b;
  };
  s += bar(y + 120, 'V-SPD', vspd, Math.min(1, Math.abs(parseFloat(vspd)) / (vSafe ? 6 : 400)), vSafe ? t.green : t.ink);
  s += bar(y + 148, 'H-SPD', hspd, Math.min(1, Math.abs(parseFloat(hspd)) / (vSafe ? 6 : 400)), t.ink);
  return s;
}

/** Surface temperature panel with sparkline. */
function tempPanel(t, { x = W - 332, y = 470, temp, trend, points, footnote }) {
  let s = panel(x, y, 268, 150, t);
  s += text(x + 16, y + 30, 'SURFACE TEMP · NADIR', { size: 14, fill: t.faint });
  s += text(x + 188, y + 74, temp, { size: 38, fill: t.ink, anchor: 'end', bold: true, glow: true });
  const gx2 = x + 218, gy2 = y + 62;
  if (trend === 'down') s += `<path d="M ${gx2} ${gy2 + 9} l -9 -14 h 18 Z" fill="#9FC4FF"/>`;
  else if (trend === 'up') s += `<path d="M ${gx2} ${gy2 - 5} l -9 14 h 18 Z" fill="${t.amber}"/>`;
  else s += `<rect x="${gx2 - 9}" y="${gy2 - 2}" width="18" height="4" fill="${t.dim}"/>`;
  const sx = x + 16, sy = y + 122, sw = 236, sh = 30;
  let d = '';
  points.forEach((p, i) => { d += (i ? 'L' : 'M') + fx(sx + (i / (points.length - 1)) * sw) + ' ' + fx(sy - p * sh) + ' '; });
  s += `<path d="${d}" stroke="${t.ink}" stroke-width="1.5" fill="none" opacity="0.8"/>`;
  s += `<line x1="${sx}" y1="${sy}" x2="${sx + sw}" y2="${sy}" stroke="${t.dim}" stroke-width="0.7" opacity="0.5"/>`;
  s += text(x + 16, y + 142, footnote, { size: 12, fill: t.faint });
  return s;
}

/** Heading strip across the top with vector marker glyphs (no unicode risk). */
function compassStrip(t, markers, y = 64, labels = ['W', 'NW', 'N', 'NE', 'E']) {
  const x0 = W / 2 - 420, x1 = W / 2 + 420;
  let s = `<g opacity="0.9"><line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${t.dim}" stroke-width="${t.stroke}"/>`;
  for (let i = 0; i <= 12; i++) {
    const x = lerp(x0, x1, i / 12);
    s += `<line x1="${fx(x)}" y1="${y}" x2="${fx(x)}" y2="${y - (i % 3 === 0 ? 10 : 5)}" stroke="${t.dim}" stroke-width="1"/>`;
  }
  labels.forEach((c, i) => s += text(lerp(x0, x1, i / 4), y - 16, c, { size: 14, fill: t.faint, anchor: 'middle' }));
  s += `<path d="M ${W / 2} ${y + 4} l -7 12 h 14 Z" fill="${t.ink}"/>`;
  for (const m of markers) {
    const x = lerp(x0, x1, m.frac);
    if (m.kind === 'earth') {
      s += `<circle cx="${fx(x)}" cy="${y + 18}" r="8" fill="none" stroke="${t.ink}" stroke-width="1.5"/><path d="M ${fx(x - 8)} ${y + 18} h 16 M ${fx(x)} ${y + 10} v 16" stroke="${t.ink}" stroke-width="1.2"/>`;
    } else if (m.kind === 'sun') {
      s += `<circle cx="${fx(x)}" cy="${y + 18}" r="8" fill="none" stroke="${t.amber}" stroke-width="1.5"/><circle cx="${fx(x)}" cy="${y + 18}" r="2.4" fill="${t.amber}"/>`;
    } else {
      s += `<path d="M ${fx(x - 8)} ${y + 11} h 16 l -8 14 Z" fill="none" stroke="${t.green}" stroke-width="1.5"/>`;
    }
    s += text(x, y + 46, m.label, { size: 12, fill: t.faint, anchor: 'middle' });
  }
  return s + '</g>';
}

/** MET / phase / next event block, top right. */
function metBlock(t, { met, phase, next }) {
  const x = W - 332, y = 88;
  let s = text(x + 250, y, met, { size: 26, fill: t.ink, anchor: 'end', bold: true, glow: true });
  s += text(x + 250, y + 28, phase, { size: 16, fill: t.dim, anchor: 'end' });
  if (next) s += text(x + 250, y + 54, next, { size: 16, fill: t.amber, anchor: 'end', bold: true });
  return s;
}

/** Minimal attitude ring with prograde + thrust markers (Glass). */
function attitudeRing(t, cx = 285, cy = 905, r = 64, pitchDeg = -12) {
  let s = `<g opacity="0.9">`;
  s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${t.panel}" stroke="${t.dim}" stroke-width="${t.stroke}"/>`;
  const hy = cy - Math.sin(pitchDeg * Math.PI / 180) * r * 0.9;
  s += `<line x1="${cx - r * 0.85}" y1="${fx(hy)}" x2="${cx + r * 0.85}" y2="${fx(hy)}" stroke="${t.ink}" stroke-width="1.5"/>`;
  s += `<line x1="${cx - r * 0.35}" y1="${fx(hy + 14)}" x2="${cx + r * 0.35}" y2="${fx(hy + 14)}" stroke="${t.dim}" stroke-width="1" stroke-dasharray="4 4"/>`;
  // retrograde marker (X in circle) and thrust vector
  s += `<circle cx="${cx + 22}" cy="${cy - 18}" r="9" fill="none" stroke="${t.amber}" stroke-width="1.5"/><path d="M ${cx + 16} ${cy - 24} l 12 12 M ${cx + 28} ${cy - 24} l -12 12" stroke="${t.amber}" stroke-width="1.2"/>`;
  s += `<path d="M ${cx} ${cy} l 0 ${r * 0.62} M ${cx} ${cy + r * 0.62} l -6 -10 M ${cx} ${cy + r * 0.62} l 6 -10" stroke="${t.green}" stroke-width="2"/>`;
  s += text(cx, cy + r + 24, `PITCH ${pitchDeg}°`, { size: 13, fill: t.faint, anchor: 'middle' });
  return s + '</g>';
}

/** Dashed predicted-trajectory ribbon with chevrons + site marker. */
function trajectoryRibbon(t, pts, { label, chevrons = 4 } = {}) {
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) d += ` Q ${pts[i][2]} ${pts[i][3]} ${pts[i][0]} ${pts[i][1]}`;
  let s = `<path d="${d}" stroke="${t.ink}" stroke-width="2" stroke-dasharray="10 8" fill="none" opacity="0.65" filter="url(#glow)"/>`;
  const [ex, ey] = pts[pts.length - 1];
  s += `<path d="M ${ex - 12} ${ey - 4} l 12 10 l 12 -10" stroke="${t.green}" stroke-width="2.5" fill="none" filter="url(#glow)"/>`;
  if (label) s += text(ex, ey + 28, label, { size: 14, fill: t.green, anchor: 'middle' });
  return s;
}

/** Landing reticle with slope tag. */
function reticle(t, cx, cy, r, slopeLabel, ok = true) {
  const c = ok ? t.green : t.red;
  let s = `<g filter="url(#glow)"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c}" stroke-width="2"/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="${fx(r * 0.55)}" fill="none" stroke="${c}" stroke-width="1.2" opacity="0.8"/>`;
  s += `<path d="M ${cx - r * 1.35} ${cy} H ${cx - r * 0.7} M ${cx + r * 0.7} ${cy} H ${cx + r * 1.35} M ${cx} ${cy - r * 1.35} V ${cy - r * 0.7} M ${cx} ${cy + r * 0.7} V ${cy + r * 1.35}" stroke="${c}" stroke-width="1.6"/></g>`;
  s += text(cx + r * 1.5, cy - 8, slopeLabel, { size: 16, fill: c, bold: true });
  s += text(cx + r * 1.5, cy + 14, ok ? 'GO' : 'NO-GO', { size: 14, fill: c });
  return s;
}

function calloutLine(t, msg, y = 1006, color = null) {
  return `<path d="M ${W / 2 - 330} ${y - 7} h 10 l 5 7 l -5 7 h -10 Z" fill="${color ?? t.ink}" opacity="0.9"/>`
    + text(W / 2 - 306, y + 6, msg, { size: 19, fill: color ?? t.ink, glow: true });
}

function featureName(t, name, y = 952) {
  return `<rect x="${W / 2 - 400}" y="${y - 19}" width="800" height="28" fill="rgba(0,0,0,0.35)" rx="3"/>`
    + text(W / 2, y, name, { size: 17, fill: t.dim, anchor: 'middle', spacing: 6 });
}

function captionStrip(label) {
  return `<rect x="0" y="${H - 26}" width="${W}" height="26" fill="rgba(0,0,0,0.55)"/>`
    + text(12, H - 8, label, { size: 13, fill: 'rgba(160,180,200,0.65)' });
}

function scanlines() {
  return `<pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="none"/><line x1="0" y1="0.5" x2="4" y2="0.5" stroke="#000" stroke-width="1" opacity="0.5"/></pattern>
  <rect width="${W}" height="${H}" fill="url(#scan)" opacity="0.20"/>
  <radialGradient id="crt" cx="0.5" cy="0.5" r="0.78"><stop offset="0.65" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.35"/></radialGradient>
  <rect width="${W}" height="${H}" fill="url(#crt)"/>`;
}

function dustStreaks(seed, intensity = 1) {
  const rng = mulberry32(seed);
  let s = `<g>`;
  const cx = W / 2, oy = H + 160;                       // engine plume origin below frame
  for (let i = 0; i < 80 * intensity; i++) {
    const a = -Math.PI / 2 + (rng() - 0.5) * 2.4;       // fan upward/outward
    const r0 = 200 + rng() * 180, r1 = r0 + 260 + rng() * 700;
    const x0 = cx + Math.cos(a) * r0, y0 = oy + Math.sin(a) * r0 * 0.55;
    const x1 = cx + Math.cos(a) * r1, y1 = oy + Math.sin(a) * r1 * 0.55;
    s += `<line x1="${fx(x0)}" y1="${fx(y0)}" x2="${fx(x1)}" y2="${fx(y1)}" stroke="#F2ECE2" stroke-width="${fx(1 + rng() * 2.2, 1)}" opacity="${fx((0.09 + rng() * 0.22) * intensity, 2)}"${rng() > 0.6 ? ' filter="url(#b2)"' : ''}/>`;
  }
  s += `<linearGradient id="dustveil" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#E4DED4" stop-opacity="${fx(0.4 * intensity, 2)}"/><stop offset="1" stop-color="#E4DED4" stop-opacity="0"/></linearGradient>`;
  s += `<rect x="0" y="${H * 0.62}" width="${W}" height="${H * 0.38}" fill="url(#dustveil)"/>`;
  return s + '</g>';
}

function legSilhouettes() {
  // slim landing-gear struts + foot pads peeking into the lower corners
  const leg = (mx) => `<g fill="#05060a" transform="translate(${mx === -1 ? 0 : W} 0) scale(${mx} 1)">
    <path d="M -10 ${H - 18} L 132 ${H - 88} L 148 ${H - 64} L 18 ${H} L -10 ${H} Z"/>
    <path d="M 60 ${H} L 128 ${H - 78} L 142 ${H - 70} L 92 ${H} Z"/>
    <ellipse cx="150" cy="${H - 70}" rx="26" ry="10"/>
  </g>`;
  return leg(-1) + leg(1);
}

// ------------------------------------------------------------------- scenes

/** 00 — pre-flight board / loading screen. */
function scenePreflight() {
  const t = GLASS;
  let s = svgOpen();
  s += starField(101, 240, { dimming: 0.5 });
  s += text(W / 2, 92, 'MOON LANDING', { size: 40, fill: t.ink, anchor: 'middle', bold: true, glow: true, spacing: 14 });
  s += text(W / 2, 124, 'PRE-FLIGHT', { size: 17, fill: t.dim, anchor: 'middle', spacing: 10 });

  // --- SITE column
  s += panel(90, 180, 540, 600, t);
  s += text(116, 220, '1 · SITE', { size: 16, fill: t.faint });
  const sites = [
    ['TRANQUILITY BASE', 'land where it began · forgiving', true, 'FEATHER · 86 M'],
    ['HADLEY-APENNINE', '4 km mountain wall + rille', false, 'FIRM'],
    ['ARISTARCHUS PLATEAU', 'the brightest ground', false, null],
    ['TYCHO CENTRAL PEAK', 'boulders. everywhere.', false, null],
    ['SHACKLETON RIM', 'eternal low sun · -185°C floor below', false, null],
    ['FREE DESCENT', 'pick any point from orbit (v1.1)', false, null],
  ];
  sites.forEach(([name, hook, sel, best], i) => {
    const y = 252 + i * 62;
    if (sel) s += `<rect x="108" y="${y - 24}" width="380" height="48" fill="rgba(191,231,255,0.08)" stroke="${t.ink}" stroke-width="1"/>`;
    s += text(124, y, name, { size: 18, fill: sel ? t.ink : t.dim, bold: sel });
    s += text(124, y + 18, hook, { size: 13, fill: t.faint });
    // per-site best-landing medal (replayability loop)
    s += `<circle cx="455" cy="${y - 5}" r="6" fill="${best ? (best.startsWith('FEATHER') ? t.green : t.amber) : 'none'}" stroke="${t.faint}" stroke-width="1"/>`;
    if (best) s += text(455, y + 16, best, { size: 10, fill: t.faint, anchor: 'middle' });
  });
  // mini moon globe with site dots
  const gx = 555, gy = 430, gr = 58;
  s += `<circle cx="${gx}" cy="${gy}" r="${gr}" fill="#84848A"/>`;
  s += `<path d="${wobblyBlob(gx - 12, gy - 16, 26, 31)}" fill="#55565E" opacity="0.8" filter="url(#b4)"/>`;
  s += `<path d="${wobblyBlob(gx + 20, gy + 10, 18, 33)}" fill="#5A5B63" opacity="0.7" filter="url(#b4)"/>`;
  s += `<circle cx="${gx}" cy="${gy}" r="${gr}" fill="none" stroke="${t.dim}" stroke-width="1"/>`;
  [[18, -8, true], [-9, -26, false], [-38, -14, false], [-12, 38, false], [2, 55, false]].forEach(([dx, dy, sel]) => {
    s += `<circle cx="${gx + dx}" cy="${gy + dy}" r="${sel ? 5 : 3}" fill="${sel ? t.green : t.faint}"${sel ? ' filter="url(#glow)"' : ''}/>`;
  });

  // --- LIGHT column
  s += panel(690, 180, 540, 290, t);
  s += text(716, 220, '2 · LIGHT', { size: 16, fill: t.faint });
  s += text(716, 258, 'DATE  2026-06-21 06:05 UTC', { size: 18, fill: t.ink });
  s += text(716, 284, "LIGHT NOW: * EXCELLENT ('now' was lunar night — jumped to next sunrise)", { size: 13, fill: t.amber });
  // sun elevation arc
  const ax = 850, ay = 420, ar = 110;
  s += `<path d="M ${ax - ar} ${ay} A ${ar} ${ar} 0 0 1 ${ax + ar} ${ay}" stroke="${t.dim}" stroke-width="1.5" fill="none"/>`;
  s += `<line x1="${ax - ar - 26}" y1="${ay}" x2="${ax + ar + 26}" y2="${ay}" stroke="${t.faint}" stroke-width="1"/>`;
  const sunA = Math.PI - (10.3 * Math.PI / 180);
  const sx2 = ax + Math.cos(sunA) * ar, sy2 = ay - Math.sin(sunA) * ar;
  s += `<circle cx="${fx(sx2)}" cy="${fx(sy2)}" r="9" fill="${t.amber}" filter="url(#glow)"/>`;
  s += text(fx(sx2 + 18), fx(sy2 + 4), 'SUN 10.3° — BEST LIGHT *', { size: 15, fill: t.amber, bold: true });
  s += text(716, 452, 'LONG SHADOWS · APOLLO LANDED AT 5-14°', { size: 13, fill: t.faint });
  // Earth phase preview — the complement of the Moon's phase: sun 10.3° at
  // Tranquility ⇒ Moon 39% ⇒ Earth 61% (accuracy review M2)
  s += earth(1150, 410, 34, { darkSide: 'left', seed: 9, lit: 0.61 });
  s += text(1150, 462, 'EARTH: GIBBOUS 61% · 66° HIGH ALL MISSION', { size: 13, fill: t.faint, anchor: 'middle' });

  // --- SEAT column
  s += panel(690, 500, 540, 280, t);
  s += text(716, 540, '3 · SEAT', { size: 16, fill: t.faint });
  const seats = [
    ['WINDOW SEAT', 'just look. guidance flies. cannot fail.', false],
    ['RIGHT SEAT', 'steer the ride · pick the pad · cannot die', true],
    ['LEFT SEAT', 'stick, throttle, fuel. you can absolutely crash.', false],
  ];
  seats.forEach(([name, desc, sel], i) => {
    const y = 572 + i * 64;
    if (sel) s += `<rect x="708" y="${y - 24}" width="504" height="52" fill="rgba(124,224,162,0.07)" stroke="${t.green}" stroke-width="1"/>`;
    s += text(728, y, name, { size: 18, fill: sel ? t.green : t.dim, bold: sel });
    s += text(728, y + 20, desc, { size: 13, fill: t.faint });
  });

  // --- loading checklist + CTA
  s += panel(1290, 180, 540, 600, t);
  s += text(1316, 220, 'PRE-FLIGHT CHECKLIST', { size: 16, fill: t.faint });
  const items = [
    ['MODE CHUNK (0.2 MB)', 'GO'], ['STAR CATALOG + MILKY WAY (9 MB)', 'GO'],
    ['MOON GLOBE · COLOR (14 MB)', 'GO'], ['MOON GLOBE · TERRAIN (8 MB)', 'GO'],
    ['SITE PACK · TRANQUILITY (11 MB)', '64%'], ['GUIDANCE + THERMAL MODEL', 'HOLD'],
  ];
  items.forEach(([n, st], i) => {
    const y = 262 + i * 44;
    const done = st === 'GO';
    s += text(1316, y, n, { size: 15, fill: done ? t.dim : t.ink });
    s += text(1804, y, st, { size: 15, fill: done ? t.green : t.amber, anchor: 'end', bold: true });
    s += `<line x1="1316" y1="${y + 12}" x2="1804" y2="${y + 12}" stroke="${t.faint}" stroke-width="0.6"/>`;
  });
  s += `<rect x="1316" y="556" width="488" height="8" fill="none" stroke="${t.dim}" stroke-width="1"/>`;
  s += `<rect x="1316" y="556" width="${fx(488 * 0.84)}" height="8" fill="${t.ink}" opacity="0.8"/>`;
  s += text(1316, 588, 'FIRST ENTRY ONLY — CACHED AFTER · 42 MB TOTAL', { size: 13, fill: t.faint });
  s += `<rect x="1316" y="640" width="488" height="74" fill="rgba(191,231,255,0.04)" stroke="${t.dim}" stroke-width="1.5" stroke-dasharray="6 4"/>`;
  s += text(1560, 678, 'BEGIN DESCENT', { size: 26, fill: t.dim, anchor: 'middle', bold: true, spacing: 6 });
  s += text(1560, 702, 'ARMING — SITE PACK 64% · ~0:07', { size: 13, fill: t.amber, anchor: 'middle' });

  s += text(W / 2, 830, 'REALISM NOTES: REAL SCALE · REAL EPHEMERIS · REAL TERRAIN DATA · DESCENT COMPRESSED BY A HOT ~4 KM/S BUDGET (APOLLO: 2)', { size: 13, fill: t.faint, anchor: 'middle' });
  s += captionStrip('MOCKUP 00 · PRE-FLIGHT BOARD = LOADING SCREEN · assets stream while you choose (DESIGN §1.1)');
  return s + svgClose;
}

/** 01 — orbit, Earthrise (Earth straddling the limb), HUD booting. */
function sceneArrival() {
  const t = GLASS;
  const horizonY = 700;
  let s = svgOpen();
  s += starField(7, 620, { yMax: horizonY + 60 });
  s += milkyWay(1450, 260, -28, 1500, 110, 8);
  // Earth drawn BEFORE the Moon so the dark limb occludes its lower half:
  // mid-Earthrise, the disc straddles the limb (true rise rate 0.039°/s)
  s += earth(620, 700, 38, { darkSide: 'left', seed: 5, lit: 0.61 });
  s += plate('plate-01.png') ?? moonFromOrbit(horizonY, 42);

  // minimal booting HUD
  s += compassStrip(t, [
    { frac: 0.31, kind: 'earth', label: 'EARTH' },
    { frac: 0.86, kind: 'sun', label: 'SUN' },
    { frac: 0.55, kind: 'site', label: 'SITE' },
  ]);
  s += metBlock(t, { met: 'T+00:32', phase: 'LUNAR ORBIT · 450.3 KM', next: 'WINDOW 2:28' });
  s += journeyTape(t, {
    value: '450.3', unit: 'KM', source: 'ORBITAL', dotFrac: 0.02, phaseIdx: 0,
    ticks: [[0.02, '450'], [0.2, '200'], [0.4, '60'], [0.6, '10'], [0.8, '1'], [0.97, '0']],
  });
  s += text(330, 300, 'V 1.50 KM/S · PERIOD 153 MIN', { size: 15, fill: t.faint });
  s += text(330, 324, 'SURFACE IN VIEW 10.3%', { size: 15, fill: t.faint });
  s += text(620, 600, 'EARTHRISE', { size: 15, fill: t.dim, anchor: 'middle', spacing: 8 });
  s += text(620, 622, 'FULL DISC IN 0:19', { size: 13, fill: t.faint, anchor: 'middle' });

  s += featureName(t, 'MARE SMYTHII — FARSIDE NIGHT BEHIND · TRANQUILITY 300 KM AHEAD', 905);
  s += calloutLine(t, 'AOS — RADIO: "GOOD MORNING. GUIDANCE IS ALIGNING YOUR WINDOW."', 960);
  // commit prompt: armed by the descent window, not instantly (design review)
  s += `<rect x="${W / 2 - 230}" y="990" width="460" height="56" fill="rgba(8,14,22,0.55)" stroke="${t.ink}" stroke-width="1.5"/>`;
  s += `<rect x="${W / 2 - 230}" y="1040" width="${fx(460 * 0.18)}" height="6" fill="${t.amber}" opacity="0.9"/>`;
  s += text(W / 2, 1014, '[ SPACE ]  COMMIT — WINDOW IN 2:28', { size: 19, fill: t.ink, anchor: 'middle', bold: true, glow: true });
  s += text(W / 2, 1034, 'or stay a while — miss it, and the next window is one orbit (153 min)', { size: 13, fill: t.faint, anchor: 'middle' });
  s += captionStrip('MOCKUP 01 · ARRIVAL & EARTHRISE · 450 km, 10.3% of the Moon in view · Earth 1.9° true size at 45° horizontal FOV, mid-rise on the limb · exposure keyed to the night side (stars legitimately visible) · night fraction theatrically compressed');
  return s + svgClose;
}

/** 02 — the long fall: ballistic coast, engine off (parameterized for both skins).
 *  Staging: heading SW, morning sun low in the east = screen-left (cross-lit);
 *  Earth is ~79° overhead — honestly NOT in a surface-pitched frame. */
function sceneLongFall(t) {
  const horizonY = 286;
  let s = svgOpen();
  // sky: black. Stars do NOT render over a sunlit scene (accuracy review) —
  // the low sun announces itself from frame-left instead.
  s += plate('plate-02.png') ?? groundPerspective(horizonY, 77, { sunDx: -1, shadowK: 4.2, craters: 210, RR: 4200 });
  s += sunGlare(t, horizonY - 10, 'left');

  s += compassStrip(t, [
    { frac: 0.04, kind: 'sun', label: 'SUN 19°' },
    { frac: 0.5, kind: 'site', label: 'SITE' },
    { frac: 0.94, kind: 'earth', label: 'EARTH 79° UP' },
  ], 64, ['E', 'SE', 'S', 'SW', 'W']);
  s += metBlock(t, { met: 'T+07:21', phase: 'THE LONG FALL · ENGINE OFF', next: 'THE WALL 1:14' });
  s += journeyTape(t, {
    value: '180.4', unit: 'KM', source: 'ORBITAL', dotFrac: 0.34, phaseIdx: 2,
    ticks: [[0.06, '400'], [0.22, '200'], [0.4, '60'], [0.58, '10'], [0.78, '1'], [0.95, '0']],
  });
  s += speedBlock(t, { spd: '1614', kmh: 'M/S · 5,810 KM/H', vspd: '-1612', hspd: '60' });
  s += tempPanel(t, {
    temp: '+21°C', trend: 'down',
    points: [0.92, 0.9, 0.88, 0.84, 0.8, 0.74, 0.7, 0.62, 0.55, 0.5, 0.44, 0.4],
    footnote: 'SUN 19° UNDER TRACK — LOWER TOWARD SITE',
  });
  s += attitudeRing(t, 285, 905, 64, -58);
  s += trajectoryRibbon(t, [[760, 980], [905, 640, 830, 800], [962, 430, 945, 520]], { label: 'SITE · 12 KM DOWNRANGE' });
  s += featureName(t, 'MARE TRANQUILLITATIS');
  s += calloutLine(t, 'RADIO: "COMING UP ON THE WALL. BRACE FOR BRAKING."', 1006, t.amber);

  if (t.name === 'heritage') {
    // DSKY homage block
    s += panel(W - 332, 700, 268, 140, t);
    s += text(W - 316, 730, 'PGM 63 — BRAKING NEXT', { size: 15, fill: t.green, bold: true });
    s += text(W - 316, 762, 'VERB 06  NOUN 63', { size: 17, fill: t.ink, bold: true });
    s += text(W - 80, 794, '+18040', { size: 22, fill: t.green, anchor: 'end', bold: true, spacing: 3 });
    s += text(W - 80, 822, '-01612', { size: 22, fill: t.green, anchor: 'end', bold: true, spacing: 3 });
    s += scanlines();
  }
  const cap = t.name === 'heritage'
    ? 'MOCKUP 02B · THE LONG FALL · HERITAGE SKIN (art direction B): phosphor, scanlines, DSKY · same layout grid as Glass'
    : 'MOCKUP 02 · THE LONG FALL · GLASS HUD (A) · ballistic coast 180.4 km, V-SPD −1,612 m/s ⇒ braking burn (60 km) in 74 s — numbers cross-check · cross-lit, 60° hFOV · no stars over sunlit ground';
  s += captionStrip(cap);
  return s + svgClose;
}

/** 03 — final, 31 m: dust wash-out, trust the tape. Approach furniture
 *  (footprint ellipse, redesignation, hazard tint) retired at low gate —
 *  this frame is reticle + dust + instruments (design review #9/#10). */
function sceneFinalApproach() {
  const t = GLASS;
  const horizonY = 150;
  let s = svgOpen();
  // black sky, no stars over sunlit ground; horizon effectively straight at 31 m
  s += plate('plate-03.png') ?? groundPerspective(horizonY, 99, { sunDx: -1, shadowK: 5.2, craters: 160, boulders: 80, RR: 90000 });
  s += sunGlare(t, horizonY - 6, 'left');

  s += reticle(t, 960, 640, 74, 'SLOPE 1.8°');
  // big docked digits — the dust-blind numbers (radar AGL + V-SPD)
  s += panel(840, 750, 240, 96, t);
  s += text(1056, 794, '31 M', { size: 44, fill: t.ink, anchor: 'end', bold: true, glow: true });
  s += text(1056, 830, '-2.4 M/S', { size: 26, fill: t.green, anchor: 'end', bold: true, glow: true });
  s += text(864, 794, 'AGL', { size: 14, fill: t.faint });
  s += text(864, 830, 'V-SPD', { size: 14, fill: t.faint });

  s += dustStreaks(31, 1.0);
  s += legSilhouettes();

  s += compassStrip(t, [
    { frac: 0.04, kind: 'sun', label: 'SUN' },
    { frac: 0.5, kind: 'site', label: 'PAD' },
    { frac: 0.94, kind: 'earth', label: 'EARTH 79° UP' },
  ], 64, ['E', 'SE', 'S', 'SW', 'W']);
  s += metBlock(t, { met: 'T+11:36', phase: 'FINAL · RADAR', next: 'CONTACT ~0:14' });
  s += journeyTape(t, {
    value: '31', unit: 'M', source: 'RADAR AGL', dotFrac: 0.93, phaseIdx: 4,
    ticks: [[0.06, '400 KM'], [0.3, '60 KM'], [0.55, '2 KM'], [0.78, '100'], [0.93, '30'], [0.99, '0']],
  });
  s += speedBlock(t, { spd: '2.5', kmh: 'M/S TOTAL', vspd: '-2.4', hspd: '0.6', vSafe: true });
  s += tempPanel(t, {
    temp: '-18°C', trend: 'flat',
    points: [0.42, 0.42, 0.41, 0.42, 0.42, 0.43, 0.42, 0.42, 0.41, 0.42, 0.42, 0.42],
    footnote: 'SUN 10.3° — LONG SHADOWS, GOOD CONTRAST',
  });
  s += attitudeRing(t, 285, 905, 64, -2);
  s += calloutLine(t, 'RADIO: "30 METERS — DOWN AT 2½ — DUST VISIBLE — TRUST THE TAPE."', 1006, t.green);
  s += captionStrip('MOCKUP 03 · FINAL · 31 m AGL, camera ~18° below horizon, 60° hFOV · approach furniture retired; big docked digits for the dust-blind beat · ballistic dust sheets (no billowing — vacuum) · horizon straight at this height');
  return s + svgClose;
}

/** 04 — stillness: down, silent, looking UP. Camera pitched ~36° above the
 *  horizon so Earth sits at her TRUE 66° elevation (accuracy review M5);
 *  daylight exposure ⇒ black sky, Earth alone in it (cf. Apollo photos). */
function sceneStillness() {
  const t = GLASS;
  const horizonY = 1004;
  let s = svgOpen();
  // Earth: lit limb tilted toward the low sun behind the viewer ⇒ rotated phase
  s += `<g transform="rotate(48 1240 250)">${earth(1240, 250, 38, { darkSide: 'left', seed: 5, lit: 0.61 })}</g>`;
  const p04 = plate('plate-04.png');
  if (p04) {
    s += p04;
  } else {
    s += groundPerspective(horizonY, 123, { sunDx: +1, shadowK: 5.6, craters: 40, boulders: 24, RR: 900000 });
    // distant crater-rim silhouettes on the (straight) horizon
    s += `<path d="M 0 ${horizonY} L 220 ${horizonY - 8} L 460 ${horizonY - 2} L 700 ${horizonY - 12} L 980 ${horizonY - 3} L 1300 ${horizonY - 9} L 1620 ${horizonY - 2} L 1920 ${horizonY - 6} L 1920 ${horizonY + 3} L 0 ${horizonY + 3} Z" fill="#73737A"/>`;
  }
  // our shadow runs ahead of us toward the horizon (sun low, directly behind)
  s += `<g fill="#000" opacity="0.7" filter="url(#b2)">
    <path d="M 870 ${H} L 1010 ${H} L 985 ${horizonY + 26} L 925 ${horizonY + 26} Z"/>
    <path d="M 700 ${H} L 800 ${H} L 905 ${horizonY + 40} L 880 ${horizonY + 34} Z"/>
    <path d="M 1080 ${H} L 1180 ${H} L 1005 ${horizonY + 40} L 1030 ${horizonY + 34} Z"/>
  </g>`;

  // near-zero HUD
  s += text(W / 2, 60, 'CONTACT · ENGINE STOP · T+11:50', { size: 22, fill: t.ink, anchor: 'middle', bold: true, glow: true, spacing: 4 });
  s += text(W / 2, 88, 'TRANQUILITY BASE · 0.674° N  23.473° E · EARTH FIXED AT 66°, AZIMUTH 268° — IT NEVER MOVES', { size: 14, fill: t.dim, anchor: 'middle' });
  s += text(1240, 330, 'EARTH · 384,400 KM · GIBBOUS 61%', { size: 13, fill: t.faint, anchor: 'middle' });

  // stats card (composite grade: touchdown quality + accuracy — design review #8)
  const cx2 = 96, cy2 = 700;
  s += panel(cx2, cy2, 392, 246, t);
  s += text(cx2 + 24, cy2 + 36, 'TOUCHDOWN', { size: 15, fill: t.faint, spacing: 6 });
  const rows = [
    ['VERTICAL AT CONTACT', '-1.8 M/S'], ['TILT', '2.1°'], ['DIST FROM PAD', '412 M'],
    ['PEAK G (THE WALL)', '2.9 G'], ['DESCENT', '8:50'], ['MISSION', '11:50'],
  ];
  rows.forEach(([k, v], i) => {
    const y = cy2 + 66 + i * 25;
    s += text(cx2 + 24, y, k, { size: 14, fill: t.dim });
    s += text(cx2 + 368, y, v, { size: 14, fill: t.ink, anchor: 'end', bold: true });
  });
  s += text(cx2 + 24, cy2 + 226, 'FEATHER · NEAR PAD', { size: 20, fill: t.green, bold: true, glow: true });

  s += text(W - 96, 880, 'HOLD L — LONG-EXPOSURE: THE MILKY WAY', { size: 14, fill: t.dim, anchor: 'end' });
  s += text(W - 96, 904, 'T — TIME-LAPSE: WATCH THE STARS WHEEL, EARTH HOLD STILL', { size: 13, fill: t.faint, anchor: 'end' });
  s += text(W - 96, 928, 'N — NAMEPLATE PHOTO    V — STAND-UP VIEW', { size: 13, fill: t.faint, anchor: 'end' });
  s += calloutLine(t, 'RADIO: "TRANQUILITY, WE COPY YOU DOWN. ENJOY THE VIEW."', 1006);
  s += captionStrip('MOCKUP 04 · STILLNESS · camera pitched up ~36° — Earth at her true 66° elevation · daylight exposure: black sky, no stars (hold L for the real night sky) · 3 s of silence before this card fades in');
  return s + svgClose;
}

// -------------------------------------------------------------------- write

const scenes = {
  '00-preflight.svg': scenePreflight(),
  '01-arrival.svg': sceneArrival(),
  '02-long-fall.svg': sceneLongFall(GLASS),
  '02b-long-fall-heritage.svg': sceneLongFall(HERITAGE),
  '03-final-approach.svg': sceneFinalApproach(),
  '04-stillness.svg': sceneStillness(),
};
for (const [name, svg] of Object.entries(scenes)) {
  writeFileSync(join(OUT, name), svg);
  console.log('wrote', name, (svg.length / 1024).toFixed(0) + ' KB');
}
