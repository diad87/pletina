import { listen } from './events'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import * as api from './api'
import { toLib } from './library.svelte'
import { isLocal, isPodcast } from './media'
import { isAndroid } from './player-android.svelte'
import { youtubeEpisodes } from './podcasts'
import type { QueueItem } from './player.svelte'
import { toast } from './toast.svelte'
import type { DownloadProgress } from './types'

/** Estado de las descargas, al día con los eventos "download" del backend. */
class Downloads {
  /** Canciones descargadas. */
  done = new SvelteSet<number>()
  /** En cola o descargándose: id → progreso de 0 a 1. */
  active = new SvelteMap<number, number>()
  /** Canciones de la cola actual, para mostrar título y carátula. */
  queued = new SvelteMap<number, QueueItem>()
  /** Sube al terminar o quitar descargas; la vista de descargas lo lee para recargarse. */
  version = $state(0)

  #finishedInBatch = 0

  async init(downloadedIds: number[]) {
    for (const id of downloadedIds) this.done.add(id)
    if (api.inTauri) await listen<DownloadProgress>('download', (e) => this.#onProgress(e.payload))
  }

  /** Descarga las canciones que falten (las ya descargadas o en cola se saltan). */
  start(items: QueueItem[]) {
    // Los episodios, solo los de YouTube (son vídeos); la música local ya está en el equipo.
    const todo = items.filter(
      (i) =>
        !isLocal(i.track.id) &&
        (!isPodcast(i.track.id) || youtubeEpisodes.has(i.track.id)) &&
        !this.done.has(i.track.id) &&
        !this.active.has(i.track.id),
    )
    if (!todo.length) return
    for (const item of todo) {
      this.active.set(item.track.id, 0)
      this.queued.set(item.track.id, item)
    }
    toast.show(todo.length === 1 ? `Descargando «${todo[0].track.title}»…` : `Descargando ${todo.length} canciones…`)
    api.download(todo.map(toLib)).catch((e) => {
      for (const item of todo) this.#forget(item.track.id)
      toast.show(`No se pudo empezar la descarga: ${e}`)
    })
    // En Android, sin esto la descarga se congela al salir de la app.
    if (isAndroid) api.androidDownloadsStarted().catch(() => {})
    // Las carátulas (la de las listas y la grande de «Sonando ahora»), a la caché del WebView: así se
    // ven también sin conexión (Deezer deja guardarlas 150 días).
    const covers = new Set(todo.map((i) => i.cover).filter((c): c is string => !!c?.startsWith('http')))
    for (const cover of covers) {
      for (const url of [cover, cover.replace(/\/\d+x\d+-/, '/1000x1000-')]) new Image().src = url
    }
  }

  async remove(ids: number[]) {
    try {
      await api.removeDownloads(ids)
      for (const id of ids) this.done.delete(id)
      this.version++
      toast.show(ids.length === 1 ? 'Descarga quitada' : `${ids.length} descargas quitadas`)
    } catch (e) {
      toast.show(`No se pudo quitar la descarga: ${e}`)
    }
  }

  /** Descarta lo que aún no ha empezado; lo que se está descargando termina. */
  cancel() {
    api.cancelDownloads().catch(() => {})
  }

  #onProgress(p: DownloadProgress) {
    const id = p.trackId
    if (p.state === 'queued' || p.state === 'downloading') {
      this.active.set(id, p.progress)
      return
    }
    const title = this.queued.get(id)?.track.title ?? 'la canción'
    this.#forget(id)
    if (p.state === 'done') {
      this.done.add(id)
      this.#finishedInBatch++
      this.version++
    } else if (p.state === 'error') {
      toast.show(`No se pudo descargar «${title}»: ${p.error}`)
    }
    if (this.active.size === 0 && this.#finishedInBatch > 0) {
      toast.show(this.#finishedInBatch === 1 ? 'Descarga terminada' : `${this.#finishedInBatch} canciones descargadas`)
      this.#finishedInBatch = 0
    }
  }

  #forget(id: number) {
    this.active.delete(id)
    this.queued.delete(id)
  }
}

export const downloads = new Downloads()
