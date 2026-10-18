// El build sustituye estos valores. No publicar los fuentes directamente.
const VERSION = "74d9ad3aebca421b"
const FILES = [{"url":"app.6db75ee077c243ae.js","sha256":"6db75ee077c243ae833dd780670f577f3fb60e2cd47c169adcefd63741a8121d"},{"url":"icons/apple-touch-icon.png","sha256":"86b852fff90393252a3572788d7fa2599c91da1c45c6af0e282b4ce81a036740"},{"url":"icons/icon-192.png","sha256":"2bb6f09431e0b78d861999f0075bd715482b9ac3c4abcfc8cc05aefa7e810713"},{"url":"icons/icon-512.png","sha256":"9e5a9b7e3c80a66183e808cd4fd83d1d0112a9d6ca627afe1beb963cd400febf"},{"url":"index.html","sha256":"85dee1800dd956a6d51ebed330e390e54fa805c311339a4b081b13bf8d95d887"},{"url":"manifest.webmanifest","sha256":"416a20c33358a4f4fbd968875d0a5bbcb94b0dafa13ba50761d486b2a8fd288f"}]
const OPTIONAL = [{"url":"application/assets/figtree-latin-ext-wght-normal-DCwSJGxG.woff2","sha256":"bf7828e2c258cffcfa50a048ee388a36b95bc16b452e8d36fa797635dbe15965"},{"url":"application/assets/figtree-latin-wght-normal-D_ZTVpCC.woff2","sha256":"4ba7d3d096695818fe0686be4f1e82c6b05134e18a22260336130335027462dd"},{"url":"application/assets/index-C3UQ1I-9.css","sha256":"90d78faada3bdc75578bf6e9a3e3d0b667307a8fc7abfef1e633e9c44b670113"},{"url":"application/assets/index-pDy3iFgl.js","sha256":"08efdf5c1fd5c48422b76589fe4cad38a036982b5dd142d44d3f51a94ca2a2c4"},{"url":"application/index.7537ce85bd4c59da.html","sha256":"7537ce85bd4c59da50207e5c4e9562dac1b9f75e996d5b2aa484e1f852499d63"},{"url":"application/launcher.a6034df63563257c.js","sha256":"a6034df63563257c582943fadc14700a0efb67e4c36e16e104f83ce8c3b2162b"}]
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
  if (event.data?.type === 'PREPARE_APPLICATION') {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE)
        for (const file of OPTIONAL) {
          const url = new URL(file.url, ROOT).href
          if (!await cache.match(url)) await cache.put(url, await verifiedResponse(url, file))
        }
        event.ports?.[0]?.postMessage({ ok: true })
      } catch {
        event.ports?.[0]?.postMessage({ ok: false })
      }
    })())
  }
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
  if (request.mode === 'navigate' && !assets.has(key) && url.pathname.startsWith(new URL('application/index.', ROOT).pathname) && /\.[a-f0-9]{16}\.html$/.test(url.pathname)) {
    event.respondWith(Response.redirect(new URL('?open=app', ROOT).href, 302))
    return
  }
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
