<script lang="ts">
  import Card from '../components/Card.svelte'
  import Collage from '../components/Collage.svelte'
  import Cover from '../components/Cover.svelte'
  import EngineSwitch from '../components/EngineSwitch.svelte'
  import Icon from '../components/Icon.svelte'
  import Shelf from '../components/Shelf.svelte'
  import { albumCardMenu, albumPlaying, playAlbum } from '../lib/actions'
  import { menu } from '../lib/menu.svelte'
  import * as api from '../lib/api'
  import { songs } from '../lib/format'
  import { fromLib, library } from '../lib/library.svelte'
  import { layout } from '../lib/layout.svelte'
  import { nav, type Route } from '../lib/nav.svelte'
  import { isAndroid } from '../lib/player-android.svelte'
  import { player } from '../lib/player.svelte'
  import { recents } from '../lib/recents.svelte'
  import { theme } from '../lib/theme.svelte'
  import type { LibTrack } from '../lib/types'

  const hour = new Date().getHours()
  const greeting = hour < 6 ? 'Buenas noches' : hour < 13 ? 'Buenos días' : hour < 21 ? 'Buenas tardes' : 'Buenas noches'

  theme.clear()

  // Discos escuchados últimamente, sacados del historial (uno por disco, el más reciente primero).
  let played = $state<LibTrack[]>([])
  let loaded = $state(false)
  $effect(() => {
    void library.historyVersion
    // Si ya se ha salido de Inicio cuando llega la respuesta, no se toca el color de la otra pantalla.
    let alive = true
    api
      .history(300)
      .then((entries) => {
        if (!alive) return
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
  }

  // Accesos rápidos: favoritas, playlists y discos recientes (hasta 8).
  const tiles = $derived.by<Tile[]>(() => {
    const list: Tile[] = []
    if (library.liked.size) list.push({ key: 'liked', title: 'Canciones que te gustan', liked: true, route: { name: 'liked' } })
    for (const p of library.playlists.slice(0, 3)) {
      list.push({ key: `p${p.id}`, title: p.name, covers: p.covers, route: { name: 'playlist', id: p.id } })
    }
    for (const t of played) {
      if (list.length >= 8) break
      list.push({
        key: `a${t.albumId}`,
        title: t.albumTitle,
        image: t.cover,
        route: { name: 'album', id: t.albumId },
        play: () => playAlbum(t.albumId),
        playing: albumPlaying(t.albumId),
      })
    }
    return list
  })

  async function playLiked() {
    const entries = await api.likedTracks()
    if (entries.length) player.playQueue(entries.map((e) => fromLib(e.track)), 0)
  }

  async function playPlaylist(id: number) {
    const p = await api.playlist(id)
    if (p.entries.length) player.playQueue(p.entries.map((e) => fromLib(e.track)), 0)
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
  <h1 class="page-title greeting">{greeting}</h1>

  {#if tiles.length}
    <div class="tiles">
      {#each tiles as t (t.key)}
        {@const play = tilePlay(t)}
        <div class="tile">
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
          {#if play}
            <button class="tile-play" class:show={t.playing} onclick={play} title={t.playing ? 'Pausa' : 'Reproducir'}>
              <Icon name={t.playing ? 'pause' : 'play'} size={18} />
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if played.length}
    <Shelf title="Escuchado recientemente">
      {#each played as t (t.albumId)}
        <Card
          image={t.cover}
          title={t.albumTitle}
          subtitle={t.artistName}
          playing={albumPlaying(t.albumId)}
          onclick={() => nav.go({ name: 'album', id: t.albumId })}
          onplay={() => playAlbum(t.albumId)}
          oncontext={(e) => menu.show(e, albumCardMenu(t.albumId))}
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

  {#if loaded && !played.length && !library.playlists.length && !recents.items.length}
    <div class="empty-state">
      <Icon name="search" size={40} />
      <strong>Empieza buscando un grupo</strong>
      <p>Encuentra sus discos, elige uno y dale a reproducir.</p>
      <button class="pill" onclick={openSearch}>Buscar</button>
    </div>
  {/if}

  <!-- En el móvil no hay nada que elegir: siempre el motor propio. -->
  {#if !isAndroid}<EngineSwitch />{/if}
</section>

<style>
  .home {
    padding-top: 76px;
  }
  .greeting {
    margin-bottom: 20px;
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
  }
</style>
