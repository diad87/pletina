<script lang="ts">
  import DownloadButton from '../components/DownloadButton.svelte'
  import Icon from '../components/Icon.svelte'
  import Skeleton from '../components/Skeleton.svelte'
  import Status from '../components/Status.svelte'
  import TrackList from '../components/TrackList.svelte'
  import * as api from '../lib/api'
  import { longDuration, shortDate, songs } from '../lib/format'
  import { fromLib, library } from '../lib/library.svelte'
  import { nav } from '../lib/nav.svelte'
  import { player } from '../lib/player.svelte'
  import { theme } from '../lib/theme.svelte'
  import type { Entry } from '../lib/types'

  let entries = $state<Entry[] | null>(null)
  let error = $state<string | null>(null)
  let first = true

  theme.clear()
  theme.setColor('hsl(258 55% 34%)', 'Canciones que te gustan')

  // Se recarga cada vez que cambia la biblioteca (p. ej. al quitar un ♥ desde aquí).
  $effect(() => {
    void library.version
    let alive = true
    api
      .likedTracks()
      .then((list) => {
        if (!alive) return
        entries = list
        if (first) nav.ready()
        first = false
      })
      .catch((e) => alive && (error = String(e)))
    return () => {
      alive = false
    }
  })

  const items = $derived((entries ?? []).map((e) => fromLib(e.track)))
  const total = $derived(items.reduce((sum, i) => sum + i.track.duration, 0))
  const isThis = $derived(items.some((i) => i.track.id === player.current?.track.id) && player.queue.length === items.length)
  const playing = $derived(isThis && player.status === 'playing')

  $effect(() => {
    theme.play = items.length ? { playing, toggle: () => (isThis ? player.toggle() : player.playQueue(items, 0, 'Canciones que te gustan')) } : null
  })
</script>

{#if error}
  <Status {error} />
{:else if !entries}
  <Skeleton />
{:else}
  <header class="hero">
    <div class="art liked-art"><Icon name="heartFilled" size={80} /></div>
    <div class="info">
      <div class="kind">Playlist</div>
      <h1>Canciones que te gustan</h1>
      <div class="meta">{songs(items.length)}{#if total}, {longDuration(total)}{/if}</div>
    </div>
  </header>

  <section class="page">
    {#if items.length}
      <div class="actions">
        <button
          class="big-play"
          onclick={() => (isThis ? player.toggle() : player.playQueue(items, 0, 'Canciones que te gustan'))}
          title={playing ? 'Pausa' : 'Reproducir'}
        >
          <Icon name={playing ? 'pause' : 'play'} size={26} />
        </button>
        <DownloadButton {items} />
      </div>
      <TrackList {items} variant="list" context="Canciones que te gustan" metaLabel="Añadida" meta={(i) => shortDate(entries![i].at)} />
    {:else}
      <div class="empty-state">
        <Icon name="heart" size={48} />
        <strong>Las canciones que te gusten aparecerán aquí</strong>
        <p>Pulsa el ♥ de cualquier canción para guardarla.</p>
      </div>
    {/if}
  </section>
{/if}

<style>
  .liked-art {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    border-radius: 6px;
    background: linear-gradient(135deg, #4b2fc9 0%, #8f6cff 55%, #e2d6ff 100%);
    color: #fff;
  }
</style>
