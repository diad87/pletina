// El build sustituye estos valores. No publicar los fuentes directamente.
const VERSION = "74604b084b6450d0"
const FILES = [{"url":"app.ecb516b07344ecee.js","sha256":"ecb516b07344ecee3ae5d19d09a5fb7d5994bde972cbed01d80af2f3396cca6d"},{"url":"icons/apple-touch-icon.png","sha256":"86b852fff90393252a3572788d7fa2599c91da1c45c6af0e282b4ce81a036740"},{"url":"icons/icon-192.png","sha256":"2bb6f09431e0b78d861999f0075bd715482b9ac3c4abcfc8cc05aefa7e810713"},{"url":"icons/icon-512.png","sha256":"9e5a9b7e3c80a66183e808cd4fd83d1d0112a9d6ca627afe1beb963cd400febf"},{"url":"index.html","sha256":"479b3c64e6bc79280cebfb8bb11ee6c18b5bbaa57c7f43fb50bc34571c4bec30"},{"url":"manifest.webmanifest","sha256":"416a20c33358a4f4fbd968875d0a5bbcb94b0dafa13ba50761d486b2a8fd288f"}]
const OPTIONAL = [{"url":"application/assets/figtree-latin-ext-wght-normal-DCwSJGxG.woff2","sha256":"bf7828e2c258cffcfa50a048ee388a36b95bc16b452e8d36fa797635dbe15965"},{"url":"application/assets/figtree-latin-wght-normal-D_ZTVpCC.woff2","sha256":"4ba7d3d096695818fe0686be4f1e82c6b05134e18a22260336130335027462dd"},{"url":"application/assets/index-B58A7Q4O.js","sha256":"0efe8f8adfd8c1457f06e9fff171d72d03ae574a6cc08397a4b2cfb198923f27"},{"url":"application/assets/index-Dhe7ruI3.css","sha256":"8aa749e9eff0f9bdd3db461c93e9dc98872bafee37a8e6bf1f415ba812d1e298"},{"url":"application/index.82c2cada25669563.html","sha256":"82c2cada25669563f8e37700ad3fbed2b16b343ecc0fd5514c4ea5f4d952db5f"},{"url":"application/launcher.93f05ec41ee4eb7c.js","sha256":"93f05ec41ee4eb7c532a69ec91c8c91a407f15387238611a78d43a382872646a"}]
const ROOT = new URL(self.registration.scope)
const PREFIX = `pletina-pwa:${encodeURIComponent(ROOT.href)}:`
const CACHE = PREFIX + VERSION
// Audio separado de los archivos de la app: una actualización conserva las descargas.
const AUDIO_CACHE = 'pletina-audio-downloads:v1'
const AUDIO_DATABASE = 'pletina-web-downloads'
const audioPath = new URL('__audio__/', ROOT).pathname
const indexURL = new URL('index.html', ROOT).href
const required = new Map(FILES.map((file) => [new URL(file.url, ROOT).href, file]))
const assets = new Map([...FILES, ...OPTIONAL].map((file) => [new URL(file.url, ROOT).href, file]))

function audioKey(url, id) {
  if (url.origin !== ROOT.origin || url.pathname !== audioPath + id || url.hash) return false
  const stage = url.searchParams.get('stage')
  return url.searchParams.size === 1 && typeof stage === 'string' && /^[0-9]{10,16}-[a-zA-Z0-9-]{1,64}$/.test(stage)
}

function downloadedKey(id) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    let opening
    try { opening = indexedDB.open(AUDIO_DATABASE) } catch { finish(null); return }
    // El módulo de descargas crea el esquema. No crear una base vacía por abrir un audio inexistente.
    opening.onupgradeneeded = () => opening.transaction.abort()
    opening.onerror = () => finish(null)
    opening.onblocked = () => finish(null)
    opening.onsuccess = () => {
      const database = opening.result
      if (settled || !database.objectStoreNames.contains('files')) { database.close(); finish(null); return }
      try {
        const tx = database.transaction('files', 'readonly')
        const request = tx.objectStore('files').get(Number(id))
        let key = null
        request.onsuccess = () => {
          const row = request.result
          try {
            if (row?.id === Number(id) && typeof row.cacheKey === 'string' && audioKey(new URL(row.cacheKey), id)) key = row.cacheKey
          } catch { /* Los metadatos incompletos nunca apuntan a otra ruta u origen. */ }
        }
        tx.oncomplete = () => { database.close(); finish(key) }
        tx.onerror = tx.onabort = () => { database.close(); finish(null) }
      } catch { database.close(); finish(null) }
    }
  })
}

async function downloadedAudio(url) {
  const id = url.pathname.slice(audioPath.length)
  if (!/^[1-9][0-9]{0,14}$/.test(id) || !Number.isSafeInteger(Number(id))) return new Response('', { status: 404 })
  let key
  if (url.search) {
    if (!audioKey(url, id)) return new Response('', { status: 404 })
    // Solo se utiliza para comprobar que un archivo temporal se puede decodificar antes de confirmarlo.
    key = url.href
  } else key = await downloadedKey(id)
  if (!key) return new Response('', { status: 404 })
  const cache = await caches.open(AUDIO_CACHE)
  const response = await cache.match(key)
  // La respuesta opaca completa conserva sus bytes; HTMLAudio gestiona su lectura y búsqueda local.
  return response || new Response('', { status: 404 })
}

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
  if (url.pathname.startsWith(audioPath)) {
    event.respondWith(downloadedAudio(url).catch(() => new Response('', { status: 404 })))
    return
  }
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
