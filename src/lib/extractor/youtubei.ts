// Motor youtubei.js: lo mismo que `YtDlp::stream` (URL del audio, título, canal y duración)
// sin programas externos. Se carga solo si se elige este motor.
import { Innertube, Platform, Player, UniversalCache } from 'youtubei.js'
import type { Types } from 'youtubei.js'
import EvalWorker from './eval.worker?worker'
import { rustFetch } from './fetch'

export interface StreamInfo {
  url: string
  title: string
  channel: string | null
  duration: number | null
  /** Datos para comparar motores. */
  client: string
  itag: number
  mime: string
  bitrate: number
}

/**
 * Clientes de YouTube a probar, en orden. Hoy (octubre de 2026) solo VISIONOS da audio que suena
 * entero sin PO token, y es también el que usa yt-dlp; los demás dan 403 pasado el primer MB, no dan
 * URLs (solo SABR) o rechazan el vídeo. Ver la sección P1 de PLAN.md.
 */
export const CLIENTS: Types.InnerTubeClient[] = ['VISIONOS']

/** Clientes de app nativa: sus URLs no llevan firma ni `n`, no necesitan el reproductor de YouTube. */
const NATIVE: Types.InnerTubeClient[] = ['VISIONOS', 'IOS', 'ANDROID_VR']

/** Tiempos internos, para las mediciones. */
export const stats = { sessionMs: 0, playerMs: 0, evals: 0, evalMs: 0 }

// --- Evaluador: el código del reproductor de YouTube corre en un worker ---
let worker: Worker | null = null
let nextId = 0
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function evaluate(code: string): Promise<unknown> {
  if (!worker) {
    worker = new EvalWorker()
    worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const w = waiting.get(e.data.id)
      waiting.delete(e.data.id)
      if (e.data.error !== undefined) w?.reject(new Error(e.data.error))
      else w?.resolve(e.data.result)
    }
  }
  const id = ++nextId
  const t = performance.now()
  return new Promise<unknown>((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    worker!.postMessage({ id, code })
  }).finally(() => {
    stats.evals++
    stats.evalMs += performance.now() - t
  })
}

Platform.load({ ...Platform.shim, eval: (data) => evaluate(data.output) as Promise<Types.EvalResult> })

// --- Sesión: se crea una vez, sin el reproductor de YouTube (VISIONOS no lo necesita) ---
let session: Promise<Innertube> | null = null
let player: Promise<Player> | null = null

export function innertube(): Promise<Innertube> {
  if (!session) {
    const t = performance.now()
    session = Innertube.create({
      fetch: rustFetch,
      cache: new UniversalCache(true),
      retrieve_player: false,
    }).then((yt) => {
      stats.sessionMs = performance.now() - t
      return yt
    })
    // Si falla (p. ej. sin conexión), se vuelve a intentar en la siguiente llamada.
    session.catch(() => (session = null))
  }
  return session
}

/**
 * El reproductor de YouTube (~2,5 MB de JavaScript) solo hace falta con clientes web: YouTube les
 * pide su `signatureTimestamp` y sus URLs llevan firma o parámetro `n`. Se baja la primera vez y
 * queda en IndexedDB hasta que YouTube lo cambie.
 */
function loadPlayer(yt: Innertube): Promise<Player> {
  if (!player) {
    const t = performance.now()
    player = Player.create(yt.session.cache, rustFetch).then((p) => {
      stats.playerMs = performance.now() - t
      yt.session.player = p
      return p
    })
    player.catch(() => (player = null))
  }
  return player
}

/** URL del audio de un vídeo: webm/opus si lo hay y si no m4a, del primer cliente que funcione. */
export async function stream(videoId: string, clients = CLIENTS): Promise<StreamInfo> {
  const yt = await innertube()
  let lastError: unknown = new Error('Sin clientes')
  for (const client of clients) {
    try {
      if (!NATIVE.includes(client)) await loadPlayer(yt)
      const info = await yt.getBasicInfo(videoId, { client })
      const ps = info.playability_status
      if (ps?.status !== 'OK') throw new Error(`${ps?.status}: ${ps?.reason ?? 'no disponible'}`)
      const format = pickAudio(info.streaming_data?.adaptive_formats ?? [])
      if (!format) throw new Error('No hay audio con URL (¿solo SABR?)')
      const ciphered = !!(format.signature_cipher || format.cipher || new URL(format.url!).searchParams.has('n'))
      const url = await format.decipher(ciphered ? await loadPlayer(yt) : undefined)
      return {
        url,
        title: info.basic_info.title ?? '',
        channel: info.basic_info.author ?? info.basic_info.channel?.name ?? null,
        duration: info.basic_info.duration ?? null,
        client,
        itag: format.itag,
        mime: format.mime_type,
        bitrate: format.bitrate,
      }
    } catch (e) {
      lastError = e
    }
  }
  throw lastError
}

type Format = NonNullable<Awaited<ReturnType<Innertube['getBasicInfo']>>['streaming_data']>['adaptive_formats'][number]

/** Solo audio, con URL, sin compresión de rango dinámico y en el idioma original; opus antes que m4a. */
function pickAudio(formats: Format[]): Format | undefined {
  const ok = formats.filter(
    (f) =>
      f.has_audio &&
      !f.has_video &&
      !f.is_type_otf &&
      !f.is_drc &&
      (f.url || f.signature_cipher || f.cipher) &&
      (!f.audio_track || f.audio_track.audio_is_default || f.is_original),
  )
  const rank = (f: Format) => (f.mime_type.startsWith('audio/webm') ? 1 : 0)
  return ok.sort((a, b) => rank(b) - rank(a) || b.bitrate - a.bitrate)[0]
}
