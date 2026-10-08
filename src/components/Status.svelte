<script lang="ts">
  // Estado de carga o error de una vista.
  import { layout } from '../lib/layout.svelte'
  import { nav } from '../lib/nav.svelte'

  let { error = null, retry }: { error?: string | null; retry?: () => void } = $props()
  // Sin conexión, el error de red no dice nada útil: se explica qué se puede hacer.
  const offline = $derived(!!error && typeof navigator !== 'undefined' && !navigator.onLine)
</script>

<div class="status">
  {#if offline}
    <p><strong>Sin conexión</strong></p>
    <p>{layout.canDownload ? 'Lo que has descargado se puede escuchar en Descargas.' : 'Vuelve a probar cuando tengas conexión.'}</p>
    <div class="buttons">
      {#if layout.canDownload}<button class="pill" onclick={() => nav.go({ name: 'downloads' })}>Ir a Descargas</button>{/if}
      {#if retry}<button class="pill" onclick={retry}>Reintentar</button>{/if}
    </div>
  {:else if error}
    <p>{error}</p>
    {#if retry}<button class="pill" onclick={retry}>Reintentar</button>{/if}
  {:else}
    <span class="dots" aria-label="Cargando"><i></i><i></i><i></i></span>
  {/if}
</div>

<style>
  .status {
    display: grid;
    place-items: center;
    gap: 16px;
    padding: 96px 24px;
    color: var(--muted);
    text-align: center;
  }
  .status p {
    margin: 0;
  }
  .status strong {
    color: var(--text);
    font-size: 18px;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px;
  }
  .dots {
    display: flex;
    gap: 6px;
  }
  .dots i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
    animation: pulse 1s infinite ease-in-out;
  }
  .dots i:nth-child(2) {
    animation-delay: 0.15s;
  }
  .dots i:nth-child(3) {
    animation-delay: 0.3s;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.25;
    }
    50% {
      opacity: 1;
    }
  }
</style>
