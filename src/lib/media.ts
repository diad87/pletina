import { convertFileSrc } from '@tauri-apps/api/core'
import { inPwa, inTauri } from './api'
import coverRouting from '../../pwa/cover-routing.mjs'

/** Los ids de la música local empiezan aquí (ver LOCAL_BASE en src-tauri/src/local.rs). */
export const LOCAL_BASE = 1_000_000_000_000_000

/** Podcasts y episodios guardados desde RSS (ver src-tauri/src/podcasts.rs). */
export const PODCAST_BASE = 500_000_000_000_000

/** Canciones independientes de YouTube (ver youtube_tracks.rs). */
export const YOUTUBE_BASE = 250_000_000_000_000
export const isYouTubeTrack = (id: number) => id >= YOUTUBE_BASE && id < PODCAST_BASE

export const isLocal = (id: number) => id >= LOCAL_BASE
export const isPodcast = (id: number) => id >= PODCAST_BASE && id < LOCAL_BASE

/** The shipped manifest is at the PWA root, independently of the app HTML path. */
function webCoverRouting() {
  const current = new URL(window.location.href)
  const manifest = typeof document === 'undefined' ? null : document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
  if (manifest?.href) {
    try {
      const url = new URL(manifest.href, current)
      if (url.origin === current.origin && url.pathname.endsWith('/manifest.webmanifest')) return coverRouting(new URL('./', url))
    } catch { /* Use the current controller, or the known app document layout. */ }
  }
  if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller?.scriptURL) {
    const script = new URL(navigator.serviceWorker.controller.scriptURL)
    if (script.origin === current.origin) return coverRouting(new URL('./', script))
  }
  return coverRouting(new URL(current.pathname.includes('/application/') ? '../' : './', current))
}

/**
 * URL que puede mostrar la interfaz: las imágenes de internet tal cual, y los archivos del equipo
 * (carátulas de la música local) por el protocolo de archivos locales de la app.
 */
export function mediaUrl(src: string | null | undefined): string | null {
  if (!src) return null
  if (inPwa && /^https:/i.test(src)) {
    try {
      const routing = webCoverRouting()
      const value = new URL(src)
      if (value.origin === routing.root.origin && value.pathname === new URL('__covers__', routing.root).pathname) return routing.parse(src) ? src : null
      return routing.local(src) ?? src
    } catch { return src }
  }
  if (/^(https?:|data:|blob:|asset:)/.test(src) || !inTauri) return src
  return convertFileSrc(src)
}
