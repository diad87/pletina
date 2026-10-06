// Color dominante de una carátula, para teñir la interfaz (como Spotify).
// El servidor de imágenes de Deezer permite leer los píxeles (CORS abierto).

import { mediaUrl } from './media'

const cache = new Map<string, Promise<string>>()
export const FALLBACK_COLOR = '#3a2f5c'

/** Versión pequeña (56 px) de una imagen de Deezer: carga al momento. */
function small(url: string) {
  return url.replace(/\/\d+x\d+-/, '/56x56-')
}

/** Color "vivo" de la imagen, ya oscurecido para servir de fondo con texto blanco encima. */
export function coverColor(url: string | null | undefined): Promise<string> {
  if (!url) return Promise.resolve(FALLBACK_COLOR)
  let hit = cache.get(url)
  if (!hit) {
    hit = extract(mediaUrl(small(url)) ?? url).catch(() => FALLBACK_COLOR)
    cache.set(url, hit)
  }
  return hit
}

function extract(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onerror = reject
    img.onload = () => {
      const size = 24
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return reject(new Error('sin canvas'))
      ctx.drawImage(img, 0, 0, size, size)
      resolve(pick(ctx.getImageData(0, 0, size, size).data))
    }
    img.src = url
  })
}

/** Agrupa los píxeles por tono y se queda con el grupo más abundante y saturado. */
function pick(data: Uint8ClampedArray): string {
  const buckets = new Map<number, { r: number; g: number; b: number; n: number; weight: number }>()
  let avg = { r: 0, g: 0, b: 0, n: 0 }
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
    avg = { r: avg.r + r, g: avg.g + g, b: avg.b + b, n: avg.n + 1 }
    const [h, s, l] = hsl(r, g, b)
    if (s < 0.2 || l < 0.12 || l > 0.9) continue
    const key = Math.round(h * 12) % 12
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0, weight: 0 }
    bucket.r += r
    bucket.g += g
    bucket.b += b
    bucket.n++
    // Más peso a lo saturado y de luminosidad media.
    bucket.weight += s * (1 - Math.abs(l - 0.5))
    buckets.set(key, bucket)
  }
  const best = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0]
  const src = best && best.n > 8 ? best : avg
  const [h, s, l] = hsl(src.r / src.n, src.g / src.n, src.b / src.n)
  // Oscurecer y moderar la saturación para que el texto blanco se lea siempre bien.
  return `hsl(${Math.round(h * 360)} ${Math.round(Math.min(s, 0.5) * 100)}% ${Math.round(Math.min(Math.max(l, 0.22), 0.32) * 100)}%)`
}

function hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}
