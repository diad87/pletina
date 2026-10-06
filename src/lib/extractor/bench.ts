// P1: compara los motores dentro de la app (tiempos, si suena en <audio> y si YouTube corta el
// audio a mitad). Se lanza con MUSIFY_BENCH=plan.json.
import { invoke } from '@tauri-apps/api/core'
import * as api from '../api'
import { player, type QueueItem } from '../player.svelte'
import { playCapture } from './capture'
import { extractor, type Engine } from './engine.svelte'
import { host } from './host'
import { CLIENTS, innertube, setup, stats, stream } from './youtubei'

interface Plan {
  videos: { id: string; label: string; duration: number }[]
  /** Probar cada cliente de YouTube con los primeros `count` vídeos. */
  survey?: { clients: string[]; count: number }
  /** youtubei.js (con su orden de clientes) con todos los vídeos. */
  full?: boolean
  /** yt-dlp con todos los vídeos. */
  ytdlp?: boolean
  /** Medir yt-dlp antes que youtubei.js (para ver si el orden influye). */
  ytdlpFirst?: boolean
  /** Comprobar que cada URL suena en un <audio> (y que se puede saltar al 80 %). */
  audio?: boolean
  /** Motor propio, nivel rápido (Rust), con todos los vídeos. */
  tier1?: boolean
  /** Motor propio, nivel garantizado (reproductor oficial en la ventana oculta), con los primeros `count`. */
  tier2?: { count: number }
  /** Reproducir canciones de verdad con el reproductor de la app y el motor indicado. */
  e2e?: E2E | E2E[]
}

type E2E = { query: string; tracks: number; engine?: Engine }

type Probe = { length: number; start: number; deep: number }
type AudioCheck = { ok: boolean; startMs?: number; playMs?: number; seekMs?: number; duration?: number; error?: string }

const logs: string[] = []

export async function runBench(plan: Plan) {
  // Se mide el youtubei.js que trae la app.
  setup(host)
  const restore = captureLogs()
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    clients: CLIENTS,
  }
  try {
    if (plan.full || plan.survey) {
      const t = performance.now()
      await innertube()
      report.session = { ms: Math.round(performance.now() - t), innerMs: Math.round(stats.sessionMs) }
    }

    if (plan.survey) {
      const rows = []
      for (const client of plan.survey.clients)
        for (const v of plan.videos.slice(0, plan.survey.count)) rows.push({ client, ...(await viaYoutubei(v.id, plan, [client])) })
      report.survey = rows
    }
    const steps = [
      async () => {
        if (!plan.full) return
        const rows = []
        for (const v of plan.videos) rows.push({ label: v.label, ...(await viaYoutubei(v.id, plan)) })
        report.youtubei = rows
      },
      async () => {
        if (!plan.ytdlp) return
        const rows = []
        for (const v of plan.videos) rows.push({ label: v.label, ...(await viaYtdlp(v.id, plan)) })
        report.ytdlp = rows
      },
    ]
    if (plan.ytdlpFirst) steps.reverse()
    for (const step of steps) await step()
    if (plan.tier1) {
      const rows = []
      for (const v of plan.videos) rows.push({ label: v.label, ...(await viaNative(v.id, plan)) })
      report.tier1 = rows
    }
    if (plan.tier2) {
      const rows = []
      for (const v of plan.videos.slice(0, plan.tier2.count)) rows.push({ label: v.label, ...(await viaCapture(v.id)) })
      report.tier2 = rows
    }
    if (plan.e2e) {
      const runs = []
      for (const e of [plan.e2e].flat()) runs.push(await endToEnd(e))
      report.e2e = runs
    }
    report.engineStats = await extractor.stats().catch(() => null)
  } catch (e) {
    report.fatal = String(e)
  } finally {
    restore()
  }
  report.stats = { ...stats, evalAvgMs: stats.evals ? Math.round(stats.evalMs / stats.evals) : 0 }
  report.logs = logs
  await invoke('bench_report', { report })
}

async function viaYoutubei(videoId: string, plan: Plan, clients?: string[]) {
  const t = performance.now()
  try {
    const s = await stream(videoId, clients as never)
    const ms = Math.round(performance.now() - t)
    return { videoId, ok: true, ms, client: s.client, itag: s.itag, mime: s.mime, ...(await check(s.url, plan)) }
  } catch (e) {
    return { videoId, ok: false, ms: Math.round(performance.now() - t), error: String(e) }
  }
}

async function viaYtdlp(videoId: string, plan: Plan) {
  try {
    const r = await invoke<{ ms: number; url: string }>('bench_ytdlp', { videoId })
    const q = new URL(r.url).searchParams
    return { videoId, ok: true, ms: r.ms, client: q.get('c'), itag: Number(q.get('itag')), mime: q.get('mime'), ...(await check(r.url, plan)) }
  } catch (e) {
    return { videoId, ok: false, error: String(e) }
  }
}

async function viaNative(videoId: string, plan: Plan) {
  try {
    const r = await invoke<{ ms: number; url: string; client: string; itag: number; mime: string }>('bench_native', { videoId })
    return { videoId, ok: true, ms: r.ms, client: r.client, itag: r.itag, mime: r.mime, ...(await check(r.url, plan)) }
  } catch (e) {
    return { videoId, ok: false, error: String(e) }
  }
}

/** Nivel garantizado: hasta que llega audio, que suene, que se pueda saltar al 80 % y cuánto tarda en estar entera. */
async function viaCapture(videoId: string) {
  try {
    const r = await invoke<{ ms: number; title: string }>('bench_capture', { videoId })
    const audio = await playCheck(videoId, true)
    let status: Record<string, unknown> | null = null
    const t = performance.now()
    while (performance.now() - t < 90000) {
      status = await invoke<Record<string, unknown> | null>('capture_status', { videoId })
      if (status?.doneMs || status?.error) break
      await new Promise((res) => setTimeout(res, 500))
    }
    return { videoId, ok: true, ms: r.ms, title: r.title, audio, status }
  } catch (e) {
    return { videoId, ok: false, error: String(e) }
  }
}

async function check(url: string, plan: Plan): Promise<{ probe: Probe | string; audio?: AudioCheck }> {
  const probe = await invoke<Probe>('bench_probe', { url }).catch((e) => String(e))
  return { probe, audio: plan.audio ? await playCheck(url) : undefined }
}

/** Que suene en un <audio> (en silencio) y que se pueda saltar al 80 % y siga sonando. */
async function playCheck(url: string, capture = false): Promise<AudioCheck> {
  const a = new Audio()
  a.muted = true
  a.preload = 'auto'
  const t0 = performance.now()
  let stop = () => {}
  try {
    if (capture) stop = playCapture(a, url)
    else a.src = url
    await Promise.all([until(a, 'playing', 15000), a.play()])
    const startMs = Math.round(performance.now() - t0)
    await progress(a, 0.5)
    const playMs = Math.round(performance.now() - t0)
    const t1 = performance.now()
    a.currentTime = a.duration * 0.8
    await until(a, 'seeked', capture ? 60000 : 15000)
    await progress(a, 0.5)
    return { ok: true, startMs, playMs, seekMs: Math.round(performance.now() - t1), duration: Math.round(a.duration) }
  } catch (e) {
    return { ok: false, error: String(e) }
  } finally {
    stop()
    a.pause()
    a.removeAttribute('src')
    a.load()
  }
}

function until(a: HTMLAudioElement, event: string, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sin '${event}' en ${ms} ms`)), ms)
    a.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true })
    a.addEventListener('error', () => (clearTimeout(timer), reject(new Error(`error de audio ${a.error?.code}: ${a.error?.message}`))), {
      once: true,
    })
  })
}

/** Espera a que el audio avance `seconds` desde donde está. */
async function progress(a: HTMLAudioElement, seconds: number) {
  const from = a.currentTime
  const deadline = performance.now() + 10000
  while (a.currentTime < from + seconds) {
    if (a.error) throw new Error(`error de audio ${a.error.code}: ${a.error.message}`)
    if (performance.now() > deadline) throw new Error(`no avanza (se quedó en ${a.currentTime.toFixed(1)} s)`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Canciones de verdad con el reproductor de la app (volumen a 0) y el motor indicado. */
async function endToEnd({ query, tracks, engine = 'youtubei' }: { query: string; tracks: number; engine?: Engine }) {
  const found = await api.search(query)
  const album = await api.album(found.albums[0].id)
  const items: QueueItem[] = album.tracks.slice(0, tracks).map((track) => ({
    track,
    albumId: album.id,
    albumTitle: album.title,
    artistId: album.artist.id,
    cover: album.coverBig,
  }))
  const volume = player.volume
  player.setVolume(0)
  await extractor.set(engine)
  const before = { served: extractor.served, failed: extractor.failed }
  const rows = []
  player.playQueue(items, 0)
  for (let i = 0; i < items.length; i++) {
    const t = performance.now()
    let startMs = -1
    let ok = true
    while (!(player.current?.track.id === items[i].track.id && player.status === 'playing' && player.time > 1)) {
      if (startMs < 0 && player.current?.track.id === items[i].track.id && player.status === 'playing')
        startMs = Math.round(performance.now() - t)
      if (performance.now() - t > 60000) {
        ok = false
        break
      }
      await new Promise((r) => setTimeout(r, 25))
    }
    rows.push({ title: items[i].track.title, ok, msToPlaying: startMs, msToOneSecond: Math.round(performance.now() - t) })
    // La siguiente se pide tras unos segundos sonando, como pasaría de verdad (le da tiempo a la precarga).
    if (i < items.length - 1) {
      await new Promise((r) => setTimeout(r, 4000))
      player.next()
    }
  }
  player.toggle()
  player.setVolume(volume)
  return {
    engine,
    rows,
    servedByYoutubei: extractor.served - before.served,
    fellBackToYtdlp: extractor.failed - before.failed,
    engineStats: await extractor.stats().catch(() => null),
  }
}

/** Guarda los avisos de youtubei.js (p. ej. sobre PO tokens) para el informe. */
function captureLogs() {
  const original = { warn: console.warn, error: console.error }
  for (const level of ['warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      const line = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
      if (line.includes('YOUTUBEJS')) logs.push(`${level}: ${line.slice(0, 500)}`)
      original[level](...args)
    }
  }
  return () => Object.assign(console, original)
}
