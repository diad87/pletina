<script lang="ts">
  // Estado de carga o error de una vista.
  let { error = null, retry }: { error?: string | null; retry?: () => void } = $props()
</script>

<div class="status">
  {#if error}
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
