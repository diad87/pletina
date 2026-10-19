import type { QueueItem, Repeat } from '../src/lib/queue'

export const WEB_QUEUE_KEY = 'pletina:web:queue:v1'
const MAX_ITEMS = 10_000
const MAX_BYTES = 2 * 1024 * 1024
const MAX_TIME = 31 * 24 * 60 * 60
export type QueueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export interface WebQueueSnapshot {
  version: 1
  savedAt: number
  queue: QueueItem[]
  order: number[]
  pos: number
  context: string
  userQueue: { key: number; item: QueueItem }[]
  manual: QueueItem | null
  position: number
  duration: number
  repeat: Repeat
  shuffle: boolean
  recorded: boolean
}

const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cola no válida')
  return value as Record<string, unknown>
}
const integer = (value: unknown, minimum = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('Índice de cola no válido')
  return value
}
const seconds = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_TIME) throw new Error('Posición de cola no válida')
  return value
}
const text = (value: unknown, maximum = 4000): string => {
  if (typeof value !== 'string' || value.length > maximum) throw new Error('Metadatos de cola no válidos')
  return value
}
const flag = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('Estado de cola no válido')
  return value
}
function cover(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com')
      || [...url.searchParams.keys()].some(key => /^(?:sig|lsig|signature|token|access_token|authorization|expires?|policy|key-pair-id|x-amz-(?:signature|credential)|x-goog-(?:signature|credential))$/i.test(key))) return null
    return url.href
  } catch { return null }
}
function item(value: unknown): QueueItem {
  const source = row(value), track = row(source.track), artist = row(track.artist)
  // Only catalog metadata. Playable, stream URL, native path and all unknown fields
  // are excluded; even optional artwork must be a permanent metadata address.
  return {
    track: {
      id: integer(track.id, 1), title: text(track.title), duration: seconds(track.duration),
      artist: { id: integer(artist.id), name: text(artist.name) },
      titleVersion: track.titleVersion == null ? null : text(track.titleVersion),
      trackPosition: integer(track.trackPosition ?? 0), diskNumber: integer(track.diskNumber ?? 1),
      explicitLyrics: flag(track.explicitLyrics ?? false), isrc: track.isrc == null ? null : text(track.isrc, 100),
    },
    albumId: integer(source.albumId), albumTitle: text(source.albumTitle), artistId: integer(source.artistId), cover: cover(source.cover),
  }
}

/** Reject corrupt snapshots as one unit: never reorder or silently drop queue entries. */
export function normalizeWebQueue(value: unknown): WebQueueSnapshot {
  const source = row(value)
  if (source.version !== 1 || !Array.isArray(source.queue) || !Array.isArray(source.order) || !Array.isArray(source.userQueue)
    || source.queue.length + source.userQueue.length + (source.manual == null ? 0 : 1) > MAX_ITEMS) throw new Error('Versión o tamaño de cola no válido')
  const queue = source.queue.map(item)
  const order = source.order.map(value => integer(value))
  if (order.length !== queue.length || new Set(order).size !== order.length || order.some(index => index >= queue.length)) throw new Error('Orden de cola no válido')
  const pos = queue.length ? integer(source.pos) : -1
  if (queue.length ? pos >= queue.length : source.pos !== -1) throw new Error('Cursor de cola no válido')
  const userQueue = source.userQueue.map(value => {
    const entry = row(value), key = integer(entry.key, 1)
    if (key >= Number.MAX_SAFE_INTEGER) throw new Error('Clave de cola no válida')
    return { key, item: item(entry.item) }
  })
  if (new Set(userQueue.map(value => value.key)).size !== userQueue.length) throw new Error('Claves de cola duplicadas')
  const manual = source.manual == null ? null : item(source.manual)
  if (!manual && !queue.length && userQueue.length) throw new Error('Cola sin canción actual')
  if (source.repeat !== 'off' && source.repeat !== 'all' && source.repeat !== 'one') throw new Error('Repetición no válida')
  const duration = seconds(source.duration), position = seconds(source.position)
  return {
    version: 1, savedAt: integer(source.savedAt), queue, order, pos, context: text(source.context), userQueue, manual,
    position: manual || queue.length ? duration > 0 ? Math.min(position, duration) : position : 0,
    duration: manual || queue.length ? duration : 0,
    repeat: source.repeat, shuffle: flag(source.shuffle), recorded: flag(source.recorded),
  }
}

export function readWebQueue(storage: QueueStorage | undefined): WebQueueSnapshot | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(WEB_QUEUE_KEY)
    if (raw === null) return null
    if (raw.length > MAX_BYTES || new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error('Cola demasiado grande')
    return normalizeWebQueue(JSON.parse(raw))
  } catch {
    try { storage.removeItem(WEB_QUEUE_KEY) } catch { /* Storage may be unavailable. */ }
    return null
  }
}

/** Synchronous durability point, called after playback's handoff or on pagehide. */
export function writeWebQueue(storage: QueueStorage | undefined, value: unknown): boolean {
  if (!storage) return false
  try {
    const raw = JSON.stringify(normalizeWebQueue(value))
    if (new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error('Cola demasiado grande')
    storage.setItem(WEB_QUEUE_KEY, raw)
    return true
  } catch {
    // An old queue must not reappear after a newer queue could not be saved.
    try { storage.removeItem(WEB_QUEUE_KEY) } catch { /* Keep in-memory playback working. */ }
    return false
  }
}
