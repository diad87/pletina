import { convertFileSrc } from '@tauri-apps/api/core'
import { inTauri } from './api'

/** Los ids de la música local empiezan aquí (ver LOCAL_BASE en src-tauri/src/local.rs). */
export const LOCAL_BASE = 1_000_000_000_000_000

export const isLocal = (id: number) => id >= LOCAL_BASE

/**
 * URL que puede mostrar la interfaz: las imágenes de internet tal cual, y los archivos del equipo
 * (carátulas de la música local) por el protocolo de archivos locales de la app.
 */
export function mediaUrl(src: string | null | undefined): string | null {
  if (!src) return null
  if (/^(https?:|data:|blob:|asset:)/.test(src) || !inTauri) return src
  return convertFileSrc(src)
}
