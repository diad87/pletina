<script lang="ts">
  import Cover from '../components/Cover.svelte'
  import Icon from '../components/Icon.svelte'
  import DownloadButton from '../components/DownloadButton.svelte'
  import Status from '../components/Status.svelte'
  import TrackList from '../components/TrackList.svelte'
  import { addToPlaylistMenu } from '../lib/actions'
  import * as api from '../lib/api'
  import { longDate, longDuration, recordType, songs, year } from '../lib/format'
  import { library } from '../lib/library.svelte'
  import { menu } from '../lib/menu.svelte'
  import { nav } from '../lib/nav.svelte'
  import { player, type QueueItem } from '../lib/player.svelte'
  import { recents } from '../lib/recents.svelte'
  import type { AlbumDetail } from '../lib/types'

  let { id }: { id: number } = $props()

  let data = $state<AlbumDetail | null>(null)
  let error = $state<string | null>(null)
  let attempt = $state(0)

  $effect(() => {
    const current = id
    void attempt
    data = null
    error = null
    let alive = true
    api
      .album(current)
      .then((album) => {
        if (!alive) return
        data = album
        nav.ready()
        recents.add({
          kind: 'album',
          id: album.id,
          title: album.title,
          subtitle: album.artist.name,
          image: album.coverBig,
        })
      })
      .catch((e) => alive && (error = String(e)))
    return () => {
      alive = false
    }
  })

  const releaseDate = $derived(longDate(data?.releaseDate ?? null))

  // El disco entero es la cola: al acabar una canción suena la siguiente.
  const queue = $derived<QueueItem[]>(
    data
      ? data.tracks.map((track) => ({
          track,
          albumId: data!.id,
          albumTitle: data!.title,
          artistId: data!.artist.id,
          cover: data!.coverBig,
        }))
      : [],
  )

  const isThisAlbum = $derived(player.current?.albumId === data?.id)
  const playing = $derived(isThisAlbum && player.status !== 'paused' && player.status !== 'idle')
  const saved = $derived(data ? library.isSaved(data.id) : false)

  function playAlbum() {
    if (isThisAlbum) player.toggle()
    else player.playQueue(queue, 0)
  }

  function albumMenu(e: MouseEvent) {
    if (!data) return
    const artistId = data.artist.id
    menu.show(e, [
      addToPlaylistMenu(() => queue),
      { label: 'Ir al artista', icon: 'user', action: () => nav.go({ name: 'artist', id: artistId }) },
    ])
  }
</script>

{#if error}
  <Status {error} retry={() => attempt++} />
{:else if !data}
  <Status />
{:else}
  <header class="hero">
    <div class="art"><Cover src={data.coverXl ?? data.coverBig} /></div>
    <div>
      <div class="kind">{recordType(data.recordType)}</div>
      <h1>{data.title}</h1>
      <div class="meta">
        <button class="link strong" onclick={() => nav.go({ name: 'artist', id: data!.artist.id })}
          >{data.artist.name}</button
        >
        {#if year(data.releaseDate)}· {year(data.releaseDate)}{/if}
        · {songs(data.tracks.length)}, {longDuration(data.duration)}
      </div>
    </div>
  </header>

  <section class="page">
    <div class="actions">
      <button class="big-play" onclick={playAlbum} title={playing ? 'Pausa' : 'Reproducir'}>
        <Icon name={playing ? 'pause' : 'play'} size={24} />
      </button>
      <button
        class="action"
        class:on={saved}
        onclick={() => library.toggleAlbum(data!)}
        title={saved ? 'Quitar de tu biblioteca' : 'Guardar en tu biblioteca'}
      >
        <Icon name={saved ? 'heartFilled' : 'heart'} size={30} />
      </button>
      <DownloadButton items={queue} />
      <button class="action" onclick={albumMenu} title="Más opciones"><Icon name="more" size={30} /></button>
    </div>

    <TrackList items={queue} variant="album" albumArtistId={data.artist.id} />

    <footer class="credits">
      {#if releaseDate}<div>{releaseDate}</div>{/if}
      {#if data.label}<div>© {data.label}</div>{/if}
      {#if data.genres.length}<div>{data.genres.join(', ')}</div>{/if}
    </footer>
  </section>
{/if}

<style>
  .credits {
    margin-top: 32px;
    padding: 0 16px;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.7;
  }
</style>
