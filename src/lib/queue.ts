// Lo común a los dos reproductores: el de la interfaz (escritorio, player.svelte.ts) y el nativo
// de Android (player-android.svelte.ts).
import type { Track, TrackQuery } from './types'
import type { SleepTimerState } from './sleep-timer'

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
    isrc: item.track.isrc ?? null,
    titleVersion: item.track.titleVersion ?? null,
  }
}

/** `first = null`: empieza al azar en aleatorio; un índice explícito siempre va primero. */
export function playOrder(length: number, first: number | null, shuffle: boolean): number[] {
  const order = Array.from({ length }, (_, i) => i)
  if (!shuffle || !length) return order
  const start = first ?? Math.floor(Math.random() * length)
  const rest = order.filter((i) => i !== start)
  return [start, ...shuffled(rest)]
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
  readonly hasNext: boolean
  readonly upcoming: { pos: number; item: QueueItem }[]
  status: Status
  /** Reintento automático de audio de la PWA (1–2); 0 o ausente fuera de una carga. */
  readonly audioRetry?: number
  time: number
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: Repeat
  readonly sleepTimer: SleepTimerState
  /** 0: cancelar; -1: al terminar; 1–1440: minutos desde ahora, también durante las pausas. */
  setSleepTimer(minutes: number): Promise<boolean>
  /** Canción para la que está abierto el selector "¿No es esta canción?". */
  picking: QueueItem | null
  playAt(pos: number): void
  /** `start = null` reproduce la colección según el modo; un índice elige esa canción. */
  playQueue(items: QueueItem[], start: number | null, context?: string): void
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
  useSource(videoId: string, item?: QueueItem | null): Promise<boolean>
}
