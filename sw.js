// El build sustituye estos valores. No publicar los fuentes directamente.
const VERSION = "fc56a244ebcc9e6e"
const FILES = [{"url":"app.2c8c90ed631505d3.js","sha256":"2c8c90ed631505d39e40db65f2b257d4599a0fe5d9c29c2503be4a0b5e5b9bb5"},{"url":"icons/apple-touch-icon.png","sha256":"86b852fff90393252a3572788d7fa2599c91da1c45c6af0e282b4ce81a036740"},{"url":"icons/icon-192.png","sha256":"2bb6f09431e0b78d861999f0075bd715482b9ac3c4abcfc8cc05aefa7e810713"},{"url":"icons/icon-512.png","sha256":"9e5a9b7e3c80a66183e808cd4fd83d1d0112a9d6ca627afe1beb963cd400febf"},{"url":"index.html","sha256":"ba6ca74e30704a7828dda844ecffb9338e598b2a2ae4d212d80a239b753d0034"},{"url":"manifest.webmanifest","sha256":"416a20c33358a4f4fbd968875d0a5bbcb94b0dafa13ba50761d486b2a8fd288f"}]
const OPTIONAL = [{"url":"application/assets/figtree-latin-ext-wght-normal-DCwSJGxG.woff2","sha256":"bf7828e2c258cffcfa50a048ee388a36b95bc16b452e8d36fa797635dbe15965"},{"url":"application/assets/figtree-latin-wght-normal-D_ZTVpCC.woff2","sha256":"4ba7d3d096695818fe0686be4f1e82c6b05134e18a22260336130335027462dd"},{"url":"application/assets/index-BzWVG3zr.css","sha256":"0a89e5ae40d6c3e7488e53dcc10a1ff949f267f9523981781bfee3e62ed2dd25"},{"url":"application/assets/index-gqrqEUkX.js","sha256":"4dbf69dd99b95a5c279ea47318bd49a75137a039704e0bec2bc69cdbcda61af8"},{"url":"application/index.637bc33b2e5406c3.html","sha256":"637bc33b2e5406c305701bf073389e343ab2cda32c72699c45cbb9666725ed24"},{"url":"application/launcher.328c20705ab548bb.js","sha256":"328c20705ab548bbc579857117d8a5122c858a2f949950eeefc2f8296747eac2"}]
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

async function downloadedAudio(url, range) {
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
  if (!response) return new Response('', { status: 404 })
  if (response.type === 'opaque' || response.status !== 200) return response
  // CORS-readable external audio can answer real local byte ranges. Returning a
  // full 200 to a tail-range request can leave mobile/native seeking pending.
  const blob = await response.blob(), size = blob.size, headers = new Headers(response.headers)
  headers.set('accept-ranges', 'bytes')
  headers.set('content-length', String(size))
  headers.delete('content-range')
  if (!range) return new Response(blob, { status: 200, headers })
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
  const unsatisfied = () => { headers.set('content-range', `bytes */${size}`); headers.set('content-length', '0'); return new Response(null, { status: 416, headers }) }
  if (!match || !size || !match[1] && !match[2]) return unsatisfied()
  let start, end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return unsatisfied()
    start = Math.max(0, size - suffix); end = size - 1
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return unsatisfied()
    end = Math.min(end, size - 1)
  }
  headers.set('content-range', `bytes ${start}-${end}/${size}`)
  headers.set('content-length', String(end - start + 1))
  return new Response(blob.slice(start, end + 1, blob.type), { status: 206, headers })
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
    event.respondWith(downloadedAudio(url, request.headers.get('range')).catch(() => new Response('', { status: 404 })))
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
