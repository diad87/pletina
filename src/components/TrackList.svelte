<script lang="ts">
  // Lista de canciones: la de un disco, favoritas, una playlist o el historial.
  import { trackMenu } from '../lib/actions'
  import { inPwa } from '../lib/api'
  import { downloads } from '../lib/downloads.svelte'
  import { duration, songs } from '../lib/format'
  import { layout } from '../lib/layout.svelte'
  import { reorder } from '../lib/reorder'
  import { library } from '../lib/library.svelte'
  import { isPodcast, isYouTubeTrack } from '../lib/media'
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
    /** Busca dentro de esta lista sin cambiar la cola ni los índices de sus entradas. */
    searchable?: boolean
    searchLabel?: string
    query?: string
  }

  let {
    items, variant = 'album', albumArtistId, playlistId, entryIds, metaLabel = '', meta, context = '',
    searchable = false, searchLabel = 'Buscar en esta lista', query = $bindable(''),
  }: Props = $props()

  let searchInput: HTMLInputElement | undefined = $state()
  const searchId = $props.id()
  const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es')
  const words = $derived(searchable ? normalize(query).trim().split(/\s+/).filter(Boolean) : [])
  const filtering = $derived(searchable && query.trim().length > 0)
  const rows = $derived(items.map((item, index) => ({
    item,
    index,
    text: searchable ? normalize(`${item.track.title} ${item.track.artist.name}`) : '',
  })))
  const visibleRows = $derived(words.length ? rows.filter((row) => words.every((word) => row.text.includes(word))) : rows)
  const sameQueue = $derived(searchable && player.context === context && player.queue.length === items.length &&
    player.queue.every((item, i) => item.track.id === items[i].track.id))
  // Comparamos entradas de la propia cola: dos apariciones de una canción siguen siendo distintas.
  const isCurrent = (item: QueueItem, index: number) => player.current?.track.id === item.track.id &&
    (!searchable || (sameQueue && player.current === player.queue[index]))
  const disc = (i: number) => items[i].track.diskNumber || 1
  const multiDisc = $derived(variant === 'album' && items.some((_, i) => disc(i) !== disc(0)))
  const reorderable = $derived(playlistId != null && entryIds != null && !filtering)
  const hasPodcasts = $derived(items.some((item) => isPodcast(item.track.id)))

  function play(i: number) {
    if (isCurrent(items[i], i)) player.toggle()
    else player.playQueue(items, i, context)
  }

  function clearSearch() {
    query = ''
    searchInput?.focus()
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
    if (!reorderable || dragFrom === null) return
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dropAt = e.clientY < r.top + r.height / 2 ? i : i + 1
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    if (reorderable && dragFrom !== null && dropAt !== null && playlistId != null && entryIds) {
      const to = dropAt > dragFrom ? dropAt - 1 : dropAt
      if (to !== dragFrom) library.moveInPlaylist(playlistId, entryIds[dragFrom], to)
    }
    dragFrom = dropAt = null
  }
</script>

{#if searchable}
  <div class="list-search">
    <div class="search-field">
      <Icon name="search" size={19} />
      <input
        bind:this={searchInput}
        bind:value={query}
        type="search"
        placeholder="Buscar canción o artista"
        aria-label={searchLabel}
        aria-controls={`${searchId}-tracks`}
        aria-describedby={`${searchId}-count`}
        autocomplete="off"
        spellcheck="false"
        onkeydown={(e) => {
          if (e.key === 'Escape' && query) {
            e.preventDefault()
            e.stopPropagation()
            clearSearch()
          }
        }}
      />
      {#if query}
        <button class="clear-search" aria-label="Limpiar búsqueda" title="Limpiar búsqueda" onclick={clearSearch}>
          <Icon name="close" size={18} />
        </button>
      {/if}
    </div>
    <p id={`${searchId}-count`} class="search-count" role="status" aria-atomic="true">
      {filtering ? `${visibleRows.length} de ${songs(items.length)}` : songs(items.length)}
    </p>
  </div>
{/if}

<ol
  id={`${searchId}-tracks`}
  class="tracks {variant}"
  class:with-meta={!!meta}
  class:grips={reorderable && layout.mobile}
  use:reorder={{
    enabled: reorderable && layout.mobile,
    onMove: (from, to) => reorderable && playlistId != null && entryIds && library.moveInPlaylist(playlistId, entryIds[from], to),
  }}
>
  <li class="row head">
    <span class="num">#</span>
    <span>Título</span>
    {#if variant === 'list'}<span>{hasPodcasts ? 'Disco / podcast' : 'Disco'}</span>{/if}
    {#if meta}<span>{metaLabel}</span>{/if}
    <span></span>
    <span class="dur"><Icon name="clock" size={16} /></span>
    <span></span>
  </li>

  {#each visibleRows as { item, index: i }, visibleIndex (entryIds?.[i] ?? `${item.track.id}-${i}`)}
    {@const current = isCurrent(item, i)}
    {@const podcast = isPodcast(item.track.id)}
    {@const youtube = isYouTubeTrack(item.track.id)}
    {@const liked = library.liked.has(item.track.id)}
    {@const downloaded = downloads.done.has(item.track.id)}
    {@const progress = downloads.active.get(item.track.id)}
    {@const showArtist = variant === 'list' || item.track.artist.id !== albumArtistId}
    {#if multiDisc && (visibleIndex === 0 || disc(i) !== disc(visibleRows[visibleIndex - 1].index))}
      <li class="disc">Disco {disc(i)}</li>
    {/if}
    <li data-reorder-index={i}>
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
        {#if reorderable && layout.mobile}
          <span class="grip" data-reorder-handle aria-label="Arrastrar para mover"><Icon name="grip" size={20} /></span>
        {/if}
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
                  {#if youtube || inPwa && layout.mobile}<span>{item.track.artist.name}</span>{:else}
                  <button class="link" onclick={(e) => go(e, podcast ? { name: 'podcast', id: item.albumId } : { name: 'artist', id: item.track.artist.id })}
                    >{item.track.artist.name}</button
                  >
                  {/if}
                {/if}
              </span>
            {/if}
          </span>
        </span>

        {#if variant === 'list'}
          <span class="album">
            <button class="link" onclick={(e) => go(e, youtube ? { name: 'youtube-tracks' } : { name: podcast ? 'podcast' : 'album', id: item.albumId })}>{item.albumTitle}</button>
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

{#if filtering && !visibleRows.length}
  <div class="search-empty">
    <Icon name="search" size={32} />
    <strong>No hay coincidencias para «{query.trim()}»</strong>
    <p>Prueba con otra canción o artista.</p>
    <button class="pill" onclick={clearSearch}>Ver todas las canciones</button>
  </div>
{/if}

<style>
  .list-search {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px 20px;
    margin: 0 16px 16px;
  }
  .search-field {
    display: flex;
    align-items: center;
    gap: 10px;
    width: min(100%, 360px);
    min-height: 44px;
    padding-left: 13px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel-2);
    color: var(--muted);
  }
  .search-field:focus-within {
    border-color: var(--accent);
    outline: 1px solid var(--accent);
  }
  .search-field input {
    flex: 1;
    width: 0;
    min-width: 0;
    min-height: 44px;
    padding: 8px 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 14px;
  }
  .search-field input::placeholder { color: var(--muted); }
  .search-field input::-webkit-search-cancel-button { display: none; }
  .clear-search {
    display: grid;
    place-items: center;
    align-self: stretch;
    flex: none;
    width: 44px;
    border-radius: 6px;
    color: var(--muted);
  }
  .clear-search:hover { color: var(--text); }
  .search-count {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .search-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 36px 16px;
    color: var(--muted);
    text-align: center;
    overflow-wrap: anywhere;
  }
  .search-empty strong { color: var(--text); }
  .search-empty p { margin: 0 0 8px; }
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
    .list-search { margin: 0 4px 12px; gap: 8px; }
    .search-field { width: 100%; }
    .search-field input { font-size: 16px; }
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

  .grip {
    display: none;
  }
  @media (max-width: 720px) {
    /* Playlists: asa a la izquierda para reordenar con el dedo (ver lib/reorder.ts). */
    .tracks.grips .row,
    .list.with-meta.grips .row {
      grid-template-columns: 36px minmax(0, 1fr) 40px;
      padding-left: 0;
    }
    .grip {
      display: grid;
      place-items: center;
      align-self: stretch;
      color: var(--faint);
      touch-action: none;
    }
    :global(li.reordering) {
      position: relative;
      z-index: 2;
      border-radius: 8px;
      background: var(--elevated);
      box-shadow: var(--shadow-2);
    }
  }
</style>
