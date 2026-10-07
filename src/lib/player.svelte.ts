import { convertFileSrc } from '@tauri-apps/api/core'
import * as api from './api'
import { downloads } from './downloads.svelte'
import { setAudioSource, stopCapture, prepareAudioSource, adoptAudioSource, seekCapture } from './extractor/capture'
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
  /** Lo que se está reproduciendo "de fondo": un disco, una playlist… */
  queue = $state<QueueItem[]>([])
  /** Posiciones de `queue` en el orden en que van a sonar. */
  order = $state<number[]>([])
  pos = $state(-1)
  /** De dónde viene `queue` (nombre del disco, de la playlist…), para mostrarlo en la cola. */
  context = $state('')
  /**
   * Tu cola: lo que vas metiendo al momento ("haces de DJ"). Suena antes de seguir con `queue`.
   * Cada elemento lleva una clave propia para poder repetir canciones y reordenarlas.
   */
  userQueue = $state<{ key: number; item: QueueItem }[]>([])
  /** Canción de tu cola que suena ahora (null = suena la de `queue`). */
  manual = $state<QueueItem | null>(null)
  status = $state<Status>('idle')
  time = $state(0)
  duration = $state(0)
  volume = $state(load('musify:volume', 0.8, (v) => typeof v === 'number' && v > 0 && v <= 1))
  muted = $state(false)
  shuffle = $state(load('musify:shuffle', false, (v) => typeof v === 'boolean'))
  repeat = $state<Repeat>(load('musify:repeat', 'off', (v) => v === 'off' || v === 'all' || v === 'one'))
  /** Canción para la que está abierto el selector "¿No es esta canción?". */
  picking = $state<QueueItem | null>(null)
  /** YouTube necesita que la persona resuelva algo en su ventana antes de reintentar. */
  captureInteraction = $state<string | null>(null)

  #audio = new Audio()
  #prepared: { id: number; playable: Playable; audio: HTMLAudioElement; stop: (cancelBackend?: boolean) => void } | null = null
  #prefetchVersion = 0
  #prefetchId: number | null = null
  /** Cada carga tiene un número; si llega una respuesta de una carga anterior, se ignora. */
  #token = 0
  /** Búsquedas en curso por canción, para no repetirlas (p. ej. precarga + clic). */
  #inFlight = new Map<number, { promise: Promise<Playable>; foreground: boolean; token: number; prefetchVersion: number }>()
  /** Una cancelación pendiente siempre termina antes de enviar la siguiente resolución. */
  #cancelPending: Promise<void> = Promise.resolve()
  /** Un vídeo elegido aún no se guarda si YouTube exige interacción antes de capturarlo. */
  #pendingSource: { videoId: string; item: QueueItem } | null = null
  #retried = false
  #failures = 0
  /** Si la canción actual ya se apuntó en el historial. */
  #recorded = false
  #nextKey = 1

  constructor() {
    this.#bindAudio(this.#audio)
    this.#setupMediaSession()
  }

  #bindAudio(a: HTMLAudioElement) {
    // Los eventos tardíos del audio anterior o de la precarga nunca cambian el estado actual.
    const on = (name: string, listener: (event: Event) => void) =>
      a.addEventListener(name, event => { if (a === this.#audio) listener(event) })
    a.preload = 'auto'
    a.volume = this.volume
    on('timeupdate', () => {
      // Mientras carga la siguiente, el audio aún tiene el tiempo de la anterior: se ignora.
      if (this.status === 'loading') return
      this.time = a.currentTime
      this.#maybeRecord()
    })
    on('durationchange', () => {
      if (Number.isFinite(a.duration)) this.duration = a.duration
      this.#syncPosition()
    })
    on('playing', () => {
      this.status = 'playing'
      this.#failures = 0
      this.#syncPosition()
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
    })
    on('pause', () => {
      if (this.status === 'playing') this.status = 'paused'
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
    })
    on('seeked', () => this.#syncPosition())
    on('ended', () => {
      if (this.repeat === 'one') {
        this.#recorded = false
        a.currentTime = 0
        a.play().catch(() => {})
      } else {
        this.next()
      }
    })
    on('error', () => this.#onAudioError())
    on('captureerror', (event) => {
      const item = this.current
      if (!item) return
      // La captura comunica fallos de identidad/formato incluso antes de crear un SourceBuffer.
      // Detenerla impide que una respuesta tardía alimente la siguiente canción.
      ++this.#token
      stopCapture(!(event as CustomEvent<string>).detail.includes('CAPTURE_REQUIRES_INTERACTION'))
      a.pause()
      this.#fail(item, (event as CustomEvent<string>).detail)
    })
    on('capturewarning', event => {
      const message = (event as CustomEvent<string>).detail
      // Una recuperación parcial conserva la canción y sus buffers; no incrementa el ticket.
      if (message.includes('CAPTURE_REQUIRES_INTERACTION'))
        this.captureInteraction = message.split('CAPTURE_REQUIRES_INTERACTION:').pop()?.trim() || message
      toast.show(`La captura se está recuperando: ${message}`)
    })
  }

  get current(): QueueItem | null {
    return this.manual ?? this.queue[this.order[this.pos]] ?? null
  }

  /** Diagnóstico del banco: cambia al promocionar el audio preparado. */
  get playbackAudio(): HTMLAudioElement { return this.#audio }
  get preparedAudio(): HTMLAudioElement | null { return this.#prepared?.audio ?? null }

  get hasNext() {
    return (
      this.userQueue.length > 0 || (this.queue.length > 0 && (this.pos < this.order.length - 1 || this.repeat === 'all'))
    )
  }

  /** Lo que viene después de la canción actual, en el orden en que va a sonar. */
  get upcoming(): { pos: number; item: QueueItem }[] {
    return this.order.slice(this.pos + 1).map((index, i) => ({ pos: this.pos + 1 + i, item: this.queue[index] }))
  }

  /** Salta a una canción de lo que viene después (por su posición en el orden de reproducción). */
  playAt(pos: number) {
    this.#load(pos)
  }

  /** Reproduce una lista (p. ej. un disco) empezando por la canción `start`. Tu cola se conserva. */
  playQueue(items: QueueItem[], start: number, context = '') {
    this.queue = items
    this.context = context || (items.every((i) => i.albumId === items[0]?.albumId) ? (items[0]?.albumTitle ?? '') : '')
    this.order = playOrder(items.length, start, this.shuffle)
    this.#load(this.shuffle ? 0 : start)
  }

  // ----- Tu cola (DJ) -----

  #wrap(items: QueueItem[]) {
    return items.map((item) => ({ key: this.#nextKey++, item }))
  }

  /** Al final de tu cola. Si no suena nada, empieza ya. */
  addToQueue(items: QueueItem[]) {
    if (!items.length) return
    this.userQueue = [...this.userQueue, ...this.#wrap(items)]
    toast.show(items.length === 1 ? `«${items[0].track.title}» añadida a la cola` : `${items.length} canciones añadidas a la cola`)
    this.#startIfIdle()
    if (this.status === 'playing') this.#prefetchNext()
  }

  /** Al principio de tu cola: suenan justo después de la actual. */
  playNext(items: QueueItem[]) {
    if (!items.length) return
    this.userQueue = [...this.#wrap(items), ...this.userQueue]
    toast.show(items.length === 1 ? `«${items[0].track.title}» sonará a continuación` : `${items.length} canciones sonarán a continuación`)
    this.#startIfIdle()
    if (this.status === 'playing') this.#prefetchNext()
  }

  /** Inserta en tu cola en una posición concreta (al arrastrar al panel de la cola). */
  insertInQueue(items: QueueItem[], at: number) {
    const list = [...this.userQueue]
    list.splice(Math.max(0, Math.min(at, list.length)), 0, ...this.#wrap(items))
    this.userQueue = list
    this.#startIfIdle()
    if (this.status === 'playing') this.#prefetchNext()
  }

  removeFromQueue(key: number) {
    this.userQueue = this.userQueue.filter((e) => e.key !== key)
    this.#prefetchNext()
  }

  moveInQueue(key: number, to: number) {
    const list = [...this.userQueue]
    const from = list.findIndex((e) => e.key === key)
    if (from < 0) return
    const [moved] = list.splice(from, 1)
    list.splice(Math.max(0, Math.min(to, list.length)), 0, moved)
    this.userQueue = list
    this.#prefetchNext()
  }

  clearQueue() {
    this.userQueue = []
    this.#prefetchNext()
  }

  /** Reproduce ya una canción de tu cola; las que iban delante se quitan (como en Spotify). */
  playFromQueue(key: number) {
    const index = this.userQueue.findIndex((e) => e.key === key)
    if (index < 0) return
    const { item } = this.userQueue[index]
    this.userQueue = this.userQueue.slice(index + 1)
    this.#loadManual(item)
  }

  #startIfIdle() {
    if (this.current || !this.userQueue.length) return
    const [first, ...rest] = this.userQueue
    this.userQueue = rest
    this.#loadManual(first.item)
  }

  toggle() {
    if (this.status === 'loading') this.#cancelLoading()
    else if (this.status === 'playing') this.#audio.pause()
    else if (this.status === 'paused') this.#audio.play().catch(() => {})
    else if (this.manual && this.status === 'idle') this.#loadManual(this.manual)
    else if (this.current && this.status === 'idle') this.#load(this.pos)
  }

  #cancelLoading() {
    ++this.#token
    this.#pendingSource = null
    this.#inFlight.clear()
    this.#discardPrefetch(true)
    stopCapture()
    this.#audio.pause()
    this.#audio.removeAttribute('src')
    this.#audio.load()
    this.status = 'idle'
    this.captureInteraction = null
    this.#cancelPending = this.#cancelPending.then(() => api.cancelResolve()).catch((e) => {
      toast.show(`No se pudo cancelar la preparación: ${e}`)
    })
  }

  async openCapture() {
    try {
      await api.showCapture()
    } catch (e) {
      this.captureInteraction = `No se pudo abrir YouTube: ${e}. Pulsa Reintentar para preparar otra ventana.`
    }
  }

  retryCapture() {
    const pending = this.#pendingSource
    if (pending && pending.item.track.id === this.current?.track.id) {
      void this.useSource(pending.videoId, pending.item)
      return
    }
    this.#pendingSource = null
    if (this.manual) this.#loadManual(this.manual, true)
    else if (this.current) this.#load(this.pos, true)
  }

  next() {
    // Primero tu cola; luego se sigue con el disco o la playlist donde iba.
    if (this.userQueue.length) {
      const [first, ...rest] = this.userQueue
      this.userQueue = rest
      this.#loadManual(first.item)
    } else if (this.pos < this.order.length - 1) {
      this.#load(this.pos + 1)
    } else if (this.repeat === 'all' && this.queue.length) {
      // Vuelta a empezar; en aleatorio, con otro orden.
      this.order = playOrder(this.queue.length, Math.floor(Math.random() * this.queue.length), this.shuffle)
      this.#load(0)
    } else {
      // Fin de la cola: se queda parado al principio de la última canción.
      if (this.status === 'loading') {
        this.#cancelLoading()
        return
      }
      this.#audio.pause()
      this.#audio.currentTime = 0
      this.status = 'paused'
    }
  }

  prev() {
    if (this.time > 3) this.seek(0)
    // Desde una canción de tu cola se vuelve a la del disco o playlist donde iba.
    else if (this.manual && this.queue[this.order[this.pos]]) this.#load(this.pos)
    else if (this.pos <= 0) this.seek(0)
    else this.#load(this.pos - 1)
  }

  seek(seconds: number) {
    const audio = this.#audio, token = this.#token
    void seekCapture(audio, seconds).then(ready => {
      if (ready && token === this.#token && audio === this.#audio) this.time = seconds
    })
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
    if (!this.queue[this.order[this.pos]]) return
    // La que suena se queda; cambia el orden del resto.
    const index = this.order[this.pos]
    this.order = playOrder(this.queue.length, index, this.shuffle)
    this.pos = this.shuffle ? 0 : index
    this.#prefetchNext()
  }

  cycleRepeat() {
    this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off'
    save('musify:repeat', this.repeat)
    this.#prefetchNext()
  }

  /**
   * Fija a mano el vídeo de una canción y lo recuerda. Si es la que suena, se cambia al momento;
   * si no, solo se guarda para la próxima vez.
   */
  async useSource(videoId: string, item: QueueItem | null = this.current, onError?: (message: string) => void): Promise<boolean> {
    if (!item) return false
    const reportError = (e: unknown) => {
      const message = `No se pudo usar ese vídeo: ${e}`
      if (onError) onError(message)
      else toast.show(message)
    }
    // Si estaba descargada, el archivo era del vídeo equivocado: el backend lo borra y se vuelve a bajar.
    const wasDownloaded = downloads.done.has(item.track.id)
    const redownload = () => {
      if (!wasDownloaded) return
      downloads.done.delete(item.track.id)
      downloads.start([item])
    }

    if (item.track.id !== this.current?.track.id) {
      try {
        await api.rememberSource(toQuery(item), videoId)
        redownload()
        toast.show(`Hecho: «${item.track.title}» sonará con ese vídeo`)
        return true
      } catch (e) {
        reportError(e)
        return false
      }
    }

    this.#discardPrefetch(true)
    const token = ++this.#token
    this.#pendingSource = null
    this.captureInteraction = null
    this.status = 'loading'
    this.#audio.pause()
    stopCapture()
    try {
      await this.#cancelPending
      if (token !== this.#token) return false
      const playable = await api.chooseSource(toQuery(item), videoId)
      redownload()
      if (token !== this.#token) return true
      this.#retried = false
      setAudioSource(this.#audio, audioSrc(playable))
      await this.#audio.play()
      this.#prefetchNext()
      toast.show('Hecho: a partir de ahora esta canción sonará con ese vídeo')
      return true
    } catch (e) {
      if (token === this.#token) {
        if (String(e).includes('CAPTURE_REQUIRES_INTERACTION')) {
          this.#pendingSource = { videoId, item }
          this.#fail(item, String(e))
        }
        else {
          this.status = 'paused'
          reportError(e)
        }
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

  /** Pone una canción del disco o playlist de fondo (por su posición en el orden). */
  #load(pos: number, refresh = false, startAt = 0) {
    const item = this.queue[this.order[pos]]
    if (!item) return
    this.manual = null
    this.pos = pos
    this.#start(item, refresh, startAt)
  }

  /** Pone una canción de tu cola (sin mover la posición en el disco o playlist de fondo). */
  #loadManual(item: QueueItem, refresh = false, startAt = 0) {
    this.manual = item
    this.#start(item, refresh, startAt)
  }

  async #start(item: QueueItem, refresh = false, startAt = 0) {
    const prepared = !refresh && this.#prepared?.id === item.track.id ? this.#prepared : null
    if (!prepared) this.#discardPrefetch(this.#prefetchId !== item.track.id)
    else { ++this.#prefetchVersion; this.#prefetchId = null; this.#prepared = null }
    const token = ++this.#token
    this.#pendingSource = null
    this.captureInteraction = null
    // Recargar la misma canción (URL caducada) no cuenta como otra escucha.
    if (!refresh) this.#recorded = false
    this.status = 'loading'
    this.time = startAt
    this.duration = item.track.duration
    this.#audio.pause()
    // Si sonaba una captura del motor propio, deja de leerse: así puede empezar la siguiente.
    stopCapture()
    this.#updateMediaSession(item)

    try {
      const playable = await this.#resolve(item, refresh)
      if (token !== this.#token) { prepared?.stop(false); return }
      this.#retried = refresh
      if (prepared && audioSrc(prepared.playable) === audioSrc(playable)) {
        // El resolve foreground promociona la sesión nativa; el Audio y su MSE ya están listos.
        this.#audio = prepared.audio
        this.#audio.volume = this.volume
        this.#audio.muted = this.muted
        adoptAudioSource(prepared.stop)
        if (Number.isFinite(this.#audio.duration)) this.duration = this.#audio.duration
      } else {
        prepared?.stop(false)
        setAudioSource(this.#audio, audioSrc(playable))
      }
      if (startAt) await seekCapture(this.#audio, startAt)
      await this.#audio.play()
      this.#prefetchNext()
    } catch (e) {
      prepared?.stop(false)
      if (token !== this.#token) return
      if (e instanceof DOMException && e.name === 'AbortError') return
      this.#fail(item, String(e))
    }
  }

  #discardPrefetch(cancelNative = false) {
    const hadPrefetch = this.#prefetchId !== null || this.#prepared !== null
    ++this.#prefetchVersion
    this.#prefetchId = null
    const previous = this.#prepared
    this.#prepared = null
    if (cancelNative && hadPrefetch) {
      // Serializar con resolve evita que una cancelación tardía retire la siguiente sesión.
      this.#cancelPending = this.#cancelPending.then(() => api.cancelPrefetch()).catch(() => {})
    }
    if (previous) {
      // El supervisor sustituye la sesión next; no cancelar una generación ya promocionada.
      previous.stop(false)
      previous.audio.pause()
      previous.audio.removeAttribute('src')
      previous.audio.load()
    }
  }

  /** Prepara el decoder/MSE de la siguiente desde que empieza a sonar la actual. */
  #prefetchNext() {
    const nextPos = this.pos + 1 < this.order.length ? this.pos + 1 : this.repeat === 'all' ? 0 : -1
    const following = this.userQueue[0]?.item ?? this.queue[this.order[nextPos]]
    if (!following || following === this.current || this.repeat === 'one') { this.#discardPrefetch(true); return }
    if (this.#prefetchId === following.track.id) return
    this.#discardPrefetch()
    this.#prefetchId = following.track.id
    const version = this.#prefetchVersion
    this.#resolve(following, false, false).then(playable => {
      if (version !== this.#prefetchVersion) return
      // La vía legacy mantiene su política anterior: resolver URL, sin una segunda captura MSE.
      if (audioSrc(playable).startsWith('musify-capture-legacy:')) return
      const audio = new Audio()
      this.#bindAudio(audio)
      audio.muted = true
      const stop = prepareAudioSource(audio, audioSrc(playable))
      this.#prepared = { id: following.track.id, playable, audio, stop }
      audio.addEventListener('captureerror', () => {
        if (this.#prepared?.audio === audio) this.#discardPrefetch(true)
      }, { once: true })
    }).catch(() => { if (version === this.#prefetchVersion) this.#prefetchId = null })
  }

  #resolve(item: QueueItem, refresh: boolean, foreground = true): Promise<Playable> {
    const id = item.track.id
    let pending = this.#inFlight.get(id)
    if (!pending || refresh || pending.token !== this.#token || (foreground && !pending.foreground) ||
        (!foreground && pending.prefetchVersion !== this.#prefetchVersion)) {
      // El clic debe llegar al backend para promocionar una precarga; allí se comparte la captura.
      const entry = {
        promise: this.#cancelPending.then(() => api.resolve(toQuery(item), refresh, foreground)),
        foreground,
        token: this.#token,
        prefetchVersion: this.#prefetchVersion,
      }
      pending = entry
      this.#inFlight.set(id, entry)
      entry.promise.finally(() => this.#inFlight.get(id) === entry && this.#inFlight.delete(id)).catch(() => {})
    }
    return pending.promise
  }

  /** El audio falló a mitad (normalmente la URL caducó): se pide otra una vez y se sigue donde iba. */
  #onAudioError() {
    const item = this.current
    if (!item || !this.#audio.src) return
    const at = this.#audio.currentTime
    if (this.#retried) this.#fail(item, 'el audio no se puede reproducir')
    else if (this.manual) this.#loadManual(this.manual, true, at)
    else this.#load(this.pos, true, at)
  }

  #fail(item: QueueItem, reason: string) {
    if (reason.includes('SOURCE_SELECTION_REQUIRED')) {
      this.status = 'idle'
      this.picking = item
      return
    }
    if (reason.includes('CAPTURE_REQUIRES_INTERACTION')) {
      this.captureInteraction = reason.split('CAPTURE_REQUIRES_INTERACTION:').pop()?.trim() || 'YouTube necesita tu intervención.'
      this.status = 'idle'
      return
    }
    this.#failures++
    toast.show(`No se pudo reproducir «${item.track.title}»: ${reason}`)
    if (this.#failures < MAX_FAILURES && (this.userQueue.length > 0 || this.pos < this.order.length - 1)) {
      this.next()
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
