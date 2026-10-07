// Motor propio, nivel garantizado: suena lo que el reproductor oficial de YouTube Music (en una
// ventana oculta) le entrega al navegador. Rust lo guarda (src-tauri/src/capture.rs) y aquí se va
// metiendo en el `<audio>` con Media Source a medida que llega.
import { invoke } from '@tauri-apps/api/core'

/** URL que da Rust cuando el audio sale del reproductor oficial. */
export const CAPTURE = 'musify-capture-legacy:'

interface Frame {
  mime: string
  /** Formato de cada trozo (cambia si YouTube elige otro al rehacer la ventana). */
  mimes: string[]
  duration: number | null
  done: boolean
  error: string | null
  next: number
  generation?: number
  chunks: Uint8Array[]
}

/** Trozos capturados a partir de `from` (si aún no hay, Rust espera un poco). */
async function read(videoId: string, from: number): Promise<Frame> {
  const buf = await invoke<ArrayBuffer>('capture_legacy_read', { videoId, from })
  const view = new DataView(buf)
  const size = view.getUint32(0, true)
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, size)))
  const chunks: Uint8Array[] = []
  for (let at = 4 + size; at < buf.byteLength; ) {
    const n = view.getUint32(at, true)
    chunks.push(new Uint8Array(buf, at + 4, n))
    at += 4 + n
  }
  return { ...head, chunks }
}

const idle = (sb: SourceBuffer) =>
  sb.updating ? new Promise<void>((r) => sb.addEventListener('updateend', () => r(), { once: true })) : Promise.resolve()

/** Mete un trozo; si el navegador no tiene sitio, suelta lo que ya sonó y lo vuelve a intentar. */
async function append(sb: SourceBuffer, audio: HTMLAudioElement, chunk: Uint8Array, stopped: () => boolean) {
  for (;;) {
    await idle(sb)
    try {
      sb.appendBuffer(chunk as Uint8Array<ArrayBuffer>)
      return
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'QuotaExceededError') || stopped()) throw e
      const keep = audio.currentTime - 20
      if (keep > 0) {
        sb.remove(0, keep)
        await idle(sb)
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

/** ¿Hay audio en `at` (o justo después)? */
const covered = (sb: SourceBuffer, at: number) => {
  for (let i = 0; i < sb.buffered.length; i++) if (sb.buffered.start(i) <= at + 0.5 && at < sb.buffered.end(i)) return true
  return false
}

/** Hasta dónde hay audio seguido desde `at`. */
const coveredUntil = (sb: SourceBuffer, at: number) => {
  for (let i = 0; i < sb.buffered.length; i++) if (sb.buffered.start(i) <= at + 0.5 && at < sb.buffered.end(i)) return sb.buffered.end(i)
  return at
}

/** Reproduce en `audio` lo capturado de una canción mientras llega. Devuelve cómo dejar de alimentarlo. */
export function playLegacyCapture(audio: HTMLAudioElement, videoId: string): () => void {
  const ms = new MediaSource()
  let stopped = false
  let generation: number | undefined
  let sbRef: SourceBuffer | null = null
  // Salto a una parte que aún no se ha capturado: que el reproductor oficial vaya ahí.
  const onSeeking = () => {
    if (sbRef && !covered(sbRef, audio.currentTime))
      invoke('capture_legacy_seek', { videoId, at: Math.max(0, audio.currentTime - 1), generation }).catch(() => {})
  }
  audio.addEventListener('seeking', onSeeking)
  const onError = () => console.warn('[captura]', videoId, 'error de audio', audio.error?.code, audio.error?.message)
  audio.addEventListener('error', onError)
  audio.src = URL.createObjectURL(ms)
  ms.addEventListener(
    'sourceopen',
    async () => {
      URL.revokeObjectURL(audio.src)
      let sb: SourceBuffer | null = null
      let mime = ''
      let from = 0
      // Sin duración, el navegador toma la de lo que lleva cargado: se pone la real en cuanto llega.
      let duration = 0
      // Hueco ya pedido (para no pedir el mismo una y otra vez).
      let resumedAt = -1
      try {
        while (!stopped) {
          const f = await read(videoId, from)
          if (stopped) return
          if (Number.isSafeInteger(f.generation)) generation = f.generation
          if (f.error) throw new Error(f.error)
          if (!sb && f.mime) {
            mime = f.mimes[0] || f.mime
            sbRef = sb = ms.addSourceBuffer(mime)
          }
          // Solo hacia arriba: al rehacer la ventana, YouTube puede dar una duración unas
          // centésimas menor, y el navegador no deja bajarla por debajo de lo ya cargado.
          if (sb && f.duration && f.duration > duration) {
            await idle(sb)
            duration = f.duration
            try {
              ms.duration = duration
            } catch {
              // Lo cargado ya llega más lejos: se queda la del navegador.
            }
          }
          for (const [i, c] of f.chunks.entries()) {
            const m = f.mimes[i]
            if (m && m !== mime) {
              await idle(sb!)
              sb!.changeType(m)
              mime = m
            }
            await append(sb!, audio, c, () => stopped)
          }
          from = f.next
          if (f.done && !f.chunks.length && sb) {
            await idle(sb)
            // ¿Falta algo hasta el final? (YouTube pasó a otra canción antes de tiempo, o hubo un salto.)
            const until = coveredUntil(sb, audio.currentTime)
            if (duration && until < duration - 1.5 && until > resumedAt + 1) {
              resumedAt = until
              console.info('[captura]', videoId, 'hueco: se pide desde', until.toFixed(1), 'de', duration)
              await invoke('capture_legacy_seek', { videoId, at: Math.max(0, until - 1), generation }).catch(() => {})
              continue
            }
            if (ms.readyState === 'open') ms.endOfStream()
            return
          }
        }
      } catch (e) {
        console.warn('[captura]', videoId, 'no se pudo seguir alimentando el audio:', String(e))
        if (!stopped && ms.readyState === 'open') ms.endOfStream('network')
      }
    },
    { once: true },
  )
  return () => {
    if (stopped) return
    stopped = true
    audio.removeEventListener('seeking', onSeeking)
    audio.removeEventListener('error', onError)
    if (generation !== undefined) void invoke('capture_legacy_cancel', { videoId, generation }).catch(() => {})
  }
}

