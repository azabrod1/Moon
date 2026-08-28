/**
 * Service-worker TEMPLATE — tools/swPlugin.mjs injects the build's manifest
 * at the marker below and writes the result to dist/sw.js during
 * `vite build`. Never served from source; never edit dist/sw.js. Behavior is
 * pinned executable-style by src/planetarium/swContract.test.ts, which
 * evaluates this file against fake caches/fetch — keep it free of syntax
 * only browsers have.
 *
 * Scope, deliberately narrow: this worker caches DATA ONLY — the stable-path
 * files under textures/, stardata/, fonts/, models/, historic/ — and never
 * answers for HTML or JS. Code always flows through the browser's normal
 * HTTP stack (fresh index.html within Pages' 10-minute window, hash-named
 * immutable chunks), so no worker state can serve a stale app or mix two
 * releases' code — the white-screen class of SW failures is designed out,
 * not managed. What GitHub Pages' fixed headers can't give the data —
 * immutable caching — this gives: repeat boots serve the whole boot set
 * from disk with zero data requests. The manifest-dir invariant that keeps
 * skew harmless: those directories hold only format-stable opaque assets or
 * pathname-versioned structured data (bright-stars.v1.bin), so "one deploy
 * old for one boot" is at worst cosmetic (enforced in swPlugin.mjs).
 *
 * Integrity: a body is stored only after its SHA-256 matches the manifest
 * (a ≤10-minute-stale HTTP-cache body or mid-rollout edge response can never
 * be stored under a fresh hash), only complete 200s are stored, and entries
 * live under content-addressed keys (href?swv=hash) — a deploy that
 * changes a file changes its key, stale keys are pruned on activate, and
 * unchanged files are never refetched. Verification runs OFF the response
 * path: the page gets the network stream immediately; a clone is hashed and
 * conditionally stored under waitUntil. On any failure the page simply has
 * the network bytes — byte-for-byte what a worker-less page would have.
 *
 * Tile sets are the one thing this worker may hold from ANOTHER origin, and
 * they are cached on a different contract (TILE_ORIGINS / TILE_SETS below):
 * a set's own content hash is in its folder name, so a tile path is either
 * new or a 404 and the body under it can never go stale. Those are stored
 * cache-first by full URL with no digest and no ?swv= — the path IS the
 * identity, a body shorter than its own WebP header claims or that is not a
 * WebP container is refused, and the digests are checked where the bytes are
 * published, not on every device.
 * Every cache key here is an absolute href for that reason: the activate
 * prune compares what cache.keys() hands back (always absolute) against
 * these keys, and pathname-shaped keys would make every off-origin entry
 * look unknown and delete it on every boot.
 *
 * skipWaiting+claim are safe for the same reason the worker is safe at all:
 * with no code cached, the wrong worker generation can at worst serve a
 * one-deploy-old data file until the next sw.js update check. Escape hatch:
 * ?nosw=1 (handled at the top of main.ts init).
 */

/* __INJECT_MANIFEST__ */

const CACHE_NAME = 'moon-data-v1';
const INSTALL_FETCH_TIMEOUT_MS = 10000;
const INSTALL_CONCURRENCY = 4;

/** Absolute href of a same-origin path (the manifest is keyed by pathname). */
function absolute(path) {
  return new URL(path, self.location.origin).href;
}

function cacheKey(pathname) {
  return absolute(pathname) + '?swv=' + MANIFEST[pathname];
}

/** Absolute prefixes of the tile sets the app currently names. A set folder
 *  carries the hash of its own contents, so these change whenever the tiles
 *  do — which is what lets a tile body be cached with no digest and no
 *  expiry, and what makes a set the app dropped prunable on activate.
 *  Deliberately only the sets the app names at its coarsest level: Cache
 *  Storage for off-origin bodies is charged to THIS origin, and WebKit
 *  evicts a whole origin at once, so an unbounded tile appetite could evict
 *  the boot precache this worker exists for.
 *
 *  A prefix is the whole published path, host included, so the path a host
 *  serves tiles under has to stay fixed — a CDN ref that moves (jsDelivr
 *  `@v1` -> `@v2`) makes every held tile unknown to the prune and every
 *  device re-download the sets it already had. The set hash is the part that
 *  is meant to move when the bytes do. */
const TILE_SET_HREFS = TILE_SETS.map(absolute);

/** The cache key for a content-addressed tile on an allowlisted origin, or
 *  null for everything else. Same-origin tiles are not this branch's
 *  business: they sit in the manifest like every other data file. */
function immutableTileKey(url) {
  if (url.origin === self.location.origin) return null;
  if (TILE_ORIGINS.indexOf(url.origin) < 0) return null;
  for (const prefix of TILE_SET_HREFS) {
    if (url.href.indexOf(prefix) === 0) return url.href;
  }
  return null;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Verify a response body against the manifest and store it under the hash
 * key. Consumes the given response (callers pass a clone or an owned
 * response). Returns true when stored. The stored Response is rebuilt from
 * the decoded bytes with content-type only — copying content-encoding or
 * content-length from the transport response onto decoded bytes would lie.
 */
async function verifyAndPut(cache, pathname, response) {
  if (!response.ok || response.status !== 200) return false;
  const body = await response.arrayBuffer();
  if ((await sha256Hex(body)) !== MANIFEST[pathname]) return false;
  await cache.put(cacheKey(pathname), new Response(body, {
    headers: { 'content-type': response.headers.get('content-type') || 'application/octet-stream' },
  }));
  return true;
}

/** True when the bytes are one whole WebP container: `RIFF`, a size field
 *  that accounts for every byte that arrived, `WEBP`, and an image chunk
 *  (VP8, VP8L or VP8X) where the first chunk belongs. The size check is the
 *  truncation guard — a transfer the server closed early arrives as a
 *  normally ended stream, arrayBuffer() resolves with the short body, and
 *  only the header's own byte count says it is short. The chunk check is
 *  what refuses a body that merely starts like a tile. Cheap, and the only
 *  thing standing between a tile key with no digest and no expiry and a
 *  body that is not a tile at all. */
function looksLikeWebp(body) {
  if (body.byteLength < 16) return false;
  const b = new Uint8Array(body, 0, 16);
  const tag = (at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return false;
  const riffSize = new DataView(body).getUint32(4, true);
  if (riffSize + 8 !== body.byteLength) return false;
  const chunk = tag(12);
  return chunk === 'VP8 ' || chunk === 'VP8L' || chunk === 'VP8X';
}

/**
 * Store a content-addressed tile under its full URL. No digest: the set hash
 * in the path is the identity, so the failures this has to exclude are an
 * incomplete transfer and a body that is complete but is not the tile —
 * looksLikeWebp covers both. status 200 only, which also excludes an
 * opaque cross-origin response (status 0): a host without CORS must stay a
 * visible failure, never a cached one.
 *
 * The WebP check is what keeps a wrong 200 from becoming permanent. A tile
 * key has no digest and no expiry, so an edge serving an HTML error page, a
 * mis-purged object or an interception proxy's page with permissive CORS
 * would pin that sector wrong for as long as the app names the set. Anything
 * that is not a WebP container is served to the page and cached nowhere, so
 * the next fetch can get it right.
 */
async function putImmutable(cache, href, response) {
  if (response.status !== 200) return false;
  const body = await response.arrayBuffer();
  if (!looksLikeWebp(body)) return false;
  await cache.put(href, new Response(body, {
    headers: { 'content-type': response.headers.get('content-type') || 'application/octet-stream' },
  }));
  return true;
}

/** Run tasks over items with bounded parallelism; failures don't stop the rest. */
async function eachWithPool(items, limit, task) {
  const queue = items.slice();
  const lanes = [];
  for (let i = 0; i < limit; i++) {
    lanes.push((async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        try {
          await task(item);
        } catch {
          // Best-effort by design: a miss self-heals at fetch time.
        }
      }
    })());
  }
  await Promise.all(lanes);
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Best-effort: no code is cached, so there is no shell integrity to
    // protect and a failed entry must never block the worker. Right after a
    // first boot these are conditional revalidations against the still-fresh
    // HTTP cache — cheap. Bounded lanes + timeouts so one stall can't pin
    // the install phase open.
    await eachWithPool(PRECACHE, INSTALL_CONCURRENCY, async (pathname) => {
      if (await cache.match(cacheKey(pathname))) return;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), INSTALL_FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(pathname, { cache: 'no-cache', signal: abort.signal });
        if (!(await verifyAndPut(cache, pathname, response))) {
          // One bypass retry: a no-cache body can be a ≤10-min-stale 304
          // reuse while the manifest already names the new deploy's bytes.
          await verifyAndPut(cache, pathname, await fetch(pathname, { cache: 'reload', signal: abort.signal }));
        }
      } finally {
        clearTimeout(timer);
      }
    });
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    const cache = await caches.open(CACHE_NAME);
    const current = new Set(Object.keys(MANIFEST).map(cacheKey));
    for (const request of await cache.keys()) {
      const url = new URL(request.url);
      if (current.has(url.href)) continue;
      // A tile of a set the app still names is kept: its path names its own
      // bytes, so it is never stale. A set the app dropped falls through and
      // is deleted — that is the only thing that frees tile bytes.
      if (immutableTileKey(url)) continue;
      await cache.delete(request);
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;
  const url = new URL(request.url);
  // A query would alias different requests onto one manifest body — the
  // app's data fetches are always bare paths, so anything else passes.
  if (url.search !== '') return;
  if (url.origin !== self.location.origin) {
    const tileKey = immutableTileKey(url);
    if (!tileKey) return;
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(tileKey);
      if (hit) return hit;
      const response = await fetch(request);
      event.waitUntil(putImmutable(cache, tileKey, response.clone()).catch(() => {}));
      return response;
    })().catch(() => fetch(request)));
    return;
  }
  // Not in the manifest — HTML, JS, sw.js itself, anything unknown — is the
  // browser's business; this worker never answers for it.
  if (!Object.prototype.hasOwnProperty.call(MANIFEST, url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(cacheKey(url.pathname));
    if (hit) return hit;
    const response = await fetch(request);
    // The page gets the stream NOW; a clone is verified and stored on the
    // side. Once a network response exists it is always what we return —
    // a verify/store failure must not trigger a second fetch.
    event.waitUntil(verifyAndPut(cache, url.pathname, response.clone()).catch(() => {}));
    return response;
  })().catch(() => fetch(request)));
});
