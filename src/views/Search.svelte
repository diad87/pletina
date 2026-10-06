<script lang="ts">
  import Card from '../components/Card.svelte'
  import Cover from '../components/Cover.svelte'
  import Icon from '../components/Icon.svelte'
  import Shelf from '../components/Shelf.svelte'
  import Skeleton from '../components/Skeleton.svelte'
  import Status from '../components/Status.svelte'
  import { albumCardMenu, albumPlaying, playAlbum } from '../lib/actions'
  import { menu } from '../lib/menu.svelte'
  import * as api from '../lib/api'
  import { fans } from '../lib/format'
  import { nav } from '../lib/nav.svelte'
  import { recents } from '../lib/recents.svelte'
  import { theme } from '../lib/theme.svelte'
  import type { SearchResults } from '../lib/types'

  let { query }: { query: string } = $props()

  let results = $state<SearchResults | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)
  let attempt = $state(0)

  theme.clear()

  // Busca 250 ms después de dejar de escribir. Los resultados anteriores se quedan
  // en pantalla mientras tanto para que no parpadee.
  $effect(() => {
    const q = query.trim()
    void attempt
    error = null
    if (!q) {
      results = null
      loading = false
      theme.neutral()
      return
    }
    loading = true
    let alive = true
    const timer = setTimeout(() => {
      api
        .search(q)
        .then((r) => {
          if (!alive) return
          results = r
          loading = false
          // La página toma el color del resultado principal.
          theme.set(r.artists[0]?.pictureMedium ?? r.albums[0]?.coverMedium)
          nav.ready()
        })
        .catch((e) => {
          if (!alive) return
          error = String(e)
          loading = false
        })
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  })

  const topArtist = $derived(results?.artists[0])
  const hasLocal = $derived(!!results && (results.localArtists.length > 0 || results.localAlbums.length > 0))
</script>

<section class="page top">
  {#if !query.trim()}
    <div class="intro">
      <h1 class="page-title">Buscar</h1>
      <p class="hint">Escribe el nombre de un grupo, artista o disco.</p>
    </div>
    {#if recents.items.length}
      <Shelf title="Visto recientemente">
        {#each recents.items as item (item.kind + item.id)}
          <Card
            image={item.image}
            title={item.title}
            subtitle={item.subtitle}
            round={item.kind === 'artist'}
            onclick={() => nav.go({ name: item.kind, id: item.id })}
          />
        {/each}
      </Shelf>
    {/if}
  {:else if error}
    <Status {error} retry={() => attempt++} />
  {:else if !results}
    <Skeleton kind="grid" />
  {:else if !results.artists.length && !results.albums.length && !hasLocal}
    {#if !loading}
      <div class="empty-state">
        <Icon name="search" size={40} />
        <strong>No hay resultados para «{query.trim()}»</strong>
        <p>Revisa cómo está escrito o prueba con menos palabras.</p>
      </div>
    {/if}
  {:else}
    <div class:stale={loading}>
      {#if hasLocal}
        <Shelf title="En tu música">
          {#each results.localArtists as artist (artist.id)}
            <Card
              image={artist.pictureMedium}
              title={artist.name}
              subtitle="Artista · tu música"
              round
              onclick={() => nav.go({ name: 'artist', id: artist.id })}
            />
          {/each}
          {#each results.localAlbums as album (album.id)}
            <Card
              image={album.coverMedium}
              title={album.title}
              subtitle={album.artist?.name ?? ''}
              playing={albumPlaying(album.id)}
              onclick={() => nav.go({ name: 'album', id: album.id })}
              onplay={() => playAlbum(album.id)}
              oncontext={(e) => menu.show(e, albumCardMenu(album.id))}
            />
          {/each}
        </Shelf>
      {/if}

      {#if topArtist}
        <div class="top-row">
          <div class="top-col">
            <h2 class="section-title">Resultado principal</h2>
            <button class="top-result" onclick={() => nav.go({ name: 'artist', id: topArtist.id })}>
              <span class="top-art"><Cover src={topArtist.pictureMedium} round /></span>
              <span class="top-name">{topArtist.name}</span>
              <span class="top-sub"><span class="tag">Artista</span> {fans(topArtist.nbFan)} fans</span>
            </button>
          </div>
          {#if results.artists.length > 1}
            <div class="others">
              <h2 class="section-title">Artistas</h2>
              <div class="artist-row">
                {#each results.artists.slice(1, 6) as artist (artist.id)}
                  <Card
                    image={artist.pictureMedium}
                    title={artist.name}
                    subtitle="Artista"
                    round
                    onclick={() => nav.go({ name: 'artist', id: artist.id })}
                  />
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/if}

      {#if results.albums.length}
        <h2 class="section-title">Discos</h2>
        <div class="grid">
          {#each results.albums as album (album.id)}
            <Card
              image={album.coverMedium}
              title={album.title}
              subtitle={album.artist?.name ?? ''}
              playing={albumPlaying(album.id)}
              onclick={() => nav.go({ name: 'album', id: album.id })}
              onplay={() => playAlbum(album.id)}
              oncontext={(e) => menu.show(e, albumCardMenu(album.id))}
            />
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .intro .page-title {
    margin-bottom: 4px;
  }
  .hint {
    margin: 0 12px 8px;
    color: var(--muted);
  }
  .stale {
    opacity: 0.55;
    transition: opacity 0.2s;
  }

  .top-row {
    display: grid;
    grid-template-columns: minmax(280px, 400px) minmax(0, 1fr);
    gap: 12px;
  }
  .top-col {
    display: flex;
    flex-direction: column;
  }
  .top-result {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin: 0 12px;
    padding: 20px;
    border-radius: var(--radius-l);
    background: rgb(255 255 255 / 0.07);
    text-align: left;
    transition:
      background 0.2s,
      transform 0.25s var(--ease);
  }
  .top-result:hover {
    background: rgb(255 255 255 / 0.12);
  }
  .top-art {
    width: 104px;
    margin-bottom: 12px;
  }
  .top-art :global(.cover) {
    box-shadow: var(--shadow-2);
  }
  .top-name {
    font-size: 32px;
    font-weight: 900;
    letter-spacing: -0.03em;
    line-height: 1.1;
  }
  .top-sub {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--muted);
    font-weight: 600;
  }
  .tag {
    padding: 3px 10px;
    border-radius: 12px;
    background: rgb(0 0 0 / 0.35);
    color: var(--text);
    font-size: 12px;
    font-weight: 700;
  }
  .others {
    min-width: 0;
  }
  .artist-row {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    grid-template-rows: auto;
    grid-auto-rows: 0;
    overflow: hidden;
  }
</style>
