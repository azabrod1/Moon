import { defineConfig } from 'vite';

// Visible build identity (menu footer): CI stamps the deployed commit via
// GITHUB_SHA; local dev reads "dev". Exists so "which build is this device
// actually running" is a glance, not a bundle-forensics session — stale
// cached tabs on phones have repeatedly masqueraded as unfixed bugs.
const buildTag = (process.env.GITHUB_SHA ?? '').slice(0, 7) || 'dev';
const buildDate = new Date().toISOString().slice(0, 10);

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
  },
  define: {
    __BUILD_TAG__: JSON.stringify(`${buildTag} · ${buildDate}`),
  },
});
