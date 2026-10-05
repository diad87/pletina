<script lang="ts">
  import Card from '../components/Card.svelte'
  import Icon from '../components/Icon.svelte'
  import Skeleton from '../components/Skeleton.svelte'
  import Status from '../components/Status.svelte'
  import TrackList from '../components/TrackList.svelte'
  import { albumPlaying, playAlbum } from '../lib/actions'
  import * as api from '../lib/api'
  import { fans, recordType, year } from '../lib/format'
  import { nav } from '../lib/nav.svelte'
  import { player, type QueueItem } from '../lib/player.svelte'
  import { recents } from '../lib/recents.svelte'
  import { theme } from '../lib/theme.svelte'
  import type { Album, ArtistPage } from '../lib/types'

  let { id }: { id: number } = $props()

  let data = $state<ArtistPage | null>(null)
  let error = $state<string | null>(null)
  let attempt = $state(0)
  let showAllTop = $state(false)
  let filter = $state<'all' | 'album' | 'single' | 'compile'>('all')

  theme.clear()

  $effect(() => {
    const current = id
    void attempt
    data = null
    error = null
    let alive = true
    api
      .artist(current)
      .then((page) => {
        if (!alive) return
        data = page
        theme.set(page.artist.pictureMedium, page.artist.name)
        nav.ready()
        recents.add({
          kind: 'artist',
          id: page.artist.id,
          title: page.artist.name,
          subtitle: 'Artista',
          image: page.artist.pictureMedium,
        })
      })
      .catch((e) => alive && (error = String(e)))
    return () => {
      alive = false
    }
  })

  // Las más escuchadas, como cola (cada una con su disco).
  const top = $derived<QueueItem[]>(
    (data?.top ?? []).map((t) => ({
      track: t,
      albumId: t.album.id,
      albumTitle: t.album.title,
      artistId: data!.artist.id,
      cover: t.album.coverBig,
    })),
  )
  const isThis = $derived(top.length > 0 && top.some((t) => t.track.id === player.current?.track.id))
  const playing = $derived(isThis && player.status === 'playing')

  function playTop() {
    if (isThis) player.toggle()
    else if (top.length) player.playQueue(top, 0)
  }

  $effect(() => {
    theme.play = top.length ? { playing, toggle: playTop } : null
  })

  const kindOf = (t: string | null) => (t === 'single' || t === 'ep' ? 'single' : t === 'compile' ? 'compile' : 'album')
  const counts = $derived({
    album: data?.albums.filter((a) => kindOf(a.recordType) === 'album').length ?? 0,
    single: data?.albums.filter((a) => kindOf(a.recordType) === 'single').length ?? 0,
    compile: data?.albums.filter((a) => kindOf(a.recordType) === 'compile').length ?? 0,
  })
  const shown = $derived((data?.albums ?? []).filter((a) => filter === 'all' || kindOf(a.recordType) === filter))
  const subtitle = (album: Album) => [year(album.releaseDate), recordType(album.recordType)].filter(Boolean).join(' · ')

  const FILTERS = [
    { key: 'all', label: 'Todo' },
    { key: 'album', label: 'Álbumes' },
    { key: 'single', label: 'Sencillos y EP' },
    { key: 'compile', label: 'Recopilatorios' },
  ] as const
</script>

{#if error}
  <Status {error} retry={() => attempt++} />
{:else if !data}
  <Skeleton round />
{:else}
  <header class="banner" style:--photo="url({data.artist.pictureXl ?? data.artist.pictureMedium})">
    <div class="photo" aria-hidden="true"></div>
    <div class="banner-text">
      <span class="verified"><Icon name="user" size={16} /> Artista</span>
      <h1>{data.artist.name}</h1>
      <div class="stats">{fans(data.artist.nbFan)} fans · {data.albums.length} lanzamientos</div>
    </div>
  </header>

  <section class="page">
    <div class="actions">
      <button class="big-play" onclick={playTop} disabled={!top.length} title={playing ? 'Pausa' : 'Reproducir lo más escuchado'}>
        <Icon name={playing ? 'pause' : 'play'} size={26} />
      </button>
    </div>

    {#if top.length}
      <h2 class="section-title">Populares</h2>
      <TrackList items={showAllTop ? top : top.slice(0, 5)} variant="list" />
      {#if top.length > 5}
        <button class="more" onclick={() => (showAllTop = !showAllTop)}>{showAllTop ? 'Mostrar menos' : 'Mostrar más'}</button>
      {/if}
    {/if}

    <h2 class="section-title">Discografía</h2>
    <div class="chips">
      {#each FILTERS as f (f.key)}
        {#if f.key === 'all' || counts[f.key]}
          <button class="chip" class:active={filter === f.key} onclick={() => (filter = f.key)}>
            {f.label}{#if f.key !== 'all'}<span class="count">{counts[f.key]}</span>{/if}
          </button>
        {/if}
      {/each}
    </div>
    <div class="grid">
      {#each shown as album (album.id)}
        <Card
          image={album.coverMedium}
          title={album.title}
          subtitle={subtitle(album)}
          playing={albumPlaying(album.id)}
          onclick={() => nav.go({ name: 'album', id: album.id })}
          onplay={() => playAlbum(album.id)}
        />
      {/each}
    </div>
  </section>
{/if}

<style>
  /* Cabecera con la foto del artista a todo lo ancho, fundida con el color de la página. */
  .banner {
    position: relative;
    display: flex;
    align-items: flex-end;
    min-height: clamp(280px, 40vh, 400px);
    padding: 84px 36px 28px;
    overflow: hidden;
  }
  .photo {
    position: absolute;
    inset: 0;
    background: var(--photo) center 25% / cover no-repeat;
    mask-image: linear-gradient(180deg, #000 45%, transparent 100%);
    animation: settle 1.2s var(--ease) both;
  }
  @keyframes settle {
    from {
      opacity: 0;
      transform: scale(1.06);
    }
  }
  .photo::after {
    content: '';
    position: absolute;
    inset: 0;
    background:
      linear-gradient(90deg, rgb(0 0 0 / 0.55) 0%, transparent 60%),
      linear-gradient(180deg, transparent 40%, color-mix(in srgb, var(--page-color) 60%, transparent) 100%);
  }
  .banner-text {
    position: relative;
  }
  .verified {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 14px;
    background: rgb(0 0 0 / 0.35);
    backdrop-filter: blur(8px);
    font-size: 12px;
    font-weight: 700;
  }
  h1 {
    margin: 10px 0 12px;
    font-size: clamp(48px, 8vw, 112px);
    font-weight: 900;
    line-height: 0.95;
    letter-spacing: -0.05em;
    text-shadow: 0 4px 30px rgb(0 0 0 / 0.45);
  }
  .stats {
    font-weight: 600;
    color: rgb(255 255 255 / 0.85);
    text-shadow: 0 1px 8px rgb(0 0 0 / 0.5);
  }

  .more {
    margin: 8px 16px 0;
    color: var(--muted);
    font-weight: 700;
    font-size: 13px;
  }
  .more:hover {
    color: var(--text);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 4px 12px 12px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 16px;
    border-radius: 17px;
    background: rgb(255 255 255 / 0.08);
    font-weight: 600;
    transition:
      background 0.15s,
      color 0.15s;
  }
  .chip:hover {
    background: rgb(255 255 255 / 0.14);
  }
  .chip.active {
    background: var(--text);
    color: #000;
  }
  .count {
    font-size: 12px;
    opacity: 0.6;
  }
</style>
