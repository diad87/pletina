<script lang="ts">
  import { player } from '../lib/player.svelte'
  import Icon from './Icon.svelte'

  const label = $derived(player.shuffle ? 'Desactivar reproducción aleatoria' : 'Activar reproducción aleatoria')
</script>

<button
  type="button"
  class="shuffle"
  class:on={player.shuffle}
  aria-label={label}
  aria-pressed={player.shuffle}
  title={label}
  onclick={() => player.toggleShuffle()}
>
  <Icon name="shuffle" size={20} />
  <span>Aleatorio</span>
</button>

<style>
  .shuffle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-width: 44px;
    min-height: 44px;
    padding: 10px 14px;
    border: 1px solid var(--line);
    border-radius: 24px;
    color: var(--muted);
    font-weight: 700;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .shuffle:hover {
    color: var(--text);
    border-color: currentColor;
  }
  .shuffle.on,
  .shuffle.on:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: #10002b;
  }
</style>
