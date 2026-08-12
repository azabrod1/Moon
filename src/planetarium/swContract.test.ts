import { beforeEach, describe, expect, it, vi } from 'vitest';
import template from '../../tools/sw.template.js?raw';

// The service worker ships as generated JS the compiler never sees
// (tools/swPlugin.mjs injects the manifest into tools/sw.template.js at
// build). String pins can't prove behavior, so this suite EXECUTES the
// template against fake caches/fetch/events and asserts the contract:
// cache-first by content-hash key, verify-before-store off the response
// path, fail-open everywhere, and a fetch handler that never answers for
// anything outside its manifest.

const ORIGIN = 'https://site.test';
const MOON_PATH = '/Moon/textures/moon.webp';
const STAR_PATH = '/Moon/stardata/bright-stars.v1.bin';
const MOON_BYTES = new TextEncoder().encode('moon-pixels');
const STAR_BYTES = new TextEncoder().encode('star-records');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** In-memory Cache double. Stores bytes, mints a fresh Response per match —
 *  a real cache body is readable on every hit. */
function fakeCaches() {
  const store = new Map<string, { body: Uint8Array; type: string }>();
  const toHref = (key: string | Request) =>
    new URL(typeof key === 'string' ? key : key.url, ORIGIN).href;
  const cache = {
    match: async (key: string | Request) => {
      const hit = store.get(toHref(key));
      if (!hit) return undefined;
      return new Response(hit.body.slice(), { headers: { 'content-type': hit.type } });
    },
    put: async (key: string | Request, response: Response) => {
      store.set(toHref(key), {
        body: new Uint8Array(await response.arrayBuffer()),
        type: response.headers.get('content-type') ?? '',
      });
    },
    keys: async () => [...store.keys()].map((href) => new Request(href)),
    delete: async (key: string | Request) => store.delete(toHref(key)),
  };
  return { cache, store };
}

interface Harness {
  handlers: Record<string, (event: never) => void>;
  store: Map<string, { body: Uint8Array; type: string }>;
  cache: ReturnType<typeof fakeCaches>['cache'];
  self: { skipWaiting: ReturnType<typeof vi.fn>; clients: { claim: ReturnType<typeof vi.fn> } };
  netFetch: ReturnType<typeof vi.fn>;
}

/** Evaluate the template with an injected manifest, exactly as the build
 *  plugin does, against the fakes. */
function bootWorker(
  manifest: Record<string, string>,
  precache: string[],
  network: Map<string, () => Response>,
): Harness {
  const handlers: Record<string, (event: never) => void> = {};
  const { cache, store } = fakeCaches();
  const self = {
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: never) => void) => {
      handlers[type] = fn;
    },
  };
  const netFetch = vi.fn(async (input: string | Request) => {
    const pathname = new URL(typeof input === 'string' ? input : input.url, ORIGIN).pathname;
    const respond = network.get(pathname);
    if (!respond) return new Response('not found', { status: 404 });
    return respond();
  });
  const source = template.replace(
    '/* __INJECT_MANIFEST__ */',
    `const MANIFEST = ${JSON.stringify(manifest)};\nconst PRECACHE = ${JSON.stringify(precache)};`,
  );
  new Function('self', 'caches', 'fetch', source)(self, { open: async () => cache }, netFetch);
  return { handlers, store, cache, self, netFetch };
}

function dispatchFetch(harness: Harness, request: Request) {
  let responded: Promise<Response> | undefined;
  const waits: Promise<unknown>[] = [];
  const event = {
    request,
    respondWith: (p: Response | Promise<Response>) => { responded = Promise.resolve(p); },
    waitUntil: (p: Promise<unknown>) => { waits.push(p.catch(() => {})); },
  };
  harness.handlers.fetch(event as never);
  return { responded, waits };
}

async function dispatchLifecycle(harness: Harness, type: 'install' | 'activate') {
  const waits: Promise<unknown>[] = [];
  harness.handlers[type]({ waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as never);
  await Promise.all(waits);
}

let MANIFEST: Record<string, string>;

beforeEach(async () => {
  MANIFEST = {
    [MOON_PATH]: await sha256Hex(MOON_BYTES),
    [STAR_PATH]: await sha256Hex(STAR_BYTES),
  };
});

const healthyNetwork = () =>
  new Map<string, () => Response>([
    [MOON_PATH, () => new Response(MOON_BYTES.slice(), { status: 200, headers: { 'content-type': 'image/webp' } })],
    [STAR_PATH, () => new Response(STAR_BYTES.slice(), { status: 200 })],
  ]);

describe('service worker template: fetch handler', () => {
  it('serves a cold request from the network immediately, body intact, then caches it', async () => {
    const harness = bootWorker(MANIFEST, [], healthyNetwork());
    const { responded, waits } = dispatchFetch(harness, new Request(ORIGIN + MOON_PATH));
    const response = await responded!;
    // The page's copy is readable even though a clone is being hashed.
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MOON_BYTES);
    expect(harness.netFetch).toHaveBeenCalledTimes(1);
    await Promise.all(waits);
    // Stored under the content-hash key, verified.
    expect(harness.store.has(ORIGIN + MOON_PATH + '?swv=' + MANIFEST[MOON_PATH])).toBe(true);
    // Second request: cache-first, no new network, body correct again.
    const again = dispatchFetch(harness, new Request(ORIGIN + MOON_PATH));
    expect(new Uint8Array(await (await again.responded!).arrayBuffer())).toEqual(MOON_BYTES);
    expect(harness.netFetch).toHaveBeenCalledTimes(1);
  });

  it('serves tampered network bytes fail-open but never stores them', async () => {
    const tampered = new Map([[MOON_PATH, () => new Response('evil', { status: 200 })]]);
    const harness = bootWorker(MANIFEST, [], tampered);
    const { responded, waits } = dispatchFetch(harness, new Request(ORIGIN + MOON_PATH));
    expect(await (await responded!).text()).toBe('evil');
    await Promise.all(waits);
    expect(harness.store.size).toBe(0);
    // Next request tries the network again rather than trusting anything.
    const again = dispatchFetch(harness, new Request(ORIGIN + MOON_PATH));
    await again.responded!;
    expect(harness.netFetch).toHaveBeenCalledTimes(2);
  });

  it('still delivers the response when the cache write blows up', async () => {
    const harness = bootWorker(MANIFEST, [], healthyNetwork());
    harness.cache.put = async () => { throw new Error('quota'); };
    const { responded, waits } = dispatchFetch(harness, new Request(ORIGIN + MOON_PATH));
    expect(new Uint8Array(await (await responded!).arrayBuffer())).toEqual(MOON_BYTES);
    await Promise.all(waits); // the contained failure must not reject anything
  });

  it('never answers for anything outside its manifest', () => {
    const harness = bootWorker(MANIFEST, [], healthyNetwork());
    const untouched = [
      new Request(ORIGIN + '/Moon/index.html'),
      new Request(ORIGIN + '/Moon/assets/index-abc123.js'),
      new Request(ORIGIN + '/Moon/sw.js'),
      new Request(ORIGIN + MOON_PATH + '?v=2'), // query would alias the manifest body
      new Request('https://elsewhere.test' + MOON_PATH), // cross-origin
      new Request(ORIGIN + MOON_PATH, { method: 'POST' }),
      new Request(ORIGIN + MOON_PATH, { headers: { range: 'bytes=0-99' } }),
    ];
    for (const request of untouched) {
      const { responded } = dispatchFetch(harness, request);
      expect(responded, `${request.method} ${request.url}`).toBeUndefined();
    }
    expect(harness.netFetch).not.toHaveBeenCalled();
  });
});

describe('service worker template: lifecycle', () => {
  it('precaches the boot set verified, and one bad file cannot block the rest', async () => {
    const network = healthyNetwork();
    network.set(MOON_PATH, () => new Response('outage', { status: 503 }));
    const harness = bootWorker(MANIFEST, [MOON_PATH, STAR_PATH], network);
    await dispatchLifecycle(harness, 'install');
    expect(harness.self.skipWaiting).toHaveBeenCalled();
    expect(harness.store.has(ORIGIN + STAR_PATH + '?swv=' + MANIFEST[STAR_PATH])).toBe(true);
    expect(harness.store.has(ORIGIN + MOON_PATH + '?swv=' + MANIFEST[MOON_PATH])).toBe(false);
  });

  it('activate claims clients and prunes keys the manifest no longer names', async () => {
    const harness = bootWorker(MANIFEST, [], healthyNetwork());
    const keep = ORIGIN + MOON_PATH + '?swv=' + MANIFEST[MOON_PATH];
    const stale = ORIGIN + MOON_PATH + '?swv=0123456789abcdef';
    harness.store.set(keep, { body: MOON_BYTES.slice(), type: 'image/webp' });
    harness.store.set(stale, { body: new TextEncoder().encode('old'), type: 'image/webp' });
    await dispatchLifecycle(harness, 'activate');
    expect(harness.self.clients.claim).toHaveBeenCalled();
    expect(harness.store.has(keep)).toBe(true);
    expect(harness.store.has(stale)).toBe(false);
  });
});
