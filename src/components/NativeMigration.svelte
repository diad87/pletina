<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { pins } from '../lib/pins.svelte'
  import { isAndroid } from '../lib/player-android.svelte'
  import Icon from './Icon.svelte'

  const url = 'https://pletina-app.tuqo.ru/?import=native'
  const noticeKey = 'pletina:native-migration-notice'
  interface SavedCopy { downloads: number; exclusions: Record<string, number> }
  let dialog: HTMLDialogElement
  let showNotice = $state(readNotice())
  let busy = $state(false)
  let saved = $state<SavedCopy | null>(null)
  let status = $state('')
  let error = $state('')
  let showLink = $state(false)
  const hasExclusions = $derived(saved && Object.values(saved.exclusions).some(Boolean))

  function readNotice() {
    try { return localStorage.getItem(noticeKey) !== 'seen' } catch { return true }
  }

  function dismissNotice() {
    showNotice = false
    try { localStorage.setItem(noticeKey, 'seen') } catch { /* El acceso sigue en Tu biblioteca. */ }
  }

  function open() {
    dismissNotice()
    dialog.showModal()
  }

  async function save() {
    busy = true
    status = ''
    error = ''
    try {
      const result = await invoke<SavedCopy | null>('save_native_migration', {
        pins: pins.items.map(({ kind, id }) => ({ kind, id })),
      })
      if (result) {
        saved = result
        status = 'Copia guardada y verificada.'
      } else {
        status = 'Guardado cancelado.'
      }
    } catch (reason) {
      error = String(reason)
    } finally {
      busy = false
    }
  }

  async function openWeb() {
    error = ''
    try {
      await invoke('open_pwa_migration')
    } catch (reason) {
      showLink = true
      error = String(reason)
    }
  }
</script>

{#if showNotice}
  <div class="notice" aria-label="Pletina en la web">
    <button class="open" onclick={open}><Icon name="download" size={18} /> Llevar mi biblioteca a la web</button>
    <button class="later" onclick={dismissNotice}>Ahora no</button>
  </div>
{:else}
  <button class="open shortcut" onclick={open}><Icon name="download" size={18} /> Llevar mi biblioteca a la web</button>
{/if}

<dialog bind:this={dialog} data-native-migration aria-labelledby="migration-title">
  <div class="body">
    <div class="heading">
      <h2 id="migration-title">Pletina en la web</h2>
      <form method="dialog"><button class="later" aria-label="Cerrar">Cerrar</button></form>
    </div>
    <p>Guarda tus favoritos, listas, historial y progreso de pódcasts en un archivo. Puedes seguir usando esta app mientras pruebas la versión web.</p>

    <ol>
      <li>Guarda el archivo de tu biblioteca en una carpeta que puedas abrir desde el navegador.</li>
      <li>Abre Pletina desde Tuqo e instálala desde el navegador.</li>
      <li>Desde el icono nuevo, abre <strong>Tu biblioteca → Copia de seguridad</strong> y elige el archivo que guardaste.</li>
    </ol>

    <div class="actions">
      <button class="primary" onclick={save} disabled={busy}>{busy ? 'Guardando…' : saved ? 'Guardar otra copia' : 'Guardar mi biblioteca'}</button>
      <button class="open" onclick={openWeb}>Abrir Pletina en Tuqo</button>
    </div>
    <p class="status" role="status">{status}</p>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if showLink}
      <label class="copy">Dirección de Pletina <input readonly value={url} onfocus={(event) => event.currentTarget.select()} /></label>
    {/if}
    {#if saved?.downloads}
      <p>La copia incluye un listado de {saved.downloads} {saved.downloads === 1 ? 'descarga' : 'descargas'}. Vuelve a descargar en la web lo que quieras escuchar sin conexión.</p>
    {/if}
    {#if hasExclusions}
      <p>Algunos datos se quedan en esta app. Pletina te mostrará el detalle al abrir la copia.</p>
    {/if}
    <p>Comprueba la biblioteca y conserva esta app si aquí tienes la única copia de algún audio{isAndroid ? ' o usas Android Auto' : ''}.</p>
  </div>
</dialog>

<style>
  .notice { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .open, .primary, .later {
    min-height: 40px;
    padding: 8px 12px;
    border-radius: 10px;
    font: inherit;
    font-weight: 700;
  }
  .open, .primary { display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
  .open { color: var(--accent); background: var(--elevated); }
  .shortcut { background: none; justify-content: flex-start; }
  .primary { color: #141218; background: var(--accent); }
  .primary:disabled { opacity: .55; }
  .later { color: var(--muted); }
  dialog {
    position: fixed;
    inset: 0;
    margin: auto;
    width: min(480px, calc(100vw - 32px));
    max-height: calc(100dvh - 32px);
    padding: 0;
    border: 1px solid var(--elevated);
    border-radius: 16px;
    color: var(--text);
    background: var(--panel);
  }
  dialog::backdrop { background: rgb(0 0 0 / 70%); }
  .body { display: grid; gap: 12px; padding: 20px; }
  .heading, .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .heading { justify-content: space-between; }
  h2 { font-size: 1.25rem; }
  p, li, .copy { color: var(--muted); line-height: 1.5; }
  ol { margin: 0; padding-left: 1.35rem; }
  li + li { margin-top: 6px; }
  .status:empty { display: none; }
  .error { color: #ffb4ab; }
  .copy input { display: block; width: 100%; padding: 8px; background: var(--elevated); color: var(--text); }
</style>
