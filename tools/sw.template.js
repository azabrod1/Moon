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
 * live under content-addressed keys (pathname?swv=hash) — a deploy that
 * changes a file changes its key, stale keys are pruned on activate, and
 * unchanged files are never refetched. Verification runs OFF the response
 * path: the page gets the network stream immediately; a clone is hashed and
 * conditionally stored under waitUntil. On any failure the page simply has
 * the network bytes — byte-for-byte what a worker-less page would have.
 *
 * Growth: only the boot set is precached, but the runtime handler stores
 * every manifest file it serves — the tier maps, the KTX2 and the whole tile
 * set included — so a session that flies everywhere can leave the CacheStorage
 * holding the entire data set (~100 MB). Nothing prunes inside a deploy; the
 * activate sweep only drops keys the new manifest no longer names. The
 * practical ceilings are the browser's: a quota prompt on a small phone, and
 * Safari's 7-day eviction of unvisited-site storage.
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

function cacheKey(pathname) {
  return pathname + '?swv=' + MANIFEST[pathname];
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

/**
 * One install attempt: fetch, verify, store. Its own timeout budget — the
 * bypass retry sharing the first attempt's timer left it almost no time after
 * a slow miss — and the timer covers reading the body, not just the headers.
 */
async function fetchAndStore(cache, pathname, cacheMode) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), INSTALL_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(pathname, { cache: cacheMode, signal: abort.signal });
    return await verifyAndPut(cache, pathname, response);
  } finally {
    clearTimeout(timer);
  }
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
      if (await fetchAndStore(cache, pathname, 'no-cache')) return;
      // One bypass retry: a no-cache body can be a ≤10-min-stale 304 reuse
      // while the manifest already names the new deploy's bytes.
      await fetchAndStore(cache, pathname, 'reload');
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
      if (!current.has(url.pathname + url.search)) await cache.delete(request);
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // A query would alias different requests onto one manifest body — the
  // app's data fetches are always bare paths, so anything else passes.
  if (url.search !== '') return;
  // Not in the manifest — HTML, JS, sw.js itself, anything unknown — is the
  // browser's business; this worker never answers for it.
  if (!Object.prototype.hasOwnProperty.call(MANIFEST, url.pathname)) return;
  event.respondWith((async () => {
    // Only the cache lookup is guarded. A CacheStorage that throws (private
    // browsing, a revoked quota) must still leave the page with the network,
    // but the network's own failure belongs to the page: catching it here and
    // fetching again cost every request two failed attempts, offline, before
    // the app's retry ladder saw one error.
    let cache = null;
    let hit;
    try {
      cache = await caches.open(CACHE_NAME);
      hit = await cache.match(cacheKey(url.pathname));
    } catch {
      cache = null;
    }
    if (hit) return hit;
    const response = await fetch(request);
    // The page gets the stream NOW; a clone is verified and stored on the
    // side. Once a network response exists it is always what we return —
    // a verify/store failure must not trigger a second fetch.
    if (cache) event.waitUntil(verifyAndPut(cache, url.pathname, response.clone()).catch(() => {}));
    return response;
  })());
});
