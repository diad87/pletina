<script lang="ts">
  import { applyWebUpdate, webUpdate } from './updates.svelte'
</script>

{#if webUpdate.ready}
  <aside class="web-update" role="status">
    <span>{webUpdate.error || (webUpdate.busy ? 'Preparando la nueva versión…' : 'Hay una nueva versión de Pletina.')}</span>
    <button disabled={webUpdate.busy} onclick={() => applyWebUpdate()}>Actualizar</button>
  </aside>
{/if}

<style>
  .web-update { position: fixed; top: calc(env(safe-area-inset-top, 0px) + 12px); left: 12px; right: 12px; z-index: 100; display: flex; align-items: center; gap: 12px; max-width: 600px; margin: auto; padding: 12px 16px; border: 1px solid #8d6aff; border-radius: 14px; background: #241c32; color: #fff; box-shadow: 0 8px 30px #0008; font: 14px/1.4 system-ui, sans-serif; }
  span { flex: 1; }
  button { min-height: 44px; padding: 8px 14px; border: 0; border-radius: 10px; background: #bba6fa; color: #15121c; font: inherit; font-weight: 700; }
  button:disabled { opacity: .6; }
</style>
