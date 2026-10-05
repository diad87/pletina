<script lang="ts">
  import Collage from '../components/Collage.svelte'
  import DownloadButton from '../components/DownloadButton.svelte'
  import Icon from '../components/Icon.svelte'
  import Status from '../components/Status.svelte'
  import TrackList from '../components/TrackList.svelte'
  import * as api from '../lib/api'
  import { longDuration, shortDate, songs } from '../lib/format'
  import { fromLib, library } from '../lib/library.svelte'
  import { menu } from '../lib/menu.svelte'
  import { nav } from '../lib/nav.svelte'
  import { player } from '../lib/player.svelte'
  import type { PlaylistDetail } from '../lib/types'

  let { id }: { id: number } = $props()

  let data = $state<PlaylistDetail | null>(null)
  let error = $state<string | null>(null)
  let editing = $state(false)
  let draft = $state('')
  let confirmDelete = $state(false)
  let loadedId = -1

  // Se recarga al cambiar de playlist y cada vez que cambia la biblioteca.
  $effect(() => {
    const current = id
    void library.version
    let alive = true
    if (current !== loadedId) {
      data = null
      error = null
      editing = false
      confirmDelete = false
    }
    api
      .playlist(current)
      .then((p) => {
        if (!alive) return
        const fresh = current !== loadedId
        data = p
        loadedId = current
        if (fresh) {
          nav.ready()
          // Recién creada desde la barra lateral: el nombre, listo para escribir.
          if (justCreated.delete(current)) startRename()
        }
      })
      .catch((e) => alive && (error = String(e)))
    return () => {
      alive = false
    }
  })

  const items = $derived((data?.entries ?? []).map((e) => fromLib(e.track)))
  const entryIds = $derived((data?.entries ?? []).map((e) => e.entryId))
  const isThis = $derived(
    items.length > 0 &&
      player.queue.length === items.length &&
      player.queue.every((q, i) => q.track.id === items[i].track.id),
  )
  const playing = $derived(isThis && player.status === 'playing')

  function startRename() {
    if (!data) return
    draft = data.name
    editing = true
  }

  async function saveName() {
    if (!editing || !data) return
    editing = false
    if (draft.trim() && draft.trim() !== data.name) await library.renamePlaylist(data.id, draft)
  }

  function playlistMenu(e: MouseEvent) {
    menu.show(e, [
      { label: 'Cambiar nombre', icon: 'edit', action: startRename },
      { label: 'Eliminar playlist', icon: 'trash', danger: true, separated: true, action: () => (confirmDelete = true) },
    ])
  }

  async function remove() {
    if (!data) return
    await library.deletePlaylist(data.id)
    nav.go({ name: 'home' })
  }

  function focus(node: HTMLInputElement) {
    node.focus()
    node.select()
  }
</script>

<script lang="ts" module>
  /** Playlists recién creadas desde la barra lateral: se abren con el nombre listo para escribir. */
  export const justCreated = new Set<number>()
</script>

{#if error}
  <Status {error} />
{:else if !data}
  <Status />
{:else}
  <header class="hero">
    <div class="art"><Collage covers={data.covers} /></div>
    <div class="info">
      <div class="kind">Playlist</div>
      {#if editing}
        <input
          class="name-input"
          bind:value={draft}
          use:focus
          onblur={saveName}
          onkeydown={(e) => {
            if (e.key === 'Enter') saveName()
            if (e.key === 'Escape') editing = false
          }}
          maxlength="100"
          aria-label="Nombre de la playlist"
        />
      {:else}
        <h1><button class="title-button" onclick={startRename} title="Cambiar nombre">{data.name}</button></h1>
      {/if}
      <div class="meta">{songs(data.count)}{#if data.duration}, {longDuration(data.duration)}{/if}</div>
    </div>
  </header>

  <section class="page">
    <div class="actions">
      <button
        class="big-play"
        disabled={!items.length}
        onclick={() => (isThis ? player.toggle() : player.playQueue(items, 0))}
        title={playing ? 'Pausa' : 'Reproducir'}
      >
        <Icon name={playing ? 'pause' : 'play'} size={24} />
      </button>
      <DownloadButton {items} />
      <button class="action" onclick={playlistMenu} title="Más opciones"><Icon name="more" size={30} /></button>
    </div>

    {#if confirmDelete}
      <div class="confirm">
        <span>¿Eliminar «{data.name}»? No se puede deshacer.</span>
        <button class="ghost" onclick={() => (confirmDelete = false)}>Cancelar</button>
        <button class="pill danger" onclick={remove}>Eliminar</button>
      </div>
    {/if}

    {#if items.length}
      <TrackList
        {items}
        variant="list"
        playlistId={data.id}
        {entryIds}
        metaLabel="Añadida"
        meta={(i) => shortDate(data!.entries[i].at)}
      />
      <p class="tip">Arrastra las canciones para cambiar el orden.</p>
    {:else}
      <div class="empty-state">
        <Icon name="note" size={48} />
        <strong>Esta playlist está vacía</strong>
        <p>Añade canciones o discos enteros desde su menú ⋯ → «Añadir a playlist».</p>
      </div>
    {/if}
  </section>
{/if}

<style>
  .info {
    min-width: 0;
    flex: 1;
  }
  .title-button {
    font: inherit;
    text-align: left;
    cursor: text;
  }
  .name-input {
    width: 100%;
    margin: 6px 0 14px;
    padding: 4px 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: rgb(0 0 0 / 0.3);
    color: var(--text);
    font: inherit;
    font-size: clamp(28px, 4vw, 56px);
    font-weight: 800;
    letter-spacing: -0.03em;
    outline: 0;
  }
  .name-input:focus {
    border-color: var(--text);
  }
  .confirm {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 0 12px 16px;
    padding: 12px 16px;
    border-radius: 8px;
    background: var(--elevated);
  }
  .confirm span {
    flex: 1;
  }
  .ghost {
    color: var(--muted);
    font-weight: 700;
  }
  .ghost:hover {
    color: var(--text);
  }
  .danger {
    background: #ff8a80;
  }
  .tip {
    margin: 16px;
    font-size: 12px;
    color: var(--faint);
  }
</style>
