// El build sustituye estos valores. No publicar los fuentes directamente.
const VERSION = "1ea46db9dc0b5af3"
const FILES = [{"url":"app.f806ab582d85e14d.js","sha256":"f806ab582d85e14dc56803bd936ab61a85167beef3b1248a13e343d974f7d211"},{"url":"icons/apple-touch-icon.png","sha256":"86b852fff90393252a3572788d7fa2599c91da1c45c6af0e282b4ce81a036740"},{"url":"icons/icon-192.png","sha256":"2bb6f09431e0b78d861999f0075bd715482b9ac3c4abcfc8cc05aefa7e810713"},{"url":"icons/icon-512.png","sha256":"9e5a9b7e3c80a66183e808cd4fd83d1d0112a9d6ca627afe1beb963cd400febf"},{"url":"index.html","sha256":"f5ee892d0d35d9f612e4a0558b3f7e7345c01f439fb248cacbf7311f4c779c2e"},{"url":"manifest.webmanifest","sha256":"416a20c33358a4f4fbd968875d0a5bbcb94b0dafa13ba50761d486b2a8fd288f"}]
const OPTIONAL = [{"url":"application/assets/figtree-latin-ext-wght-normal-DCwSJGxG.woff2","sha256":"bf7828e2c258cffcfa50a048ee388a36b95bc16b452e8d36fa797635dbe15965"},{"url":"application/assets/figtree-latin-wght-normal-D_ZTVpCC.woff2","sha256":"4ba7d3d096695818fe0686be4f1e82c6b05134e18a22260336130335027462dd"},{"url":"application/assets/index-BBZQKxHP.js","sha256":"01fd314cff217b10e02db78e4218957401eab497fe1536f3123ce05ae74e6124"},{"url":"application/assets/index-W2XYcCbw.css","sha256":"14fa408fcc7369cd48b310d7ac79052e3f9fb0871606c6dccd363be6902ebc47"},{"url":"application/assets/p1-recipe.generated-B9VIf5Tl.js","sha256":"d3bca80c0abde5aa6d17c0e0b4b7425fbb4a38f2742b5fbd44aa50ca39c60c13"},{"url":"application/assets/p1-recipe.generated-BGYpK-b1.js","sha256":"942b50d47435f0fe31a8fe1e9514310d4d1c32f6a4f268d42475e79fba14a812"},{"url":"application/assets/p1check-DM1A69LV.js","sha256":"61689fbb3c07e6e516c96d59c8eda7fdd29cad79ff29b4c33683e8bc71bf83af"},{"url":"application/assets/storage-BJF4eTjj.js","sha256":"25ddb61c2fa9204e705a4bd74ec449389ded2321a4b7ff2442c7decdc82af79b"},{"url":"application/assets/storage-PSZZs3R7.js","sha256":"95875109ebfca5945c47ae5556640fcb64cc6cc81567398293e7bf9cb92d62ba"},{"url":"application/assets/updates.svelte-CaKsDr0l.js","sha256":"6d7dc0d4ec0379302054c297d7db354b79454eafcef7348e46c4f85a0f18510a"},{"url":"application/assets/updates.svelte-d2-IJVos.js","sha256":"cdd94861f8449390ee7e5caaa4be57ec844d3885f8ca6e83a04eab59d801efb4"},{"url":"application/assets/youtube-BmuQ4-vc.js","sha256":"c426b097c16c1036c6965aff7ba223e2dc3501701eb83b1444dc121ab4657c8c"},{"url":"application/assets/youtube-p1-D6JsRkrB.js","sha256":"705ac7f9c675e978c0d943ff1d3b564a4f7f0d5f102afd1e778e063a3898fe8a"},{"url":"application/assets/youtube-p1-probe-D3C8r15R.js","sha256":"fa0f6050c1d7695072926ad4b3faf0a577a9f1c97eec3988d7b783fdbdf09470"},{"url":"application/index.3d5013bb61a98045.html","sha256":"3d5013bb61a98045e64b7f4c45ef46892cdeb2702bac7f12fef2833c045387f8"},{"url":"application/launcher.877eb1a6f54058da.js","sha256":"877eb1a6f54058da6cc193c01bb3487b4d47aaf0bac05920771f92ca2a8f29b7"},{"url":"application/p1-check.html","sha256":"542209d2ebc39818ccab2c861dc02a5f97e62c678f0306f23411b027da26a747"}]
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
