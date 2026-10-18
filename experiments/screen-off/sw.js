'use strict';

const VERSION = '__SCREEN_OFF_VERSION__';
const INTEGRITY = __SCREEN_OFF_INTEGRITY__;
const CACHE_PREFIX = `pletina-screen-off:${encodeURIComponent(self.registration.scope)}:`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const FILES = [
  './',
  'index.html',
  'app.js',
  'resolver.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];
const STATIC_URLS = FILES.map((file) => new URL(file, self.registration.scope).href);
const STATIC_PATHS = new Set(STATIC_URLS.map((url) => new URL(url).pathname));
const OWN_ORIGIN = new URL(self.registration.scope).origin;
const STATIC_NAMES = new Map(STATIC_URLS.map((url, index) =>
  [url, FILES[index] === './' ? 'index.html' : FILES[index]]));

async function verifiedResponse(url) {
  const name = STATIC_NAMES.get(url);
  const response = await fetch(new Request(url, { cache: 'reload' }));
  if (!response.ok || response.redirected) throw new Error('No se pudo descargar ' + name);
  const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== INTEGRITY[name]) throw new Error('Versión incompleta: ' + name);
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      for (const url of STATIC_URLS) {
        await cache.put(url, await verifiedResponse(url));
      }
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== OWN_ORIGIN || !STATIC_PATHS.has(url.pathname)) return;

  // Only the harness files use this cache. Audio and remote requests go directly
  // to the browser's normal network stack, outside this handler.
  url.search = '';
  url.hash = '';
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url.href);
    if (cached) return cached;
    const response = await verifiedResponse(url.href);
    await cache.put(url.href, response.clone());
    return response;
  })());
});
