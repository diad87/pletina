import * as api from './api'
import { listen } from './events'
import { toast } from './toast.svelte'
import type { PodcastProgress } from './types'

/** Estado compartido con la lista de episodios. Android escribe desde el servicio nativo. */
class EpisodeProgress {
  entries = $state<Record<number, PodcastProgress>>({})
  #writing: Promise<void> = Promise.resolve()
  #warned = false

  constructor() {
    if (api.inTauri) listen<PodcastProgress>('podcast-progress', ({ payload }) => {
      this.entries[payload.id] = payload
    }).catch(() => {})
  }

  async load(ids: number[]) {
    await this.#writing
    const rows = await api.podcastProgress(ids)
    for (const row of rows) this.entries[row.id] = row
  }

  async position(id: number): Promise<number> {
    await this.load([id])
    const progress = this.entries[id]
    return progress && !progress.completed ? progress.position : 0
  }

  save(progress: PodcastProgress) {
    this.entries[progress.id] = progress
    // Mantener el orden también al saltar rápido de episodio o volver atrás en el audio.
    const write = () => api.savePodcastProgress(progress)
    this.#writing = (api.inTauri ? this.#writing.then(write) : write()).catch(() => {
      if (!this.#warned) toast.show('No se pudo guardar el punto de escucha del pódcast')
      this.#warned = true
    })
    return this.#writing
  }

  flush() { return this.#writing }
}

export const episodeProgress = new EpisodeProgress()
