type AudioStatus = 'paused' | 'playing' | 'loading' | 'ended' | 'error'
interface AudioLogEntry { at: number; type: string; time: number; status: AudioStatus }
const KEY = 'pletina:web:audio-log:v1'
const LIMIT = 256
const TYPES = new Set(['source', 'loadstart', 'loadedmetadata', 'durationchange', 'canplay', 'playing', 'pause', 'ended',
  'stalled', 'suspend', 'waiting', 'error', 'seeking', 'seeked', 'abort', 'emptied', 'timeupdate'])
const STATUSES = new Set<AudioStatus>(['paused', 'playing', 'loading', 'ended', 'error'])
let entries: AudioLogEntry[] | undefined
let lastSample = -Infinity

function rows(): AudioLogEntry[] {
  if (entries) return entries
  entries = []
  try {
    const raw = localStorage.getItem(KEY)
    const saved: unknown = raw && raw.length <= 65536 ? JSON.parse(raw) : []
    if (Array.isArray(saved)) for (const row of saved.slice(-LIMIT)) {
      if (!row || typeof row !== 'object' || !TYPES.has(row.type) || !STATUSES.has(row.status) ||
        !Number.isFinite(row.at) || row.at < 0 || !Number.isFinite(row.time) || row.time < 0) continue
      // Reconstruir los únicos campos permitidos también al leer almacenamiento antiguo.
      entries.push({ at: row.at, type: row.type, time: row.time, status: row.status })
    }
  } catch { /* El registro sigue en RAM si el navegador no permite persistencia. */ }
  return entries
}

/** Solo estados del medio. No aceptar títulos, IDs, URLs, errores de texto ni datos de red. */
export function recordAudioEvent(type: string, audio: HTMLAudioElement): void {
  if (!TYPES.has(type)) return
  const at = Date.now()
  if (type === 'timeupdate') {
    if (at - lastSample < 10000) return
    lastSample = at
  }
  const status: AudioStatus = audio.error ? 'error' : audio.ended ? 'ended' : audio.paused ? 'paused'
    : audio.readyState < 3 ? 'loading' : 'playing'
  const value = rows()
  value.push({ at, type, time: Number.isFinite(audio.currentTime) && audio.currentTime >= 0 ? Math.round(audio.currentTime * 1000) / 1000 : 0, status })
  if (value.length > LIMIT) value.splice(0, value.length - LIMIT)
  try { localStorage.setItem(KEY, JSON.stringify(value)) } catch { /* Registro acotado en RAM. */ }
}

export function readWebLog() {
  return { format: 'pletina-web-audio-log', version: 1, generatedAt: new Date().toISOString(), events: rows().map((row) => ({ ...row })) }
}

/** El usuario elige el destino en Compartir; si no hay soporte, obtiene el JSON local. */
export async function shareWebLog(): Promise<void> {
  const name = 'pletina-audio-' + new Date().toISOString().slice(0, 10) + '.json'
  const file = new File([JSON.stringify(readWebLog(), null, 2)], name, { type: 'application/json' })
  try {
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Registro de audio de Pletina' })
      return
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
  }
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  ;(document.body || document.documentElement).append(link)
  try { link.click() } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000) }
}
