<script lang="ts">
  // Móvil: lo que suena, encima de la barra de abajo. Tocarlo abre "Sonando ahora".
  import { coverColor, FALLBACK_COLOR } from '../lib/color'
  import { library } from '../lib/library.svelte'
  import { isPodcast } from '../lib/media'
  import { player } from '../lib/player.svelte'
  import { theme } from '../lib/theme.svelte'
  import Cover from './Cover.svelte'
  import Icon from './Icon.svelte'

  const current = $derived(player.current)
  const liked = $derived(current ? library.liked.has(current.track.id) : false)
  const progress = $derived(player.duration ? Math.min(1, player.time / player.duration) : 0)

  let color = $state(FALLBACK_COLOR)
  $effect(() => {
    let alive = true
    coverColor(current?.cover).then((c) => alive && (color = c))
    return () => {
      alive = false
    }
  })
</script>

{#if current}
  <div class="mini" style:--now={color}>
    <button class="open" onclick={() => (theme.nowPlaying = true)} aria-label="Sonando ahora">
      <span class="thumb"><Cover src={current.cover} /></span>
      <span class="text">
        <span class="title">{current.track.title}</span>
        <span class="artist">{player.status === 'loading' ? (isPodcast(current.track.id) ? 'Cargando episodio…' : 'Cargando audio…') : current.track.artist.name}</span>
      </span>
    </button>
    <button class="icon" class:on={liked} onclick={() => library.toggleLike(current)} aria-label="Me gusta">
      <Icon name={liked ? 'heartFilled' : 'heart'} size={22} />
    </button>
    <button class="icon" onclick={() => player.toggle()} aria-label={player.status === 'playing' ? 'Pausa' : 'Reproducir'}>
      <Icon name={player.status === 'playing' ? 'pause' : 'play'} size={26} />
    </button>
    <span class="bar" style:--progress={progress}></span>
  </div>
{/if}

<style>
  .mini {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0 8px;
    padding: 8px 6px 8px 8px;
    border-radius: 8px;
    overflow: hidden;
    background: color-mix(in srgb, var(--now) 75%, #000);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.45);
    transition: background 0.6s var(--ease);
  }
  .open {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    text-align: left;
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
  .title,
  .artist {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .title {
    font-size: 14px;
    font-weight: 700;
  }
  .artist {
    font-size: 13px;
    color: rgb(255 255 255 / 0.7);
  }
  .icon {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    color: var(--text);
  }
  .icon.on {
    color: var(--accent);
  }
  .bar {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 0;
    height: 2px;
    border-radius: 1px;
    background: rgb(255 255 255 / 0.2);
  }
  .bar::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--text);
    transform-origin: left;
    transform: scaleX(var(--progress));
  }
</style>
