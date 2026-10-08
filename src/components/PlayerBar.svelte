<script lang="ts">
  import { coverColor, FALLBACK_COLOR } from '../lib/color'
  import { library } from '../lib/library.svelte'
  import { isLocal, isPodcast } from '../lib/media'
  import { nav } from '../lib/nav.svelte'
  import { player } from '../lib/player.svelte'
  import { theme } from '../lib/theme.svelte'
  import { toast } from '../lib/toast.svelte'
  import Cover from './Cover.svelte'
  import Icon from './Icon.svelte'
  import Transport from './Transport.svelte'

  const current = $derived(player.current)
  const podcast = $derived(current ? isPodcast(current.track.id) : false)
  const liked = $derived(current ? library.liked.has(current.track.id) : false)

  // La barra se tiñe con el color de la carátula que suena.
  let color = $state(FALLBACK_COLOR)
  $effect(() => {
    const cover = current?.cover
    let alive = true
    coverColor(cover).then((c) => alive && (color = c))
    return () => {
      alive = false
    }
  })

  const volumeFill = $derived(`${(player.muted ? 0 : player.volume) * 100}%`)
</script>

<footer class="player" style:--now={current ? color : FALLBACK_COLOR} class:idle={!current}>
  <div class="now">
    {#if current}
      <button class="thumb" onclick={() => (theme.nowPlaying = true)} title="Sonando ahora">
        <Cover src={current.cover} />
        <span class="expand"><Icon name="chevronUp" size={22} /></span>
      </button>
      <div class="info">
        <button class="link title" onclick={() => nav.go({ name: podcast ? 'podcast' : 'album', id: current.albumId })}
          >{current.track.title}</button
        >
        <button class="link artist" onclick={() => nav.go(podcast ? { name: 'podcast', id: current.albumId } : { name: 'artist', id: current.track.artist.id })}
          >{current.track.artist.name}</button
        >
        {#if player.status === 'loading'}<span class="hint">{podcast ? 'Cargando episodio…' : 'Preparando audio…'}</span>{/if}
      </div>
      <button
        class="icon heart"
        class:on={liked}
        onclick={() => library.toggleLike(current)}
        title={liked ? 'Quitar de Canciones que te gustan' : 'Añadir a Canciones que te gustan'}
      >
        <Icon name={liked ? 'heartFilled' : 'heart'} size={18} />
      </button>
    {/if}
  </div>

  <div class="center"><Transport /></div>

  <div class="side">
    {#if !podcast}
      <button
        class="icon"
        onclick={() => current && (player.picking = current)}
        disabled={!current || isLocal(current.track.id)}
        title="¿No es esta canción? Elegir otro vídeo"
      >
        <Icon name="swap" size={18} />
      </button>
    {/if}
    <button
      class="icon queue-btn"
      class:on={theme.queueOpen}
      onclick={() => (theme.queueOpen = !theme.queueOpen)}
      title="Cola de reproducción"
    >
      <Icon name="queue" size={20} />
      {#if player.userQueue.length}<span class="badge">{player.userQueue.length}</span>{/if}
    </button>
    <button class="icon" onclick={() => (theme.nowPlaying = true)} disabled={!current} title="Sonando ahora (pantalla completa)">
      <Icon name="expand" size={18} />
    </button>
    <button class="icon" onclick={() => player.toggleMute()} title={player.muted ? 'Activar sonido' : 'Silenciar'}>
      <Icon name={player.muted || player.volume === 0 ? 'mute' : 'volume'} size={20} />
    </button>
    <input
      type="range"
      class="volume"
      min="0"
      max="1"
      step="0.01"
      value={player.muted ? 0 : player.volume}
      style:--fill={volumeFill}
      oninput={(e) => player.setVolume(Number(e.currentTarget.value))}
      aria-label="Volumen"
    />
  </div>

  {#if player.captureInteraction}
    <div class="notice interaction" role="status">
      <span>YouTube necesita tu intervención: {player.captureInteraction}</span>
      <div class="actions">
        <button onclick={() => player.openCapture()}>Abrir YouTube</button>
        <button onclick={() => player.retryCapture()}>Reintentar</button>
      </div>
    </div>
  {:else if toast.message}
    {#key toast.message}
      <div class="notice" role="status">{toast.message}</div>
    {/key}
  {/if}
</footer>

<style>
  .player {
    position: relative;
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: minmax(200px, 1fr) minmax(340px, 2fr) minmax(200px, 1fr);
    align-items: center;
    gap: 16px;
    height: 80px;
    padding: 0 16px 0 10px;
    border-radius: var(--radius);
    background: linear-gradient(90deg, color-mix(in srgb, var(--now) 45%, var(--bg)) 0%, var(--bg) 42%);
  }
  .player.idle {
    background: var(--bg);
  }

  .now {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .thumb {
    position: relative;
    flex: none;
    width: 58px;
  }
  .thumb :global(.cover) {
    box-shadow: 0 6px 16px rgb(0 0 0 / 0.5);
  }
  .expand {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    border-radius: var(--radius-s);
    background: rgb(0 0 0 / 0.5);
    opacity: 0;
    transition: opacity 0.2s;
  }
  .thumb:hover .expand {
    opacity: 1;
  }
  .info {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
  }
  .title,
  .artist,
  .hint {
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .title {
    font-weight: 600;
    color: var(--text);
  }
  .artist,
  .hint {
    font-size: 12px;
    color: var(--muted);
  }
  .artist:hover {
    color: var(--text);
  }
  .hint {
    color: var(--accent);
  }

  .icon {
    display: grid;
    place-items: center;
    flex: none;
    color: var(--muted);
    transition:
      color 0.15s,
      transform 0.15s var(--ease);
  }
  .icon:hover:not(:disabled) {
    color: var(--text);
    transform: scale(1.08);
  }
  .icon:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .icon.on,
  .icon.on:hover {
    color: var(--accent);
  }
  .queue-btn {
    position: relative;
  }
  .badge {
    position: absolute;
    top: -7px;
    right: -9px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--accent);
    color: #10002b;
    font-size: 10px;
    font-weight: 800;
    line-height: 16px;
    text-align: center;
  }

  .center {
    display: flex;
    justify-content: center;
  }

  .side {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 14px;
  }
  .volume {
    width: 110px;
    height: 14px;
    margin: 0;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .volume::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 3px;
    background: linear-gradient(to right, var(--text) 0 var(--fill), rgb(255 255 255 / 0.2) var(--fill) 100%);
  }
  .volume:hover::-webkit-slider-runnable-track {
    background: linear-gradient(to right, var(--accent) 0 var(--fill), rgb(255 255 255 / 0.2) var(--fill) 100%);
  }
  .volume::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4px;
    border-radius: 50%;
    background: var(--text);
    opacity: 0;
  }
  .volume:hover::-webkit-slider-thumb {
    opacity: 1;
  }

  .notice {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 14px);
    z-index: 30;
    max-width: min(560px, 90%);
    padding: 11px 18px;
    border-radius: 10px;
    background: var(--text);
    color: #000;
    font-weight: 600;
    box-shadow: var(--shadow-2);
    transform: translateX(-50%);
    animation: pop 0.3s var(--ease);
  }
  .interaction {
    width: min(560px, 90%);
    font-weight: 500;
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 10px;
  }
  .actions button {
    padding: 6px 10px;
    border: 1px solid currentColor;
    border-radius: 6px;
    font-weight: 600;
  }
  .actions button:hover {
    background: rgb(0 0 0 / 0.08);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translate(-50%, 8px) scale(0.97);
    }
  }
</style>
