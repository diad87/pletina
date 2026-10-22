import type { Alternative, TrackQuery } from '../src/lib/types'
import { searchOfficialSources, validateOfficialTrack, type OfficialSourceOptions } from './official-youtube'

type Options = Omit<OfficialSourceOptions, 'signal'>
export class OfficialYouTubeController {
  opened = $state(false)
  track = $state<TrackQuery | null>(null)
  status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle')
  sources = $state<Alternative[]>([])
  selected = $state<Alternative | null>(null)
  error = $state<string | null>(null)
  #generation = 0
  #request: AbortController | null = null

  constructor(private readonly options: Options = {}) {}

  open(input: TrackQuery): void {
    this.#invalidate()
    this.opened = true
    this.sources = []
    this.selected = null
    this.error = null
    try { this.track = validateOfficialTrack(input) }
    catch (error) {
      this.track = null
      this.status = 'error'
      this.error = error instanceof Error ? error.message : 'La canción no es válida.'
      return
    }
    void this.#load()
  }

  retry(): void {
    if (!this.opened || !this.track) return
    this.#invalidate()
    this.selected = null
    this.sources = []
    this.error = null
    void this.#load()
  }

  select(videoId: string): boolean {
    if (!this.opened || this.status !== 'ready') return false
    const source = this.sources.find((row) => row.videoId === videoId)
    if (!source) return false
    this.selected = { ...source }
    return true
  }

  close(): void {
    this.#invalidate()
    this.opened = false
    this.selected = null
    this.sources = []
    this.track = null
    this.error = null
    this.status = 'idle'
  }

  #invalidate(): void {
    ++this.#generation
    this.#request?.abort(new DOMException('Búsqueda cancelada.', 'AbortError'))
    this.#request = null
  }

  async #load(): Promise<void> {
    const track = this.track
    if (!track) return
    const generation = this.#generation, request = new AbortController()
    this.#request = request
    this.status = 'loading'
    try {
      const sources = await searchOfficialSources(track, { ...this.options, signal: request.signal })
      if (!this.opened || generation !== this.#generation || request.signal.aborted) return
      this.sources = sources
      this.status = 'ready'
    } catch (error) {
      if (!this.opened || generation !== this.#generation || request.signal.aborted) return
      this.status = 'error'
      this.error = error instanceof Error ? error.message.replace(/https?:\/\/[^\s"'<>]+/g, '[dirección]').slice(0, 350)
        : 'No se pudieron buscar los vídeos. Vuelve a intentarlo.'
    } finally { if (this.#request === request) this.#request = null }
  }
}

export const createOfficialYouTubeController = (options: Options = {}) => new OfficialYouTubeController(options)
export const officialYouTube = createOfficialYouTubeController()
export const openOfficialYouTube = (track: TrackQuery): void => officialYouTube.open(track)
export const closeOfficialYouTube = (): void => officialYouTube.close()
