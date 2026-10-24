<script lang="ts">
  import Card from './Card.svelte'
  import Shelf from './Shelf.svelte'
  import * as api from '../lib/api'
  import { albumCardMenu, albumPlaying, playAlbum } from '../lib/actions'
  import { library } from '../lib/library.svelte'
  import { menu } from '../lib/menu.svelte'
  import { nav } from '../lib/nav.svelte'
  import { recommend, type RecommendationResult } from '../lib/recommendations'
  import type { Entry } from '../lib/types'

  let { history, ready }: { history: Entry[]; ready: boolean } = $props()
  let result = $state<RecommendationResult | null>(null)
  let loading = $state(true)
  let failed = $state(false)
  let attempt = $state(0)

  $effect(() => {
    if (!ready) return
    const recent = history
    const saved = library.albums
    void library.version
    void attempt
    let alive = true
    loading = true
    failed = false

    // La selección se calcula aquí; al catálogo solo se le piden artistas y discos.
    api.likedTracks()
      .catch(() => [])
      .then((liked) => recommend({ history: recent, liked, saved }, api))
      .then((next) => {
        if (!alive) return
        result = next
        failed = next.failed
      })
      .catch(() => {
        if (alive) failed = true
      })
      .finally(() => {
        if (alive) loading = false
      })
    return () => { alive = false }
  })

  const hasSuggestions = $derived(!!(result?.albums.length || result?.artists.length))
</script>

<svelte:window ononline={() => { api.invalidateDiscovery(); attempt++ }} />

<div class="recommendations" aria-busy={loading}>
  {#if loading && !hasSuggestions}
    <Shelf title="Sugeridos para ti" subtitle="Buscando música para descubrir…">
      {#each Array(6) as _, i (i)}
        <div class="placeholder" aria-hidden="true">
          <div class="art shimmer"></div>
          <div class="line shimmer"></div>
          <div class="line short shimmer"></div>
        </div>
      {/each}
    </Shelf>
  {:else if result && hasSuggestions}
    {#if result.albums.length}
      <Shelf
        title={result.personalized ? 'Sugeridos para ti' : 'Descubre música'}
        subtitle={result.personalized ? 'A partir de tus escuchas, favoritos y discos guardados.' : 'Una selección popular para empezar a escuchar.'}
      >
        {#each result.albums as { album, reason } (album.id)}
          <div class="suggestion">
            <Card
              image={album.coverMedium ?? album.coverXl}
              title={album.title}
              subtitle={album.artist?.name ?? 'Álbum'}
              playing={albumPlaying(album.id)}
              onclick={() => nav.go({ name: 'album', id: album.id })}
              onplay={() => playAlbum(album.id)}
              oncontext={(e) => menu.show(e, albumCardMenu(album.id))}
            />
            <p class="reason" title={reason}>{reason}</p>
          </div>
        {/each}
      </Shelf>
    {/if}
    {#if result.artists.length}
      <Shelf title={result.personalized ? 'Artistas que te pueden gustar' : 'Artistas para descubrir'}>
        {#each result.artists as { artist, reason } (artist.id)}
          <Card
            image={artist.pictureMedium ?? artist.pictureXl}
            title={artist.name}
            subtitle={reason}
            round
            onclick={() => nav.go({ name: 'artist', id: artist.id })}
          />
        {/each}
      </Shelf>
    {/if}
  {/if}

  {#if !loading && failed}
    <div class="notice" role="status">
      <p>No se han podido cargar los sugeridos. Vuelve a intentarlo cuando tengas conexión.</p>
      <button class="pill" onclick={() => attempt++}>Reintentar</button>
    </div>
  {:else if !loading && !hasSuggestions}
    <p class="notice">No hay sugerencias nuevas por ahora. Prueba a escuchar otros artistas o guardar favoritos.</p>
  {/if}
</div>

<style>
  .suggestion {
    min-width: 0;
  }
  .reason {
    margin: 0 12px 8px;
    color: var(--muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .placeholder {
    padding: 12px;
  }
  .art {
    aspect-ratio: 1;
    border-radius: var(--radius-s);
    margin-bottom: 14px;
  }
  .line {
    height: 12px;
    width: 80%;
    margin-bottom: 10px;
    border-radius: 6px;
  }
  .short {
    width: 55%;
  }
  .notice {
    margin: 24px 12px;
    color: var(--muted);
    font-size: 13px;
  }
  .notice p {
    margin: 0 0 12px;
  }
</style>
