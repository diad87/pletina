<script lang="ts">
  import Card from '../components/Card.svelte'
  import Collage from '../components/Collage.svelte'
  import Cover from '../components/Cover.svelte'
  import Icon from '../components/Icon.svelte'
  import Recommendations from '../components/Recommendations.svelte'
  import Shelf from '../components/Shelf.svelte'
  import { albumCardMenu, albumPlaying, albumQueue, playAlbum, trackMenu } from '../lib/actions'
  import { menu } from '../lib/menu.svelte'
  import * as api from '../lib/api'
  import { songs } from '../lib/format'
  import { fromLib, library } from '../lib/library.svelte'
  import { layout } from '../lib/layout.svelte'
  import { isPodcast, isYouTubeTrack } from '../lib/media'
  import { nav, type Route } from '../lib/nav.svelte'
  import { player } from '../lib/player.svelte'
  import { pins, type Pin } from '../lib/pins.svelte'
  import { recents } from '../lib/recents.svelte'
  import { theme } from '../lib/theme.svelte'
  import { toast } from '../lib/toast.svelte'
  import type { Entry, LibTrack } from '../lib/types'

  const hour = new Date().getHours()
  const greeting = hour < 6 ? 'Buenas noches' : hour < 13 ? 'Buenos días' : hour < 21 ? 'Buenas tardes' : 'Buenas noches'

  theme.clear()

  // Discos escuchados últimamente, sacados del historial (uno por disco, el más reciente primero).
  let played = $state<LibTrack[]>([])
  let history = $state<Entry[]>([])
  let loaded = $state(false)
  $effect(() => {
    void library.historyVersion
    // Si ya se ha salido de Inicio cuando llega la respuesta, no se toca el color de la otra pantalla.
    let alive = true
    api
      .history(300)
      .then((entries) => {
        if (!alive) return
        history = entries
        const seen = new Set<number>()
        played = entries.map((e) => e.track).filter((t) => !seen.has(t.albumId) && seen.add(t.albumId)).slice(0, 16)
        if (!loaded) theme.set(played[0]?.cover)
        loaded = true
      })
      .catch(() => alive && (loaded = true))
    return () => {
      alive = false
    }
  })

  nav.ready()

  interface Tile {
    key: string
    title: string
    image?: string | null
    covers?: string[]
    liked?: boolean
    route: Route
    play?: () => void
    playing?: boolean
    pin?: Pin
  }

  // Los fijados van primero y siempre se ven; el resto completa los accesos rápidos.
  const tiles = $derived.by<Tile[]>(() => {
    const list: Tile[] = []
    const seen = new Set<string>()
    const add = (tile: Tile) => {
      if (seen.has(tile.key)) return
      seen.add(tile.key)
      list.push(tile)
    }
    for (const pin of pins.items) {
      if (pin.kind === 'playlist') {
        const playlist = library.playlists.find((p) => p.id === pin.id)
        if (!playlist) continue
        add({ key: `p${pin.id}`, title: playlist.name, covers: playlist.covers, route: { name: 'playlist', id: pin.id }, pin })
      } else {
        const album = library.albums.find((a) => a.id === pin.id)
        add({
          key: `a${pin.id}`, title: album?.title ?? pin.title, image: album?.cover ?? pin.image,
          route: { name: 'album', id: pin.id }, play: () => playAlbum(pin.id), playing: albumPlaying(pin.id), pin,
        })
      }
    }
    if (library.liked.size) add({ key: 'liked', title: 'Canciones que te gustan', liked: true, route: { name: 'liked' } })
    for (const p of library.playlists.slice(0, 3)) {
      if (list.length >= 8) break
      add({ key: `p${p.id}`, title: p.name, covers: p.covers, route: { name: 'playlist', id: p.id } })
    }
    for (const t of played) {
      if (list.length >= 8) break
      add({
        key: `a${t.albumId}`,
        title: isYouTubeTrack(t.id) ? t.title : t.albumTitle,
        image: t.cover,
        route: recentRoute(t),
        play: () => playRecent(t),
        playing: albumPlaying(t.albumId),
      })
    }
    return list
  })

  function recentRoute(t: LibTrack): Route {
    return isYouTubeTrack(t.id) ? { name: 'youtube-tracks' } : { name: isPodcast(t.id) ? 'podcast' : 'album', id: t.albumId }
  }

  function playRecent(t: LibTrack) {
    if (!isPodcast(t.id) && !isYouTubeTrack(t.id)) return playAlbum(t.albumId)
    if (player.current?.albumId === t.albumId && player.status !== 'idle') return player.toggle()
    player.playQueue([fromLib(t)], 0, t.albumTitle)
  }

  async function playLiked() {
    const entries = await api.likedTracks()
    if (entries.length) player.playQueue(entries.map((e) => fromLib(e.track)), null, 'Canciones que te gustan')
  }

  async function playPlaylist(id: number) {
    const p = await api.playlist(id)
    if (p.entries.length) player.playQueue(p.entries.map((e) => fromLib(e.track)), null, p.name)
  }

  let choosingAlbum = $state(false)
  const savedMusic = $derived(library.albums.filter((album) => !isPodcast(album.id) && !isYouTubeTrack(album.id)))

  async function surpriseAlbum() {
    if (choosingAlbum || !savedMusic.length) return
    const others = savedMusic.filter((album) => album.id !== player.current?.albumId)
    const candidates = others.length ? others : savedMusic
    const chosen = candidates[Math.floor(Math.random() * candidates.length)]
    choosingAlbum = true
    try {
      const album = await api.album(chosen.id)
      if (!album.tracks.length) throw new Error('Este disco no tiene canciones disponibles.')
      // La sorpresa es el disco: las canciones se escuchan en su orden, desde la primera.
      if (player.shuffle) player.toggleShuffle()
      if (player.repeat === 'one') player.cycleRepeat()
      player.playQueue(albumQueue(album), 0, album.title)
      toast.show(`Hoy suena «${album.title}» de ${album.artist.name}`)
    } catch (error) {
      toast.show(`No se pudo poner el disco: ${error}`)
    } finally {
      choosingAlbum = false
    }
  }

  const tilePlay = (t: Tile) =>
    t.play ?? (t.liked ? playLiked : t.route.name === 'playlist' ? () => playPlaylist((t.route as { id: number }).id) : undefined)

  /** En el móvil, el cuadro de búsqueda solo está en la pantalla de Buscar. */
  function openSearch() {
    if (layout.mobile) nav.go({ name: 'search', query: '' })
    requestAnimationFrame(() => nav.focusSearch())
  }
</script>

<section class="page home">
  <div class="welcome">
    <h1 class="page-title greeting">{greeting}</h1>
    <button
      class="surprise"
      onclick={surpriseAlbum}
      disabled={choosingAlbum || !savedMusic.length}
      aria-busy={choosingAlbum}
      title={savedMusic.length ? 'Un disco de tu biblioteca al azar, desde el principio' : 'Guarda un disco en tu biblioteca para empezar'}
    >
      <Icon name="disc" size={20} />
      {choosingAlbum ? 'Eligiendo disco…' : 'Ponme un disco'}
    </button>
  </div>

  {#if tiles.length}
    <div class="tiles">
      {#each tiles as t (t.key)}
        {@const play = tilePlay(t)}
        <div class="tile" class:pinned={!!t.pin}>
          <button class="tile-hit" onclick={() => nav.go(t.route)} title={t.title}></button>
          <span class="tile-art">
            {#if t.liked}
              <span class="liked-art"><Icon name="heartFilled" size={22} /></span>
            {:else if t.covers}
              <Collage covers={t.covers} />
            {:else}
              <Cover src={t.image ?? null} />
            {/if}
          </span>
          <span class="tile-title">{t.title}</span>
          {#if t.pin}
            <button class="tile-pin" onclick={() => pins.remove(t.pin!.kind, t.pin!.id)} title={`Desfijar de Inicio: ${t.title}`} aria-label={`Desfijar de Inicio: ${t.title}`}>
              <Icon name="pin" size={16} />
            </button>
          {/if}
          {#if play}
            <button class="tile-play" class:show={t.playing} onclick={play} title={t.playing ? 'Pausa' : 'Reproducir'}>
              <Icon name={t.playing ? 'pause' : 'play'} size={18} />
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <Recommendations {history} ready={loaded} />

  {#if played.length}
    <Shelf title="Escuchado recientemente">
      {#each played as t (t.albumId)}
        <Card
          image={t.cover}
          title={isYouTubeTrack(t.id) ? t.title : t.albumTitle}
          subtitle={t.artistName}
          playing={albumPlaying(t.albumId)}
          onclick={() => nav.go(recentRoute(t))}
          onplay={() => playRecent(t)}
          oncontext={(e) => menu.show(e, isPodcast(t.id) || isYouTubeTrack(t.id) ? trackMenu(fromLib(t)) : albumCardMenu(t.albumId))}
        />
      {/each}
    </Shelf>
  {/if}

  {#if library.playlists.length}
    <Shelf title="Tus playlists">
      {#each library.playlists as p (p.id)}
        <Card
          covers={p.covers}
          title={p.name}
          subtitle={songs(p.count)}
          onclick={() => nav.go({ name: 'playlist', id: p.id })}
          onplay={p.count ? () => playPlaylist(p.id) : undefined}
          oncontext={(e) => menu.show(e, [{
            label: pins.has('playlist', p.id) ? 'Desfijar de Inicio' : 'Fijar en Inicio',
            icon: 'pin',
            action: () => pins.toggle({ kind: 'playlist', id: p.id, title: p.name, covers: p.covers }),
          }])}
        />
      {/each}
    </Shelf>
  {/if}

  {#if library.albums.length}
    <Shelf title="Tus discos">
      {#each library.albums as a (a.id)}
        <Card
          image={a.cover}
          title={a.title}
          subtitle={a.artistName}
          playing={albumPlaying(a.id)}
          onclick={() => nav.go({ name: 'album', id: a.id })}
          onplay={() => playAlbum(a.id)}
          oncontext={(e) => menu.show(e, albumCardMenu(a.id))}
        />
      {/each}
    </Shelf>
  {/if}

  {#if recents.items.length}
    <Shelf title="Visto recientemente">
      {#each recents.items as item (item.kind + item.id)}
        <Card
          image={item.image}
          title={item.title}
          subtitle={item.subtitle}
          round={item.kind === 'artist'}
          onclick={() => nav.go({ name: item.kind, id: item.id })}
          onplay={item.kind === 'album' ? () => playAlbum(item.id) : undefined}
        />
      {/each}
    </Shelf>
  {/if}

  {#if loaded && !tiles.length && !played.length && !library.liked.size && !library.albums.length && !library.playlists.length && !recents.items.length}
    <div class="empty-state">
      <Icon name="search" size={40} />
      <strong>Encuentra tu música</strong>
      <p>Busca un grupo o prueba los sugeridos. Tus escuchas y favoritos afinan las recomendaciones.</p>
      <button class="pill" onclick={openSearch}>Buscar</button>
    </div>
  {/if}
</section>

<style>
  .home {
    padding-top: 76px;
  }
  .welcome {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
  }
  .greeting {
    margin-bottom: 0;
  }
  .surprise {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 44px;
    margin-right: 12px;
    padding: 10px 18px;
    border: 1px solid var(--line);
    border-radius: 24px;
    background: var(--panel-2);
    font-weight: 700;
    flex-shrink: 0;
  }
  .surprise:hover:not(:disabled) {
    background: var(--hover);
    border-color: var(--accent);
  }
  .surprise:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .surprise:focus-visible,
  .tile-pin:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
  .tile-pin {
    position: relative;
    z-index: 2;
    display: grid;
    place-items: center;
    flex: none;
    width: 32px;
    height: 44px;
    color: var(--accent);
    border-radius: var(--radius-s);
  }
  .tile-pin:hover {
    background: var(--hover);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 10px;
    margin: 0 12px 12px;
  }
  .tile {
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    height: 64px;
    padding-right: 12px;
    overflow: hidden;
    border-radius: var(--radius-s);
    background: rgb(255 255 255 / 0.08);
    backdrop-filter: blur(10px);
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.15);
    transition: background 0.2s;
  }
  .tile:hover {
    background: rgb(255 255 255 / 0.16);
  }
  .tile-hit {
    position: absolute;
    inset: 0;
    z-index: 1;
  }
  .tile-art {
    flex: none;
    width: 64px;
    height: 64px;
  }
  .tile-art :global(.cover),
  .tile-art :global(.collage) {
    border-radius: 0;
    box-shadow: 4px 0 12px rgb(0 0 0 / 0.3);
  }
  .liked-art {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    background: linear-gradient(135deg, #5b3fd1, #c7b3ff);
    color: #fff;
  }
  .tile-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    font-weight: 700;
    line-height: 1.25;
  }
  .tile-play {
    position: relative;
    z-index: 2;
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--accent-grad);
    color: #10002b;
    box-shadow: 0 6px 16px rgb(0 0 0 / 0.4);
    opacity: 0;
    transform: scale(0.9);
    transition:
      opacity 0.2s,
      transform 0.2s var(--ease);
  }
  .tile:hover .tile-play,
  .tile:focus-within .tile-play,
  .tile-play.show {
    opacity: 1;
    transform: none;
  }
  @media (hover: none) {
    .tile-play:not(.show) {
      display: none;
    }
  }

  @media (max-width: 720px) {
    .welcome {
      align-items: flex-start;
      flex-direction: column;
      gap: 12px;
    }
    .surprise {
      margin-left: 4px;
      margin-right: 4px;
    }
    .tile-pin {
      width: 28px;
    }
    .home {
      padding-top: calc(60px + var(--safe-top));
    }
    .tiles {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin: 0 4px 12px;
    }
    .tile {
      height: 56px;
      gap: 10px;
    }
    .tile-art {
      width: 56px;
      height: 56px;
    }
    .tile-title {
      font-size: 13px;
    }
    /* El botón de lo que suena va sobre la carátula: al lado, el título no cabría. */
    .tile-play {
      position: absolute;
      top: 12px;
      left: 12px;
      width: 32px;
      height: 32px;
    }
  }
  @media (max-width: 420px) {
    .tile.pinned {
      grid-column: 1 / -1;
    }
  }
</style>
