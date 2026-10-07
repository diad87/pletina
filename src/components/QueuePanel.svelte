<script lang="ts">
  // Panel lateral de la cola: lo que suena, tu cola (la que vas montando) y lo que viene después.
  import { duration } from '../lib/format'
  import { layout } from '../lib/layout.svelte'
  import { reorder } from '../lib/reorder'
  import { library } from '../lib/library.svelte'
  import { nav } from '../lib/nav.svelte'
  import { player, type QueueItem } from '../lib/player.svelte'
  import { theme } from '../lib/theme.svelte'
  import { justCreated } from '../views/PlaylistView.svelte'
  import Cover from './Cover.svelte'
  import Icon from './Icon.svelte'

  /** Tipo de dato al arrastrar canciones desde cualquier lista (ver TrackList). */
  const ITEMS = 'application/x-musify-items'
  /** Tipo de dato al arrastrar dentro de tu cola (para reordenar). */
  const KEY = 'application/x-musify-queue-key'

  const current = $derived(player.current)
  const upcoming = $derived(player.upcoming.slice(0, 50))

  // Posición donde caería lo que se está arrastrando sobre tu cola.
  let dropAt = $state<number | null>(null)

  function onDragOver(e: DragEvent, index: number) {
    const types = e.dataTransfer?.types ?? []
    if (!types.includes(ITEMS) && !types.includes(KEY)) return
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    const r = target.getBoundingClientRect()
    dropAt = index < player.userQueue.length && e.clientY < r.top + r.height / 2 ? index : index + 1
    if (index >= player.userQueue.length) dropAt = player.userQueue.length
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    const at = dropAt ?? player.userQueue.length
    dropAt = null
    const key = e.dataTransfer?.getData(KEY)
    if (key) {
      const from = player.userQueue.findIndex((q) => q.key === Number(key))
      player.moveInQueue(Number(key), from >= 0 && at > from ? at - 1 : at)
      return
    }
    const raw = e.dataTransfer?.getData(ITEMS)
    if (raw) player.insertInQueue(JSON.parse(raw) as QueueItem[], at)
  }

  async function saveAsPlaylist() {
    // Lo que has montado tú; si no hay nada en tu cola, lo que suena y lo que viene.
    const items = player.userQueue.length
      ? [current, ...player.userQueue.map((q) => q.item)]
      : [current, ...player.upcoming.map((u) => u.item)]
    const created = await library.createPlaylist(items.filter((i): i is QueueItem => !!i))
    if (!created) return
    justCreated.add(created.id)
    nav.go({ name: 'playlist', id: created.id })
  }
</script>

<aside class="queue-panel" aria-label="Cola de reproducción">
  <header>
    <h2>Cola</h2>
    <button class="save" onclick={saveAsPlaylist} disabled={!current} title="Guardar como playlist">
      <Icon name="plus" size={16} /> Guardar como playlist
    </button>
    <button
      class="close"
      onclick={() => (layout.mobile ? (theme.queueSheet = false) : (theme.queueOpen = false))}
      title="Cerrar"><Icon name="close" size={18} /></button
    >
  </header>

  <div class="scroll">
    <h3>Sonando ahora</h3>
    {#if current}
      {@render row(current, true)}
    {:else}
      <p class="hint">No suena nada. Dale a reproducir a un disco o añade canciones a tu cola.</p>
    {/if}

    <div class="section-head">
      <h3>En tu cola {#if player.userQueue.length}<span class="count">{player.userQueue.length}</span>{/if}</h3>
      {#if player.userQueue.length}<button class="clear" onclick={() => player.clearQueue()}>Vaciar</button>{/if}
    </div>
    <ol
      class="mine"
      class:dropping={dropAt !== null}
      use:reorder={{
        enabled: layout.mobile,
        onMove: (from, to) => player.moveInQueue(player.userQueue[from].key, to),
      }}
      ondragover={(e) => onDragOver(e, player.userQueue.length)}
      ondragleave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dropAt = null
      }}
      ondrop={onDrop}
    >
      {#each player.userQueue as entry, i (entry.key)}
        <li
          class:drop-before={dropAt === i}
          data-reorder-index={i}
          draggable={!layout.mobile}
          ondragstart={(e) => e.dataTransfer?.setData(KEY, String(entry.key))}
          ondragover={(e) => {
            e.stopPropagation()
            onDragOver(e, i)
          }}
          ondrop={(e) => {
            e.stopPropagation()
            onDrop(e)
          }}
        >
          {@render row(entry.item, false, () => player.playFromQueue(entry.key), () => player.removeFromQueue(entry.key), layout.mobile)}
        </li>
      {/each}
      <li class="drop-zone" class:drop-before={dropAt === player.userQueue.length && player.userQueue.length > 0}>
        {#if !player.userQueue.length}
          <Icon name="queue" size={20} />
          {#if layout.mobile}
            <span>Mantén pulsada una canción, o usa <strong>⋯ → Añadir a la cola</strong>.</span>
          {:else}
            <span>Arrastra canciones aquí, o usa <strong>⋯ → Añadir a la cola</strong> en cualquier canción o disco.</span>
          {/if}
        {/if}
      </li>
    </ol>

    {#if upcoming.length}
      <h3>A continuación{#if player.context}<span class="from"> · {player.context}</span>{/if}</h3>
      <ol>
        {#each upcoming as { pos, item } (pos)}
          <li>{@render row(item, false, () => player.playAt(pos))}</li>
        {/each}
      </ol>
    {/if}
  </div>
</aside>

{#snippet row(item: QueueItem, playing: boolean, play?: () => void, remove?: () => void, grip = false)}
  <div class="row" class:playing class:with-grip={grip}>
    {#if grip}<span class="grip" data-reorder-handle aria-label="Arrastrar para mover"><Icon name="grip" size={20} /></span>{/if}
    <button class="main" onclick={play} disabled={!play} title={play ? 'Reproducir ahora' : undefined}>
      <span class="thumb"><Cover src={item.cover} /></span>
      <span class="text">
        <span class="title">{item.track.title}</span>
        <span class="sub">{item.track.artist.name}</span>
      </span>
      <span class="dur">{duration(item.track.duration)}</span>
    </button>
    {#if remove}
      <button class="remove" onclick={remove} title="Quitar de la cola"><Icon name="close" size={14} /></button>
    {/if}
  </div>
{/snippet}

<style>
  .queue-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-radius: var(--radius);
    background: linear-gradient(180deg, #17171d 0%, var(--panel) 160px);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.04);
    animation: slide 0.3s var(--ease);
  }
  @keyframes slide {
    from {
      opacity: 0;
      transform: translateX(16px);
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 12px 8px 18px;
  }
  h2 {
    flex: 1;
    margin: 0;
    font-size: 18px;
    font-weight: 800;
  }
  .save {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 12px;
    border-radius: 15px;
    background: rgb(255 255 255 / 0.08);
    font-size: 12px;
    font-weight: 700;
    transition: background 0.15s;
  }
  .save:hover:not(:disabled) {
    background: rgb(255 255 255 / 0.14);
  }
  .save:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .close {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    color: var(--muted);
  }
  .close:hover {
    background: rgb(255 255 255 / 0.08);
    color: var(--text);
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 8px 16px;
  }
  h3 {
    margin: 18px 10px 6px;
    font-size: 14px;
    font-weight: 800;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-right: 6px;
  }
  .count {
    margin-left: 4px;
    padding: 1px 8px;
    border-radius: 10px;
    background: var(--accent);
    color: #10002b;
    font-size: 11px;
  }
  .from {
    font-weight: 500;
    color: var(--muted);
  }
  .clear {
    margin-top: 12px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }
  .clear:hover {
    color: var(--text);
  }
  .hint {
    margin: 0 10px;
    color: var(--muted);
    font-size: 13px;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .mine {
    border-radius: 8px;
    transition: background 0.15s;
  }
  .mine.dropping {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .drop-before {
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .drop-zone {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 12px;
    color: var(--faint);
    font-size: 12px;
  }
  .drop-zone:has(span) {
    margin: 4px 2px;
    padding: 14px;
    border: 1px dashed rgb(255 255 255 / 0.14);
    border-radius: 8px;
  }
  .drop-zone strong {
    color: var(--muted);
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: 6px;
  }
  .row:hover {
    background: rgb(255 255 255 / 0.07);
  }
  .main {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    text-align: left;
  }
  .main:disabled {
    cursor: default;
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
  .title {
    font-weight: 600;
  }
  .playing .title {
    color: var(--accent);
  }
  .sub,
  .dur {
    font-size: 12px;
    color: var(--muted);
  }
  .dur {
    font-variant-numeric: tabular-nums;
  }
  .remove {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    margin-right: 4px;
    border-radius: 50%;
    color: var(--muted);
    opacity: 0;
  }
  .row:hover .remove {
    opacity: 1;
  }
  /* Con el dedo no hay "pasar por encima": la X siempre a la vista y más grande. */
  @media (hover: none) {
    .remove {
      width: 40px;
      height: 40px;
      margin-right: 0;
      opacity: 1;
    }
  }
  .remove:hover {
    background: rgb(255 255 255 / 0.1);
    color: var(--text);
  }
  li[draggable='true'] {
    cursor: grab;
  }

  /* Móvil: el asa para arrastrar con el dedo (ver lib/reorder.ts). */
  .row.with-grip {
    padding-left: 0;
  }
  .grip {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    align-self: stretch;
    color: var(--faint);
    touch-action: none;
    cursor: grab;
  }
  :global(li.reordering) {
    position: relative;
    z-index: 2;
    border-radius: 8px;
    background: var(--elevated);
    box-shadow: var(--shadow-2);
  }
</style>
