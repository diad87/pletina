<script lang="ts">
  // Botones de reproducción y barra de progreso; se usan en la barra inferior y en "Sonando ahora".
  import { duration } from '../lib/format'
  import { player } from '../lib/player.svelte'
  import Icon from './Icon.svelte'

  let { big = false }: { big?: boolean } = $props()

  const current = $derived(player.current)

  // Mientras se arrastra la barra de progreso, manda la posición del ratón, no la del audio.
  let dragging = $state(false)
  let dragValue = $state(0)
  const position = $derived(dragging ? dragValue : player.time)
  const total = $derived(player.duration || current?.track.duration || 0)
  const fill = $derived(`${total > 0 ? Math.min(100, (position / total) * 100) : 0}%`)
</script>

<div class="transport" class:big>
  <div class="buttons">
    <button
      class="icon toggle"
      class:on={player.shuffle}
      onclick={() => player.toggleShuffle()}
      title={player.shuffle ? 'Desactivar aleatorio' : 'Aleatorio'}
    >
      <Icon name="shuffle" size={big ? 22 : 18} />
    </button>
    <button class="icon" onclick={() => player.prev()} disabled={!current} title="Anterior">
      <Icon name="prev" size={big ? 30 : 20} />
    </button>
    <button
      class="play"
      onclick={() => player.toggle()}
      disabled={!current}
      title={player.status === 'loading' ? 'Cancelar carga (espacio)' : player.status === 'playing' ? 'Pausa (espacio)' : 'Reproducir (espacio)'}
    >
      {#if player.status === 'loading'}
        <span class="spinner"></span>
      {:else}
        <Icon name={player.status === 'playing' ? 'pause' : 'play'} size={big ? 28 : 18} />
      {/if}
    </button>
    <button class="icon" onclick={() => player.next()} disabled={!player.hasNext} title="Siguiente">
      <Icon name="next" size={big ? 30 : 20} />
    </button>
    <button
      class="icon toggle"
      class:on={player.repeat !== 'off'}
      onclick={() => player.cycleRepeat()}
      title={player.repeat === 'off' ? 'Repetir' : player.repeat === 'all' ? 'Repetir una' : 'No repetir'}
    >
      <Icon name={player.repeat === 'one' ? 'repeatOne' : 'repeat'} size={big ? 22 : 18} />
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
      style:--fill={fill}
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

<style>
  .transport {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    width: 100%;
  }
  .buttons {
    display: flex;
    align-items: center;
    gap: 22px;
  }
  .big .buttons {
    gap: 36px;
  }
  .icon {
    position: relative;
    display: grid;
    place-items: center;
    color: var(--muted);
    transition:
      color 0.15s,
      transform 0.15s var(--ease);
  }
  .icon:hover:not(:disabled) {
    color: var(--text);
    transform: scale(1.08);
  }
  .icon:disabled,
  .play:disabled {
    opacity: 0.4;
    cursor: default;
  }
  /* Aleatorio / repetir activos: color de acento y un punto debajo. */
  .toggle.on,
  .toggle.on:hover {
    color: var(--accent);
  }
  .toggle.on::after {
    content: '';
    position: absolute;
    left: 50%;
    bottom: -8px;
    width: 4px;
    height: 4px;
    margin-left: -2px;
    border-radius: 50%;
    background: var(--accent);
  }
  .play {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--text);
    color: #000;
    box-shadow: 0 4px 14px rgb(0 0 0 / 0.35);
    transition: transform 0.15s var(--ease);
  }
  .big .play {
    width: 64px;
    height: 64px;
  }
  .play:hover:not(:disabled) {
    transform: scale(1.07);
  }
  .play:active:not(:disabled) {
    transform: scale(0.96);
  }
  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgb(0 0 0 / 0.2);
    border-top-color: #000;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .big .spinner {
    width: 24px;
    height: 24px;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .progress {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    max-width: 660px;
  }
  .big .progress {
    max-width: none;
  }
  .time {
    min-width: 40px;
    font-size: 12px;
    font-weight: 500;
    color: var(--muted);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  /* Barra fina que engorda al pasar el ratón, con el relleno en color de acento. */
  .slider {
    flex: 1;
    height: 14px;
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
    border-radius: 3px;
    background: linear-gradient(to right, var(--text) 0 var(--fill), rgb(255 255 255 / 0.2) var(--fill) 100%);
    transition: height 0.15s;
  }
  .slider:hover:not(:disabled)::-webkit-slider-runnable-track {
    height: 6px;
    background: linear-gradient(to right, var(--accent) 0 var(--fill), rgb(255 255 255 / 0.2) var(--fill) 100%);
  }
  .slider::-webkit-slider-thumb {
    appearance: none;
    width: 14px;
    height: 14px;
    margin-top: -5px;
    border-radius: 50%;
    background: var(--text);
    box-shadow: 0 2px 6px rgb(0 0 0 / 0.5);
    opacity: 0;
    transition: opacity 0.15s;
  }
  .slider:hover:not(:disabled)::-webkit-slider-thumb {
    opacity: 1;
    margin-top: -4px;
  }
</style>
