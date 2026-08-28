/// <reference types="vite/client" />

/** Build identity stamped by vite.config define — commit short-sha + date in CI, "dev · date" locally. */
declare const __BUILD_TAG__: string;

interface ImportMetaEnv {
  /** URL prefix the sector tile sets are served from; empty for the app's own
   *  origin. Read only by world/texturePolicy.ts, and by tools/swPlugin.mjs
   *  (as process.env) for the service worker's allowlist. */
  readonly VITE_TILE_ORIGIN?: string;
}
