<script lang="ts">
  import ContextMenu from './components/ContextMenu.svelte'
  import PlayerBar from './components/PlayerBar.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import SourcePicker from './components/SourcePicker.svelte'
  import TopBar from './components/TopBar.svelte'
  import { downloads } from './lib/downloads.svelte'
  import { library } from './lib/library.svelte'
  import { nav } from './lib/nav.svelte'
  import { player } from './lib/player.svelte'
  import AlbumView from './views/AlbumView.svelte'
  import ArtistView from './views/ArtistView.svelte'
  import DownloadsView from './views/DownloadsView.svelte'
  import HistoryView from './views/HistoryView.svelte'
  import Home from './views/Home.svelte'
  import LikedView from './views/LikedView.svelte'
  import PlaylistView from './views/PlaylistView.svelte'
  import Search from './views/Search.svelte'

  let scroller: HTMLElement | undefined = $state()
  $effect(() => {
    nav.scroller = scroller ?? null
  })

  const route = $derived(nav.route)

  library.load().then((data) => downloads.init(data?.downloadedIds ?? []))

  function onKeydown(e: KeyboardEvent) {
    if (e.altKey && e.key === 'ArrowLeft') nav.back()
    else if (e.altKey && e.key === 'ArrowRight') nav.forward()
    else if (e.ctrlKey && (e.key === 'k' || e.key === 'l')) nav.focusSearch()
    else if (e.key === ' ' && !isTyping(e.target) && !player.picking) player.toggle()
    else return
    e.preventDefault()
  }

  const isTyping = (target: EventTarget | null) =>
    target instanceof HTMLInputElement && target.type !== 'range'

  // Botones laterales del ratón: atrás / adelante.
  function onMouseup(e: MouseEvent) {
    if (e.button === 3) nav.back()
    else if (e.button === 4) nav.forward()
  }
</script>

<svelte:window onkeydown={onKeydown} onmouseup={onMouseup} />

<div class="app">
  <Sidebar />
  <main class="main">
    <TopBar />
    <div class="content" bind:this={scroller}>
      {#if route.name === 'home'}
        <Home />
      {:else if route.name === 'search'}
        <Search query={route.query} />
      {:else if route.name === 'artist'}
        <ArtistView id={route.id} />
      {:else if route.name === 'album'}
        <AlbumView id={route.id} />
      {:else if route.name === 'liked'}
        <LikedView />
      {:else if route.name === 'playlist'}
        <PlaylistView id={route.id} />
      {:else if route.name === 'downloads'}
        <DownloadsView />
      {:else}
        <HistoryView />
      {/if}
    </div>
  </main>
  <PlayerBar />
</div>

<SourcePicker />
<ContextMenu />

<style>
  .app {
    display: grid;
    grid-template-columns: 232px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
    gap: 8px;
    height: 100vh;
    padding: 8px;
  }
  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    border-radius: 10px;
    background: var(--panel);
  }
  .content {
    flex: 1;
    overflow-y: auto;
  }
</style>
