// Lo que la app le da al extractor youtubei.js (el incluido o uno descargado, ver
// src-tauri/src/extractors.rs): peticiones HTTP hechas desde Rust y un sitio aislado donde ejecutar
// el código de YouTube. Así el extractor se puede actualizar solo, sin tocar esto.
import EvalWorker from './eval.worker?worker'
import { rustFetch } from './fetch'
import type { Host } from './youtubei'

let worker: Worker | null = null
let nextId = 0
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

/** Ejecuta el código del reproductor de YouTube (descifrar firma y `n`) en un worker. */
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
  return new Promise<unknown>((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    worker!.postMessage({ id, code })
  })
}

export const host: Host = { fetch: rustFetch, evaluate }
