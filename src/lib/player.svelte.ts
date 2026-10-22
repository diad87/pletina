import { convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import * as api from './api'
import { downloads } from './downloads.svelte'
import { setAudioSource, stopCapture } from './extractor/capture'
import { library, toLib } from './library.svelte'
import { isPodcast, isYouTubeTrack, mediaUrl } from './media'
import { toast } from './toast.svelte'
import { episodeProgress } from './podcast-progress.svelte'
import { AndroidPlayer, isAndroid } from './player-android.svelte'
import { load, playOrder, save, toQuery, type PlayerApi, type QueueItem, type Repeat, type Status } from './queue'
import type { Playable } from './types'
import { isSleepMinutes, type SleepTimerState } from './sleep-timer'
import { readWebQueue, writeWebQueue, type QueueStorage } from '../../web-port/queue-persistence'

export { toQuery, type QueueItem, type Repeat }

/** Tras tantos fallos seguidos se deja de saltar a la siguiente (p. ej. sin conexión). */
const MAX_FAILURES = 3
const RESOLVE_TIMEOUT = 120_000
const AUDIO_TIMEOUT = 30_000
/** Lo que espera el cierre de la ventana a que se guarde el punto del pódcast. */
const CLOSE_TIMEOUT = 1_500
const PREPARE_AHEAD = 60_000
const PREPARE_RETRY = 60_000
/** Sólo se permite omitir una introducción breve y verificada, nunca la canción entera. */
const MAX_SOURCE_START = 60

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
  if (api.inPwa) {
    try {
      const scope = new URL('../', window.location.href)
      const url = new URL(p.url)
      const prefix = scope.pathname + '__audio__/'
      const id = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ''
      const secure = url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      if (secure && url.origin === scope.origin && !url.username && !url.password && !url.search && !url.hash &&
        /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id))) return url.href
    } catch { /* Una copia web solo se sirve por la ruta de su propio service worker. */ }
    throw new Error('La copia descargada no tiene una dirección local válida.')
  }
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

  #audio: HTMLAudioElement
  /** Cada carga tiene un número; si llega una respuesta de una carga anterior, se ignora. */
  #token = 0
  /** Búsquedas en curso por canción, para no repetirlas (p. ej. precarga + clic). */
  #inFlight = new Map<number, Promise<Playable>>()
  /** Una sola fuente siguiente, solo en RAM: ended no tiene que volver a abrir IndexedDB. */
  #preparedNext: { id: number; playable: Playable; expiresAt: number; position: number } | null = null
  #preparation = 0
  #preparingNext: { id: number; preparation: number } | null = null
  #prepareRetry: { id: number; at: number } | null = null
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
  #resumeRequestedAt = 0
  #resumeExplicit = false
  #requestedSeek: number | null = null
  #metadataReady = false
  #positionKnown = false
  #sleepTimeout: ReturnType<typeof setTimeout> | undefined
  #sleepDeadline = 0
  #queueSaveQueued = false
  #lastQueueSaved = 0

  constructor() {
    if (api.inPwa) {
      try {
        const audioNavigator = navigator as Navigator & { audioSession?: { type: string } }
        if (audioNavigator.audioSession) audioNavigator.audioSession.type = 'playback'
      } catch { /* Integración opcional. */ }
    }
    this.#audio = this.#createAudio()
    this.#setupMediaSession()
    if (api.inPwa) this.#restoreQueue()
    window.addEventListener('pagehide', () => {
      this.#saveProgress(true)
      this.#saveQueue(true)
    })
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.#saveProgress(true)
        this.#saveQueue()
        if (api.inPwa && this.#wantsPlay) this.#prefetchNext()
      }
      else if (!this.#checkSleepTimer() && api.inPwa && this.#wantsPlay) this.#prefetchNext()
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

  #queueStorage(): QueueStorage | undefined {
    try { return window.localStorage } catch { return undefined }
  }

  #restoreQueue() {
    // Reading localStorage is synchronous: no late restore can overwrite a user's
    // selection, and no network/decoder is started until an explicit Play action.
    const saved = readWebQueue(this.#queueStorage())
    if (!saved) return
    this.queue = saved.queue
    this.order = saved.order
    this.pos = saved.pos
    this.context = saved.context
    this.userQueue = saved.userQueue
    this.manual = saved.manual
    this.time = saved.position
    this.duration = saved.duration
    this.repeat = saved.repeat
    this.shuffle = saved.shuffle
    this.#recorded = saved.recorded
    this.#nextKey = saved.userQueue.reduce((next, value) => Math.max(next, value.key + 1), 1)
    this.#positionKnown = Boolean(this.current)
    this.status = this.current ? 'paused' : 'idle'
    if (this.current) {
      this.#updateMediaSession(this.current)
      this.#withMediaSession((ms) => { ms.playbackState = 'paused' })
    }
  }

  #saveQueue(immediate = false) {
    if (!api.inPwa) return
    if (!immediate) {
      if (this.#queueSaveQueued) return
      this.#queueSaveQueued = true
      queueMicrotask(() => {
        this.#queueSaveQueued = false
        this.#saveQueue(true)
      })
      return
    }
    this.#lastQueueSaved = Date.now()
    // Construct the snapshot now, not when the microtask was requested: a newer
    // queue edit wins. In ended, src/play handoff finishes before this write.
    const position = this.#activeItem?.track.id === this.current?.track.id && this.status !== 'loading' &&
      this.#metadataReady && !this.#resumeAt && Number.isFinite(this.#audio.currentTime)
      ? Math.max(0, this.#audio.currentTime) : this.time
    writeWebQueue(this.#queueStorage(), {
      version: 1, savedAt: Date.now(), queue: this.queue, order: this.order, pos: this.pos,
      context: this.context, userQueue: this.userQueue, manual: this.manual,
      position, duration: this.duration, repeat: this.repeat, shuffle: this.shuffle, recorded: this.#recorded,
    })
  }

  /** El escritorio renueva el elemento por carga; la PWA conserva el activado por el usuario. */
  #createAudio() {
    const a = new Audio()
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
      if (Date.now() - this.#lastQueueSaved >= 10000) this.#saveQueue()
      if (api.inPwa && this.#wantsPlay) this.#prefetchNext()
    })
    a.addEventListener('loadedmetadata', () => {
      if (a !== this.#audio) return
      const initial = !this.#metadataReady
      this.#metadataReady = true
      // Una duración real más corta invalida el salto de la fuente; no permite
      // convertir un metadato incorrecto en un seek cerca del final del audio.
      if (initial && this.#playable && !this.#resumeExplicit && this.#sourceStart(this.#playable) > 0) {
        this.#resumeAt = Math.max(this.#resumeRequestedAt, this.#sourceStart(this.#playable, a.duration))
        this.time = this.#resumeAt
      }
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
      if (a !== this.#audio) { a.pause(); return }
      this.#confirmPlaying(a, this.#token)
    })
    a.addEventListener('pause', () => {
      if (a !== this.#audio || !a.paused) return
      this.#clearProgressTimer()
      if (this.status === 'playing') this.status = 'paused'
      this.#saveProgress(true)
      this.#saveQueue()
      this.#withMediaSession((ms) => { ms.playbackState = 'paused' })
    })
    a.addEventListener('seeked', () => {
      if (a !== this.#audio) return
      this.#syncPosition()
      this.#watchProgress()
      this.#saveProgress(true)
      this.#saveQueue()
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
        a.currentTime = this.#playable ? this.#sourceStart(this.#playable, a.duration) : 0
        this.time = a.currentTime
        this.#resume()
      } else {
        this.next()
      }
    })
    a.addEventListener('error', () => { if (a === this.#audio) this.#onAudioError() })
    return a
  }

  #confirmPlaying(a: HTMLAudioElement, token: number) {
    if (a !== this.#audio || token !== this.#token) return
    if (this.#checkSleepTimer() || !this.#wantsPlay) {
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
    this.#saveQueue()
  }

  #resetAudio(recreate = false) {
    this.#clearProgressTimer()
    const previous = this.#audio
    // En web se conserva el elemento activado por el usuario entre canciones.
    // La reparación de un decoder bloqueado sí puede reconstruirlo.
    if (!api.inPwa || recreate) this.#audio = this.#createAudio()
    this.#sourceLocal = true
    this.#playable = null
    this.#metadataReady = false
    this.#resumeAt = 0
    this.#resumeRequestedAt = 0
    this.#resumeExplicit = false
    stopCapture()
    previous.pause()
    previous.removeAttribute('src')
    previous.load()
    this.#withMediaSession((ms) => { ms.playbackState = 'paused' })
  }

  get current(): QueueItem | null {
    return this.manual ?? this.queue[this.order[this.pos]] ?? null
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
    if (api.inPwa) this.#prefetchNext()
    this.#saveQueue()
  }

  /** Al principio de tu cola: suenan justo después de la actual. */
  playNext(items: QueueItem[]) {
    if (!items.length) return
    this.userQueue = [...this.#wrap(items), ...this.userQueue]
    toast.show(items.length === 1 ? `«${items[0].track.title}» sonará a continuación` : `${items.length} canciones sonarán a continuación`)
    this.#startIfIdle()
    if (api.inPwa) this.#prefetchNext()
    this.#saveQueue()
  }

  /** Inserta en tu cola en una posición concreta (al arrastrar al panel de la cola). */
  insertInQueue(items: QueueItem[], at: number) {
    const list = [...this.userQueue]
    list.splice(Math.max(0, Math.min(at, list.length)), 0, ...this.#wrap(items))
    this.userQueue = list
    this.#startIfIdle()
    if (api.inPwa) this.#prefetchNext()
    this.#saveQueue()
  }

  removeFromQueue(key: number) {
    this.userQueue = this.userQueue.filter((e) => e.key !== key)
    if (api.inPwa) this.#prefetchNext()
    this.#saveQueue()
  }

  moveInQueue(key: number, to: number) {
    const list = [...this.userQueue]
    const from = list.findIndex((e) => e.key === key)
    if (from < 0) return
    const [moved] = list.splice(from, 1)
    list.splice(Math.max(0, Math.min(to, list.length)), 0, moved)
    this.userQueue = list
    if (api.inPwa) this.#prefetchNext()
    this.#saveQueue()
  }

  clearQueue() {
    this.userQueue = []
    if (api.inPwa) this.#prefetchNext()
    this.#saveQueue()
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
    ++this.#token
    this.#clearProgressTimer()
    // Durante una renovación el elemento todavía no contiene audio; se conserva la posición guardada.
    if (this.#audio.src) this.time = Math.max(this.time, this.#audio.currentTime)
    this.#audio.pause()
    this.status = 'paused'
    this.#saveProgress(true)
    this.#saveQueue()
  }

  async #resume() {
    const item = this.current
    if (!item || this.#wantsPlay && this.status === 'loading') return
    if (this.#checkSleepTimer()) return
    this.#wantsPlay = true
    this.#repaired = false
    if (api.inPwa && this.#playable && !this.#playable.local && !isPodcast(item.track.id) &&
      this.#preparedExpiry(this.#playable, item.track.id) <= Date.now()) {
      this.#start(item, true, this.time, true)
      return
    }
    if (!this.#audio.src || this.status === 'idle' || !this.#activeItem) {
      this.#start(item, false, this.time, true)
      return
    }
    const token = ++this.#token
    const at = this.time
    this.status = 'loading'
    try {
      await this.#playElement(this.#audio)
      if (api.inPwa && token === this.#token) this.#prefetchNext()
    } catch (e) {
      if (token !== this.#token) return
      if (this.#canRefreshSource()) this.#repair(at)
      else this.#fail(item, String(e), token, false)
    }
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
        this.#wantsPlay = false
        ++this.#token
        this.#resetAudio()
        this.status = 'idle'
        this.#saveQueue()
        return
      }
      this.#pause()
      this.#audio.currentTime = 0
      this.time = 0
      this.status = 'paused'
      this.#saveQueue()
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
    this.#completed = false
    this.#positionKnown = true
    this.#resumeRequestedAt = seconds
    this.#resumeExplicit = true
    if (this.status === 'loading') {
      this.#requestedSeek = seconds
      this.time = seconds
      if (this.#activeItem && this.#metadataReady) {
        this.#resumeAt = 0
        this.#audio.currentTime = seconds
      } else this.#resumeAt = seconds
      this.#saveQueue()
      return
    }
    this.#resumeAt = 0
    this.#audio.currentTime = seconds
    this.time = seconds
    this.#clearProgressTimer()
    this.#watchProgress()
    this.#saveProgress(true)
    this.#saveQueue()
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
    this.#saveQueue()
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
    if (api.inPwa) this.#prefetchNext()
    this.#saveQueue()
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
  async useSource(videoId: string, item: QueueItem | null = this.current): Promise<boolean> {
    if (!item || isPodcast(item.track.id) || isYouTubeTrack(item.track.id)) return false
    if (api.inPwa) {
      this.#clearPrepared()
      this.#inFlight.delete(item.track.id)
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
        await api.chooseSource(toQuery(item), videoId)
        if (api.inPwa) this.#prefetchNext()
        redownload()
        toast.show(`Hecho: «${item.track.title}» sonará con ese vídeo`)
        return true
      } catch (e) {
        if (api.inPwa) this.#prefetchNext()
        toast.show(`No se pudo usar ese vídeo: ${e}`)
        return false
      }
    }

    const token = ++this.#token
    this.#wantsPlay = true
    this.#repaired = false
    this.status = 'loading'
    try {
      this.#resetAudio()
      const playable = await withTimeout(api.chooseSource(toQuery(item), videoId), RESOLVE_TIMEOUT,
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
      if (api.inPwa) this.#prefetchNext()
      toast.show('Hecho: a partir de ahora esta canción sonará con ese vídeo')
      return true
    } catch (e) {
      if (token === this.#token) {
        ++this.#token
        this.#wantsPlay = false
        this.#resetAudio()
        this.status = 'idle'
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
    this.#saveQueue()
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
    const prepared = api.inPwa && !refresh && startAt === 0 && this.#preparedNext?.id === item.track.id &&
      this.#preparedNext.expiresAt > Date.now() ? this.#preparedNext : null
    const sameEpisode = this.#activeItem?.track.id === item.track.id
    const previousPosition = this.#completed ? 0 : this.time
    if (api.inPwa) this.#clearPrepared()
    this.#saveProgress(true)
    this.#activeItem = null
    const restore = !refresh && (!preserveHistory || !this.#positionKnown)
    if (!preserveHistory && !refresh) {
      this.#requestedSeek = null
      this.#positionKnown = false
    }
    const token = ++this.#token
    this.#wantsPlay = true
    if (!refresh) this.#repaired = false
    // Recargar la misma canción (URL caducada) no cuenta como otra escucha.
    if (!refresh && !preserveHistory) this.#recorded = false
    this.status = 'loading'
    this.time = startAt
    this.duration = item.track.duration
    this.#saveQueue()
    try {
      if (prepared) {
        // Cambiar src y llamar a play en la misma tarea que ended, sin descargar el elemento
        // ni esperar a IndexedDB/red cuando el teléfono deja de tener audio activo.
        this.#clearProgressTimer()
        this.#updateMediaSession(item)
        this.#retried = false
        const position = restore && isPodcast(item.track.id)
          ? sameEpisode ? previousPosition : prepared.position : startAt
        await this.#playAudio(prepared.playable, position)
        if (token !== this.#token) return
        this.#prefetchNext()
        return
      }
      this.#resetAudio()
      this.#updateMediaSession(item)
      this.#retried = refresh
      const [playable, savedAt] = await Promise.all([
        this.#resolve(item, refresh),
        restore && isPodcast(item.track.id)
          ? episodeProgress.position(item.track.id).catch(() => {
              toast.show('No se pudo recuperar el punto de escucha del pódcast')
              return 0
            }) : Promise.resolve(startAt),
      ])
      if (token !== this.#token) return
      await this.#playAudio(playable, savedAt)
      if (token !== this.#token) return
      this.#prefetchNext()
    } catch (e) {
      // Un AbortError de esta carga también es un fallo; solo se ignoran las cargas sustituidas.
      if (token !== this.#token) return
      if (this.#checkSleepTimer()) return
      if (this.#canRefreshSource()) {
        this.#start(item, true, this.#requestedSeek ?? this.time)
        return
      }
      const official = api.inPwa ? api.automaticYouTubeSource(toQuery(item), e) : null
      if (official) {
        const at = this.#requestedSeek ?? this.time
        // Conserva canción y cola; invalida esta carga y detiene el Audio antes
        // de abrir el vídeo visible. No se lanza desde el resolver o la precarga.
        this.#pause()
        this.#clearPrepared()
        this.#resetAudio()
        if (api.openAutomaticYouTubePlayer(toQuery(item), official, at)) return
        this.#fail(item, String(e), this.#token)
        return
      }
      this.#fail(item, String(e), token)
    }
  }

  async #playAudio(playable: Playable, startAt = 0) {
    const a = this.#audio
    this.#activeItem = this.current
    this.#completed = false
    this.#progressSavedAt = Date.now()
    this.#positionKnown = true
    this.#metadataReady = false
    this.#resumeRequestedAt = this.#requestedSeek ?? startAt
    this.#resumeExplicit = this.#requestedSeek !== null
    // Un seek explícito del usuario puede volver al silencio inicial. El salto
    // de la fuente sólo se aplica al arrancar o reconstruir la reproducción.
    this.#resumeAt = this.#requestedSeek ?? Math.max(startAt, this.#sourceStart(playable))
    this.time = this.#resumeAt
    this.#sourceLocal = playable.local
    this.#playable = playable
    setAudioSource(a, audioSrc(playable))
    await this.#playElement(a)
  }

  #sourceStart(playable: Playable, duration = this.current?.track.duration ?? 0): number {
    if (!api.inPwa || playable.local || !this.current || isPodcast(this.current.track.id)) return 0
    const start = playable.source?.startAt
    return typeof start === 'number' && Number.isFinite(start) && start > 0 && start <= MAX_SOURCE_START &&
      (!Number.isFinite(duration) || duration <= 0 || start < duration) ? start : 0
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
    let onError: () => void = () => {}
    let stopProgress = () => {}
    const started = new Promise<void>((resolve, reject) => {
      onError = () => reject(new Error(audioError(a)))
      a.addEventListener('error', onError)
      if (api.inPwa) {
        // WebKit también puede dejar pendiente play() aunque el audio ya avance.
        // Dos muestras, ajenas a un seek, acreditan el inicio de esta fuente concreta.
        const source = a.src
        const id = this.#activeItem?.track.id
        let previous: number | null = null
        const reset = () => { previous = null }
        const progress = () => {
          if (a !== this.#audio || token !== this.#token || a.src !== source) { resolve(); return }
          if (!this.#wantsPlay || !this.#metadataReady || this.#resumeAt || a.paused || a.error || a.seeking ||
            id === undefined || id !== this.#activeItem?.track.id || id !== this.current?.track.id ||
            (a.currentSrc || a.src) !== source || !Number.isFinite(a.currentTime)) { reset(); return }
          if (previous !== null && a.currentTime > previous + 0.05) resolve()
          else previous = a.currentTime
        }
        a.addEventListener('timeupdate', progress)
        for (const type of ['loadedmetadata', 'seeking', 'seeked']) a.addEventListener(type, reset)
        stopProgress = () => {
          a.removeEventListener('timeupdate', progress)
          for (const type of ['loadedmetadata', 'seeking', 'seeked']) a.removeEventListener(type, reset)
        }
      }
      try {
        if (a.error) throw new Error(audioError(a))
        a.play().then(resolve, reject)
      } catch (e) {
        reject(e)
      }
    })
    try {
      await withTimeout(started, AUDIO_TIMEOUT, 'El reproductor no ha podido iniciar el audio (30 s). Vuelve a intentarlo')
      // Al reanudar, WebKit puede resolver play() sin repetir el evento playing.
      // Conserva el mismo vigilante de avance: una promesa resuelta no basta para el decoder.
      if (api.inPwa) this.#confirmPlaying(a, token)
    } catch (error) {
      if (api.inPwa && error instanceof DOMException && error.name === 'NotAllowedError') {
        if (a !== this.#audio || token !== this.#token) return
        // Conserva la fuente preparada: el siguiente toque puede iniciar el audio.
        this.#wantsPlay = false
        this.status = 'paused'
        toast.show('Audio preparado. Pulsa Reproducir para escucharlo.')
        return
      }
      throw error
    } finally {
      a.removeEventListener('error', onError)
      stopProgress()
    }
  }

  #clearProgressTimer() {
    clearTimeout(this.#progressTimer)
    this.#progressTimer = undefined
  }

  /** `playing` y una promesa resuelta no garantizan que el decoder avance (WebKit incluido). */
  #watchProgress() {
    const a = this.#audio
    if (!this.#wantsPlay || a.paused || !a.src) return
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
    if (api.inPwa) this.#clearPrepared()
    this.#resetAudio(true)
    try {
      // Una ruta local sigue siendo local; nunca se busca en YouTube para reparar su decoder.
      const source = playable.local ? playable : await this.#resolve(item, true)
      if (token !== this.#token) return
      this.#retried = !source.local
      await this.#playAudio(source, at)
      if (api.inPwa && token === this.#token) this.#prefetchNext()
    } catch (e) {
      if (token === this.#token) this.#fail(item, String(e), token, false)
    }
  }

  #following(): QueueItem | undefined {
    const nextPos = this.pos + 1 < this.order.length ? this.pos + 1 : this.repeat === 'all' ? 0 : -1
    return this.userQueue[0]?.item ?? this.queue[this.order[nextPos]]
  }

  #clearPrepared() {
    ++this.#preparation
    this.#preparedNext = null
    this.#preparingNext = null
    this.#prepareRetry = null
  }

  #preparedExpiry(source: Playable, id: number): number {
    const now = Date.now()
    let expiresAt = now + 5 * 60_000
    let temporary = false
    try {
      const params = new URL(source.url).searchParams
      const expiration = Number(params.get('expire') || params.get('expires')) * 1000
      if (Number.isFinite(expiration) && expiration > 0) {
        expiresAt = Math.min(now + 20 * 60_000, expiration - 60_000)
        temporary = true
      }
    } catch { /* Un origen sin caducidad explícita tiene una reserva corta. */ }
    // El enclosure RSS publicado no es una URL temporal de YouTube: puede esperar al siguiente
    // episodio aunque el actual dure horas. El navegador comprobará su disponibilidad al cargarlo.
    if (!temporary && isPodcast(id) && !source.videoId) expiresAt = Infinity
    if (!source.local && !isPodcast(id) && typeof source.source?.expiresAt === 'number' && Number.isFinite(source.source.expiresAt)) {
      expiresAt = Math.min(expiresAt, source.source.expiresAt - 60_000)
    }
    return expiresAt
  }

  /** Mientras suena una canción, se prepara la siguiente para que no haya espera. */
  #prefetchNext() {
    const following = this.#following()
    if (!api.inPwa) {
      if (following && following !== this.current) this.#resolve(following, false).catch(() => {})
      return
    }
    if (!following) { this.#clearPrepared(); return }
    const id = following.track.id
    const now = Date.now()
    if (this.#preparedNext?.id === id && this.#preparedNext.expiresAt > now + PREPARE_AHEAD) return
    if (this.#preparingNext?.id === id || this.#prepareRetry?.id === id && this.#prepareRetry.at > now) return
    const previous = this.#preparedNext?.id === id ? this.#preparedNext : null
    this.#clearPrepared()
    // Una renovación de red fallida no inutiliza una fuente que todavía no ha caducado.
    if (previous && previous.expiresAt > now) this.#preparedNext = previous
    const preparation = this.#preparation
    this.#preparingNext = { id, preparation }
    // Una aparición duplicada de la canción actual puede reutilizar su fuente vigente.
    const currentSource = !previous && id === this.current?.track.id ? this.#playable : null
    const pending = currentSource && this.#preparedExpiry(currentSource, id) > now
      ? Promise.resolve(currentSource) : this.#resolve(following, !!previous || !!currentSource)
    const position = isPodcast(id) && id !== this.current?.track.id ? episodeProgress.position(id) : Promise.resolve(0)
    Promise.all([pending, position]).then(([playable, position]) => {
      if (preparation !== this.#preparation || this.#following()?.track.id !== id) return
      const expiresAt = this.#preparedExpiry(playable, id)
      if (expiresAt > Date.now()) this.#preparedNext = { id, playable, expiresAt, position }
      else this.#prepareRetry = { id, at: Date.now() + PREPARE_RETRY }
    }).catch(() => {
      if (preparation === this.#preparation) this.#prepareRetry = { id, at: Date.now() + PREPARE_RETRY }
    }).finally(() => {
      if (this.#preparingNext?.preparation === preparation) this.#preparingNext = null
    })
  }

  #resolve(item: QueueItem, refresh: boolean): Promise<Playable> {
    const id = item.track.id
    let pending = this.#inFlight.get(id)
    if (!pending || refresh) {
      pending = withTimeout(api.resolve(toQuery(item), refresh), RESOLVE_TIMEOUT,
        'No se pudo preparar el audio a tiempo. Vuelve a intentarlo')
      this.#inFlight.set(id, pending)
      pending.finally(() => this.#inFlight.get(id) === pending && this.#inFlight.delete(id)).catch(() => {})
    }
    return pending
  }

  /** Una URL remota caducada puede aparecer como error de red o de fuente no compatible. */
  #canRefreshSource() {
    const code = this.#audio.error?.code
    return !this.#retried && !this.#sourceLocal && (code === 2 || code === 4)
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

  #fail(item: QueueItem, reason: string, token: number, advance = true) {
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
    this.#resetAudio()
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
