// El build sustituye estos valores. No publicar los fuentes directamente.
const VERSION = "85d3cde632c1480f"
const FILES = [{"url":"app.df35bd17c4c1f623.js","sha256":"df35bd17c4c1f623233a3c2f10a0e72d81b93f0b8f29dba068c061da33a95e79"},{"url":"icons/apple-touch-icon.png","sha256":"86b852fff90393252a3572788d7fa2599c91da1c45c6af0e282b4ce81a036740"},{"url":"icons/icon-192.png","sha256":"2bb6f09431e0b78d861999f0075bd715482b9ac3c4abcfc8cc05aefa7e810713"},{"url":"icons/icon-512.png","sha256":"9e5a9b7e3c80a66183e808cd4fd83d1d0112a9d6ca627afe1beb963cd400febf"},{"url":"index.html","sha256":"1cb82027108d045d88f10af2b7db3a79bc95b0503a36b7e4469e4f04750af011"},{"url":"manifest.webmanifest","sha256":"416a20c33358a4f4fbd968875d0a5bbcb94b0dafa13ba50761d486b2a8fd288f"}]
const OPTIONAL = [{"url":"player/entry.c9dae38823c2f999.js","sha256":"c9dae38823c2f99934f44a127e3041d065733fa62c00dc652ce4e70184cacb49"},{"url":"player/resolver.ecb4d1adb7520d25.js","sha256":"ecb4d1adb7520d250330ca4c6d7993a9c98ca027be79c0ba73b28d9bb34f9971"}]
const ROOT = new URL(self.registration.scope)
const PREFIX = `pletina-pwa:${encodeURIComponent(ROOT.href)}:`
const CACHE = PREFIX + VERSION
const indexURL = new URL('index.html', ROOT).href
const required = new Map(FILES.map((file) => [new URL(file.url, ROOT).href, file]))
const assets = new Map([...FILES, ...OPTIONAL].map((file) => [new URL(file.url, ROOT).href, file]))

async function verifiedResponse(url, file) {
  const response = await fetch(new Request(url, { cache: 'reload' }))
  if (!response.ok || response.redirected) throw new Error(`No se pudo descargar ${file.url}`)
  const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer())
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (hash !== file.sha256) throw new Error(`Versión incompleta: ${file.url}`)
  return response
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    try {
      // Verificar todo antes de activar evita versiones incompletas o mezclas del CDN.
      for (const [url, file] of required) {
        await cache.put(url, await verifiedResponse(url, file))
      }
    } catch (error) {
      await caches.delete(CACHE)
      throw error
    }
    // Sin skipWaiting automático: una versión activa no se interrumpe al descargar otra.
  })())
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== ROOT.origin) return
  const isHome = request.mode === 'navigate' && (url.pathname === ROOT.pathname || url.pathname === new URL(indexURL).pathname)
  const key = isHome ? indexURL : new URL(url.pathname, ROOT.origin).href
  if (!isHome && !assets.has(key)) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const cached = await cache.match(key)
    if (cached) return cached
    const response = await verifiedResponse(key, assets.get(key))
    await cache.put(key, response.clone())
    return response
  })())
})
