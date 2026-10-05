<script lang="ts">
  import Cover from '../components/Cover.svelte'
  import Icon from '../components/Icon.svelte'
  import Status from '../components/Status.svelte'
  import TrackList from '../components/TrackList.svelte'
  import * as api from '../lib/api'
  import { downloads } from '../lib/downloads.svelte'
  import { songs } from '../lib/format'
  import { fromLib } from '../lib/library.svelte'
  import { nav } from '../lib/nav.svelte'
  import { player } from '../lib/player.svelte'
  import { theme } from '../lib/theme.svelte'
  import { toast } from '../lib/toast.svelte'
  import type { DownloadEntry } from '../lib/types'

  let entries = $state<DownloadEntry[] | null>(null)
  let error = $state<string | null>(null)
  let folder = $state('')
  let confirmRemoveAll = $state(false)
  let first = true

  theme.clear()
  theme.setColor('hsl(160 35% 24%)')

  $effect(() => {
    void downloads.version
    let alive = true
    api
      .downloadsList()
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

  api.downloadDirPath().then((dir) => (folder = dir))

  const items = $derived((entries ?? []).map((e) => fromLib(e.track)))
  const totalSize = $derived((entries ?? []).reduce((sum, e) => sum + e.size, 0))
  const pending = $derived([...downloads.queued.values()])
  const playing = $derived(
    items.length > 0 && player.queue.length === items.length && player.status === 'playing' && player.queue.every((q, i) => q.track.id === items[i].track.id),
  )

  const mb = (bytes: number) =>
    bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.round(bytes / 1e6)} MB`

  async function changeFolder() {
    try {
      const chosen = await api.chooseDownloadDir()
      if (chosen) {
        folder = chosen
        toast.show('Las próximas descargas irán a la carpeta nueva')
      }
    } catch (e) {
      toast.show(`No se pudo cambiar la carpeta: ${e}`)
    }
  }
</script>

<section class="page top">
  <h1 class="page-title">Descargas</h1>

  <div class="folder">
    <Icon name="folder" size={20} />
    <span class="path" title={folder}>{folder}</span>
    <button class="ghost" onclick={() => api.openDownloadDir().catch((e) => toast.show(String(e)))}>Abrir</button>
    <button class="ghost" onclick={changeFolder}>Cambiar…</button>
  </div>

  {#if pending.length}
    <h2 class="section-title">Descargando · {pending.length}</h2>
    <ul class="queue">
      {#each pending as item (item.track.id)}
        {@const p = downloads.active.get(item.track.id) ?? 0}
        <li>
          <span class="thumb"><Cover src={item.cover} /></span>
          <span class="text">
            <span class="title">{item.track.title}</span>
            <span class="sub">{item.track.artist.name}</span>
          </span>
          <span class="bar"><span style:width="{Math.round(p * 100)}%"></span></span>
          <span class="pct">{p > 0 ? `${Math.round(p * 100)} %` : 'En cola'}</span>
        </li>
      {/each}
    </ul>
    <button class="ghost cancel" onclick={() => downloads.cancel()}>Cancelar las que no han empezado</button>
  {/if}

  {#if error}
    <Status {error} />
  {:else if !entries}
    <Status />
  {:else if items.length}
    <div class="summary">
      <h2 class="section-title">En este equipo · {songs(items.length)} · {mb(totalSize)}</h2>
      {#if !confirmRemoveAll}
        <button class="ghost" onclick={() => (confirmRemoveAll = true)}><Icon name="trash" size={16} /> Quitar todas</button>
      {/if}
    </div>
    {#if confirmRemoveAll}
      <div class="confirm">
        <span>¿Borrar los {items.length} archivos descargados? Se podrán seguir escuchando en streaming.</span>
        <button class="ghost" onclick={() => (confirmRemoveAll = false)}>Cancelar</button>
        <button
          class="pill danger"
          onclick={async () => {
            confirmRemoveAll = false
            await downloads.remove(items.map((i) => i.track.id))
          }}>Borrar</button
        >
      </div>
    {/if}
    <div class="actions">
      <button class="big-play" onclick={() => (playing ? player.toggle() : player.playQueue(items, 0))} title={playing ? 'Pausa' : 'Reproducir'}>
        <Icon name={playing ? 'pause' : 'play'} size={24} />
      </button>
    </div>
    <TrackList {items} variant="list" metaLabel="Tamaño" meta={(i) => mb(entries![i].size)} />
  {:else if !pending.length}
    <div class="empty-state">
      <Icon name="download" size={48} />
      <strong>Aún no has descargado nada</strong>
      <p>Pulsa ⬇ en un disco o una playlist, o «Descargar» en el menú ⋯ de una canción, para escucharla sin conexión.</p>
    </div>
  {/if}
</section>

<style>
  .folder {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 12px 8px;
    padding: 12px 16px;
    border-radius: 8px;
    background: var(--elevated);
    color: var(--muted);
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--text);
    user-select: text;
  }
  .ghost {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-weight: 700;
  }
  .ghost:hover {
    color: var(--text);
  }
  .queue {
    list-style: none;
    margin: 8px 0;
    padding: 0 12px;
  }
  .queue li {
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr) minmax(80px, 200px) 64px;
    align-items: center;
    gap: 12px;
    padding: 6px 4px;
  }
  .thumb :global(.cover) {
    border-radius: 4px;
    box-shadow: none;
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title,
  .sub {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .sub {
    font-size: 13px;
    color: var(--muted);
  }
  .bar {
    height: 4px;
    border-radius: 2px;
    background: var(--elevated);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.3s;
  }
  .pct {
    font-size: 12px;
    color: var(--muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .cancel {
    margin: 4px 16px 8px;
    font-size: 13px;
  }
  .summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-right: 12px;
  }
  .confirm {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 8px 12px;
    padding: 12px 16px;
    border-radius: 8px;
    background: var(--elevated);
  }
  .confirm span {
    flex: 1;
  }
  .danger {
    background: #ff8a80;
  }
</style>
