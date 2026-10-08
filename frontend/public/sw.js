/**
 * Tally service worker.
 *
 * Hand-written rather than generated, because the caching rules here are small
 * and worth being able to read:
 *
 *   /api/*       never touched. Writes are queued in IndexedDB by the app, and
 *                a cached sync response would be actively harmful.
 *   navigations  served from the precached shell first, so the app opens with
 *                no network at all, then revalidated in the background.
 *   assets       precached at install, cache-first afterwards.
 *   everything   else same-origin: stale-while-revalidate.
 *
 * The two placeholders below are replaced at build time by
 * `scripts/finalize-sw.mjs`. The version is a hash of the built output, so a
 * deploy invalidates exactly once and never by accident.
 */

const VERSION = '__SW_VERSION__';
const PRECACHE_URLS = __PRECACHE_MANIFEST__;

const SHELL_CACHE = `tally-shell-${VERSION}`;
const RUNTIME_CACHE = `tally-runtime-${VERSION}`;
const SHELL_URL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll is all-or-nothing; one 404 would leave us with no shell at all.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const response = await fetch(url, { cache: 'reload' });
            if (response.ok) await cache.put(url, response);
          } catch {
            /* keep installing: a missing optional asset is not fatal */
          }
        }),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('tally-') && name !== SHELL_CACHE && name !== RUNTIME_CACHE)
          .map((name) => caches.delete(name)),
      );
      // Navigation preload shaves a round trip off the revalidate path.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

async function handleNavigation(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(SHELL_URL);

  const fromNetwork = (async () => {
    try {
      const preloaded = await event.preloadResponse;
      const response = preloaded || (await fetch(event.request));
      if (response && response.ok) {
        await cache.put(SHELL_URL, response.clone());
      }
      return response;
    } catch {
      return null;
    }
  })();

  // Cache-first: the shell is tiny and the whole point is instant cold start
  // with no signal. The network copy refreshes it for next time.
  if (cached) {
    event.waitUntil(fromNetwork);
    return cached;
  }

  const network = await fromNetwork;
  if (network) return network;

  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Tally is offline</title>' +
      '<body style="font:16px system-ui;background:#0b1020;color:#e8ecff;padding:2rem">' +
      '<h1>Tally</h1><p>The app shell has not been cached yet. ' +
      'Open Tally once while connected and it will work offline from then on.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type === 'basic') {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) return cached;

  const response = await network;
  if (response) return response;
  return new Response('', { status: 504, statusText: 'offline' });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The sync API is the app's job, not the cache's.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

/**
 * Background Sync wake-up.
 *
 * The outbox lives in IndexedDB and the push logic lives in the page, so the
 * worker's job here is to nudge any client that is alive. If none is, the
 * queue simply waits for the next time the app is opened - which is correct,
 * just less immediate. Chrome-only; everything else falls back to the app's
 * own online/visibility/interval triggers.
 */
self.addEventListener('sync', (event) => {
  if (event.tag !== 'tally-outbox') return;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      for (const client of clients) client.postMessage({ type: 'tally:flush-outbox' });
    })(),
  );
});
