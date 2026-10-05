<script lang="ts">
  import { duration } from '../lib/format'
  import { library } from '../lib/library.svelte'
  import { nav } from '../lib/nav.svelte'
  import { player } from '../lib/player.svelte'
  import { toast } from '../lib/toast.svelte'
  import Cover from './Cover.svelte'
  import Icon from './Icon.svelte'

  const current = $derived(player.current)
  const liked = $derived(current ? library.liked.has(current.track.id) : false)

  // Mientras se arrastra la barra de progreso, manda la posición del dedo, no la del audio.
  let dragging = $state(false)
  let dragValue = $state(0)
  const position = $derived(dragging ? dragValue : player.time)
  const total = $derived(player.duration || current?.track.duration || 0)

  const pct = (value: number, max: number) => `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%`
</script>

<footer class="player">
  <div class="now">
    {#if current}
      <button class="thumb" onclick={() => nav.go({ name: 'album', id: current.albumId })} title="Ir al disco">
        <Cover src={current.cover} />
      </button>
      <div class="info">
        <button class="link title" onclick={() => nav.go({ name: 'album', id: current.albumId })}
          >{current.track.title}</button
        >
        <button class="link artist" onclick={() => nav.go({ name: 'artist', id: current.track.artist.id })}
          >{current.track.artist.name}</button
        >
        {#if player.status === 'loading'}<span class="hint">Buscando en YouTube…</span>{/if}
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

  <div class="center">
    <div class="buttons">
      <button
        class="icon toggle"
        class:on={player.shuffle}
        onclick={() => player.toggleShuffle()}
        title={player.shuffle ? 'Desactivar aleatorio' : 'Aleatorio'}
      >
        <Icon name="shuffle" size={18} />
      </button>
      <button class="icon" onclick={() => player.prev()} disabled={!current} title="Anterior">
        <Icon name="prev" />
      </button>
      <button
        class="play"
        onclick={() => player.toggle()}
        disabled={!current}
        title={player.status === 'playing' ? 'Pausa (espacio)' : 'Reproducir (espacio)'}
      >
        {#if player.status === 'loading'}
          <span class="spinner"></span>
        {:else}
          <Icon name={player.status === 'playing' ? 'pause' : 'play'} size={18} />
        {/if}
      </button>
      <button class="icon" onclick={() => player.next()} disabled={!player.hasNext} title="Siguiente">
        <Icon name="next" />
      </button>
      <button
        class="icon toggle"
        class:on={player.repeat !== 'off'}
        onclick={() => player.cycleRepeat()}
        title={player.repeat === 'off' ? 'Repetir' : player.repeat === 'all' ? 'Repetir una' : 'No repetir'}
      >
        <Icon name={player.repeat === 'one' ? 'repeatOne' : 'repeat'} size={18} />
      </button>
    </div>
    <div class="progress">
      <span class="time">{duration(position)}</span>
      <input
        type="range"
        class="slider"
        min="0"
        max={total}
        step="1"
        value={position}
        disabled={!current || player.status === 'loading'}
        style:--fill={pct(position, total)}
        oninput={(e) => {
          dragging = true
          dragValue = Number(e.currentTarget.value)
        }}
        onchange={(e) => {
          player.seek(Number(e.currentTarget.value))
          dragging = false
        }}
        aria-label="Posición"
      />
      <span class="time">{duration(total)}</span>
    </div>
  </div>

  <div class="side">
    <button
      class="icon"
      onclick={() => current && (player.picking = current)}
      disabled={!current}
      title="¿No es esta canción? Elegir otro vídeo"
    >
      <Icon name="swap" />
    </button>
    <button class="icon" onclick={() => player.toggleMute()} title={player.muted ? 'Activar sonido' : 'Silenciar'}>
      <Icon name={player.muted || player.volume === 0 ? 'mute' : 'volume'} />
    </button>
    <input
      type="range"
      class="slider volume"
      min="0"
      max="1"
      step="0.01"
      value={player.muted ? 0 : player.volume}
      style:--fill={pct(player.muted ? 0 : player.volume, 1)}
      oninput={(e) => player.setVolume(Number(e.currentTarget.value))}
      aria-label="Volumen"
    />
  </div>

  {#if toast.message}
    <div class="notice" role="status">{toast.message}</div>
  {/if}
</footer>

<style>
  .player {
    position: relative;
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(320px, 2fr) minmax(180px, 1fr);
    align-items: center;
    gap: 16px;
    height: 72px;
    padding: 0 8px;
  }

  .now {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .thumb {
    flex: none;
    width: 56px;
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
  .heart {
    flex: none;
  }
  .heart.on,
  .heart.on:hover {
    color: var(--accent);
  }

  .center {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .buttons {
    display: flex;
    align-items: center;
    gap: 20px;
  }
  .icon {
    display: grid;
    place-items: center;
    color: var(--muted);
    transition: color 0.15s;
  }
  .icon:hover:not(:disabled) {
    color: var(--text);
  }
  /* Aleatorio / repetir activos: color de acento y un punto debajo. */
  .toggle {
    position: relative;
  }
  .toggle.on {
    color: var(--accent);
  }
  .toggle.on:hover {
    color: var(--accent);
  }
  .toggle.on::after {
    content: '';
    position: absolute;
    left: 50%;
    bottom: -7px;
    width: 4px;
    height: 4px;
    margin-left: -2px;
    border-radius: 50%;
    background: var(--accent);
  }
  .icon:disabled,
  .play:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .play {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--text);
    color: #000;
    transition: transform 0.1s;
  }
  .play:hover:not(:disabled) {
    transform: scale(1.06);
  }
  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgb(0 0 0 / 0.25);
    border-top-color: #000;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .progress {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    max-width: 640px;
  }
  .time {
    min-width: 40px;
    font-size: 12px;
    color: var(--muted);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .side {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    padding-right: 8px;
  }
  .volume {
    width: 110px;
    flex: none;
  }

  /* Barra fina que se rellena; al pasar el ratón, color de acento y bolita. */
  .slider {
    flex: 1;
    height: 12px;
    margin: 0;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .slider:disabled {
    cursor: default;
  }
  .slider::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(
      to right,
      var(--text) 0 var(--fill),
      rgb(255 255 255 / 0.25) var(--fill) 100%
    );
  }
  .slider:hover:not(:disabled)::-webkit-slider-runnable-track {
    background: linear-gradient(
      to right,
      var(--accent) 0 var(--fill),
      rgb(255 255 255 / 0.25) var(--fill) 100%
    );
  }
  .slider::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4px;
    border-radius: 50%;
    background: var(--text);
    opacity: 0;
  }
  .slider:hover:not(:disabled)::-webkit-slider-thumb {
    opacity: 1;
  }

  .notice {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 12px);
    transform: translateX(-50%);
    max-width: min(560px, 90%);
    padding: 10px 16px;
    border-radius: 8px;
    background: var(--text);
    color: #000;
    font-weight: 600;
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.5);
  }
</style>
