<script lang="ts">
  import { onMount } from 'svelte'
  import * as api from '../lib/api'
  import { downloads } from '../lib/downloads.svelte'
  import { createDrivingWakeLock, type DrivingWakeLockState } from '../lib/driving-wake-lock'
  import { duration } from '../lib/format'
  import { fromLib, library } from '../lib/library.svelte'
  import { isPodcast } from '../lib/media'
  import { pins } from '../lib/pins.svelte'
  import { player, type QueueItem } from '../lib/player.svelte'
  import { episodeQueue, noteYoutubeEpisodes } from '../lib/podcasts'
  import { theme } from '../lib/theme.svelte'
  import { toast } from '../lib/toast.svelte'
  import Cover from './Cover.svelte'
  import Icon, { type IconName } from './Icon.svelte'

  type Collection = { kind: 'liked' | 'downloads' | 'history' | 'playlist' | 'album' | 'podcast'; title: string; id?: number; feedUrl?: string; cover?: string | null }
  type QueueRow = { id: string; item: QueueItem; key?: number; pos?: number }
  const PAGE_SIZE = 8
  let section = $state<'now' | 'music' | 'queue'>(player.current ? 'now' : 'music')
  let dialog: HTMLDivElement
  let content: HTMLDivElement
  let clock = $state(new Date())
  let online = $state(navigator.onLine)
  let awake = $state(readAwakePreference())
  let wakeState = $state<DrivingWakeLockState>('off')
  let fullscreen = $state(false)
  let fullscreenAvailable = $state(false)
  let collection = $state<Collection | null>(null)
  let items = $state<QueueItem[]>([])
  let collectionLoading = $state(false)
  let collectionError = $state('')
  let collectionPage = $state(0)
  let sourcesPage = $state(0)
  let queuePage = $state(0)
  let loadToken = 0
  let wakeLock: ReturnType<typeof createDrivingWakeLock> | undefined

  const current = $derived(player.current)
  const podcast = $derived(current ? isPodcast(current.track.id) : false)
  const loading = $derived(player.status === 'loading')
  const total = $derived(Number.isFinite(player.duration) && player.duration > 0 ? player.duration : current?.track.duration ?? 0)
  const position = $derived(Math.max(0, Math.min(player.time || 0, total)))
  const liked = $derived(current ? library.liked.has(current.track.id) : false)
  const queue = $derived<QueueRow[]>([
    ...player.userQueue.map(({ key, item }) => ({ id: `manual:${key}`, key, item })),
    ...player.upcoming.map(({ pos, item }) => ({ id: `order:${pos}`, pos, item })),
  ])
  const visibleQueuePage = $derived(Math.min(queuePage, Math.max(0, Math.ceil(queue.length / PAGE_SIZE) - 1)))
  const sources = $derived.by(() => {
    const all: Collection[] = [
      ...pins.items.map((pin): Collection => ({ kind: pin.kind, id: pin.id, title: pin.title, cover: pin.image ?? pin.covers?.[0] })),
      ...library.playlists.map((list): Collection => ({ kind: 'playlist', id: list.id, title: list.name, cover: list.covers[0] })),
      ...library.albums.map((album): Collection => ({ kind: 'album', id: album.id, title: album.title, cover: album.cover })),
      ...library.podcasts.map((show): Collection => ({ kind: 'podcast', id: show.id, title: show.title, cover: show.image, feedUrl: show.feedUrl })),
    ]
    const seen = new Set<string>()
    return all.filter((entry) => {
      const key = `${entry.kind}:${entry.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })
  const visibleSourcesPage = $derived(Math.min(sourcesPage, Math.max(0, Math.ceil(sources.length / PAGE_SIZE) - 1)))
  const wakeLabel = $derived(wakeState === 'active' ? 'Pantalla encendida' : wakeState === 'requesting' ? 'Activando pantalla…' : awake && wakeState === 'unavailable' ? 'El sistema permite apagar la pantalla' : 'Pantalla según el sistema')
  const collectionIcon = (kind: Collection['kind']): IconName => kind === 'podcast' ? 'podcast' : kind === 'album' ? 'disc' : kind === 'liked' ? 'heartFilled' : kind === 'downloads' ? 'downloaded' : kind === 'history' ? 'clock' : 'queue'
  const collectionType = (kind: Collection['kind']) => kind === 'podcast' ? 'Pódcast' : kind === 'album' ? 'Disco' : 'Playlist'

  $effect(() => {
    void section
    void collection
    void collectionPage
    void visibleSourcesPage
    void visibleQueuePage
    content?.scrollTo(0, 0)
  })

  function readAwakePreference() {
    try { return localStorage.getItem('pletina:driving:awake') !== 'false' } catch { return true }
  }
  function toggleAwake() {
    awake = !awake
    try { localStorage.setItem('pletina:driving:awake', String(awake)) } catch { /* Preferencia solo para esta sesión. */ }
    wakeLock?.setEnabled(awake)
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === dialog) await document.exitFullscreen()
      else await dialog.requestFullscreen()
    } catch { toast.show('La pantalla completa no está disponible en este navegador.') }
  }
  function showSection(next: typeof section) {
    section = next
    // Favoritos, escuchas y copias disponibles pueden cambiar mientras suena la cola.
    if (next === 'music' && collection && ['liked', 'history', 'downloads'].includes(collection.kind)) void openCollection(collection)
  }
  function musicRoot() {
    section = 'music'
    // Una respuesta pendiente no debe deshacer Volver a Tu música.
    loadToken++
    collection = null
    collectionLoading = false
    collectionError = ''
    items = []
  }
  async function openCollection(value: Collection) {
    const token = ++loadToken
    collection = value
    collectionPage = 0
    items = []
    collectionError = ''
    collectionLoading = true
    try {
      let result: QueueItem[]
      if (value.kind === 'liked') result = (await api.likedTracks()).map((entry) => fromLib(entry.track))
      else if (value.kind === 'history') result = (await api.history(100)).map((entry) => fromLib(entry.track))
      else if (value.kind === 'downloads') result = (await downloads.list()).map((entry) => fromLib(entry.track))
      else if (value.kind === 'playlist') result = (await api.playlist(value.id!)).entries.map((entry) => fromLib(entry.track))
      else if (value.kind === 'album') {
        const album = await api.album(value.id!)
        result = album.tracks.map((track) => ({ track, albumId: album.id, albumTitle: album.title, artistId: album.artist.id, cover: album.coverBig }))
      } else {
        const feedUrl = value.feedUrl || await api.podcastFeedUrl(value.id!)
        const show = await api.podcastDetail(feedUrl)
        if (token !== loadToken) return
        noteYoutubeEpisodes(show)
        result = episodeQueue(show)
      }
      if (token === loadToken) items = result
    } catch {
      if (token === loadToken) collectionError = online ? 'No se pudo abrir esta colección. Puedes volver a intentarlo.' : 'No se pudo abrir sin conexión. Prueba con Descargas.'
    } finally {
      if (token === loadToken) collectionLoading = false
    }
  }
  function playCollection(index: number) {
    if (!items[index]) return
    player.playQueue(items, index, collection?.title)
    showSection('now')
  }
  function playQueued(row: QueueRow) {
    if (row.key !== undefined) player.playFromQueue(row.key)
    else if (row.pos !== undefined) player.playAt(row.pos)
    showSection('now')
  }
  function trapFocus(event: KeyboardEvent) {
    if (event.key !== 'Tab') return
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter((element) => element.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    if (!first || !last) { event.preventDefault(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { last.focus(); event.preventDefault() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { first.focus(); event.preventDefault() }
  }
  onMount(() => {
    dialog.focus()
    fullscreenAvailable = !!document.fullscreenEnabled && typeof dialog.requestFullscreen === 'function'
    wakeLock = createDrivingWakeLock((state) => { wakeState = state })
    wakeLock.setEnabled(awake)
    const timer = setInterval(() => { clock = new Date() }, 30_000)
    const network = () => { online = navigator.onLine }
    const syncFullscreen = () => { fullscreen = document.fullscreenElement === dialog }
    window.addEventListener('online', network)
    window.addEventListener('offline', network)
    document.addEventListener('fullscreenchange', syncFullscreen)
    return () => {
      loadToken++
      wakeLock?.destroy()
      clearInterval(timer)
      window.removeEventListener('online', network)
      window.removeEventListener('offline', network)
      document.removeEventListener('fullscreenchange', syncFullscreen)
      const restoreFocus = () => requestAnimationFrame(() => document.querySelector<HTMLElement>('button[aria-label="Modo coche"]')?.focus({ preventScroll: true }))
      if (document.fullscreenElement === dialog) void document.exitFullscreen().catch(() => {}).finally(restoreFocus)
      else restoreFocus()
    }
  })
</script>

<div class="driving" role="dialog" aria-modal="true" aria-label="Modo coche" tabindex="-1" bind:this={dialog} onkeydown={trapFocus}>
  <header class="car-header">
    <div class="brand"><Icon name="car" size={26} /><div><strong>Modo coche</strong><span>Pletina{online ? '' : ' · Sin conexión'}</span></div></div>
    <time>{clock.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</time>
    {#if fullscreenAvailable}<button class="square" onclick={toggleFullscreen} aria-label={fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'} title={fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}><Icon name="expand" size={26} /></button>{/if}
    <button class="square exit" onclick={() => (theme.driving = false)} aria-label="Salir del modo coche" title="Salir del modo coche"><Icon name="close" size={28} /></button>
  </header>

  <div class="car-content" bind:this={content}>
    {#if section === 'now'}
      {#if current}
        <section class="now" aria-label="Reproducción">
          <div class="artwork"><Cover src={current.cover} /></div>
          <div class="playback">
            <div class="track-meta"><span class="eyebrow">{podcast ? 'Pódcast' : 'Sonando ahora'}</span><h1>{current.track.title}</h1><p class="artist">{current.track.artist.name}</p></div>
            <div class="timeline"><progress max={total || 1} value={position} aria-label="Progreso de reproducción"></progress><div><span>{duration(position)}</span><span>{duration(total)}</span></div></div>
            <div class="transport" aria-label="Controles de reproducción">
              <button class="control" onclick={() => player.prev()} aria-label="Anterior"><Icon name="prev" size={36} /></button>
              <button class="main-play" onclick={() => player.toggle()} aria-label={loading ? 'Cancelar carga' : player.status === 'playing' ? 'Pausa' : 'Reproducir'}>
                {#if loading}<span class="spinner" aria-hidden="true"></span>{:else}<Icon name={player.status === 'playing' ? 'pause' : 'play'} size={42} />{/if}
              </button>
              <button class="control" onclick={() => player.next()} disabled={!player.hasNext} aria-label="Siguiente"><Icon name="next" size={36} /></button>
            </div>
            <div class="secondary-controls">
              {#if podcast}
                <button onclick={() => player.seek(position - 15)} disabled={loading || !total} aria-label="Retroceder 15 segundos"><Icon name="back" size={24} />15 s</button>
                <button onclick={() => player.seek(position + 30)} disabled={loading || !total} aria-label="Avanzar 30 segundos">30 s<Icon name="forward" size={24} /></button>
              {:else}
                <button class:active={player.shuffle} aria-pressed={player.shuffle} onclick={() => player.toggleShuffle()} aria-label="Aleatorio"><Icon name="shuffle" size={24} /><span>Aleatorio</span></button>
                <button class:active={liked} aria-pressed={liked} onclick={() => current && library.toggleLike(current)} aria-label={liked ? 'Quitar de favoritos' : 'Añadir a favoritos'}><Icon name={liked ? 'heartFilled' : 'heart'} size={24} /><span>Me gusta</span></button>
              {/if}
            </div>
            <p class="playback-status" role="status">{loading ? (player.audioRetry ? 'Recuperando audio…' : 'Preparando audio…') : player.status === 'playing' ? (online ? player.context : 'Sin conexión') : player.status === 'idle' ? 'Pulsa reproducir para volver a intentarlo' : 'En pausa'}</p>
          </div>
        </section>
      {:else}
        <div class="empty"><Icon name="note" size={48} /><h1>Tu música, a mano</h1><p>Elige una colección para empezar.</p><button class="primary" onclick={() => showSection('music')}>Elegir música</button></div>
      {/if}
    {:else if section === 'music'}
      {#if collection}
        <section class="browser" aria-label={collection.title}>
          <div class="collection-header"><button class="square" onclick={musicRoot} aria-label="Volver a Tu música"><Icon name="back" size={28} /></button><h1>{collection.title}</h1></div>
          {#if collectionLoading}<p class="message" role="status">Cargando colección…</p>
          {:else if collectionError}<div class="message" role="status"><p>{collectionError}</p><button class="primary" onclick={() => collection && openCollection(collection)}>Reintentar</button></div>
          {:else if !items.length}<p class="message">Todavía no hay nada aquí.</p>
          {:else}
            <button class="primary play-all" onclick={() => playCollection(0)}><Icon name="play" size={24} />Reproducir todo<span>{items.length}</span></button>
            <ol class="track-list" aria-label="Canciones de la colección">
              {#each items.slice(collectionPage * PAGE_SIZE, (collectionPage + 1) * PAGE_SIZE) as item, index}
                <li><button class="track" class:current={current?.track.id === item.track.id} onclick={() => playCollection(collectionPage * PAGE_SIZE + index)} aria-label={`Reproducir ${item.track.title}`}><span class="thumb"><Cover src={item.cover} /></span><span class="row-text"><strong>{item.track.title}</strong><span>{item.track.artist.name}</span></span><Icon name="play" size={24} /></button></li>
              {/each}
            </ol>
            {#if items.length > PAGE_SIZE}<div class="pagination"><button disabled={!collectionPage} onclick={() => collectionPage--} aria-label="Canciones anteriores"><Icon name="back" size={24} /></button><span>{collectionPage + 1} / {Math.ceil(items.length / PAGE_SIZE)}</span><button disabled={(collectionPage + 1) * PAGE_SIZE >= items.length} onclick={() => collectionPage++} aria-label="Más canciones"><Icon name="forward" size={24} /></button></div>{/if}
          {/if}
        </section>
      {:else}
        <section class="browser" aria-label="Tu música">
          <h1>Tu música</h1>
          <div class="shortcuts">
            <button class="tile favorite" onclick={() => openCollection({ kind: 'liked', title: 'Favoritos' })}><Icon name="heartFilled" size={28} /><span class="row-text"><strong>Favoritos</strong><span>{library.liked.size} canciones</span></span></button>
            <button class="tile" onclick={() => openCollection({ kind: 'downloads', title: 'Descargas' })}><Icon name="downloaded" size={28} /><span class="row-text"><strong>Descargas</strong><span>Para escuchar sin red</span></span></button>
            <button class="tile" onclick={() => openCollection({ kind: 'history', title: 'Recientes' })}><Icon name="clock" size={28} /><span class="row-text"><strong>Recientes</strong><span>Vuelve a lo que escuchabas</span></span></button>
          </div>
          {#if sources.length}
            <h2>Tus colecciones</h2>
            <div class="collections">
              {#each sources.slice(visibleSourcesPage * PAGE_SIZE, (visibleSourcesPage + 1) * PAGE_SIZE) as source (`${source.kind}:${source.id}`)}
                <button class="tile" onclick={() => openCollection(source)}>{#if source.cover}<span class="thumb"><Cover src={source.cover} /></span>{:else}<Icon name={collectionIcon(source.kind)} size={28} />{/if}<span class="row-text"><strong>{source.title}</strong><span>{collectionType(source.kind)}</span></span></button>
              {/each}
            </div>
            {#if sources.length > PAGE_SIZE}<div class="pagination"><button disabled={!visibleSourcesPage} onclick={() => (sourcesPage = visibleSourcesPage - 1)} aria-label="Colecciones anteriores"><Icon name="back" size={24} /></button><span>{visibleSourcesPage + 1} / {Math.ceil(sources.length / PAGE_SIZE)}</span><button disabled={(visibleSourcesPage + 1) * PAGE_SIZE >= sources.length} onclick={() => (sourcesPage = visibleSourcesPage + 1)} aria-label="Más colecciones"><Icon name="forward" size={24} /></button></div>{/if}
          {/if}
          <div class="preferences">
            {#if wakeState !== 'unsupported'}<button class="wake" aria-label="Mantener pantalla encendida" aria-pressed={awake} onclick={toggleAwake}><Icon name="car" size={24} /><span class="row-text"><strong>Mantener pantalla encendida</strong><span>{wakeLabel}</span></span><span class="switch" class:on={awake} aria-hidden="true"></span></button>{/if}
            <p>Prepara tu música antes de salir. Los mandos del coche dependen del móvil y del navegador.</p>
          </div>
        </section>
      {/if}
    {:else}
      <section class="browser" aria-label="Cola de reproducción"><h1>A continuación <span class="count">{queue.length}</span></h1>
        {#if !queue.length}<div class="message"><p>No hay más canciones en la cola.</p><button class="primary" onclick={() => showSection('music')}>Elegir música</button></div>
        {:else}
          <ol class="track-list" aria-label="A continuación">
            {#each queue.slice(visibleQueuePage * PAGE_SIZE, (visibleQueuePage + 1) * PAGE_SIZE) as row (row.id)}
              <li><button class="track" onclick={() => playQueued(row)} aria-label={`Reproducir ${row.item.track.title}`}><span class="thumb"><Cover src={row.item.cover} /></span><span class="row-text"><strong>{row.item.track.title}</strong><span>{row.item.track.artist.name}{row.key !== undefined ? ' · En tu cola' : ''}</span></span><Icon name="play" size={24} /></button></li>
            {/each}
          </ol>
          {#if queue.length > PAGE_SIZE}<div class="pagination"><button disabled={!visibleQueuePage} onclick={() => (queuePage = visibleQueuePage - 1)} aria-label="Cola anterior"><Icon name="back" size={24} /></button><span>{visibleQueuePage + 1} / {Math.ceil(queue.length / PAGE_SIZE)}</span><button disabled={(visibleQueuePage + 1) * PAGE_SIZE >= queue.length} onclick={() => (queuePage = visibleQueuePage + 1)} aria-label="Más de la cola"><Icon name="forward" size={24} /></button></div>{/if}
        {/if}
      </section>
    {/if}
  </div>
  {#if toast.message}<div class="car-toast" role="status">{toast.message}</div>{/if}
  <nav class="car-nav" aria-label="Secciones del modo coche">
    <button class:selected={section === 'now'} aria-current={section === 'now' ? 'page' : undefined} onclick={() => showSection('now')}><Icon name="note" size={26} /><span>Sonando</span></button>
    <button class:selected={section === 'music'} aria-current={section === 'music' ? 'page' : undefined} onclick={() => showSection('music')}><Icon name="library" size={26} /><span>Tu música</span></button>
    <button class:selected={section === 'queue'} aria-current={section === 'queue' ? 'page' : undefined} onclick={() => showSection('queue')}><Icon name="queue" size={26} /><span>Cola</span>{#if queue.length}<span class="badge">{queue.length}</span>{/if}</button>
  </nav>
</div>

<style>
  .driving { position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column; height: var(--pletina-viewport-height, 100dvh); background: #090b11; color: #f6f6f8; padding: var(--safe-top) env(safe-area-inset-right, 0px) var(--safe-bottom) env(safe-area-inset-left, 0px); outline: none; }
  .driving:fullscreen { height: 100%; }
  .car-header { display: flex; align-items: center; flex: none; gap: 12px; min-height: 72px; padding: 8px 24px; border-bottom: 1px solid #ffffff14; }
  .brand { display: flex; gap: 12px; align-items: center; min-width: 0; }
  .brand > :global(svg) { color: var(--accent); flex: none; }
  .brand div { display: flex; flex-direction: column; }
  .brand strong { font-size: 18px; }
  .brand span { font-size: 13px; color: #b6bac8; }
  time { margin-left: auto; font-size: 21px; font-variant-numeric: tabular-nums; }
  button { touch-action: manipulation; }
  button:disabled { opacity: 0.35; cursor: default; }
  button:focus-visible { outline: 3px solid var(--accent); outline-offset: -3px; }
  .square { display: grid; place-items: center; width: 52px; height: 52px; flex: none; border-radius: 16px; background: #ffffff0b; }
  .car-content { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
  .now { display: grid; grid-template-columns: minmax(120px, 0.8fr) minmax(0, 1.2fr); gap: clamp(24px, 5vw, 72px); align-items: center; width: min(100%, 1120px); min-height: 100%; margin: 0 auto; padding: 24px 40px; }
  .artwork { width: 100%; max-width: 360px; margin: auto; }
  .artwork :global(.cover) { border-radius: 20px; box-shadow: 0 16px 50px #0008; }
  .playback { min-width: 0; }
  .eyebrow { font-size: 14px; font-weight: 700; color: var(--accent); }
  h1 { font-size: clamp(24px, 3.2vw, 40px); line-height: 1.15; margin: 8px 0; overflow-wrap: anywhere; }
  .track-meta h1 { display: -webkit-box; line-clamp: 2; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .artist { font-size: clamp(18px, 2.5vw, 24px); color: #b6bac8; margin: 6px 0 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .timeline progress { display: block; width: 100%; height: 5px; border: 0; border-radius: 3px; overflow: hidden; background: #ffffff20; accent-color: var(--accent); }
  progress::-webkit-progress-bar { background: #ffffff20; }
  progress::-webkit-progress-value { background: var(--accent); }
  progress::-moz-progress-bar { background: var(--accent); }
  .timeline > div { display: flex; justify-content: space-between; color: #b6bac8; font-size: 15px; font-variant-numeric: tabular-nums; margin-top: 6px; }
  .transport { display: flex; justify-content: center; align-items: center; gap: 24px; margin-top: 12px; }
  .control { display: grid; place-items: center; flex: 1; max-width: 100px; min-width: 64px; height: 80px; border-radius: 20px; background: #ffffff0b; }
  .main-play { display: grid; place-items: center; flex: none; width: 96px; height: 96px; border-radius: 32px; background: var(--accent); color: #151020; }
  .secondary-controls { display: flex; justify-content: center; gap: 12px; margin-top: 12px; }
  .secondary-controls button { display: flex; align-items: center; justify-content: center; gap: 8px; flex: 1; min-height: 56px; padding: 8px; border-radius: 16px; background: #ffffff09; color: #b6bac8; font-size: 17px; }
  .secondary-controls button.active { color: var(--accent); background: #b69cff1a; }
  .playback-status { min-height: 21px; margin: 8px 0 0; text-align: center; font-size: 14px; color: #b6bac8; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .browser { width: min(100%, 1040px); margin: 0 auto; padding: 20px 28px; }
  .browser > h1 { font-size: 28px; margin: 0 0 20px; }
  h2 { font-size: 18px; color: #b6bac8; margin: 28px 0 12px; }
  .shortcuts, .collections { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .shortcuts { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .tile { display: flex; align-items: center; gap: 16px; min-width: 0; min-height: 88px; padding: 16px; background: #171b25; border-radius: 18px; text-align: left; }
  .tile > :global(svg) { flex: none; color: var(--accent); }
  .tile.favorite { background: #29203f; }
  .row-text { display: flex; flex-direction: column; flex: 1; min-width: 0; gap: 4px; }
  .row-text strong { font-size: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row-text > span { color: #b6bac8; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .thumb { display: block; width: 52px; flex: none; }
  .thumb :global(.cover) { border-radius: 10px; }
  .collection-header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
  .collection-header h1 { font-size: 26px; }
  .primary { display: inline-flex; justify-content: center; align-items: center; gap: 12px; min-height: 60px; padding: 14px 24px; border-radius: 18px; background: var(--accent); color: #151020; font-weight: 750; font-size: 19px; }
  .play-all { width: 100%; margin-bottom: 12px; }
  .play-all > span { margin-left: auto; opacity: 0.7; }
  .track-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
  .track { display: flex; align-items: center; gap: 16px; min-height: 84px; width: 100%; padding: 12px 16px; text-align: left; background: #171b25; border-radius: 16px; }
  .track > :global(svg) { flex: none; color: var(--accent); }
  .track.current { background: #29203f; }
  .preferences { margin-top: 24px; border-top: 1px solid #ffffff14; padding-top: 16px; }
  .preferences p { color: #b6bac8; font-size: 14px; margin-bottom: 0; }
  .wake { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 72px; text-align: left; }
  .wake > :global(svg) { flex: none; color: var(--accent); }
  .wake .row-text strong { font-size: 17px; white-space: normal; }
  .wake .row-text > span { white-space: normal; font-size: 13px; }
  .switch { flex: none; width: 44px; height: 26px; padding: 4px; border-radius: 20px; background: #545762; }
  .switch::after { content: ''; display: block; width: 18px; height: 18px; border-radius: 50%; background: #fff; }
  .switch.on { background: var(--accent-strong); }
  .switch.on::after { transform: translateX(18px); }
  .pagination { display: flex; justify-content: center; align-items: center; gap: 24px; margin-top: 16px; }
  .pagination button { display: grid; place-items: center; min-width: 64px; min-height: 56px; border-radius: 16px; background: #171b25; }
  .count { color: var(--accent); font-size: 18px; }
  .message { color: #b6bac8; padding: 24px 0; font-size: 20px; }
  .empty { display: flex; min-height: 100%; padding: 32px 24px; flex-direction: column; justify-content: center; align-items: center; text-align: center; gap: 12px; }
  .empty > :global(svg) { color: var(--accent); }
  .empty p { color: #b6bac8; font-size: 20px; margin: 0 0 12px; }
  .car-nav { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); flex: none; gap: 8px; padding: 8px 20px; border-top: 1px solid #ffffff14; background: #090b11; }
  .car-nav button { position: relative; display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 64px; padding: 8px; border-radius: 18px; color: #b6bac8; font-size: 19px; font-weight: 700; }
  .car-nav button.selected { color: var(--accent); background: #b69cff1a; }
  .badge { font-size: 13px; border-radius: 12px; background: #ffffff15; padding: 2px 7px; }
  .car-toast { position: absolute; left: 16px; right: 16px; bottom: calc(88px + var(--safe-bottom)); padding: 12px 20px; border-radius: 14px; background: #f6f6f8; color: #111; text-align: center; font-weight: 650; box-shadow: 0 8px 24px #0008; pointer-events: none; }
  .spinner { width: 34px; height: 34px; border: 3px solid #15102040; border-top-color: #151020; border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 600px) {
    .car-header { min-height: 64px; padding: 6px 12px; gap: 8px; }
    .brand { gap: 8px; }
    .brand strong { font-size: 16px; }
    .brand span { font-size: 12px; }
    time { font-size: 18px; }
    .square { width: 48px; height: 48px; }
    .now { grid-template-columns: 1fr; gap: 18px; padding: 24px; align-content: center; }
    .artwork { width: min(54vw, 220px); }
    .track-meta h1 { font-size: 28px; }
    .artist { margin-bottom: 14px; font-size: 20px; }
    .transport { gap: 16px; }
    .browser { padding: 20px 16px; }
    .shortcuts, .collections { grid-template-columns: 1fr; }
    .tile { min-height: 80px; }
    .car-nav { padding: 8px; gap: 4px; }
    .car-nav button { flex-direction: column; gap: 4px; min-height: 64px; font-size: 15px; }
    .badge { position: absolute; top: 4px; right: 12px; }
  }
  @media (max-height: 720px) and (max-width: 600px) {
    .now { gap: 12px; padding: 16px 20px; }
    .artwork { width: min(36vw, 150px); }
    .track-meta h1 { font-size: 24px; margin: 4px 0; }
    .artist { font-size: 18px; margin: 4px 0 10px; }
    .eyebrow { font-size: 12px; }
    .control { height: 64px; }
    .main-play { width: 80px; height: 80px; border-radius: 26px; }
    .secondary-controls { margin-top: 8px; }
    .secondary-controls button { min-height: 48px; }
  }
  @media (min-width: 601px) and (max-height: 540px) {
    .car-header { min-height: 56px; padding: 4px 20px; }
    .square { width: 48px; height: 48px; }
    .now { padding: 12px 32px; gap: 32px; grid-template-columns: minmax(120px, 0.7fr) minmax(0, 1.3fr); }
    .artwork { width: min(100%, 38dvh); }
    .track-meta h1 { font-size: 25px; margin: 2px 0; line-clamp: 1; -webkit-line-clamp: 1; }
    .eyebrow { font-size: 12px; }
    .artist { font-size: 18px; margin: 2px 0 10px; }
    .main-play { width: 76px; height: 76px; border-radius: 24px; }
    .control { height: 64px; }
    .transport { margin-top: 6px; gap: 20px; }
    .secondary-controls { margin-top: 6px; }
    .secondary-controls button { min-height: 48px; padding: 6px; font-size: 15px; }
    .playback-status { margin-top: 4px; font-size: 12px; min-height: 18px; }
    .car-nav { padding: 4px 20px; }
    .car-nav button { min-height: 56px; }
  }
  @media (max-width: 600px) and (max-height: 620px) {
    .now { gap: 8px; padding: 12px 20px; }
    .artwork { width: min(28vw, 110px); }
  }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
