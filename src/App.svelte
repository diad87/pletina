<script lang="ts">
  import BottomNav from './components/BottomNav.svelte'
  import ContextMenu from './components/ContextMenu.svelte'
  import MiniPlayer from './components/MiniPlayer.svelte'
  import NowPlaying from './components/NowPlaying.svelte'
  import PlayerBar from './components/PlayerBar.svelte'
  import QueuePanel from './components/QueuePanel.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import SourcePicker from './components/SourcePicker.svelte'
  import TopBar from './components/TopBar.svelte'
  import { downloads } from './lib/downloads.svelte'
  import { layout } from './lib/layout.svelte'
  import { library } from './lib/library.svelte'
  import { menu } from './lib/menu.svelte'
  import { local } from './lib/local.svelte'
  import { nav } from './lib/nav.svelte'
  import { player } from './lib/player.svelte'
  import { theme } from './lib/theme.svelte'
  import { toast } from './lib/toast.svelte'
  import { updates } from './lib/updates.svelte'
  import AlbumView from './views/AlbumView.svelte'
  import ArtistView from './views/ArtistView.svelte'
  import DownloadsView from './views/DownloadsView.svelte'
  import HistoryView from './views/HistoryView.svelte'
  import LibraryView from './views/LibraryView.svelte'
  import Home from './views/Home.svelte'
  import LikedView from './views/LikedView.svelte'
  import LocalView from './views/LocalView.svelte'
  import PlaylistView from './views/PlaylistView.svelte'
  import Search from './views/Search.svelte'

  let scroller: HTMLElement | undefined = $state()
  let scrollY = $state(0)
  $effect(() => {
    nav.scroller = scroller ?? null
  })

  const route = $derived(nav.route)

  library.load().then((data) => downloads.init(data?.downloadedIds ?? []))
  updates.init()
  local.init()

  // La barra superior se tiñe según el scroll; se lee una vez por fotograma.
  let frame = 0
  function onScroll() {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      scrollY = scroller?.scrollTop ?? 0
    })
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.altKey && e.key === 'ArrowLeft') nav.back()
    else if (e.altKey && e.key === 'ArrowRight') nav.forward()
    else if (e.ctrlKey && (e.key === 'k' || e.key === 'l')) nav.focusSearch()
    else if (e.key === ' ' && !isTyping(e.target) && !player.picking) player.toggle()
    else if (e.key === 'Escape' && theme.nowPlaying) theme.nowPlaying = false
    else return
    e.preventDefault()
  }

  const isTyping = (target: EventTarget | null) =>
    target instanceof HTMLInputElement && target.type !== 'range'

  // Botón "atrás" de Android (MainActivity.kt): cierra lo que haya abierto o vuelve a la página
  // anterior. Si no queda nada, la app pasa a segundo plano.
  ;(window as unknown as { __musifyBack: () => boolean }).__musifyBack = () => {
    if (menu.open) menu.close()
    else if (player.picking) player.picking = null
    else if (theme.queueOpen && layout.mobile) theme.queueOpen = false
    else if (theme.nowPlaying) theme.nowPlaying = false
    else if (nav.canBack) nav.back()
    else return false
    return true
  }

  // Botones laterales del ratón: atrás / adelante.
  function onMouseup(e: MouseEvent) {
    if (e.button === 3) nav.back()
    else if (e.button === 4) nav.forward()
  }
</script>

<svelte:window onkeydown={onKeydown} onmouseup={onMouseup} />

{#snippet page()}
  {#key nav.index}
    <div class="view">
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
      {:else if route.name === 'local'}
        <LocalView />
      {:else if route.name === 'library'}
        <LibraryView />
      {:else}
        <HistoryView />
      {/if}
    </div>
  {/key}
{/snippet}

{#if layout.mobile}
  <!-- Móvil: la página a pantalla completa y, abajo, lo que suena y las tres secciones. -->
  <div class="app mobile">
    <main class="main" style:--page-color={theme.color}>
      <TopBar {scrollY} />
      <div class="content" bind:this={scroller} onscroll={onScroll}>
        <div class="backdrop" aria-hidden="true"></div>
        {@render page()}
      </div>
    </main>
    <div class="dock">
      {#if toast.message}
        {#key toast.message}
          <div class="toast" role="status">{toast.message}</div>
        {/key}
      {/if}
      <MiniPlayer />
      <BottomNav />
    </div>
  </div>
  {#if theme.queueOpen}<div class="queue-sheet"><QueuePanel /></div>{/if}
{:else}
  <div class="app" class:with-queue={theme.queueOpen}>
    <Sidebar />
    <main class="main" style:--page-color={theme.color}>
      <TopBar {scrollY} />
      <div class="content" bind:this={scroller} onscroll={onScroll}>
        <div class="backdrop" aria-hidden="true"></div>
        {@render page()}
      </div>
    </main>
    {#if theme.queueOpen}<QueuePanel />{/if}
    <PlayerBar />
  </div>
{/if}

<NowPlaying />
<SourcePicker />
<ContextMenu />

<style>
  .app {
    display: grid;
    grid-template-columns: 248px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
    gap: 8px;
    height: 100vh;
    padding: 8px;
  }
  .app.with-queue {
    grid-template-columns: 248px minmax(0, 1fr) 340px;
  }
  .main {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    border-radius: var(--radius);
    background: var(--panel);
    transition: --page-color 0.6s var(--ease);
  }
  .content {
    position: relative;
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }
  /* Degradado del color de la página que se funde con el panel (se desplaza con el contenido). */
  .backdrop {
    position: absolute;
    inset: 0 0 auto;
    height: 480px;
    pointer-events: none;
    background: linear-gradient(
      180deg,
      var(--page-color) 0%,
      color-mix(in srgb, var(--page-color) 55%, var(--panel)) 45%,
      var(--panel) 100%
    );
  }
  .view {
    position: relative;
  }

  .app.mobile {
    display: flex;
    flex-direction: column;
    gap: 0;
    height: 100dvh;
    padding: 0;
  }
  .app.mobile .main {
    flex: 1;
    border-radius: 0;
  }
  .dock {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: 6px;
    background: var(--bg);
  }
  .toast {
    position: absolute;
    left: 16px;
    right: 16px;
    bottom: calc(100% + 8px);
    padding: 10px 14px;
    border-radius: 8px;
    background: var(--text);
    color: #000;
    font-weight: 600;
    text-align: center;
    box-shadow: var(--shadow-2);
    animation: pop 0.25s var(--ease);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  /* La cola, a pantalla completa por encima de "Sonando ahora". */
  .queue-sheet {
    position: fixed;
    inset: 0;
    z-index: 45;
    display: flex;
    padding: var(--safe-top) 0 var(--safe-bottom);
    background: var(--bg);
  }
  .queue-sheet :global(.queue-panel) {
    flex: 1;
    border-radius: 0;
  }
</style>
