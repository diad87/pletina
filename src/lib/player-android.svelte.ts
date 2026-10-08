// Reproductor de Android: la música suena en el servicio nativo (PlaybackService.kt, con ExoPlayer),
// que sigue con la pantalla apagada, pasa de canción y prepara la siguiente sin la interfaz. Esto es
// solo el mando: manda órdenes (`player_native`, ver src-tauri/src/native_player.rs) y enseña lo
// que el servicio cuenta ("player-timeline" y "player-status").
//
// La cola nativa es la lista en el orden en que va a sonar: lo ya escuchado, la actual, tu cola (DJ)
// justo detrás, y lo que queda del disco o la playlist. Cada canción es una "entrada" que lleva
// todo lo que necesita el servicio (consulta para buscarla, datos para el historial).
import { invoke } from '@tauri-apps/api/core'
import { listen } from './events'
import * as api from './api'
import { library, toLib } from './library.svelte'
import { isPodcast, isYouTubeTrack } from './media'
import { load, playOrder, save, shuffled, toQuery, type PlayerApi, type QueueItem, type Repeat, type Status } from './queue'
import { toast } from './toast.svelte'
import type { LibTrack, TrackQuery } from './types'

export const isAndroid = api.inTauri && /Android/i.test(navigator.userAgent)

interface Entry {
  uid: string
  item: QueueItem
  lib: LibTrack
  query: TrackQuery
  /** Metida a mano en tu cola (DJ). */
  user: boolean
  /** Clave en tu cola (para quitarla o moverla). */
  key: number
  /** Posición en el disco o la playlist original (-1 si es de tu cola). */
  ctx: number
  /** Nombre del disco o la playlist de la que viene. */
  context: string
}

interface NativeStatus {
  index: number
  positionMs: number
  durationMs: number
  playing: boolean
  playWhenReady: boolean
  state: 'idle' | 'buffering' | 'ready' | 'ended'
  repeat: Repeat
  at: number
}

let seq = Date.now()

export class AndroidPlayer implements PlayerApi {
  entries = $state<Entry[]>([])
  index = $state(-1)
  status = $state<Status>('idle')
  time = $state(0)
  duration = $state(0)
  volume = $state(1)
  muted = $state(false)
  shuffle = $state(load('musify:shuffle', false, (v) => typeof v === 'boolean'))
  repeat = $state<Repeat>('off')
  picking = $state<QueueItem | null>(null)

  /** Última posición que dio el servicio; entre avisos, la hora se calcula aquí. */
  #position = { ms: 0, at: 0, playing: false }
  #nextKey = 1

  constructor() {
    listen<{ entries: (Entry | null)[] }>('player-timeline', (e) => this.#applyTimeline(e.payload.entries))
    listen<NativeStatus>('player-status', (e) => this.#applyStatus(e.payload))
    listen<{ message: string }>('player-error', (e) => toast.show(e.payload.message))
    listen('history-changed', () => library.historyVersion++)
    this.#sync()
    // Al volver de segundo plano, el estado completo: los avisos de mientras estaba congelada se perdieron.
    document.addEventListener('visibilitychange', () => !document.hidden && this.#sync())
    setInterval(() => this.#tickTime(), 250)
  }

  // --- Lo que se ve ---------------------------------------------------------------------------

  get current(): QueueItem | null {
    return this.entries[this.index]?.item ?? null
  }

  /** Cuántas canciones de tu cola hay justo detrás de la actual. */
  get #userCount() {
    let n = 0
    while (this.entries[this.index + 1 + n]?.user) n++
    return n
  }

  get userQueue() {
    return this.entries.slice(this.index + 1, this.index + 1 + this.#userCount).map((e) => ({ key: e.key, item: e.item }))
  }

  get upcoming() {
    const from = this.index + 1 + this.#userCount
    return this.entries
      .map((e, pos) => ({ pos, e }))
      .slice(from)
      .filter(({ e }) => !e.user)
      .map(({ pos, e }) => ({ pos, item: e.item }))
  }

  get queue() {
    return this.entries
      .filter((e) => !e.user)
      .sort((a, b) => a.ctx - b.ctx)
      .map((e) => e.item)
  }

  get context() {
    return this.entries.find((e) => !e.user)?.context ?? ''
  }

  get hasNext() {
    return this.index < this.entries.length - 1 || this.repeat === 'all'
  }

  // --- Cola -----------------------------------------------------------------------------------

  #entry(item: QueueItem, user: boolean, ctx = -1, context = ''): Entry {
    return {
      uid: String(++seq),
      item,
      lib: toLib(item),
      query: toQuery(item),
      user,
      key: user ? this.#nextKey++ : 0,
      ctx,
      context,
    }
  }

  playQueue(items: QueueItem[], start: number, context = '') {
    if (!items.length) return
    const label = context || (items.every((i) => i.albumId === items[0].albumId) ? items[0].albumTitle : '')
    const entries = items.map((item, i) => this.#entry(item, false, i, label))
    // Tu cola se conserva: suena después de la canción elegida.
    const mine = this.entries.slice(this.index + 1, this.index + 1 + this.#userCount)
    let list: Entry[]
    let index: number
    if (this.shuffle) {
      const order = playOrder(items.length, start, true)
      list = [entries[order[0]], ...mine, ...order.slice(1).map((i) => entries[i])]
      index = 0
    } else {
      list = [...entries.slice(0, start + 1), ...mine, ...entries.slice(start + 1)]
      index = start
    }
    this.#setQueue(list, index, true)
  }

  addToQueue(items: QueueItem[]) {
    if (!items.length) return
    this.#insertUser(items, this.index + 1 + this.#userCount)
    toast.show(items.length === 1 ? `«${items[0].track.title}» añadida a la cola` : `${items.length} canciones añadidas a la cola`)
  }

  playNext(items: QueueItem[]) {
    if (!items.length) return
    this.#insertUser(items, this.index + 1)
    toast.show(items.length === 1 ? `«${items[0].track.title}» sonará a continuación` : `${items.length} canciones sonarán a continuación`)
  }

  insertInQueue(items: QueueItem[], at: number) {
    this.#insertUser(items, this.index + 1 + Math.max(0, Math.min(at, this.#userCount)))
  }

  #insertUser(items: QueueItem[], at: number) {
    const entries = items.map((item) => this.#entry(item, true))
    if (!this.entries.length) return this.#setQueue(entries, 0, true)
    const list = [...this.entries]
    list.splice(at, 0, ...entries)
    this.entries = list
    this.#call('insert', { entries, index: at })
  }

  removeFromQueue(key: number) {
    const i = this.entries.findIndex((e) => e.user && e.key === key)
    if (i < 0) return
    this.entries = this.entries.filter((_, j) => j !== i)
    this.#call('remove', { from: i, to: i + 1 })
  }

  moveInQueue(key: number, to: number) {
    const from = this.entries.findIndex((e) => e.user && e.key === key)
    if (from < 0) return
    const target = this.index + 1 + Math.max(0, Math.min(to, this.#userCount - 1))
    const list = [...this.entries]
    const [moved] = list.splice(from, 1)
    list.splice(target, 0, moved)
    this.entries = list
    this.#call('move', { from, to: target })
  }

  clearQueue() {
    const n = this.#userCount
    if (!n) return
    const from = this.index + 1
    this.entries = this.entries.filter((_, j) => j < from || j >= from + n)
    this.#call('remove', { from, to: from + n })
  }

  /** Reproduce ya una canción de tu cola; las que iban delante se quitan (como en Spotify). */
  async playFromQueue(key: number) {
    const i = this.entries.findIndex((e) => e.user && e.key === key)
    if (i < 0) return
    const from = this.index + 1
    if (i > from) await this.#call('remove', { from, to: i })
    await this.#call('skipTo', { index: from })
  }

  playAt(pos: number) {
    this.#call('skipTo', { index: pos })
  }

  // --- Mandos ---------------------------------------------------------------------------------

  toggle() {
    if (this.status === 'playing' || this.status === 'loading') {
      this.status = 'paused'
      this.#call('pause')
    } else if (this.entries.length) {
      this.#call('play')
    }
  }

  next() {
    this.#call('next')
  }

  prev() {
    this.#call('previous')
  }

  seek(seconds: number) {
    this.time = seconds
    this.#position = { ms: seconds * 1000, at: Date.now(), playing: this.#position.playing }
    this.#call('seek', { positionMs: Math.round(seconds * 1000) })
  }

  setVolume(v: number) {
    this.volume = v
    this.muted = v === 0
    this.#call('setVolume', { volume: v })
  }

  toggleMute() {
    this.muted = !this.muted
    this.#call('setVolume', { volume: this.muted ? 0 : this.volume })
  }

  /** La actual se queda; cambia el orden de lo que queda del disco o la playlist (no tu cola). */
  toggleShuffle() {
    this.shuffle = !this.shuffle
    save('musify:shuffle', this.shuffle)
    const from = this.index + 1 + this.#userCount
    if (from > this.entries.length) return
    const rest = this.entries.slice(from).filter((e) => !e.user)
    let upcoming: Entry[]
    if (this.shuffle) {
      upcoming = shuffled(rest)
    } else {
      // En orden, desde la canción del disco o la playlist donde iba.
      const base = [...this.entries.slice(0, this.index + 1)].reverse().find((e) => !e.user)?.ctx ?? -1
      const all = this.entries.filter((e) => !e.user)
      const byCtx = new Map(all.map((e) => [e.ctx, e]))
      upcoming = [...byCtx.keys()]
        .filter((ctx) => ctx > base)
        .sort((a, b) => a - b)
        .map((ctx) => {
          const e = byCtx.get(ctx)!
          // Las que ya sonaron (están detrás) vuelven como entradas nuevas.
          return this.entries.indexOf(e) > this.index ? e : this.#entry(e.item, false, e.ctx, e.context)
        })
    }
    this.entries = [...this.entries.slice(0, from), ...upcoming]
    this.#call('replace', { from, to: from + rest.length, entries: upcoming })
  }

  cycleRepeat() {
    this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off'
    this.#call('setRepeat', { mode: this.repeat })
  }

  async useSource(videoId: string, item: QueueItem | null = this.current): Promise<boolean> {
    if (!item || isPodcast(item.track.id) || isYouTubeTrack(item.track.id)) return false
    try {
      await api.chooseSource(toQuery(item), videoId)
      if (item.track.id === this.current?.track.id) {
        if (!(await this.#call('reload'))) return false
        toast.show('Hecho: a partir de ahora esta canción sonará con ese vídeo')
      } else {
        toast.show(`Hecho: «${item.track.title}» sonará con ese vídeo`)
      }
      return true
    } catch (e) {
      toast.show(`No se pudo usar ese vídeo: ${e}`)
      return false
    }
  }

  // --- Con el servicio ------------------------------------------------------------------------

  /** Una orden al servicio. Si falla, se avisa y devuelve `false`. */
  #call(cmd: string, args: Record<string, unknown> = {}): Promise<boolean> {
    return invoke('player_native', { cmd, args }).then(
      () => true,
      (e) => {
        toast.show(`El reproductor no responde: ${e}`)
        return false
      },
    )
  }

  #setQueue(entries: Entry[], index: number, play: boolean) {
    this.entries = entries
    this.index = index
    this.status = 'loading'
    this.time = 0
    this.duration = entries[index]?.item.track.duration ?? 0
    this.#call('setQueue', { entries, index, play }).then((ok) => ok || (this.status = 'idle'))
  }

  async #sync() {
    const s = await invoke<NativeStatus & { entries: (Entry | null)[] }>('player_native', { cmd: 'state', args: {} }).catch(() => null)
    if (!s) return
    this.#applyTimeline(s.entries)
    this.#applyStatus(s)
  }

  #applyTimeline(entries: (Entry | null)[]) {
    this.entries = entries.filter((e): e is Entry => !!e)
    for (const e of this.entries) if (e.user && e.key >= this.#nextKey) this.#nextKey = e.key + 1
  }

  #applyStatus(s: NativeStatus) {
    this.index = s.index
    this.repeat = s.repeat
    const current = this.current
    this.duration = s.durationMs > 0 ? s.durationMs / 1000 : (current?.track.duration ?? 0)
    // La foto es de hace un instante (s.at): se descuenta lo que tardó en llegar.
    this.#position = { ms: s.positionMs + (s.playing ? Math.max(0, Date.now() - s.at) : 0), at: Date.now(), playing: s.playing }
    this.time = this.#position.ms / 1000
    if (!current) this.status = 'idle'
    else if (s.playing) this.status = 'playing'
    else if (s.playWhenReady && (s.state === 'buffering' || s.state === 'idle')) this.status = 'loading'
    else this.status = 'paused'
  }

  #tickTime() {
    const p = this.#position
    if (!p.playing) return
    const t = (p.ms + (Date.now() - p.at)) / 1000
    this.time = this.duration ? Math.min(t, this.duration) : t
  }
}
