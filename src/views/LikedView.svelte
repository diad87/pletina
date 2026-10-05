<script lang="ts">
  import DownloadButton from '../components/DownloadButton.svelte'
  import Icon from '../components/Icon.svelte'
  import Status from '../components/Status.svelte'
  import TrackList from '../components/TrackList.svelte'
  import * as api from '../lib/api'
  import { longDuration, shortDate, songs } from '../lib/format'
  import { fromLib, library } from '../lib/library.svelte'
  import { nav } from '../lib/nav.svelte'
  import { player } from '../lib/player.svelte'
  import type { Entry } from '../lib/types'

  let entries = $state<Entry[] | null>(null)
  let error = $state<string | null>(null)
  let first = true

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
</script>

{#if error}
  <Status {error} />
{:else if !entries}
  <Status />
{:else}
  <header class="hero">
    <div class="art liked-art"><Icon name="heartFilled" size={72} /></div>
    <div>
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
          onclick={() => (isThis ? player.toggle() : player.playQueue(items, 0))}
          title={playing ? 'Pausa' : 'Reproducir'}
        >
          <Icon name={playing ? 'pause' : 'play'} size={24} />
        </button>
        <DownloadButton {items} />
      </div>
      <TrackList {items} variant="list" metaLabel="Añadida" meta={(i) => shortDate(entries![i].at)} />
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
    background: linear-gradient(135deg, #5b3fd1, #b69cff);
    color: #fff;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.35);
  }
</style>
