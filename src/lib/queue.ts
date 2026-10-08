// Lo común a los dos reproductores: el de la interfaz (escritorio, player.svelte.ts) y el nativo
// de Android (player-android.svelte.ts).
import type { Track, TrackQuery } from './types'

/** Una canción en la cola, con lo necesario para mostrarla y buscarla. */
export interface QueueItem {
  track: Track
  albumId: number
  albumTitle: string
  artistId: number
  cover: string | null
}

export type Status = 'idle' | 'loading' | 'playing' | 'paused'
export type Repeat = 'off' | 'all' | 'one'

export function toQuery(item: QueueItem): TrackQuery {
  return {
    id: item.track.id,
    title: item.track.title,
    artist: item.track.artist.name,
    album: item.albumTitle,
    duration: item.track.duration,
  }
}

/** Orden de reproducción: en aleatorio, `first` primero y el resto barajado. */
export function playOrder(length: number, first: number, shuffle: boolean): number[] {
  const order = Array.from({ length }, (_, i) => i)
  if (!shuffle) return order
  const rest = order.filter((i) => i !== first)
  return [first, ...shuffled(rest)]
}

export function shuffled<T>(list: T[]): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function load<T>(key: string, fallback: T, valid: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key)
    const v = raw === null ? fallback : JSON.parse(raw)
    return valid(v) ? v : fallback
  } catch {
    return fallback
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Sin almacenamiento: vale para esta sesión.
  }
}

/** Lo que usan las pantallas de cualquiera de los dos reproductores. */
export interface PlayerApi {
  /** El disco o la playlist "de fondo", en su orden original. */
  readonly queue: QueueItem[]
  /** De dónde viene la cola (nombre del disco, de la playlist…). */
  readonly context: string
  /** Tu cola (DJ): suena antes de seguir con el disco o la playlist. */
  readonly userQueue: { key: number; item: QueueItem }[]
  readonly current: QueueItem | null
  readonly pos: number
  readonly hasNext: boolean
  readonly upcoming: { pos: number; item: QueueItem }[]
  status: Status
  time: number
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: Repeat
  /** Canción para la que está abierto el selector "¿No es esta canción?". */
  picking: QueueItem | null
  /** Interacción de captura de escritorio; Android no expone esa ventana. */
  readonly captureInteraction: string | null
  openCapture(): Promise<void>
  retryCapture(): void
  /** Diagnóstico HTMLAudio del banco de escritorio; no disponible en Android. */
  readonly playbackAudio: HTMLAudioElement
  readonly playbackSource: { trackId: number; videoId: string; kind: 'capture' | 'capture-legacy' | 'local' | 'network' } | null
  readonly preparedAudio: HTMLAudioElement | null
  readonly preparedAudios: { trackId: number; slot: 0 | 1; audio: HTMLAudioElement }[]
  playAt(pos: number): void
  playQueue(items: QueueItem[], start: number, context?: string): void
  addToQueue(items: QueueItem[]): void
  playNext(items: QueueItem[]): void
  insertInQueue(items: QueueItem[], at: number): void
  removeFromQueue(key: number): void
  moveInQueue(key: number, to: number): void
  clearQueue(): void
  playFromQueue(key: number): void
  toggle(): void
  next(): void
  prev(): void
  seek(seconds: number): void
  setVolume(v: number): void
  toggleMute(): void
  toggleShuffle(): void
  cycleRepeat(): void
  useSource(videoId: string, item?: QueueItem | null, onError?: (message: string) => void): Promise<boolean>
}
