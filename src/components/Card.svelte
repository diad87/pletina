<script lang="ts">
  import Collage from './Collage.svelte'
  import Cover from './Cover.svelte'
  import Icon from './Icon.svelte'

  let {
    image = null,
    covers,
    title,
    subtitle,
    round = false,
    playing = false,
    onclick,
    onplay,
    oncontext,
  }: {
    image?: string | null
    /** Mosaico de portadas (playlists) en lugar de una sola imagen. */
    covers?: string[]
    title: string
    subtitle: string
    round?: boolean
    /** Es lo que está sonando: el botón se queda visible y muestra pausa. */
    playing?: boolean
    onclick: () => void
    /** Si se pasa, aparece el botón de reproducir al pasar el ratón. */
    onplay?: () => void
    /** Clic derecho (menú de la tarjeta). */
    oncontext?: (e: MouseEvent) => void
  } = $props()
</script>

<div class="card" class:round oncontextmenu={oncontext} role="group">
  <button class="hit" {onclick} {title} aria-label={title}></button>
  <div class="art">
    {#if covers}<Collage {covers} />{:else}<Cover src={image} {round} />{/if}
    {#if onplay}
      <button
        class="play"
        class:show={playing}
        title={playing ? 'Pausa' : 'Reproducir'}
        onclick={(e) => {
          e.stopPropagation()
          onplay?.()
        }}
      >
        <Icon name={playing ? 'pause' : 'play'} size={20} />
      </button>
    {/if}
  </div>
  <span class="title">{title}</span>
  <span class="subtitle">{subtitle}</span>
</div>

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 12px;
    border-radius: var(--radius);
    transition:
      background 0.25s var(--ease),
      transform 0.25s var(--ease);
  }
  .card:hover,
  .card:focus-within {
    background: rgb(255 255 255 / 0.06);
  }
  /* Toda la tarjeta es clicable; el botón de reproducir queda por encima. */
  .hit {
    position: absolute;
    inset: 0;
    z-index: 1;
    border-radius: inherit;
  }
  .art {
    position: relative;
    margin-bottom: 8px;
    transition: transform 0.3s var(--ease);
  }
  .card:hover .art {
    transform: translateY(-2px);
  }
  .card:hover .art :global(.cover),
  .card:hover .art :global(.collage) {
    box-shadow: var(--shadow-2);
  }
  .play {
    position: absolute;
    right: 8px;
    bottom: 8px;
    z-index: 2;
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--accent-grad);
    color: #10002b;
    box-shadow: 0 8px 20px rgb(0 0 0 / 0.45);
    opacity: 0;
    transform: translateY(8px);
    transition:
      opacity 0.25s var(--ease),
      transform 0.25s var(--ease);
  }
  .card:hover .play,
  .play.show,
  .play:focus-visible {
    opacity: 1;
    transform: none;
  }
  .play:hover {
    transform: scale(1.06) !important;
  }
  .title {
    font-weight: 700;
    color: var(--text);
  }
  .subtitle {
    font-size: 13px;
    color: var(--muted);
  }
  .title,
  .subtitle {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .round .title,
  .round .subtitle {
    text-align: center;
  }
</style>
