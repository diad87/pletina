import { convertFileSrc } from '@tauri-apps/api/core'
import * as api from './api'
import { downloads } from './downloads.svelte'
import { library, toLib } from './library.svelte'
import { toast } from './toast.svelte'
import type { Playable, Track, TrackQuery } from './types'

/** Una canción en la cola, con lo necesario para mostrarla y buscarla. */
export interface QueueItem {
  track: Track
  albumId: number
  albumTitle: string
  artistId: number
  cover: string | null
}

type Status = 'idle' | 'loading' | 'playing' | 'paused'
export type Repeat = 'off' | 'all' | 'one'

/** Tras tantos fallos seguidos se deja de saltar a la siguiente (p. ej. sin conexión). */
const MAX_FAILURES = 3

function load<T>(key: string, fallback: T, valid: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key)
    const v = raw === null ? fallback : JSON.parse(raw)
    return valid(v) ? v : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Sin almacenamiento: vale para esta sesión.
  }
}

/** Orden de reproducción: en aleatorio, `first` primero y el resto barajado. */
function playOrder(length: number, first: number, shuffle: boolean): number[] {
  const order = Array.from({ length }, (_, i) => i)
  if (!shuffle) return order
  const rest = order.filter((i) => i !== first)
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j], rest[i]]
  }
  return [first, ...rest]
}

/** Lo que se pone en el `<audio>`: el archivo descargado (protocolo local) o la URL del stream. */
const audioSrc = (p: Playable) => (p.local ? convertFileSrc(p.url) : p.url)

export function toQuery(item: QueueItem): TrackQuery {
  return {
    id: item.track.id,
    title: item.track.title,
    artist: item.track.artist.name,
    album: item.albumTitle,
    duration: item.track.duration,
  }
}

class Player {
  queue = $state<QueueItem[]>([])
  /** Posiciones de `queue` en el orden en que van a sonar. */
  order = $state<number[]>([])
  pos = $state(-1)
  status = $state<Status>('idle')
  time = $state(0)
  duration = $state(0)
  volume = $state(load('musify:volume', 0.8, (v) => typeof v === 'number' && v > 0 && v <= 1))
  muted = $state(false)
  shuffle = $state(load('musify:shuffle', false, (v) => typeof v === 'boolean'))
  repeat = $state<Repeat>(load('musify:repeat', 'off', (v) => v === 'off' || v === 'all' || v === 'one'))
  /** Canción para la que está abierto el selector "¿No es esta canción?". */
  picking = $state<QueueItem | null>(null)

  #audio = new Audio()
  /** Cada carga tiene un número; si llega una respuesta de una carga anterior, se ignora. */
  #token = 0
  /** Búsquedas en curso por canción, para no repetirlas (p. ej. precarga + clic). */
  #inFlight = new Map<number, Promise<Playable>>()
  #retried = false
  #failures = 0
  /** Si la canción actual ya se apuntó en el historial. */
  #recorded = false

  constructor() {
    const a = this.#audio
    a.preload = 'auto'
    a.volume = this.volume
    a.addEventListener('timeupdate', () => {
      // Mientras carga la siguiente, el audio aún tiene el tiempo de la anterior: se ignora.
      if (this.status === 'loading') return
      this.time = a.currentTime
      this.#maybeRecord()
    })
    a.addEventListener('durationchange', () => {
      if (Number.isFinite(a.duration)) this.duration = a.duration
      this.#syncPosition()
    })
    a.addEventListener('playing', () => {
      this.status = 'playing'
      this.#failures = 0
      this.#syncPosition()
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
    })
    a.addEventListener('pause', () => {
      if (this.status === 'playing') this.status = 'paused'
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
    })
    a.addEventListener('seeked', () => this.#syncPosition())
    a.addEventListener('ended', () => {
      if (this.repeat === 'one') {
        this.#recorded = false
        a.currentTime = 0
        a.play().catch(() => {})
      } else {
        this.next()
      }
    })
    a.addEventListener('error', () => this.#onAudioError())
    this.#setupMediaSession()
  }

  get current(): QueueItem | null {
    return this.queue[this.order[this.pos]] ?? null
  }

  get hasNext() {
    return this.queue.length > 0 && (this.pos < this.order.length - 1 || this.repeat === 'all')
  }

  /** Reproduce una lista (p. ej. un disco) empezando por la canción `start`. */
  playQueue(items: QueueItem[], start: number) {
    this.queue = items
    this.order = playOrder(items.length, start, this.shuffle)
    this.#load(this.shuffle ? 0 : start)
  }

  toggle() {
    if (this.status === 'playing') this.#audio.pause()
    else if (this.status === 'paused') this.#audio.play().catch(() => {})
    else if (this.current && this.status === 'idle') this.#load(this.pos)
  }

  next() {
    if (this.pos < this.order.length - 1) {
      this.#load(this.pos + 1)
    } else if (this.repeat === 'all' && this.queue.length) {
      // Vuelta a empezar; en aleatorio, con otro orden.
      this.order = playOrder(this.queue.length, Math.floor(Math.random() * this.queue.length), this.shuffle)
      this.#load(0)
    } else {
      // Fin de la cola: se queda parado al principio de la última canción.
      this.#audio.pause()
      this.#audio.currentTime = 0
      this.status = 'paused'
    }
  }

  prev() {
    if (this.time > 3 || this.pos <= 0) this.seek(0)
    else this.#load(this.pos - 1)
  }

  seek(seconds: number) {
    this.#audio.currentTime = seconds
    this.time = seconds
  }

  setVolume(v: number) {
    this.volume = v
    this.muted = v === 0
    this.#audio.volume = v
    this.#audio.muted = this.muted
    save('musify:volume', v)
  }

  toggleMute() {
    this.muted = !this.muted
    this.#audio.muted = this.muted
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle
    save('musify:shuffle', this.shuffle)
    if (!this.current) return
    // La que suena se queda; cambia el orden del resto.
    const index = this.order[this.pos]
    this.order = playOrder(this.queue.length, index, this.shuffle)
    this.pos = this.shuffle ? 0 : index
    this.#prefetchNext()
  }

  cycleRepeat() {
    this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off'
    save('musify:repeat', this.repeat)
  }

  /**
   * Fija a mano el vídeo de una canción y lo recuerda. Si es la que suena, se cambia al momento;
   * si no, solo se guarda para la próxima vez.
   */
  async useSource(videoId: string, item: QueueItem | null = this.current): Promise<boolean> {
    if (!item) return false
    // Si estaba descargada, el archivo era del vídeo equivocado: el backend lo borra y se vuelve a bajar.
    const wasDownloaded = downloads.done.has(item.track.id)
    const redownload = () => {
      if (!wasDownloaded) return
      downloads.done.delete(item.track.id)
      downloads.start([item])
    }

    if (item.track.id !== this.current?.track.id) {
      try {
        await api.chooseSource(toQuery(item), videoId)
        redownload()
        toast.show(`Hecho: «${item.track.title}» sonará con ese vídeo`)
        return true
      } catch (e) {
        toast.show(`No se pudo usar ese vídeo: ${e}`)
        return false
      }
    }

    const token = ++this.#token
    this.status = 'loading'
    this.#audio.pause()
    try {
      const playable = await api.chooseSource(toQuery(item), videoId)
      redownload()
      if (token !== this.#token) return true
      this.#retried = false
      this.#audio.src = audioSrc(playable)
      await this.#audio.play()
      toast.show('Hecho: a partir de ahora esta canción sonará con ese vídeo')
      return true
    } catch (e) {
      if (token === this.#token) {
        this.status = 'paused'
        toast.show(`No se pudo usar ese vídeo: ${e}`)
      }
      return false
    }
  }

  /** Apunta la canción en el historial al llevar 30 s sonando (o la mitad, si es muy corta). */
  #maybeRecord() {
    const item = this.current
    const a = this.#audio
    if (this.#recorded || !item || this.status !== 'playing') return
    if (a.currentTime < Math.min(30, (a.duration || 60) / 2)) return
    this.#recorded = true
    api
      .recordPlay(toLib(item))
      .then(() => library.historyVersion++)
      .catch(() => {})
  }

  async #load(pos: number, refresh = false, startAt = 0) {
    const item = this.queue[this.order[pos]]
    if (!item) return
    const token = ++this.#token
    this.pos = pos
    // Recargar la misma canción (URL caducada) no cuenta como otra escucha.
    if (!refresh) this.#recorded = false
    this.status = 'loading'
    this.time = startAt
    this.duration = item.track.duration
    this.#audio.pause()
    this.#updateMediaSession(item)

    try {
      const playable = await this.#resolve(item, refresh)
      if (token !== this.#token) return
      this.#retried = refresh
      this.#audio.src = audioSrc(playable)
      if (startAt) this.#audio.currentTime = startAt
      await this.#audio.play()
      this.#prefetchNext()
    } catch (e) {
      if (token !== this.#token) return
      if (e instanceof DOMException && e.name === 'AbortError') return
      this.#fail(item, String(e))
    }
  }

  /** Mientras suena una canción, se prepara la siguiente para que no haya espera. */
  #prefetchNext() {
    const nextPos = this.pos + 1 < this.order.length ? this.pos + 1 : this.repeat === 'all' ? 0 : -1
    const following = this.queue[this.order[nextPos]]
    if (following && following !== this.current) this.#resolve(following, false).catch(() => {})
  }

  #resolve(item: QueueItem, refresh: boolean): Promise<Playable> {
    const id = item.track.id
    let pending = this.#inFlight.get(id)
    if (!pending || refresh) {
      pending = api.resolve(toQuery(item), refresh)
      this.#inFlight.set(id, pending)
      pending.finally(() => this.#inFlight.get(id) === pending && this.#inFlight.delete(id)).catch(() => {})
    }
    return pending
  }

  /** El audio falló a mitad (normalmente la URL caducó): se pide otra una vez y se sigue donde iba. */
  #onAudioError() {
    const item = this.current
    if (!item || !this.#audio.src) return
    if (!this.#retried) this.#load(this.pos, true, this.#audio.currentTime)
    else this.#fail(item, 'el audio no se puede reproducir')
  }

  #fail(item: QueueItem, reason: string) {
    this.#failures++
    toast.show(`No se pudo reproducir «${item.track.title}»: ${reason}`)
    if (this.pos < this.order.length - 1 && this.#failures < MAX_FAILURES) {
      this.#load(this.pos + 1)
    } else {
      this.status = 'idle'
    }
  }

  // Teclas multimedia del teclado y panel multimedia de Windows.
  #setupMediaSession() {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    ms.setActionHandler('play', () => this.toggle())
    ms.setActionHandler('pause', () => this.toggle())
    ms.setActionHandler('previoustrack', () => this.prev())
    ms.setActionHandler('nexttrack', () => this.next())
    ms.setActionHandler('seekto', (d) => d.seekTime != null && this.seek(d.seekTime))
  }

  #updateMediaSession(item: QueueItem) {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.track.title,
      artist: item.track.artist.name,
      album: item.albumTitle,
      artwork: item.cover ? [{ src: item.cover, sizes: '500x500', type: 'image/jpeg' }] : [],
    })
  }

  #syncPosition() {
    const d = this.#audio.duration
    if (!('mediaSession' in navigator) || !Number.isFinite(d) || d <= 0) return
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        position: Math.min(this.#audio.currentTime, d),
        playbackRate: this.#audio.playbackRate,
      })
    } catch {
      // Posición fuera de rango mientras cambia de canción: se ignora.
    }
  }
}

export const player = new Player()
