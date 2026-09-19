import { defineConfig } from 'vite';
import swPlugin from './tools/swPlugin.mjs';
import devTilesPlugin from './tools/devTilesPlugin.mjs';

// Visible build identity (menu footer): CI stamps the deployed commit via
// GITHUB_SHA; local dev reads "dev". Exists so "which build is this device
// actually running" is a glance, not a bundle-forensics session — stale
// cached tabs on phones have repeatedly masqueraded as unfixed bugs.
const buildTag = (process.env.GITHUB_SHA ?? '').slice(0, 7) || 'dev';
const buildDate = new Date().toISOString().slice(0, 10);

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [swPlugin(), devTilesPlugin()],
  build: {
    outDir: 'dist',
  },
  server: {
    // A worktree under .claude/ carries its own index.html, and an HTML file
    // appearing anywhere in the root is a full reload to every open page —
    // which killed a browser battery mid-run. planning/ is local scratch.
    watch: { ignored: ['**/.claude/**', '**/planning/**'] },
  },
  define: {
    __BUILD_TAG__: JSON.stringify(`${buildTag} · ${buildDate}`),
  },
});
