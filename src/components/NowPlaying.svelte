<script lang="ts">
  // Pantalla completa "Sonando ahora": carátula grande sobre su propio color difuminado, y la cola.
  import { duration } from '../lib/format'
  import { library } from '../lib/library.svelte'
  import { nav } from '../lib/nav.svelte'
  import { player } from '../lib/player.svelte'
  import { theme } from '../lib/theme.svelte'
  import Cover from './Cover.svelte'
  import Icon from './Icon.svelte'
  import Transport from './Transport.svelte'

  const current = $derived(player.current)
  const liked = $derived(current ? library.liked.has(current.track.id) : false)
  const upcoming = $derived(player.upcoming.slice(0, 40))
  // Carátula grande: la de 1000 px si es de Deezer.
  const big = $derived(current?.cover?.replace(/\/\d+x\d+-/, '/1000x1000-') ?? null)

  function go(route: Parameters<typeof nav.go>[0]) {
    theme.nowPlaying = false
    nav.go(route)
  }
</script>

{#if theme.nowPlaying && current}
  <div class="np" role="dialog" aria-label="Sonando ahora">
    <div class="bg" aria-hidden="true">
      {#if current.cover}<img src={current.cover} alt="" />{/if}
    </div>

    <header>
      <button class="close" onclick={() => (theme.nowPlaying = false)} title="Cerrar (Esc)">
        <Icon name="chevronDown" size={28} />
      </button>
      <div class="from">
        <span>Sonando desde</span>
        <button class="link" onclick={() => go({ name: 'album', id: current.albumId })}>{current.albumTitle}</button>
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
            <button class="link artist" onclick={() => go({ name: 'artist', id: current.track.artist.id })}
              >{current.track.artist.name}</button
            >
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
      </section>

      <aside class="queue">
        <h2>A continuación</h2>
        {#if upcoming.length}
          <ol>
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
  .empty {
    margin: 12px;
    color: rgb(255 255 255 / 0.6);
  }
</style>
