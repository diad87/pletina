/**
 * Shared by the UI, downloader and the classic worker (the build embeds this
 * self-contained factory). Keys are absolute local URLs naming canonical image
 * families; local() retains the requested permanent URL for online fallback.
 * @param {string | URL} rootURL
 */
export default function coverRouting(rootURL) {
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
