// P1: elegir de dónde sale el audio de YouTube (yt-dlp, youtubei.js o el motor propio) y atender
// las peticiones de Rust cuando se usa youtubei.js. Ver src-tauri/src/extractor.rs.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/** `oficial` es el motor propio usando solo su nivel garantizado (para probarlo). */
export type Engine = 'ytdlp' | 'youtubei' | 'propio' | 'oficial'

/** Números del motor propio (ver `engine_stats` en Rust). */
export interface EngineStats {
  recipe: number
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
        const { stream } = await import('./youtubei')
        const info = await stream(payload.videoId)
        this.served++
        await invoke('extractor_reply', { reply: { id: payload.id, info, error: null } })
      } catch (e) {
        this.failed++
        await invoke('extractor_reply', { reply: { id: payload.id, info: null, error: String(e) } })
      }
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
