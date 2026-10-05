<script lang="ts">
  import Card from '../components/Card.svelte'
  import Status from '../components/Status.svelte'
  import * as api from '../lib/api'
  import { fans } from '../lib/format'
  import { nav } from '../lib/nav.svelte'
  import type { SearchResults } from '../lib/types'

  let { query }: { query: string } = $props()

  let results = $state<SearchResults | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)
  let attempt = $state(0)

  // Busca 250 ms después de dejar de escribir. Los resultados anteriores se quedan
  // en pantalla mientras tanto para que no parpadee.
  $effect(() => {
    const q = query.trim()
    void attempt
    error = null
    if (!q) {
      results = null
      loading = false
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
</script>

<section class="page">
  {#if !query.trim()}
    <p class="hint">Escribe el nombre de un grupo, artista o disco.</p>
  {:else if error}
    <Status {error} retry={() => attempt++} />
  {:else if !results}
    <Status />
  {:else if !results.artists.length && !results.albums.length}
    {#if !loading}<p class="hint">No hay resultados para «{query.trim()}».</p>{/if}
  {:else}
    <div class:stale={loading}>
      {#if results.artists.length}
        <h2 class="section-title">Artistas</h2>
        <div class="grid one-row">
          {#each results.artists as artist (artist.id)}
            <Card
              image={artist.pictureMedium}
              title={artist.name}
              subtitle={`${fans(artist.nbFan)} fans`}
              round
              onclick={() => nav.go({ name: 'artist', id: artist.id })}
            />
          {/each}
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
              onclick={() => nav.go({ name: 'album', id: album.id })}
            />
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .hint {
    padding: 48px 12px;
    color: var(--muted);
  }
  /* Solo la primera fila de artistas, para que los discos queden a la vista. */
  .one-row {
    grid-template-rows: auto;
    grid-auto-rows: 0;
    overflow: hidden;
  }
  .stale {
    opacity: 0.6;
    transition: opacity 0.2s;
  }
</style>
