<script lang="ts">
  // "Tu biblioteca" en el móvil (en escritorio es la barra lateral).
  import Icon from '../components/Icon.svelte'
  import LibraryList from '../components/LibraryList.svelte'
  import { newPlaylist } from '../lib/actions'
  import * as api from '../lib/api'
  import { isAndroid } from '../lib/player-android.svelte'
  import { theme } from '../lib/theme.svelte'
  import { toast } from '../lib/toast.svelte'
  import { updates } from '../lib/updates.svelte'

  theme.clear()
  theme.neutral()
</script>

<section class="page top">
  <div class="title-row">
    <h1 class="page-title">Tu biblioteca</h1>
    <button class="add" onclick={newPlaylist} title="Crear playlist"><Icon name="plus" size={26} /></button>
  </div>
  <LibraryList />

  <!-- Lo que en el escritorio está en la barra lateral: versión y actualizaciones. -->
  <footer class="about">
    {#if updates.available}
      <button class="update" onclick={() => api.openReleases()}>
        <span class="dot"></span> Versión {updates.available} disponible · <strong>Descargar</strong>
      </button>
      <p>Si la instalaste con Obtainium, te avisará y se actualiza desde allí.</p>
    {/if}
    <div class="row">
      {#if updates.current}<span>Pletina {updates.current}</span>{/if}
      {#if isAndroid}
        <button class="link" onclick={() => api.shareLog().catch((e) => toast.show(String(e)))}>Enviar registro</button>
      {/if}
    </div>
  </footer>
</section>

<style>
  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .about {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 28px 8px 0;
    color: var(--faint);
    font-size: 12px;
  }
  .about p {
    margin: 0;
  }
  .about .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .link {
    padding: 8px 0;
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }
  .update {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--text);
    font-size: 13px;
    text-align: left;
  }
  .update strong {
    color: var(--accent);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
  }
  .add {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    color: var(--text);
  }
</style>
