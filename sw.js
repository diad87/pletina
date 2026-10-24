// El build sustituye estos valores. No publicar los fuentes directamente.
const VERSION = "cc8c27ed537f3353"
const FILES = [{"url":"app.789dd748b7efbfbc.js","sha256":"789dd748b7efbfbcc12323cc8fbcdd2735881046c24b0481bdb6063aabe3ce51"},{"url":"icons/apple-touch-icon.png","sha256":"86b852fff90393252a3572788d7fa2599c91da1c45c6af0e282b4ce81a036740"},{"url":"icons/icon-192.png","sha256":"2bb6f09431e0b78d861999f0075bd715482b9ac3c4abcfc8cc05aefa7e810713"},{"url":"icons/icon-512.png","sha256":"9e5a9b7e3c80a66183e808cd4fd83d1d0112a9d6ca627afe1beb963cd400febf"},{"url":"index.html","sha256":"b2b2a80531036d911831bb6e5cb8da28668e09616e9657f74e96cea88dc20e62"},{"url":"manifest.webmanifest","sha256":"95fd9d853c621c99b2126aa1ce2a4edeb06cad69e33d95a9e05af3b1d6bbbf9d"}]
const OPTIONAL = [{"url":"application/assets/figtree-latin-ext-wght-normal-DCwSJGxG.woff2","sha256":"bf7828e2c258cffcfa50a048ee388a36b95bc16b452e8d36fa797635dbe15965"},{"url":"application/assets/figtree-latin-wght-normal-D_ZTVpCC.woff2","sha256":"4ba7d3d096695818fe0686be4f1e82c6b05134e18a22260336130335027462dd"},{"url":"application/assets/index-KloXT6Z1.css","sha256":"7d401d8b1d5503c47e10cd6ed4145c9d5513d954af79d6b10a9db64c7fc45f7e"},{"url":"application/assets/index-Qtx4Iifn.js","sha256":"d3328026006111aa9066923bff8df13a09b96c69770e79db409c2a47a17918fb"},{"url":"application/assets/p1-recipe.generated-BtxtnceM.js","sha256":"5e5fa499a78e08cb2de1fc425d70f7fcef6dc0c0477065f87ca07624a6295328"},{"url":"application/assets/p1-recipe.generated-C4oQvyrS.js","sha256":"bfb45f9889a0110c35e009dd7dff50132d2473b35288cb05987a49e420039a52"},{"url":"application/assets/p1check-eElhzM6G.js","sha256":"39f19f7e81a12f77955b09cab55431d80498ca711f2cf70a7863ad3e8ce2cd5d"},{"url":"application/assets/storage-H4YP9eR3.js","sha256":"4672ed0995cb2027914605f606489bf544dacbd417f6f5394585a7bc2dbc05f0"},{"url":"application/assets/storage-ON5O59yG.js","sha256":"e59c9da53ab55c46f0a1db46e0981be8958db6641d356cc4e4d2df0895b20109"},{"url":"application/assets/updates.svelte-DWJ4lW8D.js","sha256":"455b13dd5555e533ad6c94dd9b3b34494889527e5d1c17d27fa7faa5b5425755"},{"url":"application/assets/updates.svelte-DZqi8l40.js","sha256":"a36c8b946174db29f33f3c28605a7145e5a655057caf283e300c5f0c297eee32"},{"url":"application/assets/youtube-Bnw5FnW6.js","sha256":"2e9b9ea65f455a8c9d204409fa92e9a1bd12b3685d2869db0f73f6566a26d60a"},{"url":"application/assets/youtube-p1-OeC5GoPm.js","sha256":"37fcaa33ab775f21061857481e4118df9f2e6462b073310ad909d410ac2d8dff"},{"url":"application/assets/youtube-p1-probe-B9_PRGjk.js","sha256":"f9c332f959da2a5980ab1ac3607c3fec703c1412be5f819112692ece547c3f7f"},{"url":"application/index.5c4b8e0fbdd5fd0b.html","sha256":"5c4b8e0fbdd5fd0bd71b2f748a72010ba963827d00817f98590a0059624dfdb6"},{"url":"application/launcher.e8c79eca6f67e724.js","sha256":"e8c79eca6f67e7241d8c5fb9d0cca91050ec53fee3ba03974018e3bc0716a824"},{"url":"application/p1-check.html","sha256":"6d2cc3af920b603cb3f728ebd3b51b933a04949bdccad8cae40dbc58f0a356d6"}]
const ROOT = new URL(self.registration.scope)
const COVERS = (/**
 * Shared by the UI, downloader and the classic worker (the build embeds this
 * self-contained factory). Keys are absolute local URLs naming canonical image
 * families; local() retains the requested permanent URL for online fallback.
 * @param {string | URL} rootURL
 */
function coverRouting(rootURL) {
  const root = new URL(rootURL)
  root.search = ''; root.hash = ''
  if (!root.pathname.endsWith('/')) root.pathname += '/'
  const endpoint = new URL('__covers__', root)
  const limits = { maxBytes: 5 * 1024 * 1024, maxDimension: 4096, maxPixels: 16 * 1024 * 1024 }
  const forbidden = /^(?:sig|lsig|signature|signaturecipher|token|access_token|auth|auth_token|authorization|jwt|expires?|policy|key-pair-id|x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential))$/i

  /** @param {unknown} value @returns {string | null} */
  function normalize(value) {
    if (typeof value !== 'string' || value.length > 4000 || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null
    try {
      const url = new URL(value.trim())
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
        [...url.searchParams.keys()].some(key => forbidden.test(key))) return null
      return url.href.length <= 4000 ? url.href : null
    } catch { return null }
  }
  /** @param {string} value */
  function family(value) {
    const url = new URL(value)
    if (/(?:^|\.)(?:dzcdn\.net|deezer\.com)$/i.test(url.hostname)) {
      url.pathname = url.pathname.replace(/^(\/images\/(?:cover|artist)\/[A-Za-z0-9_-]{1,200}\/)\d{1,5}x\d{1,5}(-[^/]{1,200})$/, (_match, prefix, suffix) => prefix + '1000x1000' + suffix)
    }
    return url.href
  }
  /** @param {string} value */
  function route(value) { const url = new URL(endpoint); url.searchParams.set('url', value); return url.href }
  /** @param {unknown} value @returns {string | null} */
  function key(value) { const normalized = normalize(value); return normalized ? route(family(normalized)) : null }
  /** @param {unknown} value @returns {string | null} */
  function local(value) { const normalized = normalize(value); return normalized ? route(normalized) : null }
  /** @param {unknown} value @returns {string | null} */
  function parse(value) {
    try {
      const url = new URL(String(value))
      if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname || url.username || url.password || url.hash ||
        url.searchParams.size !== 1 || url.searchParams.getAll('url').length !== 1) return null
      const original = normalize(url.searchParams.get('url'))
      return original && url.href === route(original) ? original : null
    } catch { return null }
  }
  /** @param {unknown} value @returns {string[]} */
  function candidates(value) { const normalized = normalize(value); return normalized ? [...new Set([family(normalized), normalized])] : [] }
  /** @param {Uint8Array} bytes @param {number} at */
  const be16 = (bytes, at) => bytes[at] * 256 + bytes[at + 1]
  /** @param {Uint8Array} bytes @param {number} at */
  const be32 = (bytes, at) => bytes[at] * 0x1000000 + bytes[at + 1] * 0x10000 + bytes[at + 2] * 256 + bytes[at + 3]
  /** @param {Uint8Array} bytes @param {number} at */
  const le24 = (bytes, at) => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 0x10000
  /** @param {Uint8Array} bytes @param {number} at */
  const le32 = (bytes, at) => le24(bytes, at) + bytes[at + 3] * 0x1000000
  /** @param {Uint8Array} bytes @param {number} at @param {number} length */
  const ascii = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length))
  /** @param {number} width @param {number} height */
  const validSize = (width, height) => Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= limits.maxDimension && height <= limits.maxDimension && width * height <= limits.maxPixels

  /** @param {Uint8Array} bytes @param {string} mime */
  function raster(bytes, mime) {
    if (mime === 'image/gif') {
      if (bytes.length < 27 || !['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return false
      const width = bytes[6] + bytes[7] * 256, height = bytes[8] + bytes[9] * 256
      if (!validSize(width, height)) return false
      let at = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), frames = 0
      const blocks = () => {
        let data = false
        while (at < bytes.length) {
          const length = bytes[at++]
          if (!length) return data
          if (length > bytes.length - at) return null
          data = true; at += length
        }
        return null
      }
      while (at < bytes.length) {
        const type = bytes[at++]
        if (type === 0x3b) return frames === 1 && at === bytes.length
        if (type === 0x21) { if (at >= bytes.length) return false; at++; if (blocks() === null) return false; continue }
        if (type !== 0x2c || ++frames > 1 || at + 9 > bytes.length) return false
        const x = bytes[at] + bytes[at + 1] * 256, y = bytes[at + 2] + bytes[at + 3] * 256
        const w = bytes[at + 4] + bytes[at + 5] * 256, h = bytes[at + 6] + bytes[at + 7] * 256, flags = bytes[at + 8]
        if (!validSize(w, h) || x + w > width || y + h > height) return false
        at += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0)
        if (at >= bytes.length || bytes[at] < 2 || bytes[at++] > 8 || blocks() !== true) return false
      }
      return false
    }
    if (mime === 'image/png') {
      if (bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) ||
        be32(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR' || !validSize(be32(bytes, 16), be32(bytes, 20))) return false
      let at = 8, data = false
      while (at + 12 <= bytes.length) {
        const length = be32(bytes, at), type = ascii(bytes, at + 4, 4)
        if (length > bytes.length - at - 12 || ['acTL', 'fcTL', 'fdAT'].includes(type)) return false
        if (type === 'IDAT') data = data || length > 0
        if (type === 'IEND') return data && length === 0 && at + 12 === bytes.length
        at += length + 12
      }
      return false
    }
    if (mime === 'image/jpeg') {
      if (bytes.length < 15 || be16(bytes, 0) !== 0xffd8 || be16(bytes, bytes.length - 2) !== 0xffd9) return false
      for (let at = 2; at + 4 < bytes.length;) {
        if (bytes[at++] !== 0xff) return false
        while (bytes[at] === 0xff) at++
        const marker = bytes[at++]
        if (marker === 0xd9 || marker === 0xda) return false
        if (marker === 1 || marker >= 0xd0 && marker <= 0xd8) continue
        const length = be16(bytes, at)
        if (length < 2 || at + length > bytes.length) return false
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return length >= 8 && validSize(be16(bytes, at + 5), be16(bytes, at + 3))
        at += length
      }
      return false
    }
    if (mime !== 'image/webp' || bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP' || le32(bytes, 4) + 8 !== bytes.length) return false
    let at = 12, width = 0, height = 0, canvasWidth = 0, canvasHeight = 0
    while (at + 8 <= bytes.length) {
      const type = ascii(bytes, at, 4), length = le32(bytes, at + 4), data = at + 8
      if (length > bytes.length - data || ['ANIM', 'ANMF'].includes(type)) return false
      if (type === 'VP8X') {
        if (length !== 10 || bytes[data] & 2) return false
        canvasWidth = le24(bytes, data + 4) + 1; canvasHeight = le24(bytes, data + 7) + 1
        if (!validSize(canvasWidth, canvasHeight)) return false
      } else if (type === 'VP8 ') {
        if (length < 10 || bytes[data] & 1 || ascii(bytes, data + 3, 3) !== '\x9d\x01\x2a') return false
        width = (bytes[data + 6] + bytes[data + 7] * 256) & 0x3fff; height = (bytes[data + 8] + bytes[data + 9] * 256) & 0x3fff
      } else if (type === 'VP8L') {
        if (length < 5 || bytes[data] !== 0x2f || bytes[data + 4] >> 5) return false
        width = 1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8)
        height = 1 + (bytes[data + 2] >> 6) + (bytes[data + 3] << 2) + ((bytes[data + 4] & 15) << 10)
      }
      at = data + length + (length & 1)
    }
    return at === bytes.length && validSize(width, height) && (!canvasWidth || canvasWidth === width && canvasHeight === height)
  }

  /** Bounded readable raster bytes only; native decode is an additional saver gate.
   * @param {Response} response @param {AbortSignal} [signal] @returns {Promise<Response | null>} */
  async function readRaster(response, signal) {
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const declared = response.headers.get('content-length')
    if (response.type === 'opaque' || response.status !== 200 || response.headers.has('content-range') ||
      !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime) || !response.body ||
      declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limits.maxBytes)) {
      await response.body?.cancel().catch(() => {})
      return null
    }
    const reader = response.body.getReader(), chunks = []
    let total = 0, complete = false
    const aborted = () => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Carátula cancelada.', 'AbortError') }
    const abort = () => { void reader.cancel().catch(() => {}) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      aborted()
      while (true) {
        const part = await reader.read()
        aborted()
        if (part.done) { complete = true; break }
        total += part.value.byteLength
        if (total > limits.maxBytes) return null
        chunks.push(part.value)
      }
      if (!total) return null
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      if (!raster(bytes, mime)) return null
      return new Response(bytes, { headers: { 'content-type': mime, 'content-length': String(total),
        'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox" } })
    } finally {
      signal?.removeEventListener('abort', abort)
      if (!complete) await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  return { cacheName: 'pletina-cover-downloads:v1', root, normalize, key, local, parse, candidates, readRaster, limits }
}
)(ROOT)
const PREFIX = `pletina-pwa:${encodeURIComponent(ROOT.href)}:`
const CACHE = PREFIX + VERSION
// Audio separado de los archivos de la app: una actualización conserva las descargas.
const AUDIO_CACHE = 'pletina-audio-downloads:v1'
const AUDIO_DATABASE = 'pletina-web-downloads'
const audioPath = new URL('__audio__/', ROOT).pathname
const indexURL = new URL('index.html', ROOT).href
const required = new Map(FILES.map((file) => [new URL(file.url, ROOT).href, file]))
const assets = new Map([...FILES, ...OPTIONAL].map((file) => [new URL(file.url, ROOT).href, file]))
const coverPath = new URL('__covers__', ROOT).pathname

async function coveredImage(url) {
  const original = COVERS.parse(url)
  if (!original) return new Response('', { status: 404 })
  try {
    const cached = await (await caches.open(COVERS.cacheName)).match(COVERS.key(original))
    if (cached) {
      const raster = await COVERS.readRaster(cached)
      if (raster) return raster
    }
  } catch { /* Artwork must remain independent of audio/storage failures. */ }
  if (self.navigator?.onLine === false) return new Response('', { status: 404 })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    for (const candidate of COVERS.candidates(original)) {
      try {
        const response = await fetch(candidate, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal })
        const raster = await COVERS.readRaster(response, controller.signal)
        if (raster) return raster
      } catch { /* A readable original candidate can still follow a failed variant. */ }
      if (controller.signal.aborted) break
    }
  } finally { clearTimeout(timer) }
  // Unsupported/CORS-blocked art keeps its normal online image behaviour.
  // Never store or serve an opaque, SVG or HTML body under our own origin.
  return Response.redirect(original, 302)
}

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
  if (url.pathname === coverPath) {
    event.respondWith(coveredImage(url).catch(() => new Response('', { status: 404 })))
    return
  }
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
