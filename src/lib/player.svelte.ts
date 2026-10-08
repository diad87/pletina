import { convertFileSrc } from '@tauri-apps/api/core'
import * as api from './api'
import { downloads } from './downloads.svelte'
import { CAPTURE, captureProgress, captureReady, waitForCaptureReady, setAudioSource, stopCapture, prepareAudioSource, adoptAudioSource, seekCapture } from './extractor/capture'
import { extractor } from './extractor/engine.svelte'
import { library, toLib } from './library.svelte'
import { isPodcast } from './media'
import { toast } from './toast.svelte'
import { AndroidPlayer, isAndroid } from './player-android.svelte'
import { load, playOrder, save, toQuery, type PlayerApi, type QueueItem, type Repeat, type Status } from './queue'
import type { Playable } from './types'

export { toQuery, type QueueItem, type Repeat }

type PreparedAudio = { id: number; playable: Playable; audio: HTMLAudioElement; stop: (cancelBackend?: boolean) => void }
type CapturePromotion = { token: number; audio: HTMLAudioElement; ready: boolean; played: boolean; interrupted: boolean }
type PrefetchEntry = { item: QueueItem; engine: string; slot: 0 | 1; version: number; pending: boolean; resolved: boolean; prepared: PreparedAudio | null }

/** Tras tantos fallos seguidos se deja de saltar a la siguiente (p. ej. sin conexión). */
const MAX_FAILURES = 3

/** Lo que se pone en el `<audio>`: el archivo descargado (protocolo local) o la URL del stream. */
const audioSrc = (p: Playable) => (p.local ? convertFileSrc(p.url) : p.url)

/** El reproductor de escritorio: un `<audio>` en la interfaz. */
class Player implements PlayerApi {
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
  #source: { trackId: number; videoId: string; kind: 'capture' | 'capture-legacy' | 'local' | 'network' } | null = null
  #prefetches = new Map<number, PrefetchEntry>()
  /** La sesión preparada sigue siendo next hasta que termina su promoción nativa. */
  #promotion: CapturePromotion | null = null
  #prefetchVersion = 0
  #prefetchLimit = 2
  #admission: (api.ForegroundAdmission & { token: number; audio: HTMLAudioElement }) | null = null
  #loadingCanPrefetch = false
  /** Cada carga tiene un número; si llega una respuesta de una carga anterior, se ignora. */
  #token = 0
  /** Búsquedas en curso por canción, para no repetirlas (p. ej. precarga + clic). */
  #inFlight = new Map<string, { promise: Promise<Playable>; token: number; prefetchVersion: number }>()
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
      if (this.#promotion) {
        // Un nuevo playing después de pause/AbortError completa la reproducción
        // pendiente; no convierte un rechazo de promoción en éxito.
        if (this.#promotion.interrupted) this.#promotion.played = true
        this.#completePromotion(this.#promotion)
      }
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
      toast.show(message.startsWith('CAPTURE_PROMOTION_FAILED:')
        ? `No se pudo promover la captura; se conserva el audio confirmado: ${message.slice('CAPTURE_PROMOTION_FAILED:'.length).trim()}`
        : `La captura se está recuperando: ${message}`)
    })
  }

  get current(): QueueItem | null {
    return this.manual ?? this.queue[this.order[this.pos]] ?? null
  }

  /** Diagnóstico del banco: cambia al promocionar el audio preparado. */
  get playbackAudio(): HTMLAudioElement { return this.#audio }
  /** Diagnóstico sin URL firmada: permite comprobar el vídeo realmente elegido por búsqueda. */
  get playbackSource() { return this.#source ? { ...this.#source } : null }
  get preparedAudio(): HTMLAudioElement | null { return this.preparedAudios[0]?.audio ?? null }
  get preparedAudios(): { trackId: number; slot: 0 | 1; audio: HTMLAudioElement }[] {
    return this.#followingItems().flatMap(item => {
      const entry = this.#prefetches.get(item.track.id)
      return entry?.prepared ? [{ trackId: item.track.id, slot: entry.slot, audio: entry.prepared.audio }] : []
    })
  }

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
    if (this.status === 'playing' || this.status === 'loading') this.#prefetchNext()
  }

  /** Al principio de tu cola: suenan justo después de la actual. */
  playNext(items: QueueItem[]) {
    if (!items.length) return
    this.userQueue = [...this.#wrap(items), ...this.userQueue]
    toast.show(items.length === 1 ? `«${items[0].track.title}» sonará a continuación` : `${items.length} canciones sonarán a continuación`)
    this.#startIfIdle()
    if (this.status === 'playing' || this.status === 'loading') this.#prefetchNext()
  }

  /** Inserta en tu cola en una posición concreta (al arrastrar al panel de la cola). */
  insertInQueue(items: QueueItem[], at: number) {
    const list = [...this.userQueue]
    list.splice(Math.max(0, Math.min(at, list.length)), 0, ...this.#wrap(items))
    this.userQueue = list
    this.#startIfIdle()
    if (this.status === 'playing' || this.status === 'loading') this.#prefetchNext()
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
    this.#admission = null
    this.#loadingCanPrefetch = false
    this.#pendingSource = null
    this.#inFlight.clear()
    this.#discardPrefetch(true)
    stopCapture()
    this.#audio.pause()
    this.#audio.removeAttribute('src')
    this.#audio.load()
    this.status = 'idle'
    this.#source = null
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
    if (!item || isPodcast(item.track.id)) return false
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
        const prefetched = this.#prefetches.get(item.track.id)
        if (prefetched) this.#removePrefetch(prefetched, true)
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
    this.#admission = null
    this.#loadingCanPrefetch = true
    this.#pendingSource = null
    this.captureInteraction = null
    this.status = 'loading'
    this.#audio.pause()
    stopCapture()
    try {
      await this.#cancelPending
      if (token !== this.#token) return false
      const playable = await api.chooseSource(toQuery(item), videoId, true, this.#admissionOptions(item))
      redownload()
      if (token !== this.#token) return true
      this.#rememberPlayback(item, playable)
      this.#retried = false
      setAudioSource(this.#audio, audioSrc(playable))
      const audio = this.#audio
      await waitForCaptureReady(audio)
      if (token !== this.#token || audio !== this.#audio) return true
      await audio.play()
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
          this.#admission = null
          this.#discardPrefetch(true)
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
    const prefetched = this.#prefetches.get(item.track.id)
    const prepared = !refresh && prefetched?.engine === extractor.engine ? prefetched.prepared : null
    // La señal nativa llega después de asegurar la plaza foreground, incluso si
    // antes era next. Un Audio ya preparado conserva además su barrera de play.
    this.#loadingCanPrefetch = !prepared
    this.#admission = null
    // La plaza promovida deja de ser next; nunca se cancela por su número después.
    // Las otras canciones deseadas conservan plaza, lector y Audio.
    if (prefetched) this.#removePrefetch(prefetched, false, !!prepared)
    this.#prunePrefetch(this.#followingItems())
    const token = ++this.#token
    this.#promotion = null
    this.#pendingSource = null
    this.captureInteraction = null
    // Recargar la misma canción (URL caducada) no cuenta como otra escucha.
    if (!refresh) this.#recorded = false
    this.status = 'loading'
    this.#source = null
    this.time = startAt
    this.duration = item.track.duration
    this.#audio.pause()
    // Si sonaba una captura del motor propio, deja de leerse: así puede empezar la siguiente.
    stopCapture()
    this.#updateMediaSession(item)

    if (!refresh && prepared && startAt === 0 && this.#readyCapture(prepared)) {
      // Estos bytes ya están confirmados y aceptados por MSE. El cierre de la ventana
      // anterior no debe retrasar play; el ticket foreground se promociona en paralelo.
      this.#adoptPrepared(prepared)
      this.#rememberPlayback(item, prepared.playable)
      this.#retried = false
      const pendingPromotion: CapturePromotion = { token, audio: prepared.audio, ready: false, played: false, interrupted: false }
      this.#promotion = pendingPromotion
      const current = () => token === this.#token && this.#audio === prepared.audio
      const phase = (phase: string, error?: string) => prepared.audio.dispatchEvent(new CustomEvent('capturehandoff', {
        detail: { phase, ...(error ? { error } : {}) },
      }))
      phase('promotion-request')
      const promotion = this.#resolve(item, false).then(playable => {
        if (!current()) return false
        if (audioSrc(playable) !== audioSrc(prepared.playable) || playable.videoId !== prepared.playable.videoId)
          throw new Error('La resolución ya no coincide con el vídeo preparado')
        pendingPromotion.ready = true
        phase('promotion-ready')
        this.#completePromotion(pendingPromotion)
        return true
      }).catch(error => {
        if (current()) {
          phase('promotion-failed', String(error))
          prepared.audio.dispatchEvent(new CustomEvent('capturewarning', { detail: `CAPTURE_PROMOTION_FAILED: ${error}` }))
        }
        return false
      })
      try {
        phase('play-request')
        await prepared.audio.play()
        pendingPromotion.played = true
        if (await promotion) this.#completePromotion(pendingPromotion)
      } catch (error) {
        if (!current()) return
        if (error instanceof DOMException && error.name === 'AbortError') {
          pendingPromotion.interrupted = true
          pendingPromotion.played = false
          return
        }
        prepared.stop(false)
        this.#fail(item, String(error))
      }
      return
    }

    try {
      const playable = await this.#resolve(item, refresh)
      if (token !== this.#token) { prepared?.stop(false); return }
      this.#rememberPlayback(item, playable)
      this.#retried = refresh
      if (prepared && audioSrc(prepared.playable) === audioSrc(playable)) {
        // El resolve foreground promociona la sesión nativa; el Audio y su MSE ya están listos.
        this.#adoptPrepared(prepared)
      } else {
        prepared?.stop(false)
        setAudioSource(this.#audio, audioSrc(playable))
      }
      if (startAt) await seekCapture(this.#audio, startAt)
      const audio = this.#audio
      await waitForCaptureReady(audio)
      if (token !== this.#token || audio !== this.#audio) return
      await audio.play()
      this.#prefetchNext()
    } catch (e) {
      prepared?.stop(false)
      if (token !== this.#token) return
      if (e instanceof DOMException && e.name === 'AbortError') return
      this.#fail(item, String(e))
    }
  }

  #readyCapture(prepared: PreparedAudio): boolean {
    const { audio, playable } = prepared
    if (playable.local || !/^[A-Za-z0-9_-]{11}$/.test(playable.videoId) || playable.url !== `${CAPTURE}${playable.videoId}` ||
        !audio.paused || audio.currentTime !== 0 || audio.error || audio.readyState < 2 || !(captureProgress(audio)?.units) || !captureReady(audio)) return false
    for (let i = 0; i < audio.buffered.length; i++)
      if (audio.buffered.start(i) <= 0.000001 && audio.buffered.end(i) > 0) return true
    return false
  }

  #completePromotion(promotion: CapturePromotion) {
    if (this.#promotion !== promotion || promotion.token !== this.#token || promotion.audio !== this.#audio ||
        !promotion.ready || !promotion.played || promotion.audio.paused) return
    this.#promotion = null
    this.#prefetchNext()
  }

  #adoptPrepared(prepared: PreparedAudio) {
    this.#audio = prepared.audio
    this.#audio.volume = this.volume
    this.#audio.muted = this.muted
    adoptAudioSource(prepared.stop)
    if (Number.isFinite(this.#audio.duration)) this.duration = this.#audio.duration
  }

  #rememberPlayback(item: QueueItem, playable: Playable) {
    this.#source = { trackId: item.track.id, videoId: playable.videoId,
      kind: playable.local ? 'local' : playable.url.startsWith(CAPTURE) ? 'capture' :
        playable.url.startsWith('musify-capture-legacy:') ? 'capture-legacy' : 'network' }
  }

  #followingItems(): QueueItem[] {
    if (this.repeat === 'one') return []
    const limit = extractor.engine === 'oficial' ? this.#prefetchLimit : 2
    const rest = this.order.slice(this.pos + 1)
    if (this.repeat === 'all') rest.push(...this.order.slice(0, this.pos + 1))
    const result: QueueItem[] = [], seen = new Set<number>()
    for (const item of [...this.userQueue.map(e => e.item), ...rest.map(index => this.queue[index])]) {
      if (!item || item === this.current || seen.has(item.track.id)) continue
      seen.add(item.track.id); result.push(item)
      if (result.length >= limit) break
    }
    return limit ? result : []
  }

  #removePrefetch(entry: PrefetchEntry, cancelNative: boolean, adopt = false) {
    if (this.#prefetches.get(entry.item.track.id) !== entry) return
    this.#prefetches.delete(entry.item.track.id)
    if (cancelNative)
      this.#cancelPending = this.#cancelPending.then(() => api.cancelPrefetch(entry.slot)).catch(() => {})
    if (entry.prepared && !adopt) {
      entry.prepared.stop(false)
      entry.prepared.audio.pause()
      entry.prepared.audio.removeAttribute('src')
      entry.prepared.audio.load()
    }
  }

  #discardPrefetch(cancelNative = false) {
    const entries = [...this.#prefetches.values()]
    if (cancelNative && entries.length)
      this.#cancelPending = this.#cancelPending.then(() => api.cancelPrefetch()).catch(() => {})
    for (const entry of entries) this.#removePrefetch(entry, false)
  }

  #prunePrefetch(following: QueueItem[]) {
    const wanted = new Set(following.map(item => item.track.id))
    for (const entry of this.#prefetches.values())
      if (!wanted.has(entry.item.track.id) || entry.engine !== extractor.engine) this.#removePrefetch(entry, true)
  }

  /** Prepara hasta dos Audio sin cambiar la plaza de una canción todavía deseada. */
  #prefetchNext() {
    if (this.#promotion?.token === this.#token) return
    const admission = this.#currentAdmission()
    if (this.status === 'idle' || (this.status === 'loading' && (!this.#loadingCanPrefetch || !admission))) return
    const following = this.#followingItems()
    this.#prunePrefetch(following)
    for (const item of following) {
      let entry = this.#prefetches.get(item.track.id)
      if (entry?.pending || entry?.resolved) continue
      if (!entry) {
        const occupied = new Set([...this.#prefetches.values()].map(e => e.slot))
        const slot = ([0, 1] as const).find(s => !occupied.has(s))
        if (slot === undefined) break
        entry = { item, engine: extractor.engine, slot, version: ++this.#prefetchVersion, pending: false, resolved: false, prepared: null }
        this.#prefetches.set(item.track.id, entry)
      }
      const selected = entry, token = this.#token
      selected.pending = true
      if (admission) this.#audio.dispatchEvent(new CustomEvent('capturehandoff', { detail: {
        phase: 'prefetch-request', requestId: admission.requestId, resolution: admission.resolution,
        trackId: admission.trackId, nextTrackId: item.track.id, nextSlot: selected.slot,
      } }))
      this.#resolve(item, false, false, selected).then(playable => {
        if (this.#prefetches.get(item.track.id) !== selected) return
        if (selected.engine !== extractor.engine) { this.#removePrefetch(selected, true); return }
        selected.pending = false
        selected.resolved = true
        // Legacy sigue resolviendo su URL sin abrir otro consumidor MSE.
        if (audioSrc(playable).startsWith('musify-capture-legacy:')) return
        const audio = new Audio()
        this.#bindAudio(audio); audio.muted = true
        const stop = prepareAudioSource(audio, audioSrc(playable))
        selected.prepared = { id: item.track.id, playable, audio, stop }
        audio.addEventListener('captureerror', () => {
          if (this.#prefetches.get(item.track.id) === selected) this.#removePrefetch(selected, true)
        }, { once: true })
      }).catch(() => {
        if (this.#prefetches.get(item.track.id) !== selected) return
        selected.pending = false
        if (token !== this.#token) this.#prefetchNext()
        else this.#removePrefetch(selected, true)
      })
    }
  }

  #resolve(item: QueueItem, refresh: boolean, foreground = true, prefetch?: PrefetchEntry): Promise<Playable> {
    const id = item.track.id
    const key = `${foreground ? 'foreground' : 'next'}:${id}`
    let pending = this.#inFlight.get(key)
    if (!pending || refresh || pending.token !== this.#token ||
        (!foreground && pending.prefetchVersion !== prefetch?.version)) {
      // El clic debe llegar al backend para promocionar una precarga; allí se comparte la captura.
      const options = foreground ? this.#admissionOptions(item) : {
        expectedForeground: this.#currentAdmission()?.resolution,
        nextSlot: prefetch?.slot,
        isCurrent: () => !!prefetch && prefetch.engine === extractor.engine && this.#prefetches.get(id) === prefetch,
      }
      const entry = {
        promise: this.#cancelPending.then(() => {
          if (options.isCurrent?.() === false) throw new DOMException('Resolución sustituida', 'AbortError')
          return api.resolve(toQuery(item), refresh, foreground, options)
        }),
        token: this.#token,
        prefetchVersion: prefetch?.version ?? 0,
      }
      pending = entry
      this.#inFlight.set(key, entry)
      entry.promise.finally(() => this.#inFlight.get(key) === entry && this.#inFlight.delete(key)).catch(() => {})
    }
    return pending.promise
  }

  #currentAdmission() {
    const a = this.#admission
    return a && a.token === this.#token && a.audio === this.#audio && a.trackId === this.current?.track.id &&
      extractor.engine === 'oficial' ? a : null
  }

  #admissionOptions(item: QueueItem): api.ResolutionOptions {
    const token = this.#token, audio = this.#audio, engine = extractor.engine
    const isCurrent = () => token === this.#token && audio === this.#audio && item.track.id === this.current?.track.id
    return {
      isCurrent,
      ...(engine === 'oficial' ? { onAdmitted: (admission: api.ForegroundAdmission) => {
        if (!isCurrent() || extractor.engine !== engine || admission.engine !== engine ||
            admission.trackId !== item.track.id || !Number.isSafeInteger(admission.resolution) || admission.resolution < 0 ||
            !/^[A-Za-z0-9_-]{11}$/.test(admission.videoId)) return
        this.#admission = { ...admission, token, audio }
        if (Number.isInteger(admission.prefetchSlots) && admission.prefetchSlots! >= 0 && admission.prefetchSlots! <= 2)
          this.#prefetchLimit = admission.prefetchSlots!
        audio.dispatchEvent(new CustomEvent('capturehandoff', { detail: { ...admission, phase: 'foreground-admitted' } }))
        this.#prefetchNext()
      } } : {}),
    }
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
      this.#admission = null
      this.#discardPrefetch(true)
      this.status = 'idle'
      this.picking = item
      return
    }
    if (reason.includes('CAPTURE_REQUIRES_INTERACTION')) {
      this.#admission = null
      this.#discardPrefetch(true)
      this.captureInteraction = reason.split('CAPTURE_REQUIRES_INTERACTION:').pop()?.trim() || 'YouTube necesita tu intervención.'
      this.status = 'idle'
      return
    }
    this.#failures++
    toast.show(`No se pudo reproducir «${item.track.title}»: ${reason}`)
    if (this.#failures < MAX_FAILURES && (this.userQueue.length > 0 || this.pos < this.order.length - 1)) {
      this.next()
    } else {
      this.#admission = null
      this.#discardPrefetch(true)
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

/** En Android suena el servicio nativo (sigue con la pantalla apagada); en escritorio, la interfaz. */
export const player: PlayerApi = isAndroid ? new AndroidPlayer() : new Player()
