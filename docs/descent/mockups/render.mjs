/**
 * Renders the generated SVG mockups to PNG using @resvg/resvg-js.
 * Raster terrain plates (plate-*.png, see terrainPlate.mjs) are referenced by
 * filename in the SVGs and inlined as base64 here before rasterizing.
 * The renderer is NOT a project dependency — install it ad hoc:
 *   npm i --no-save @resvg/resvg-js   (or set NODE_PATH to a dir that has it)
 * Then: node generate.mjs && node render.mjs
 */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let Resvg;
try {
  ({ Resvg } = require('@resvg/resvg-js'));
} catch {
  console.error('Missing @resvg/resvg-js — run: npm i --no-save @resvg/resvg-js');
  process.exit(1);
}

const inlinePlates = (svg) => svg.replace(/href="(plate-[\w.-]+\.png)"/g, (m, f) => {
  const p = join(here, f);
  return existsSync(p) ? `href="data:image/png;base64,${readFileSync(p).toString('base64')}"` : m;
});

for (const f of readdirSync(here).filter((f) => f.endsWith('.svg')).sort()) {
  const svg = inlinePlates(readFileSync(join(here, f), 'utf8'));
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: 1920 }, font: { loadSystemFonts: true } });
  const png = r.render().asPng();
  const out = f.replace(/\.svg$/, '.png');
  writeFileSync(join(here, out), png);
  console.log('rendered', out, (png.length / 1024).toFixed(0) + ' KB');
}
