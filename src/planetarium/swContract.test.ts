import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import template from '../../tools/sw.template.js?raw';
import swPlugin, { tileOriginFrom } from '../../tools/swPlugin.mjs';
import { resolveTileUrl, tileSetPath } from './world/texturePolicy';
import { SECTOR_SET_TABLE } from './world/sectorSets.generated';

// The service worker ships as generated JS the compiler never sees
// (tools/swPlugin.mjs injects the manifest into tools/sw.template.js at
// build). String pins can't prove behavior, so this suite EXECUTES the
// template against fake caches/fetch/events and asserts the contract:
// cache-first by content-hash key, verify-before-store off the response
// path, fail-open everywhere, a fetch handler that never answers for
// anything outside its manifest, and — for tile sets whose folder names
// carry their own content hash — cache-first by full URL, but only for an
// origin the build put on the allowlist.
//
// Everything here is keyed by absolute href, cache and fake network alike,
// because the worker's own keys are: pathname keys would collide across
// origins and make the activate prune delete every off-origin body.

const ORIGIN = 'https://site.test';
const TILE_ORIGIN = 'https://tiles.test';
const MOON_PATH = '/Moon/textures/moon.webp';
const STAR_PATH = '/Moon/stardata/bright-stars.v1.bin';
// Built the way a build with VITE_TILE_ORIGIN set builds them: the allowlist
// entry is the app's own set path under the tile origin, and the request is
// the app's own tile URL under the same. The two formulas live apart — the
// app's in texturePolicy, the worker's prefix match in the template — so
// pinning them here is what stops one from drifting into serving nothing.
const TILE_SET = { key: 'earth-day.v2', tier: '16k', hash: '1a2b3c4d' };
const TILE_SET_PREFIX = `${TILE_ORIGIN}/${tileSetPath(TILE_SET.key, TILE_SET.tier, TILE_SET.hash)}`;
const tileUrlOn = (hash: string, c = 2, r = 1) =>
  TILE_ORIGIN + resolveTileUrl(TILE_SET.key, TILE_SET.tier, hash, c, r);
const TILE_URL = tileUrlOn(TILE_SET.hash);
const MOON_BYTES = new TextEncoder().encode('moon-pixels');
const STAR_BYTES = new TextEncoder().encode('star-records');

/** Bytes shaped like a whole WebP file: 'RIFF', a size field covering every
 *  byte after it, 'WEBP', then one VP8L chunk holding the payload. The
 *  worker checks the size against what arrived and the first chunk's tag
 *  before it stores a tile, so a tile body in this suite has to carry both. */
function webpBytes(payload: string): Uint8Array {
  const body = new TextEncoder().encode(payload);
  const out = new Uint8Array(20 + body.length);
  const ascii = (text: string) => new TextEncoder().encode(text);
  out.set(ascii('RIFF'), 0);
  new DataView(out.buffer).setUint32(4, 12 + body.length, true);
  out.set(ascii('WEBP'), 8);
  out.set(ascii('VP8L'), 12);
  new DataView(out.buffer).setUint32(16, body.length, true);
  out.set(body, 20);
  return out;
}
const TILE_BYTES = webpBytes('tile-pixels');

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
  tiles: { origins?: string[]; sets?: string[] } = {},
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
    const href = new URL(typeof input === 'string' ? input : input.url, ORIGIN).href;
    const respond = network.get(href);
    if (!respond) return new Response('not found', { status: 404 });
    return respond();
  });
  const source = template.replace(
    '/* __INJECT_MANIFEST__ */',
    `const MANIFEST = ${JSON.stringify(manifest)};\nconst PRECACHE = ${JSON.stringify(precache)};\n` +
      `const TILE_ORIGINS = ${JSON.stringify(tiles.origins ?? [])};\n` +
      `const TILE_SETS = ${JSON.stringify(tiles.sets ?? [])};`,
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
    [ORIGIN + MOON_PATH, () => new Response(MOON_BYTES.slice(), { status: 200, headers: { 'content-type': 'image/webp' } })],
    [ORIGIN + STAR_PATH, () => new Response(STAR_BYTES.slice(), { status: 200 })],
    [TILE_URL, () => new Response(TILE_BYTES.slice(), { status: 200, headers: { 'content-type': 'image/webp' } })],
  ]);

const tileHost = { origins: [TILE_ORIGIN], sets: [TILE_SET_PREFIX] };

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

  it('never stores a non-200 response, even one carrying the right bytes', async () => {
    // Pins the status guard on its own: digest-matching bytes on an error
    // status (a misconfigured edge, a captive portal echo) must not cache.
    const weird = new Map([[ORIGIN + MOON_PATH, () => new Response(MOON_BYTES.slice(), { status: 203 })]]);
    const harness = bootWorker(MANIFEST, [], weird);
    const { responded, waits } = dispatchFetch(harness, new Request(ORIGIN + MOON_PATH));
    await responded!;
    await Promise.all(waits);
    expect(harness.store.size).toBe(0);
  });

  it('serves tampered network bytes fail-open but never stores them', async () => {
    const tampered = new Map([[ORIGIN + MOON_PATH, () => new Response('evil', { status: 200 })]]);
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

describe('service worker template: content-addressed tile sets', () => {
  it('serves an allowlisted tile from the network, caches it by full URL, then from cache', async () => {
    const harness = bootWorker(MANIFEST, [], healthyNetwork(), tileHost);
    const { responded, waits } = dispatchFetch(harness, new Request(TILE_URL));
    expect(new Uint8Array(await (await responded!).arrayBuffer())).toEqual(TILE_BYTES);
    await Promise.all(waits);
    // No ?swv=: the set hash in the path is already the body's identity.
    expect([...harness.store.keys()]).toEqual([TILE_URL]);
    const again = dispatchFetch(harness, new Request(TILE_URL));
    expect(new Uint8Array(await (await again.responded!).arrayBuffer())).toEqual(TILE_BYTES);
    expect(harness.netFetch).toHaveBeenCalledTimes(1);
  });

  it('allows exactly the URL the app builds for a set it names', () => {
    // The allowlist entry and the request come from two different pieces of
    // code — the build's prefix and the app's resolveTileUrl — and a drift
    // between them is a worker that quietly caches nothing.
    expect(TILE_URL).toBe(`${TILE_SET_PREFIX}2_1.webp`);
  });

  it('ignores a cross-origin tile whose origin is not allowlisted', () => {
    const harness = bootWorker(MANIFEST, [], healthyNetwork(), { origins: [], sets: [TILE_SET_PREFIX] });
    const { responded } = dispatchFetch(harness, new Request(TILE_URL));
    expect(responded).toBeUndefined();
    expect(harness.netFetch).not.toHaveBeenCalled();
  });

  it('ignores anything on an allowlisted origin that is not one of the named sets', () => {
    const harness = bootWorker(MANIFEST, [], healthyNetwork(), tileHost);
    const outside = [
      tileUrlOn('deadbeef'), // a set the app no longer names
      `${TILE_ORIGIN}/index.html`,
      `${TILE_ORIGIN}/textures/moon.webp`,
      `${TILE_SET_PREFIX}2_1.webp?v=2`, // a query would alias one cached body
    ];
    for (const url of outside) {
      expect(dispatchFetch(harness, new Request(url)).responded, url).toBeUndefined();
    }
    expect(harness.netFetch).not.toHaveBeenCalled();
  });

  it('never stores a tile response that is not a complete 200', async () => {
    const cases: Array<[string, () => Response]> = [
      ['404', () => new Response('not found', { status: 404 })],
      ['503', () => new Response(TILE_BYTES.slice(), { status: 503 })],
      // An opaque response is what a host without CORS gives an <img> — and
      // caching one would turn a missing header into a blank texture that
      // outlives the fix. Response cannot be constructed with status 0.
      ['opaque', () => ({ status: 0, clone: () => ({ status: 0 }) }) as unknown as Response],
    ];
    for (const [label, respond] of cases) {
      const harness = bootWorker(MANIFEST, [], new Map([[TILE_URL, respond]]), tileHost);
      const { responded, waits } = dispatchFetch(harness, new Request(TILE_URL));
      await responded!;
      await Promise.all(waits);
      expect(harness.store.size, label).toBe(0);
    }
  });

  it('never stores a complete 200 whose body is not a WebP container', async () => {
    // A tile key has no digest and no expiry, so a wrong 200 from an edge —
    // an error page, a mis-purged object, a proxy's own page, any of them
    // with permissive CORS — would pin that sector wrong for as long as the
    // app names the set. The page still gets the bytes; nothing is stored.
    const page = '<!doctype html><title>Not found</title>';
    const harness = bootWorker(
      MANIFEST,
      [],
      new Map([[TILE_URL, () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } })]]),
      tileHost,
    );
    const { responded, waits } = dispatchFetch(harness, new Request(TILE_URL));
    expect(await (await responded!).text()).toBe(page);
    await Promise.all(waits);
    expect(harness.store.size).toBe(0);
    // The same request with real WebP bytes is stored — the check is the
    // body's shape, not a blanket refusal.
    const good = bootWorker(MANIFEST, [], healthyNetwork(), tileHost);
    const hit = dispatchFetch(good, new Request(TILE_URL));
    await hit.responded!;
    await Promise.all(hit.waits);
    expect([...good.store.keys()]).toEqual([TILE_URL]);
  });

  it('never stores a tile whose bytes stop short of what its own header claims', async () => {
    // A server that closes the connection early ends the stream normally:
    // arrayBuffer() resolves with the short body and nothing else says it is
    // short. The RIFF size field does. Without that check a half tile would
    // be pinned under a key that never expires.
    const short = TILE_BYTES.slice(0, TILE_BYTES.length - 3);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(short.slice(0, 9));
        controller.enqueue(short.slice(9));
        controller.close();
      },
    });
    const harness = bootWorker(
      MANIFEST,
      [],
      new Map([[TILE_URL, () => new Response(stream, { status: 200, headers: { 'content-type': 'image/webp' } })]]),
      tileHost,
    );
    const { responded, waits } = dispatchFetch(harness, new Request(TILE_URL));
    expect(new Uint8Array(await (await responded!).arrayBuffer())).toEqual(short);
    await Promise.all(waits);
    expect(harness.store.size).toBe(0);
    // The same refusal for a body that is a RIFF/WEBP header over something
    // that is not an image chunk.
    const wrongChunk = TILE_BYTES.slice();
    wrongChunk.set(new TextEncoder().encode('ICCP'), 12);
    const other = bootWorker(
      MANIFEST,
      [],
      new Map([[TILE_URL, () => new Response(wrongChunk, { status: 200, headers: { 'content-type': 'image/webp' } })]]),
      tileHost,
    );
    const miss = dispatchFetch(other, new Request(TILE_URL));
    await miss.responded!;
    await Promise.all(miss.waits);
    expect(other.store.size).toBe(0);
  });

  it('with an empty allowlist behaves exactly as a same-origin-only worker', () => {
    const harness = bootWorker(MANIFEST, [], healthyNetwork());
    expect(dispatchFetch(harness, new Request(TILE_URL)).responded).toBeUndefined();
    expect(harness.netFetch).not.toHaveBeenCalled();
  });

  it('activate keeps tiles of the sets it still names and prunes the rest', async () => {
    const harness = bootWorker(MANIFEST, [], healthyNetwork(), tileHost);
    const dropped = tileUrlOn('deadbeef');
    const elsewhere = 'https://other.test' + resolveTileUrl(TILE_SET.key, TILE_SET.tier, TILE_SET.hash, 2, 1);
    for (const href of [TILE_URL, dropped, elsewhere]) {
      harness.store.set(href, { body: TILE_BYTES.slice(), type: 'image/webp' });
    }
    await dispatchLifecycle(harness, 'activate');
    expect(harness.store.has(TILE_URL)).toBe(true);
    expect(harness.store.has(dropped)).toBe(false);
    expect(harness.store.has(elsewhere)).toBe(false);
  });
});

describe('service worker template: lifecycle', () => {
  it('precaches the boot set verified, and one bad file cannot block the rest', async () => {
    const network = healthyNetwork();
    network.set(ORIGIN + MOON_PATH, () => new Response('outage', { status: 503 }));
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

// The build plugin, driven the way Vite drives it. The tile origin is the
// seam that matters here: the app reads VITE_TILE_ORIGIN from
// import.meta.env, which Vite fills from .env files AND process.env, and it
// never writes an .env value back into process.env. A plugin reading
// process.env would therefore build an empty allowlist for a build whose app
// fetches from a CDN — every tile uncached, nothing in the log.
describe('service worker build plugin: tile origin and allowlist', () => {
  const TILE_HOST = 'https://cdn.test/gh/user/moon-tiles@v1';
  let dist = '';
  let savedEnv: string | undefined;

  /** A dist tree with the little the plugin insists on: the five data
   *  directories, a boot-warm script whose files all exist, and two fonts. */
  function fakeDist(): string {
    const dir = mkdtempSync(join(tmpdir(), 'moon-sw-'));
    for (const d of ['textures', 'stardata', 'fonts', 'models', 'historic']) {
      mkdirSync(join(dir, d), { recursive: true });
    }
    const warm: string[] = [];
    for (let i = 0; i < 22; i++) {
      warm.push(`t${i}.webp`);
      writeFileSync(join(dir, 'textures', `t${i}.webp`), `pixels-${i}`);
    }
    writeFileSync(join(dir, 'stardata', 'bright-stars.v1.bin'), 'records');
    writeFileSync(join(dir, 'fonts', 'a.woff2'), 'font-a');
    writeFileSync(join(dir, 'fonts', 'b.woff2'), 'font-b');
    writeFileSync(
      join(dir, 'index.html'),
      `<!doctype html><html><body><script id="boot-texture-warm">\n` +
        `const files = [${warm.map((f) => `'${f}'`).join(', ')}];\n` +
        `for (let i = 0; i < files.length; i++) warm('/textures/' + files[i]);\n` +
        `warm('/stardata/bright-stars.v1.bin');\n` +
        `</script></body></html>\n`,
    );
    return dir;
  }

  function runPlugin(env: Record<string, string | boolean | undefined>): string {
    const plugin = swPlugin();
    plugin.configResolved({ root: dist, base: '/', build: { outDir: dist }, env });
    plugin.closeBundle();
    return readFileSync(join(dist, 'sw.js'), 'utf8');
  }

  /** One injected constant back out of the generated worker. */
  function injected(sw: string, name: string): unknown {
    const head = `const ${name} = `;
    const line = sw.split('\n').find((l) => l.startsWith(head));
    expect(line, `${name} not injected`).toBeDefined();
    return JSON.parse(line!.slice(head.length, -1));
  }

  beforeEach(() => {
    dist = fakeDist();
    // The whole point is that nothing reaches the plugin through process.env.
    savedEnv = process.env.VITE_TILE_ORIGIN;
    delete process.env.VITE_TILE_ORIGIN;
  });

  afterEach(() => {
    rmSync(dist, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.VITE_TILE_ORIGIN;
    else process.env.VITE_TILE_ORIGIN = savedEnv;
  });

  it('takes the tile origin from config.env, where an .env file lands', () => {
    const sw = runPlugin({ VITE_TILE_ORIGIN: `${TILE_HOST}/` });
    expect(injected(sw, 'TILE_ORIGINS')).toEqual(['https://cdn.test']);
    // Every set the app names, under the host, at the hash it will ask for.
    const sets = injected(sw, 'TILE_SETS') as string[];
    expect(sets.length).toBe(Object.keys(SECTOR_SET_TABLE).length);
    for (const [id, entry] of Object.entries(SECTOR_SET_TABLE)) {
      const [key, tier] = id.split('/');
      expect(sets).toContain(`${TILE_HOST}/${tileSetPath(key, tier, entry.setHash8)}`);
    }
  });

  it('never names a root-level HTML file, so a page like probe.html stays outside it', () => {
    // The worker caches data directories only and precaches what the boot
    // warm script names. A page dropped into public/ — the GPU memory probe
    // is the one that exists — must therefore be invisible to it: cached
    // HTML is how an app goes stale through its own worker.
    writeFileSync(join(dist, 'probe.html'), '<!doctype html><title>probe</title>');
    const sw = runPlugin({ VITE_TILE_ORIGIN: `${TILE_HOST}/` });
    const manifest = injected(sw, 'MANIFEST') as Record<string, string>;
    const precache = injected(sw, 'PRECACHE') as string[];
    for (const pathname of [...Object.keys(manifest), ...precache]) {
      expect(pathname.endsWith('.html'), `${pathname} is HTML`).toBe(false);
    }
    expect(manifest['/probe.html']).toBeUndefined();
    expect(precache).not.toContain('/probe.html');
  });

  it('allows nothing off-origin when no tile origin is configured', () => {
    // Tiles are then ordinary same-origin data files — but this dist has no
    // tile folders, which is the case the build has to refuse rather than
    // ship a plausible app with quietly soft hero bodies.
    expect(() => runPlugin({})).toThrow(/VITE_TILE_ORIGIN is unset/);
  });

  it('refuses a tile origin that is not an absolute URL', () => {
    expect(() => tileOriginFrom({ VITE_TILE_ORIGIN: 'cdn.test/tiles' })).toThrow(/not an absolute URL/);
    expect(tileOriginFrom({ VITE_TILE_ORIGIN: '  https://cdn.test/tiles//  ' })).toBe('https://cdn.test/tiles');
    // The tile path is appended to the origin, so anything that would land
    // the path inside a query, a fragment or the credentials is refused.
    expect(() => tileOriginFrom({ VITE_TILE_ORIGIN: 'https://cdn.test/x?token=abc' })).toThrow(/no query/);
    expect(() => tileOriginFrom({ VITE_TILE_ORIGIN: 'https://cdn.test/x?' })).toThrow(/no query/);
    expect(() => tileOriginFrom({ VITE_TILE_ORIGIN: 'https://cdn.test/x#tiles' })).toThrow(/no query/);
    expect(() => tileOriginFrom({ VITE_TILE_ORIGIN: 'https://user:pw@cdn.test/x' })).toThrow(/no query/);
    expect(() => tileOriginFrom({ VITE_TILE_ORIGIN: 'ftp://cdn.test/x' })).toThrow(/http\(s\)/);
    expect(tileOriginFrom({ VITE_TILE_ORIGIN: 'https://CDN.test/gh/moon-tiles@main/' })).toBe('https://cdn.test/gh/moon-tiles@main');
    expect(tileOriginFrom({})).toBe('');
    expect(tileOriginFrom(undefined)).toBe('');
  });
});
