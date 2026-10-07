// P1: elegir de dónde sale el audio de YouTube (yt-dlp, youtubei.js o el motor propio) y atender
// las peticiones de Rust cuando se usa youtubei.js. Ver src-tauri/src/extractor.rs.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '../events'
import { inTauri } from '../api'
import { host } from './host'

type YoutubeiModule = typeof import('./youtubei')

let youtubei: Promise<YoutubeiModule> | null = null

/**
 * El motor youtubei.js: el descargado si hay uno más nuevo (ver src-tauri/src/extractors.rs) y,
 * si no hay o no carga, el que trae la app.
 */
export function loadYoutubei(): Promise<YoutubeiModule> {
  youtubei ??= (async () => {
    const remote = await invoke<{ version: number; code: string } | null>('extractor_module', { name: 'youtubei' }).catch(() => null)
    if (remote) {
      const url = URL.createObjectURL(new Blob([remote.code], { type: 'text/javascript' }))
      try {
        const m: YoutubeiModule = await import(/* @vite-ignore */ url)
        if (m.api !== 1) throw new Error(`api ${m.api}`)
        m.setup(host)
        return m
      } catch (e) {
        console.warn(`[extractores] youtubei v${remote.version} no carga; se usa el incluido:`, e)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    const m = await import('./youtubei')
    m.setup(host)
    return m
  })()
  youtubei.catch(() => (youtubei = null))
  return youtubei
}

/** `oficial` es el motor propio usando solo su nivel garantizado (para probarlo). */
export type Engine = 'ytdlp' | 'youtubei' | 'propio' | 'oficial'

/** Números del motor propio (ver `engine_stats` en Rust). */
export interface EngineStats {
  /** Versión de cada extractor y si es uno descargado (ver src-tauri/src/extractors.rs). */
  extractors: { name: 'recipe' | 'capture' | 'youtubei'; version: number; downloaded: boolean }[]
  fast: number
  fastFailed: number
  replaced: number
  official: number
}

const KEY = 'musify:engine'
const isEngine = (v: unknown): v is Engine => v === 'ytdlp' || v === 'youtubei' || v === 'propio' || v === 'oficial'

class Extractor {
  engine = $state<Engine>('ytdlp')
  /** URLs sacadas con youtubei.js y fallos (en los fallos, Rust tira de yt-dlp). */
  served = $state(0)
  failed = $state(0)

  async start() {
    // En el navegador (vista previa) no hay Rust ni motores.
    if (!inTauri) return
    let saved: string | null = null
    try {
      saved = localStorage.getItem(KEY)
    } catch {
      // Sin almacenamiento: se queda el motor que diga Rust.
    }
    if (isEngine(saved)) await invoke('set_stream_engine', { engine: saved }).catch(() => {})
    this.engine = await invoke<Engine>('stream_engine').catch(() => 'ytdlp' as const)

    await listen<{ id: number; videoId: string }>('extractor:stream', async ({ payload }) => {
      try {
        const { stream } = await loadYoutubei()
        const info = await stream(payload.videoId)
        this.served++
        await invoke('extractor_reply', { reply: { id: payload.id, info, error: null } })
      } catch (e) {
        this.failed++
        await invoke('extractor_reply', { reply: { id: payload.id, info: null, error: String(e) } })
      }
    })

    // Ha llegado un youtubei.js nuevo: se usa desde la siguiente canción.
    await listen<{ name: string }>('extractors-updated', ({ payload }) => {
      if (payload.name === 'youtubei') youtubei = null
    })

    // Medición: solo si se arranca con MUSIFY_BENCH=plan.json.
    const plan = await invoke<unknown>('bench_plan').catch(() => null)
    if (plan) import('./bench').then((b) => b.runBench(plan as never))
  }

  stats() {
    return invoke<EngineStats>('engine_stats')
  }

  async set(engine: Engine) {
    await invoke('set_stream_engine', { engine })
    this.engine = engine
    try {
      localStorage.setItem(KEY, engine)
    } catch {
      // Vale para esta sesión.
    }
  }
}

export const extractor = new Extractor()
