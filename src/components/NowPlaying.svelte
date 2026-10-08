<script lang="ts">
  // Pantalla completa "Sonando ahora": carátula grande sobre su propio color difuminado, y la cola.
  import { duration } from '../lib/format'
  import { library } from '../lib/library.svelte'
  import { isLocal, isPodcast, isYouTubeTrack, mediaUrl } from '../lib/media'
  import { nav } from '../lib/nav.svelte'
  import { player } from '../lib/player.svelte'
  import { theme } from '../lib/theme.svelte'
  import Cover from './Cover.svelte'
  import Icon from './Icon.svelte'
  import Transport from './Transport.svelte'

  const current = $derived(player.current)
  const podcast = $derived(current ? isPodcast(current.track.id) : false)
  const youtube = $derived(current ? isYouTubeTrack(current.track.id) : false)
  const liked = $derived(current ? library.liked.has(current.track.id) : false)
  const upcoming = $derived(player.upcoming.slice(0, 40))
  const queued = $derived(player.userQueue)
  // Carátula grande: la de 1000 px si es de Deezer.
  const big = $derived(!podcast && current?.cover?.startsWith('http') ? current.cover.replace(/\/\d+x\d+-/, '/1000x1000-') : (current?.cover ?? null))

  /**
   * Deslizar hacia abajo para cerrar (con el dedo). No cuenta si empieza en un botón o en la barra
   * de progreso. Si se suelta antes de 120 px (o despacio), vuelve a su sitio.
   */
  function swipeDown(node: HTMLElement) {
    let start: { y: number; t: number } | null = null
    let dy = 0
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || (e.target as HTMLElement).closest('button, input, a, .queue')) return
      start = { y: e.clientY, t: performance.now() }
      dy = 0
      node.style.transition = 'none'
    }
    const move = (e: PointerEvent) => {
      if (!start) return
      dy = Math.max(0, e.clientY - start.y)
      node.style.transform = `translateY(${dy}px)`
    }
    const up = () => {
      if (!start) return
      const fast = dy / Math.max(1, performance.now() - start.t) > 0.6
      start = null
      node.style.transition = 'transform 0.25s var(--ease)'
      if (dy > 120 || (fast && dy > 40)) {
        node.style.transform = 'translateY(100%)'
        setTimeout(() => (theme.nowPlaying = false), 200)
      } else {
        node.style.transform = ''
      }
    }
    // Si no, el navegador se queda el gesto vertical (pointercancel) y la pantalla no llega a moverse.
    // La cola de al lado (escritorio) sigue con su scroll: tiene su propio contenedor.
    node.style.touchAction = 'none'
    node.addEventListener('pointerdown', down)
    node.addEventListener('pointermove', move)
    node.addEventListener('pointerup', up)
    node.addEventListener('pointercancel', up)
    return {
      destroy() {
        node.removeEventListener('pointerdown', down)
        node.removeEventListener('pointermove', move)
        node.removeEventListener('pointerup', up)
        node.removeEventListener('pointercancel', up)
      },
    }
  }

  function go(route: Parameters<typeof nav.go>[0]) {
    theme.nowPlaying = false
    nav.go(route)
  }
</script>

{#if theme.nowPlaying && current}
  <div class="np" role="dialog" aria-label="Sonando ahora" use:swipeDown>
    <div class="bg" aria-hidden="true">
      {#if current.cover}<img src={mediaUrl(current.cover)} alt="" />{/if}
    </div>

    <header>
      <button class="close" onclick={() => (theme.nowPlaying = false)} title="Cerrar (Esc)">
        <Icon name="chevronDown" size={28} />
      </button>
      <div class="from">
        <span>Sonando desde</span>
        <button class="link" onclick={() => go(youtube ? { name: 'youtube-tracks' } : { name: podcast ? 'podcast' : 'album', id: current.albumId })}>{current.albumTitle}</button>
      </div>
      <span class="spacer"></span>
    </header>

    <div class="body">
      <section class="stage">
        {#key current.track.id}
          <div class="art"><Cover src={big} /></div>
        {/key}
        <div class="meta">
          <div class="text">
            <h1>{current.track.title}</h1>
            {#if youtube}<span class="artist">{current.track.artist.name}</span>{:else}
            <button class="link artist" onclick={() => go(podcast ? { name: 'podcast', id: current.albumId } : { name: 'artist', id: current.track.artist.id })}
              >{current.track.artist.name}</button
            >
            {/if}
          </div>
          <button
            class="heart"
            class:on={liked}
            onclick={() => library.toggleLike(current)}
            title={liked ? 'Quitar de Canciones que te gustan' : 'Añadir a Canciones que te gustan'}
          >
            <Icon name={liked ? 'heartFilled' : 'heart'} size={28} />
          </button>
        </div>
        <Transport big />
        <!-- Móvil: la cola no cabe al lado; se abre a pantalla completa. -->
        <div class="extras">
          {#if !podcast && !youtube}
            <button onclick={() => (player.picking = current)} disabled={isLocal(current.track.id)}>
              <Icon name="swap" size={20} /> ¿No es esta canción?
            </button>
          {/if}
          <button onclick={() => (theme.queueSheet = true)}>
            <Icon name="queue" size={20} /> Cola{#if queued.length}&nbsp;· {queued.length}{/if}
          </button>
        </div>
      </section>

      <aside class="queue">
        <h2>A continuación</h2>
        {#if queued.length || upcoming.length}
          <ol>
            {#each queued as { key, item } (`q${key}`)}
              <li>
                <button onclick={() => player.playFromQueue(key)}>
                  <span class="thumb"><Cover src={item.cover} /></span>
                  <span class="q-text">
                    <span class="q-title">{item.track.title}</span>
                    <span class="q-sub"><span class="mine">En tu cola</span> {item.track.artist.name}</span>
                  </span>
                  <span class="q-dur">{duration(item.track.duration)}</span>
                </button>
              </li>
            {/each}
            {#each upcoming as { pos, item } (pos)}
              <li>
                <button onclick={() => player.playAt(pos)}>
                  <span class="thumb"><Cover src={item.cover} /></span>
                  <span class="q-text">
                    <span class="q-title">{item.track.title}</span>
                    <span class="q-sub">{item.track.artist.name}</span>
                  </span>
                  <span class="q-dur">{duration(item.track.duration)}</span>
                </button>
              </li>
            {/each}
          </ol>
        {:else}
          <p class="empty">No hay nada más en la cola.</p>
        {/if}
      </aside>
    </div>
  </div>
{/if}

<style>
  .np {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #000;
    animation: up 0.4s var(--ease);
  }
  @keyframes up {
    from {
      opacity: 0;
      transform: translateY(24px);
    }
  }
  /* Fondo: la propia carátula, enorme y desenfocada. */
  .bg {
    position: absolute;
    inset: -10%;
    z-index: 0;
  }
  .bg img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: blur(80px) saturate(1.6) brightness(0.55);
    transform: scale(1.2);
  }
  .bg::after {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at 30% 40%, transparent 0%, rgb(0 0 0 / 0.55) 75%);
  }

  header,
  .body {
    position: relative;
    z-index: 1;
  }
  header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 18px 28px;
  }
  .close,
  .spacer {
    width: 40px;
  }
  .close {
    display: grid;
    place-items: center;
    height: 40px;
    border-radius: 50%;
    background: rgb(0 0 0 / 0.3);
    color: var(--text);
    transition: background 0.15s;
  }
  .close:hover {
    background: rgb(0 0 0 / 0.55);
  }
  .from {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    font-size: 12px;
    color: rgb(255 255 255 / 0.7);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .from .link {
    font-size: 14px;
    font-weight: 700;
    color: var(--text);
    text-transform: none;
    letter-spacing: 0;
  }

  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 380px);
    gap: 40px;
    padding: 8px 48px 40px;
  }
  .stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 28px;
    min-height: 0;
  }
  .art {
    width: min(52vh, 520px, 100%);
    animation: fade 0.5s var(--ease);
  }
  @keyframes fade {
    from {
      opacity: 0;
      transform: scale(0.97);
    }
  }
  .art :global(.cover) {
    border-radius: 12px;
    box-shadow: 0 30px 80px rgb(0 0 0 / 0.6);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 20px;
    width: min(52vh, 520px, 100%);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  h1 {
    margin: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 30px;
    font-weight: 800;
    letter-spacing: -0.03em;
  }
  .artist {
    font-size: 17px;
    color: rgb(255 255 255 / 0.75);
  }
  .heart {
    color: rgb(255 255 255 / 0.75);
    transition: transform 0.15s var(--ease);
  }
  .heart:hover {
    transform: scale(1.1);
    color: var(--text);
  }
  .heart.on {
    color: var(--accent);
  }
  .stage :global(.transport) {
    width: min(64vh, 640px, 100%);
  }

  .queue {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 20px 8px 8px;
    border-radius: 16px;
    background: rgb(0 0 0 / 0.28);
    backdrop-filter: blur(20px);
    border: 1px solid rgb(255 255 255 / 0.06);
  }
  .queue h2 {
    margin: 0 12px 12px;
    font-size: 18px;
    font-weight: 800;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
  }
  ol button {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 6px 12px;
    border-radius: 8px;
    text-align: left;
  }
  ol button:hover {
    background: rgb(255 255 255 / 0.08);
  }
  .thumb :global(.cover) {
    border-radius: 4px;
    box-shadow: none;
  }
  .q-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .q-title,
  .q-sub {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .q-title {
    font-weight: 600;
  }
  .q-sub,
  .q-dur {
    font-size: 13px;
    color: rgb(255 255 255 / 0.6);
  }
  .q-dur {
    font-variant-numeric: tabular-nums;
  }
  .mine {
    margin-right: 4px;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--accent);
    color: #10002b;
    font-size: 10px;
    font-weight: 800;
  }
  .empty {
    margin: 12px;
    color: rgb(255 255 255 / 0.6);
  }

  .extras {
    display: none;
  }
  @media (max-width: 720px) {
    header {
      padding: calc(8px + var(--safe-top)) 12px 4px;
    }
    .body {
      grid-template-columns: minmax(0, 1fr);
      padding: 4px 24px calc(20px + var(--safe-bottom));
    }
    .queue {
      display: none;
    }
    .art,
    .meta {
      width: min(100%, 44vh);
    }
    .stage {
      gap: 20px;
    }
    h1 {
      font-size: 22px;
    }
    .extras {
      display: flex;
      justify-content: space-between;
      width: 100%;
    }
    .extras button {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 4px;
      color: rgb(255 255 255 / 0.75);
      font-size: 13px;
      font-weight: 600;
    }
    .extras button:disabled {
      opacity: 0.4;
    }
  }
</style>
