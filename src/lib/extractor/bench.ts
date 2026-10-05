// Prototipo P1: compara youtubei.js con yt-dlp dentro de la app (tiempos, si suena en <audio>
// y si YouTube corta el audio por falta de PO token). Se lanza con MUSIFY_BENCH=plan.json.
import { invoke } from '@tauri-apps/api/core'
import * as api from '../api'
import { player, type QueueItem } from '../player.svelte'
import { extractor } from './engine.svelte'
import { CLIENTS, innertube, stats, stream } from './youtubei'

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
  /** Reproducir canciones de verdad con el reproductor de la app y youtubei.js. */
  e2e?: { query: string; tracks: number }
}

type Probe = { length: number; start: number; deep: number }
type AudioCheck = { ok: boolean; playMs?: number; seekMs?: number; duration?: number; error?: string }

const logs: string[] = []

export async function runBench(plan: Plan) {
  const restore = captureLogs()
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    clients: CLIENTS,
  }
  try {
    const t = performance.now()
    await innertube()
    report.session = { ms: Math.round(performance.now() - t), innerMs: Math.round(stats.sessionMs) }

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
    if (plan.e2e) report.e2e = await endToEnd(plan.e2e)
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

async function check(url: string, plan: Plan): Promise<{ probe: Probe | string; audio?: AudioCheck }> {
  const probe = await invoke<Probe>('bench_probe', { url }).catch((e) => String(e))
  return { probe, audio: plan.audio ? await playCheck(url) : undefined }
}

/** Que suene en un <audio> (en silencio) y que se pueda saltar al 80 % y siga sonando. */
async function playCheck(url: string): Promise<AudioCheck> {
  const a = new Audio()
  a.muted = true
  a.preload = 'auto'
  const t0 = performance.now()
  try {
    a.src = url
    await Promise.all([until(a, 'playing', 15000), a.play()])
    await progress(a, 0.5)
    const playMs = Math.round(performance.now() - t0)
    const t1 = performance.now()
    a.currentTime = a.duration * 0.8
    await until(a, 'seeked', 15000)
    await progress(a, 0.5)
    return { ok: true, playMs, seekMs: Math.round(performance.now() - t1), duration: Math.round(a.duration) }
  } catch (e) {
    return { ok: false, error: String(e) }
  } finally {
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

/** Canciones de verdad con el reproductor de la app (volumen a 0) y el motor youtubei.js. */
async function endToEnd({ query, tracks }: { query: string; tracks: number }) {
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
  await extractor.set('youtubei')
  const before = { served: extractor.served, failed: extractor.failed }
  const rows = []
  player.playQueue(items, 0)
  for (let i = 0; i < items.length; i++) {
    const t = performance.now()
    let ok = true
    while (!(player.current?.track.id === items[i].track.id && player.status === 'playing' && player.time > 1)) {
      if (performance.now() - t > 30000) {
        ok = false
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    rows.push({ title: items[i].track.title, ok, msToPlaying: Math.round(performance.now() - t) })
    if (i < items.length - 1) player.next()
  }
  player.toggle()
  player.setVolume(volume)
  return { rows, servedByYoutubei: extractor.served - before.served, fellBackToYtdlp: extractor.failed - before.failed }
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
