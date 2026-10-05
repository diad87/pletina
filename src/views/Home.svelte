<script lang="ts">
  import Card from '../components/Card.svelte'
  import Collage from '../components/Collage.svelte'
  import Icon from '../components/Icon.svelte'
  import * as api from '../lib/api'
  import { songs } from '../lib/format'
  import { library } from '../lib/library.svelte'
  import { nav } from '../lib/nav.svelte'
  import { recents } from '../lib/recents.svelte'
  import type { LibTrack } from '../lib/types'

  const hour = new Date().getHours()
  const greeting = hour < 6 ? 'Buenas noches' : hour < 13 ? 'Buenos días' : hour < 21 ? 'Buenas tardes' : 'Buenas noches'

  // Discos escuchados últimamente, sacados del historial (uno por disco, el más reciente primero).
  let played = $state<LibTrack[]>([])
  $effect(() => {
    void library.historyVersion
    api
      .history(300)
      .then((entries) => {
        const seen = new Set<number>()
        played = entries.map((e) => e.track).filter((t) => !seen.has(t.albumId) && seen.add(t.albumId)).slice(0, 12)
      })
      .catch(() => {})
  })

  nav.ready()
</script>

<section class="page">
  <h1 class="page-title">{greeting}</h1>

  {#if played.length}
    <h2 class="section-title">Escuchado recientemente</h2>
    <div class="grid">
      {#each played as t (t.albumId)}
        <Card
          image={t.cover}
          title={t.albumTitle}
          subtitle={t.artistName}
          onclick={() => nav.go({ name: 'album', id: t.albumId })}
        />
      {/each}
    </div>
  {/if}

  {#if library.playlists.length}
    <h2 class="section-title">Tus playlists</h2>
    <div class="grid">
      {#each library.playlists as p (p.id)}
        <button class="playlist-card" onclick={() => nav.go({ name: 'playlist', id: p.id })} title={p.name}>
          <Collage covers={p.covers} />
          <span class="title">{p.name}</span>
          <span class="subtitle">{songs(p.count)}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if recents.items.length}
    <h2 class="section-title">Visto recientemente</h2>
    <div class="grid">
      {#each recents.items as item (item.kind + item.id)}
        <Card
          image={item.image}
          title={item.title}
          subtitle={item.subtitle}
          round={item.kind === 'artist'}
          onclick={() => nav.go({ name: item.kind, id: item.id })}
        />
      {/each}
    </div>
  {/if}

  {#if !played.length && !library.playlists.length && !recents.items.length}
    <div class="empty-state">
      <Icon name="search" size={48} />
      <p>Busca un grupo para ver sus discos.</p>
      <button class="pill" onclick={() => nav.focusSearch()}>Buscar</button>
    </div>
  {/if}
</section>

<style>
  /* Igual que Card, pero con el mosaico de portada de la playlist. */
  .playlist-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 12px;
    border-radius: 8px;
    text-align: left;
    transition: background 0.15s;
  }
  .playlist-card:hover {
    background: var(--hover);
  }
  .title {
    margin-top: 8px;
    font-weight: 600;
  }
  .subtitle {
    font-size: 13px;
    color: var(--muted);
  }
  .title,
  .subtitle {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
</style>
