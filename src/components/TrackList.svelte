<script lang="ts">
  // Lista de canciones: la de un disco, favoritas, una playlist o el historial.
  import { trackMenu } from '../lib/actions'
  import { downloads } from '../lib/downloads.svelte'
  import { duration } from '../lib/format'
  import { layout } from '../lib/layout.svelte'
  import { library } from '../lib/library.svelte'
  import { menu } from '../lib/menu.svelte'
  import { nav } from '../lib/nav.svelte'
  import { player, type QueueItem } from '../lib/player.svelte'
  import Cover from './Cover.svelte'
  import Icon from './Icon.svelte'

  interface Props {
    items: QueueItem[]
    /** 'album': dentro de un disco. 'list': canciones sueltas, con carátula y columna de disco. */
    variant?: 'album' | 'list'
    /** En 'album', el artista de cada canción solo se muestra si no es el del disco. */
    albumArtistId?: number
    /** Si es una playlist: permite quitar canciones y reordenarlas arrastrando. */
    playlistId?: number
    entryIds?: number[]
    /** Columna extra, p. ej. cuándo se añadió. */
    metaLabel?: string
    meta?: (index: number) => string
    /** De dónde vienen (nombre del disco, de la playlist…), para la cola. */
    context?: string
  }

  let { items, variant = 'album', albumArtistId, playlistId, entryIds, metaLabel = '', meta, context = '' }: Props =
    $props()

  const isCurrent = (item: QueueItem) => player.current?.track.id === item.track.id
  const disc = (i: number) => items[i].track.diskNumber || 1
  const multiDisc = $derived(variant === 'album' && items.some((_, i) => disc(i) !== disc(0)))
  const reorderable = $derived(playlistId != null && entryIds != null)

  function play(i: number) {
    if (isCurrent(items[i])) player.toggle()
    else player.playQueue(items, i, context)
  }

  function openMenu(e: MouseEvent, i: number) {
    const inPlaylist = playlistId != null && entryIds ? { id: playlistId, entryId: entryIds[i] } : undefined
    const item = items[i]
    menu.show(e, trackMenu(item, inPlaylist), {
      title: item.track.title,
      subtitle: item.track.artist.name,
      cover: item.cover,
    })
  }

  function go(e: MouseEvent, route: Parameters<typeof nav.go>[0]) {
    e.stopPropagation()
    nav.go(route)
  }

  // Arrastrar para reordenar (solo playlists). `dropAt` = posición donde se insertaría.
  let dragFrom = $state<number | null>(null)
  let dropAt = $state<number | null>(null)

  function onDragOver(e: DragEvent, i: number) {
    if (dragFrom === null) return
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dropAt = e.clientY < r.top + r.height / 2 ? i : i + 1
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    if (dragFrom !== null && dropAt !== null && playlistId != null && entryIds) {
      const to = dropAt > dragFrom ? dropAt - 1 : dropAt
      if (to !== dragFrom) library.moveInPlaylist(playlistId, entryIds[dragFrom], to)
    }
    dragFrom = dropAt = null
  }
</script>

<ol class="tracks {variant}" class:with-meta={!!meta}>
  <li class="row head">
    <span class="num">#</span>
    <span>Título</span>
    {#if variant === 'list'}<span>Disco</span>{/if}
    {#if meta}<span>{metaLabel}</span>{/if}
    <span></span>
    <span class="dur"><Icon name="clock" size={16} /></span>
    <span></span>
  </li>

  {#each items as item, i (entryIds?.[i] ?? `${item.track.id}-${i}`)}
    {@const current = isCurrent(item)}
    {@const liked = library.liked.has(item.track.id)}
    {@const downloaded = downloads.done.has(item.track.id)}
    {@const progress = downloads.active.get(item.track.id)}
    {@const showArtist = variant === 'list' || item.track.artist.id !== albumArtistId}
    {#if multiDisc && (i === 0 || disc(i) !== disc(i - 1))}
      <li class="disc">Disco {disc(i)}</li>
    {/if}
    <li>
      <div
        class="row"
        class:current
        class:dragging={dragFrom === i}
        class:drop-before={dragFrom !== null && dropAt === i}
        class:drop-after={dragFrom !== null && dropAt === items.length && i === items.length - 1}
        role="button"
        tabindex="0"
        draggable={!layout.mobile}
        onclick={() => play(i)}
        onkeydown={(e) => e.key === 'Enter' && play(i)}
        oncontextmenu={(e) => openMenu(e, i)}
        ondragstart={(e) => {
          // Se puede arrastrar a la cola (panel lateral) y, en playlists, para reordenar.
          e.dataTransfer?.setData('application/x-musify-items', JSON.stringify([item]))
          if (reorderable) dragFrom = i
        }}
        ondragover={(e) => onDragOver(e, i)}
        ondrop={onDrop}
        ondragend={() => (dragFrom = dropAt = null)}
      >
        <span class="num">
          {#if current && player.status === 'playing'}
            <span class="eq" aria-label="Sonando"><i></i><i></i><i></i></span>
          {:else}
            <span class="index">{variant === 'album' ? item.track.trackPosition || i + 1 : i + 1}</span>
            <span class="hover-play"><Icon name={current && player.status !== 'paused' ? 'pause' : 'play'} size={16} /></span>
          {/if}
        </span>

        <span class="main">
          {#if variant === 'list'}<span class="thumb"><Cover src={item.cover} /></span>{/if}
          <span class="text">
            <span class="name">{item.track.title}</span>
            {#if showArtist || item.track.explicitLyrics || downloaded || progress !== undefined}
              <span class="by">
                {#if downloaded}
                  <span class="dl" title="Descargada"><Icon name="downloaded" size={14} /></span>
                {:else if progress !== undefined}
                  <span class="dl busy" title="Descargando">{Math.round(progress * 100)} %</span>
                {/if}
                {#if item.track.explicitLyrics}<span class="explicit" title="Explícita">E</span>{/if}
                {#if showArtist}
                  <button class="link" onclick={(e) => go(e, { name: 'artist', id: item.track.artist.id })}
                    >{item.track.artist.name}</button
                  >
                {/if}
              </span>
            {/if}
          </span>
        </span>

        {#if variant === 'list'}
          <span class="album">
            <button class="link" onclick={(e) => go(e, { name: 'album', id: item.albumId })}>{item.albumTitle}</button>
          </span>
        {/if}
        {#if meta}<span class="meta">{meta(i)}</span>{/if}

        <span class="like-cell">
          <button
            class="icon heart"
            class:on={liked}
            title={liked ? 'Quitar de Canciones que te gustan' : 'Añadir a Canciones que te gustan'}
            onclick={(e) => {
              e.stopPropagation()
              library.toggleLike(item)
            }}><Icon name={liked ? 'heartFilled' : 'heart'} size={16} /></button
          >
        </span>
        <span class="dur">{duration(item.track.duration)}</span>
        <span class="more-cell">
          <button class="icon more" title="Más opciones" onclick={(e) => openMenu(e, i)}>
            <Icon name="more" size={18} />
          </button>
        </span>
      </div>
    </li>
  {/each}
</ol>

<style>
  .tracks {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
  }
  .row {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) 32px 56px 32px;
    align-items: center;
    gap: 16px;
    min-height: 56px;
    padding: 0 16px;
    border-radius: 6px;
    cursor: default;
    outline-offset: -2px;
  }
  .list .row {
    grid-template-columns: 32px minmax(0, 4fr) minmax(0, 3fr) 32px 56px 32px;
  }
  .list.with-meta .row {
    grid-template-columns: 32px minmax(0, 4fr) minmax(0, 3fr) 120px 32px 56px 32px;
  }
  .row:not(.head) {
    transition: background 0.15s;
  }
  .row:not(.head):hover,
  .row:focus-visible {
    background: rgb(255 255 255 / 0.07);
  }
  .row.current {
    background: rgb(255 255 255 / 0.04);
  }
  .head {
    min-height: 36px;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--line);
    border-radius: 0;
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .disc {
    padding: 20px 16px 8px;
    color: var(--muted);
    font-weight: 700;
  }
  .num,
  .dur,
  .meta {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .num {
    text-align: right;
  }
  .dur {
    display: flex;
    justify-content: flex-end;
  }
  .meta {
    font-size: 13px;
  }
  .main {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .thumb {
    flex: none;
    width: 40px;
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
  .name,
  .by,
  .album {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .name {
    color: var(--text);
    font-weight: 500;
  }
  .current .name {
    color: var(--accent);
  }
  .by,
  .album {
    font-size: 13px;
    color: var(--muted);
  }
  .by {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .link:hover {
    color: var(--text);
  }
  .dl {
    display: inline-grid;
    flex: none;
    color: var(--accent);
  }
  .dl.busy {
    font-size: 11px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .explicit {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 16px;
    height: 16px;
    border-radius: 2px;
    background: var(--muted);
    color: var(--panel);
    font-size: 10px;
    font-weight: 700;
  }

  .icon {
    display: grid;
    place-items: center;
    color: var(--muted);
  }
  .icon:hover {
    color: var(--text);
  }
  .heart.on {
    color: var(--accent);
  }
  /* ♥ y "⋯" aparecen al pasar el ratón (el ♥ se queda visible si está marcado). */
  .heart:not(.on),
  .more {
    opacity: 0;
  }
  .row:hover .icon,
  .row:focus-within .icon {
    opacity: 1;
  }

  .hover-play {
    display: none;
    color: var(--text);
  }
  .row:hover .index {
    display: none;
  }
  .row:hover .hover-play {
    display: inline-grid;
  }

  .dragging {
    opacity: 0.4;
  }
  .drop-before {
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .drop-after {
    box-shadow: inset 0 -2px 0 var(--accent);
  }

  /* Ecualizador animado en la canción que suena. */
  .eq {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    height: 14px;
  }
  .eq i {
    width: 3px;
    background: var(--accent);
    animation: eq 0.9s infinite ease-in-out alternate;
  }
  .eq i:nth-child(2) {
    animation-delay: -0.3s;
  }
  .eq i:nth-child(3) {
    animation-delay: -0.6s;
  }
  @keyframes eq {
    from {
      height: 3px;
    }
    to {
      height: 14px;
    }
  }

  /* Móvil: título y artista, y el botón "⋯" siempre visible. */
  @media (max-width: 720px) {
    .head,
    .row > .num,
    .row > .album,
    .row > .meta,
    .row > .dur,
    .row > .like-cell {
      display: none;
    }
    .row,
    .list .row,
    .list.with-meta .row {
      grid-template-columns: minmax(0, 1fr) 40px;
      gap: 8px;
      min-height: 58px;
      padding: 0 0 0 8px;
      -webkit-touch-callout: none;
    }
    .more {
      opacity: 1;
    }
    /* Tocar una fila no la deja marcada (en el móvil no hay ratón ni teclado). */
    .row:hover,
    .row:focus-visible {
      background: none;
    }
    .row.current {
      background: rgb(255 255 255 / 0.04);
    }
    .row:active {
      background: var(--press);
    }
  }
</style>
