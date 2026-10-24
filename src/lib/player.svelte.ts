import { convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import * as api from './api'
import { downloads } from './downloads.svelte'
import { CAPTURE, captureProgress, captureReady, waitForCaptureReady, setAudioSource, stopCapture, prepareAudioSource, adoptAudioSource, seekCapture } from './extractor/capture'
import { extractor } from './extractor/engine.svelte'
import { library, toLib } from './library.svelte'
import { isPodcast, isYouTubeTrack, mediaUrl } from './media'
import { toast } from './toast.svelte'
import { episodeProgress } from './podcast-progress.svelte'
import { AndroidPlayer, isAndroid } from './player-android.svelte'
import { load, playOrder, save, toQuery, type PlayerApi, type QueueItem, type Repeat, type Status } from './queue'
import type { Playable } from './types'
import { isSleepMinutes, type SleepTimerState } from './sleep-timer'

export { toQuery, type QueueItem, type Repeat }

type PreparedAudio = { id: number; playable: Playable; audio: HTMLAudioElement; stop: (cancelBackend?: boolean) => void }
type CapturePromotion = { token: number; audio: HTMLAudioElement; ready: boolean; played: boolean; interrupted: boolean }
type PrefetchEntry = { item: QueueItem; engine: string; slot: 0 | 1; version: number; pending: boolean; resolved: boolean; prepared: PreparedAudio | null }

/** Tras tantos fallos seguidos se deja de saltar a la siguiente (p. ej. sin conexión). */
const MAX_FAILURES = 3
const RESOLVE_TIMEOUT = 120_000
const AUDIO_TIMEOUT = 30_000
/** Lo que espera el cierre de la ventana a que se guarde el punto del pódcast. */
const CLOSE_TIMEOUT = 1_500

/** También limita las promesas del navegador que no llegan a resolver ni rechazar. */
function withTimeout<T>(pending: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

function audioError(audio: HTMLAudioElement): string {
  if (audio.error?.code === 3) return 'No se pudo decodificar el audio'
  // SRC_NOT_SUPPORTED también puede ser un HTTP 403 de una URL caducada.
  if (audio.error?.code === 4) return 'No se pudo cargar la fuente de audio'
  return audio.error?.message || 'El audio no se puede reproducir'
}

/** Linux sirve los archivos por HTTP local porque WebKitGTK no reproduce audio desde asset://. */
function audioSrc(p: Playable): string {
  if (!p.local) return p.url
  if (p.url.startsWith('http://127.0.0.1:')) {
    try {
      const url = new URL(p.url)
      if (url.hostname === '127.0.0.1' && !url.username && !url.password) return p.url
    } catch {
      // Una ruta local o una URL inválida sigue usando el protocolo de archivos de Tauri.
    }
  }
  return convertFileSrc(p.url)
}

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
  sleepTimer = $state<SleepTimerState>({ mode: 'off', endsAt: 0 })
  /** Canción para la que está abierto el selector "¿No es esta canción?". */
  picking = $state<QueueItem | null>(null)
  /** YouTube necesita que la persona resuelva algo en su ventana antes de reintentar. */
  captureInteraction = $state<string | null>(null)

  #audio: HTMLAudioElement
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
  #sourceLocal = true
  #playable: Playable | null = null
  /** La intención del usuario es independiente de los eventos tardíos del navegador. */
  #wantsPlay = false
  #progressTimer: ReturnType<typeof setTimeout> | undefined
  #progressAt = 0
  /** Una reparación automática por bloqueo; Reproducir permite volver a intentarlo. */
  #repaired = false
  #failures = 0
  /** Si la canción actual ya se apuntó en el historial. */
  #recorded = false
  #nextKey = 1
  // La cola visible puede cambiar antes de sustituir el audio que todavía suena.
  #activeItem: QueueItem | null = null
  #progressSavedAt = 0
  #completed = false
  #resumeAt = 0
  #requestedSeek: number | null = null
  #metadataReady = false
  #positionKnown = false
  #sleepTimeout: ReturnType<typeof setTimeout> | undefined
  #sleepDeadline = 0

  constructor() {
    this.#audio = this.#createAudio()
    this.#setupMediaSession()
    window.addEventListener('pagehide', () => this.#saveProgress(true))
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.#saveProgress(true)
      else this.#checkSleepTimer()
    })
    window.addEventListener('focus', () => this.#checkSleepTimer())
    if (api.inTauri) {
      const win = getCurrentWindow()
      void win.onCloseRequested(async (event) => {
        event.preventDefault()
        try {
          this.#pause()
          this.#saveProgress(true)
          // Si la base de datos no responde, se cierra igual: como mucho se pierde el último punto.
          await withTimeout(episodeProgress.flush(), CLOSE_TIMEOUT, 'cierre').catch(() => {})
        } finally {
          await win.destroy()
        }
      }).catch(() => {})
    }
  }

  /** Un elemento por carga: los eventos tardíos de una canción anterior se ignoran. */
  #createAudio() {
    const a = new Audio()
    this.#bindAudio(a)
    return a
  }

  #bindAudio(a: HTMLAudioElement) {
    const on = (name: string, listener: (event: Event) => void) =>
      a.addEventListener(name, event => { if (a === this.#audio) listener(event) })
    a.preload = 'auto'
    a.volume = this.volume
    a.muted = this.muted
    a.addEventListener('timeupdate', () => {
      if (a === this.#audio && this.#checkSleepTimer()) return
      // Mientras carga la siguiente, el audio aún tiene el tiempo de la anterior: se ignora.
      if (a !== this.#audio || this.status === 'loading') return
      this.time = a.currentTime
      this.#watchProgress()
      this.#maybeRecord()
      this.#saveProgress()
    })
    a.addEventListener('loadedmetadata', () => {
      if (a !== this.#audio) return
      this.#metadataReady = true
      if (!this.#resumeAt) return
      // YouTube y RSS pueden tener duraciones distintas; conservar los segundos sin salir del audio.
      a.currentTime = Number.isFinite(a.duration) && a.duration > 0
        ? Math.min(this.#resumeAt, Math.max(0, a.duration - 1)) : this.#resumeAt
      this.time = a.currentTime
      this.#resumeAt = 0
    })
    a.addEventListener('durationchange', () => {
      if (a !== this.#audio) return
      if (Number.isFinite(a.duration)) this.duration = a.duration
      this.#syncPosition()
    })
    a.addEventListener('playing', () => {
      if (a !== this.#audio || this.#checkSleepTimer() || !this.#wantsPlay) {
        a.pause()
        return
      }
      if (a.paused || a.error) return
      this.status = 'playing'
      this.#requestedSeek = null
      this.#failures = 0
      this.#watchProgress()
      this.#syncPosition()
      this.#withMediaSession((ms) => { ms.playbackState = 'playing' })
      if (this.#promotion) {
        if (this.#promotion.interrupted) this.#promotion.played = true
        this.#completePromotion(this.#promotion)
      }
    })
    a.addEventListener('pause', () => {
      if (a !== this.#audio || !a.paused) return
      this.#clearProgressTimer()
      if (this.status === 'playing') this.status = 'paused'
      this.#saveProgress(true)
      this.#withMediaSession((ms) => { ms.playbackState = 'paused' })
    })
    a.addEventListener('seeked', () => {
      if (a !== this.#audio) return
      this.#syncPosition()
      this.#watchProgress()
      this.#saveProgress(true)
    })
    a.addEventListener('ended', () => {
      if (a !== this.#audio || !this.#wantsPlay || this.status === 'loading') return
      this.#clearProgressTimer()
      this.#completed = true
      this.#saveProgress(true)
      if (this.sleepTimer.mode === 'end') {
        this.#finishSleep(true)
        return
      }
      if (this.#checkSleepTimer()) return
      if (this.repeat === 'one') {
        this.#recorded = false
        this.#completed = false
        a.currentTime = 0
        this.time = 0
        this.#resume()
      } else {
        this.next()
      }
    })
    a.addEventListener('error', () => { if (a === this.#audio) this.#onAudioError() })
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

  #resetAudio(cancelBackend = true, nextAudio?: HTMLAudioElement) {
    this.#clearProgressTimer()
    const previous = this.#audio
    this.#audio = nextAudio ?? this.#createAudio()
    this.#source = null
    this.#admission = null
    this.#promotion = null
    this.#sourceLocal = true
    this.#playable = null
    this.#metadataReady = false
    this.#resumeAt = 0
    stopCapture(cancelBackend)
    previous.pause()
    previous.removeAttribute('src')
    previous.load()
    this.#withMediaSession((ms) => { ms.playbackState = 'paused' })
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

  /** Reproduce una colección (`start = null`) o una canción concreta. Tu cola se conserva. */
  playQueue(items: QueueItem[], start: number | null, context = '') {
    if (!items.length) return
    this.queue = items
    this.context = context || (items.every((i) => i.albumId === items[0]?.albumId) ? (items[0]?.albumTitle ?? '') : '')
    this.order = playOrder(items.length, start, this.shuffle)
    this.#load(this.shuffle ? 0 : (start ?? 0))
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
    if (this.status === 'playing' || this.status === 'loading' && this.#wantsPlay) this.#pause()
    else this.#resume()
  }

  #pause() {
    if (!this.current) return
    this.#wantsPlay = false
    this.#clearProgressTimer()
    this.#saveProgress(true)
    // Una promoción ya tiene audio confirmado: pausar no revoca su acuse nativo.
    if (this.status === 'loading') {
      this.#cancelLoading()
      this.status = 'paused'
      return
    }
    if (!this.#promotion) ++this.#token
    if (this.#audio.src) this.time = Math.max(this.time, this.#audio.currentTime)
    this.#audio.pause()
    this.status = 'paused'
  }

  async #resume() {
    const item = this.current
    if (!item || this.#wantsPlay && this.status === 'loading') return
    if (this.#checkSleepTimer()) return
    this.#wantsPlay = true
    this.#repaired = false
    if (!this.#audio.src || this.status === 'idle' || !this.#activeItem) {
      this.#start(item, false, this.time, true)
      return
    }
    const token = this.#promotion ? this.#token : ++this.#token
    const at = this.time
    this.status = 'loading'
    try {
      await this.#playElement(this.#audio)
      if (token === this.#token && this.#wantsPlay) this.#prefetchNext()
    } catch (e) {
      if (token !== this.#token || !this.#wantsPlay) return
      if (this.#canRefreshSource()) this.#repair(at)
      else this.#fail(item, String(e), token, false)
    }
  }

  #cancelLoading() {
    ++this.#token
    this.#wantsPlay = false
    this.#loadingCanPrefetch = false
    this.#pendingSource = null
    this.#inFlight.clear()
    this.#discardPrefetch(true)
    this.#resetAudio()
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
      this.#saveProgress(true)
      this.#activeItem = null
      this.#positionKnown = false
      if (this.status === 'loading') {
        this.#cancelLoading()
        return
      }
      this.#pause()
      this.#audio.currentTime = 0
      this.time = 0
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
    if (this.#source?.kind === 'capture') {
      const audio = this.#audio, token = this.#token
      void seekCapture(audio, seconds).then(ready => {
        if (!ready || token !== this.#token || audio !== this.#audio) return
        this.#completed = false
        this.#positionKnown = true
        this.#requestedSeek = null
        this.time = seconds
        this.#syncPosition()
      })
      return
    }
    this.#completed = false
    this.#positionKnown = true
    if (this.status === 'loading') {
      this.#requestedSeek = seconds
      this.time = seconds
      if (this.#activeItem && this.#metadataReady) {
        this.#resumeAt = 0
        this.#audio.currentTime = seconds
      } else this.#resumeAt = seconds
      return
    }
    this.#resumeAt = 0
    this.#audio.currentTime = seconds
    this.time = seconds
    this.#clearProgressTimer()
    this.#watchProgress()
    this.#saveProgress(true)
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

  async setSleepTimer(minutes: number): Promise<boolean> {
    if (minutes !== 0 && minutes !== -1 && !isSleepMinutes(minutes)) return false
    if (minutes !== 0 && !this.current) return false
    clearTimeout(this.#sleepTimeout)
    this.#sleepTimeout = undefined
    this.#sleepDeadline = 0
    if (minutes === 0) this.sleepTimer = { mode: 'off', endsAt: 0 }
    else if (minutes === -1) this.sleepTimer = { mode: 'end', endsAt: 0 }
    else {
      const delay = minutes * 60_000
      this.sleepTimer = { mode: 'time', endsAt: Date.now() + delay }
      this.#sleepDeadline = performance.now() + delay
      this.#scheduleSleepCheck()
    }
    return true
  }

  #checkSleepTimer(): boolean {
    if (this.sleepTimer.mode !== 'time' || performance.now() < this.#sleepDeadline) return false
    this.#finishSleep()
    return true
  }

  #scheduleSleepCheck() {
    this.#sleepTimeout = setTimeout(() => {
      if (!this.#checkSleepTimer() && this.sleepTimer.mode === 'time') this.#scheduleSleepCheck()
    }, Math.max(1, this.#sleepDeadline - performance.now()))
  }

  #finishSleep(atEnd = false) {
    void this.setSleepTimer(0)
    // La pausa invalida cargas pendientes y detiene el detector de bloqueos y la recuperación.
    this.#pause()
    if (atEnd || this.#completed) {
      this.#activeItem = null
      this.#positionKnown = false
      this.#resetAudio()
      this.time = 0
    }
    this.#withMediaSession((ms) => { ms.playbackState = 'paused' })
  }

  /**
   * Fija a mano el vídeo de una canción y lo recuerda. Si es la que suena, se cambia al momento;
   * si no, solo se guarda para la próxima vez.
   */
  async useSource(videoId: string, item: QueueItem | null = this.current, onError?: (message: string) => void): Promise<boolean> {
    if (!item || isPodcast(item.track.id) || isYouTubeTrack(item.track.id)) return false
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

    this.#saveProgress(true)
    this.#discardPrefetch(true)
    const token = ++this.#token
    this.#loadingCanPrefetch = true
    this.#pendingSource = null
    this.captureInteraction = null
    this.#wantsPlay = true
    this.#repaired = false
    this.status = 'loading'
    try {
      this.#resetAudio()
      await this.#cancelPending
      if (token !== this.#token) return false
      const playable = await withTimeout(
        api.chooseSource(toQuery(item), videoId, true, this.#admissionOptions(item)), RESOLVE_TIMEOUT,
        'No se pudo preparar el audio a tiempo. Vuelve a intentarlo')
      redownload()
      if (token !== this.#token) return true
      this.#retried = false
      try {
        await this.#playAudio(playable)
      } catch (e) {
        if (token !== this.#token) return true
        if (!this.#canRefreshSource()) throw e
        this.#resetAudio()
        this.#retried = true
        const refreshed = await this.#resolve(item, true)
        if (token !== this.#token) return true
        await this.#playAudio(refreshed)
      }
      if (token !== this.#token) return true
      this.#prefetchNext()
      toast.show('Hecho: a partir de ahora esta canción sonará con ese vídeo')
      return true
    } catch (e) {
      if (token === this.#token) {
        if (String(e).includes('CAPTURE_REQUIRES_INTERACTION')) {
          this.#pendingSource = { videoId, item }
          this.#fail(item, String(e), token)
        } else {
          ++this.#token
          this.#wantsPlay = false
          this.#discardPrefetch(true)
          this.#resetAudio()
          this.status = 'idle'
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
    if (!refresh && this.sleepTimer.mode === 'end') void this.setSleepTimer(0)
    this.manual = null
    this.pos = pos
    this.#start(item, refresh, startAt)
  }

  /** Pone una canción de tu cola (sin mover la posición en el disco o playlist de fondo). */
  #loadManual(item: QueueItem, refresh = false, startAt = 0) {
    if (!refresh && this.sleepTimer.mode === 'end') void this.setSleepTimer(0)
    this.manual = item
    this.#start(item, refresh, startAt)
  }

  async #start(item: QueueItem, refresh = false, startAt = 0, preserveHistory = false) {
    this.#saveProgress(true)
    this.#activeItem = null
    const restore = !refresh && (!preserveHistory || !this.#positionKnown)
    if (!preserveHistory && !refresh) {
      this.#requestedSeek = null
      this.#positionKnown = false
    }
    const prefetched = this.#prefetches.get(item.track.id)
    const prepared = !refresh && prefetched?.engine === extractor.engine ? prefetched.prepared : null
    // La señal nativa llega después de asegurar foreground. Un Audio preparado
    // conserva además su barrera de promoción y reproducción.
    this.#loadingCanPrefetch = !prepared
    if (prefetched) this.#removePrefetch(prefetched, false, !!prepared)
    this.#prunePrefetch(this.#followingItems())
    const token = ++this.#token
    this.#pendingSource = null
    this.captureInteraction = null
    this.#wantsPlay = true
    if (!refresh) this.#repaired = false
    if (!refresh && !preserveHistory) this.#recorded = false
    this.status = 'loading'
    this.time = startAt
    this.duration = item.track.duration
    const readyPrepared = !refresh && prepared && startAt === 0 && !isPodcast(item.track.id) && this.#readyCapture(prepared)
    this.#resetAudio(true, readyPrepared ? prepared.audio : undefined)
    this.#updateMediaSession(item)

    if (readyPrepared) {
      // Sólo audio confirmado: promover el ticket en paralelo no retrasa play.
      this.#adoptPrepared(prepared)
      this.#rememberPlayback(item, prepared.playable)
      this.#activeItem = item
      this.#completed = false
      this.#positionKnown = true
      this.#metadataReady = true
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
        await this.#playElement(prepared.audio)
        if (!current()) return
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
        this.#fail(item, String(error), token)
      }
      return
    }

    try {
      this.#retried = refresh
      const [playable, savedAt] = await Promise.all([
        this.#resolve(item, refresh),
        restore && isPodcast(item.track.id)
          ? episodeProgress.position(item.track.id).catch(() => {
              toast.show('No se pudo recuperar el punto de escucha del pódcast')
              return 0
            }) : Promise.resolve(startAt),
      ])
      if (token !== this.#token) { prepared?.stop(false); return }
      const adopt = !!prepared && audioSrc(prepared.playable) === audioSrc(playable)
      if (adopt) this.#adoptPrepared(prepared!)
      else prepared?.stop(false)
      await this.#playAudio(playable, savedAt, adopt)
      if (token !== this.#token) return
      this.#prefetchNext()
    } catch (e) {
      prepared?.stop(false)
      if (token !== this.#token) return
      if (this.#canRefreshSource()) {
        this.#start(item, true, this.#requestedSeek ?? this.time)
        return
      }
      this.#fail(item, String(e), token)
    }
  }

  async #playAudio(playable: Playable, startAt = 0, adopted = false) {
    const a = this.#audio
    const token = this.#token
    this.#activeItem = this.current
    if (this.#activeItem) this.#rememberPlayback(this.#activeItem, playable)
    this.#completed = false
    this.#progressSavedAt = Date.now()
    this.#positionKnown = true
    this.#metadataReady = adopted && a.readyState >= 1
    const at = this.#requestedSeek ?? startAt
    this.#resumeAt = playable.url.startsWith(CAPTURE) ? 0 : at
    this.time = at
    if (!adopted) setAudioSource(a, audioSrc(playable))
    if (playable.url.startsWith(CAPTURE)) {
      if (at) await seekCapture(a, at)
    } else if (adopted && this.#resumeAt) {
      // El metadata de una precarga pudo llegar antes de adoptarla.
      a.currentTime = Number.isFinite(a.duration) && a.duration > 0
        ? Math.min(this.#resumeAt, Math.max(0, a.duration - 1)) : this.#resumeAt
      this.time = a.currentTime
      this.#resumeAt = 0
    }
    if (token !== this.#token || a !== this.#audio) return
    await this.#playElement(a)
  }

  #saveProgress(force = false) {
    const item = this.#activeItem
    const audio = this.#audio
    if (!item || !isPodcast(item.track.id) || !this.#metadataReady || this.status === 'loading' || this.#resumeAt) return
    if (!Number.isFinite(audio.currentTime) || (!force && Date.now() - this.#progressSavedAt < 5000)) return
    this.#progressSavedAt = Date.now()
    void episodeProgress.save({
      id: item.track.id,
      position: audio.currentTime,
      duration: Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0,
      completed: this.#completed,
    })
  }

  async #playElement(a: HTMLAudioElement) {
    const token = this.#token
    if (this.#source?.kind === 'capture' && !captureReady(a)) await waitForCaptureReady(a)
    if (token !== this.#token || a !== this.#audio || !this.#wantsPlay)
      throw new DOMException('Reproducción sustituida', 'AbortError')
    let onError: () => void = () => {}
    const started = new Promise<void>((resolve, reject) => {
      onError = () => reject(new Error(audioError(a)))
      a.addEventListener('error', onError)
      try {
        if (a.error) throw new Error(audioError(a))
        a.play().then(resolve, reject)
      } catch (e) {
        reject(e)
      }
    })
    try {
      await withTimeout(started, AUDIO_TIMEOUT, 'El reproductor no ha podido iniciar el audio (30 s). Vuelve a intentarlo')
    } finally {
      a.removeEventListener('error', onError)
    }
  }

  #clearProgressTimer() {
    clearTimeout(this.#progressTimer)
    this.#progressTimer = undefined
  }

  /** `playing` y una promesa resuelta no garantizan que el decoder avance (WebKit incluido). */
  #watchProgress() {
    const a = this.#audio
    if (!this.#wantsPlay || a.paused || !a.src || this.#source?.kind === 'capture') return
    // No alargar el plazo por timeupdate/playing repetidos con la misma posición.
    if (this.#progressTimer !== undefined && a.currentTime <= this.#progressAt + 0.05) return
    this.#clearProgressTimer()
    this.#progressAt = a.currentTime
    const token = this.#token
    this.#progressTimer = setTimeout(() => {
      this.#progressTimer = undefined
      if (token !== this.#token || a !== this.#audio || !this.#wantsPlay || a.paused) return
      if (a.currentTime > this.#progressAt + 0.05) this.#watchProgress()
      else this.#repair(Math.max(this.time, this.#progressAt, a.currentTime))
    }, AUDIO_TIMEOUT)
  }

  /** Reconstruye el decoder una vez, sin cambiar de canción ni reextraer los archivos locales. */
  async #repair(at: number) {
    if (this.#checkSleepTimer()) return
    const item = this.current
    const playable = this.#playable
    if (!item || !playable || !this.#wantsPlay) return
    if (this.#repaired) {
      this.#fail(item, 'El audio no avanza. Pulsa Reproducir para volver a intentarlo', this.#token, false)
      return
    }
    this.#repaired = true
    this.#saveProgress(true)
    const token = ++this.#token
    this.time = at
    this.status = 'loading'
    this.#resetAudio()
    try {
      // Una ruta local sigue siendo local; nunca se busca en YouTube para reparar su decoder.
      const source = playable.local ? playable : await this.#resolve(item, true)
      if (token !== this.#token) return
      this.#retried = !source.local
      await this.#playAudio(source, at)
    } catch (e) {
      if (token === this.#token) this.#fail(item, String(e), token, false)
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
    this.#sourceLocal = playable.local
    this.#playable = playable
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
    const discarded = [...this.#prefetches.values()].filter(entry =>
      !wanted.has(entry.item.track.id) || entry.engine !== extractor.engine)
    // Sólo ambas plazas: tras adoptar una canción puede quedar una entrada cuya
    // cancelación no debe revocar la plaza promovida todavía pendiente en Rust.
    if (this.#prefetches.size === 2 && discarded.length === 2 &&
        discarded.some(entry => entry.slot === 0) && discarded.some(entry => entry.slot === 1)) {
      this.#discardPrefetch(true)
      return
    }
    for (const entry of discarded) this.#removePrefetch(entry, true)
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
          return withTimeout(api.resolve(toQuery(item), refresh, foreground, options), RESOLVE_TIMEOUT,
            'No se pudo preparar el audio a tiempo. Vuelve a intentarlo')
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

  /** Una URL remota caducada puede aparecer como error de red o de fuente no compatible. */
  #canRefreshSource() {
    const code = this.#audio.error?.code
    return !this.#retried && !this.#sourceLocal && this.#source?.kind !== 'capture' && (code === 2 || code === 4)
  }

  /** El audio falló a mitad: si la URL pudo caducar, se pide otra una vez y se sigue donde iba. */
  #onAudioError() {
    if (this.#checkSleepTimer()) return
    const item = this.current
    // Al arrancar, #playAudio recoge tanto el evento error como el rechazo de play(): un solo fallo.
    if (this.status === 'loading' || !item || !this.#audio.src || !this.#wantsPlay) return
    const at = this.#audio.currentTime
    if (!this.#canRefreshSource())
      this.#fail(item, audioError(this.#audio), this.#token, !this.#repaired)
    else if (this.manual) this.#loadManual(this.manual, true, at)
    else this.#load(this.pos, true, at)
  }

  #fail(item: QueueItem, reason: string, token = this.#token, advance = true) {
    if (token !== this.#token) return
    if (this.#checkSleepTimer()) return
    if (this.sleepTimer.mode === 'end') {
      toast.show(`No se pudo reproducir «${item.track.title}»: ${reason}`)
      this.#finishSleep()
      this.#activeItem = null
      this.#resetAudio()
      return
    }
    this.#saveProgress(true)
    ++this.#token
    this.#wantsPlay = false
    const interaction = reason.includes('CAPTURE_REQUIRES_INTERACTION')
    this.#resetAudio(!interaction)
    this.#discardPrefetch(true)
    if (reason.includes('SOURCE_SELECTION_REQUIRED')) {
      this.status = 'idle'
      this.picking = item
      return
    }
    if (interaction) {
      this.captureInteraction = reason.split('CAPTURE_REQUIRES_INTERACTION:').pop()?.trim() || 'YouTube necesita tu intervención.'
      this.status = 'idle'
      return
    }
    this.#failures++
    toast.show(`No se pudo reproducir «${item.track.title}»: ${reason}`)
    if (advance && this.#failures < MAX_FAILURES && (this.userQueue.length > 0 || this.pos < this.order.length - 1)) {
      this.next()
    } else {
      this.status = 'idle'
    }
  }

  // Teclas multimedia del teclado y panel multimedia de Windows.
  #setupMediaSession() {
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => { if (this.status !== 'playing') this.#resume() }],
      ['pause', () => this.#pause()],
      ['previoustrack', () => this.prev()],
      ['nexttrack', () => this.next()],
      ['seekto', (d) => d.seekTime != null && this.seek(d.seekTime)],
    ]
    for (const [action, handler] of handlers) this.#withMediaSession((ms) => ms.setActionHandler(action, handler))
  }

  #withMediaSession(update: (session: MediaSession) => void) {
    try {
      if ('mediaSession' in navigator) update(navigator.mediaSession)
    } catch {
      // Integración opcional: un WebView sin esta función no debe impedir que suene el audio.
    }
  }

  #updateMediaSession(item: QueueItem) {
    this.#withMediaSession((ms) => {
      if (typeof MediaMetadata === 'undefined') return
      const cover = mediaUrl(item.cover)
      ms.metadata = new MediaMetadata({
        title: item.track.title,
        artist: item.track.artist.name,
        album: item.albumTitle,
        artwork: cover ? [{ src: cover, sizes: '500x500', type: 'image/jpeg' }] : [],
      })
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
