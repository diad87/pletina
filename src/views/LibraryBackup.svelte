<script lang="ts">
  import { onDestroy } from 'svelte'
  import Icon from '../components/Icon.svelte'
  import * as api from '../lib/api'
  import { library } from '../lib/library.svelte'
  import { nav } from '../lib/nav.svelte'
  import { theme } from '../lib/theme.svelte'

  type Summary = Awaited<ReturnType<typeof api.previewWebLibraryBackup>>
  type Phase = 'idle' | 'exporting' | 'reading' | 'review' | 'importing'
  let phase = $state<Phase>('idle')
  let error = $state('')
  let success = $state('')
  let downloadUrl = $state('')
  let downloadName = $state('')
  let exported = $state<Summary | null>(null)
  let preview = $state<Summary | null>(null)
  let fileName = $state('')
  let content: string | null = null
  let input: HTMLInputElement | undefined = $state()
  let generation = 0
  let disposed = false
  const busy = $derived(phase === 'exporting' || phase === 'reading' || phase === 'importing')
  const message = (value: unknown) => value instanceof Error ? value.message : String(value)
  const current = (token: number) => !disposed && token === generation

  theme.clear()
  theme.neutral()
  nav.ready()

  onDestroy(() => {
    disposed = true
    generation++
    if (downloadUrl) URL.revokeObjectURL(downloadUrl)
  })

  async function prepare() {
    if (busy || disposed) return
    const token = ++generation
    phase = 'exporting'
    error = ''
    success = ''
    preview = null
    content = null
    if (downloadUrl) URL.revokeObjectURL(downloadUrl)
    downloadUrl = ''
    exported = null
    try {
      const backup = await api.exportWebLibrary()
      if (!current(token)) return
      const summary = await api.previewWebLibraryBackup(backup)
      if (!current(token)) return
      const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' })
      if (downloadUrl) URL.revokeObjectURL(downloadUrl)
      downloadUrl = URL.createObjectURL(blob)
      downloadName = `pletina-biblioteca-${new Date().toISOString().slice(0, 10)}.json`
      exported = summary
    } catch (e) {
      if (current(token)) error = `No se pudo preparar la copia: ${message(e)}`
    } finally {
      if (current(token)) phase = 'idle'
    }
  }

  async function readFile(event: Event) {
    if (busy || disposed) return
    const selected = (event.currentTarget as HTMLInputElement).files?.[0]
    if (!selected) return
    const token = ++generation
    phase = 'reading'
    error = ''
    success = ''
    preview = null
    content = null
    fileName = selected.name
    try {
      if (selected.size > 10 * 1024 * 1024) throw new Error('La copia no puede superar los 10 MB.')
      const text = await selected.text()
      if (!current(token)) return
      const summary = await api.previewWebLibraryBackup(text)
      if (!current(token)) return
      content = text
      preview = summary
      phase = 'review'
    } catch (e) {
      if (!current(token)) return
      error = `No se pudo leer la copia: ${message(e)}`
      phase = 'idle'
      if (input) input.value = ''
    }
  }

  function cancel() {
    if (busy) return
    generation++
    content = null
    preview = null
    fileName = ''
    phase = 'idle'
    error = ''
    if (input) input.value = ''
  }

  async function restore() {
    if (phase !== 'review' || content === null || disposed) return
    const token = ++generation
    const selected = content
    phase = 'importing'
    error = ''
    success = ''
    let committed = false
    try {
      const added = await api.importWebLibraryBackup(selected)
      committed = true
      // A confirmed merge can finish after leaving this page. Refresh shared
      // library state without navigating, starting audio or changing its queue.
      const loaded = await library.load()
      library.version++
      library.historyVersion++
      api.invalidateDiscovery()
      if (!current(token)) return
      success = `Copia añadida: ${added.playlists} listas y ${added.likes} favoritos nuevos.${loaded ? '' : ' Vuelve a abrir Tu biblioteca para actualizar la vista.'}`
      content = null
      preview = null
      fileName = ''
      if (input) input.value = ''
    } catch (e) {
      if (current(token)) {
        error = committed
          ? 'La copia ya se ha guardado. Vuelve a abrir Tu biblioteca para ver los cambios.'
          : `No se pudo importar la copia: ${message(e)}`
        if (committed) { content = null; preview = null }
      }
    } finally {
      if (current(token)) phase = content === null || committed ? 'idle' : 'review'
    }
  }
</script>

<section class="page top backup" aria-labelledby="backup-title" aria-busy={busy}>
  <h1 class="page-title" id="backup-title">Copia de seguridad</h1>
  <p class="intro">Conserva tu biblioteca en un archivo y llévala a otro dispositivo.</p>

  <div class="card">
    <h2>Guardar una copia</h2>
    <p>Incluye favoritos, listas, discos, artistas, historial, pódcasts y progreso.</p>
    {#if downloadUrl && exported}
      <a class="primary" href={downloadUrl} download={downloadName}>
        <Icon name="download" size={20} /> Guardar archivo
      </a>
      <p class="file">{downloadName} · {exported.playlists} listas · {exported.likes} favoritos</p>
      <button class="secondary" onclick={prepare} disabled={busy}>Preparar otra copia</button>
    {:else}
      <button class="primary" onclick={prepare} disabled={busy}>
        <Icon name="download" size={20} /> {phase === 'exporting' ? 'Preparando copia…' : 'Preparar copia'}
      </button>
    {/if}
  </div>

  <div class="card">
    <h2>Importar una copia</h2>
    <p>Elige un archivo guardado desde Pletina web. Primero podrás revisar su contenido.</p>
    <label class="secondary picker" class:disabled={busy}>
      <Icon name="folder" size={20} /> {phase === 'reading' ? 'Leyendo copia…' : 'Elegir copia'}
      <input bind:this={input} type="file" accept=".json,application/json" aria-label="Archivo de copia de seguridad" onchange={readFile} disabled={busy} />
    </label>

    {#if preview}
      <div class="review" aria-labelledby="backup-review-title">
        <h3 id="backup-review-title">Contenido de la copia</h3>
        <p class="file">{fileName}</p>
        <dl>
          <div><dt>Favoritos</dt><dd>{preview.likes}</dd></div>
          <div><dt>Listas</dt><dd>{preview.playlists}</dd></div>
          <div><dt>Canciones en listas</dt><dd>{preview.entries}</dd></div>
          <div><dt>Discos</dt><dd>{preview.albums}</dd></div>
          <div><dt>Artistas</dt><dd>{preview.artists}</dd></div>
          <div><dt>Escuchas del historial</dt><dd>{preview.history}</dd></div>
          <div><dt>Pódcasts</dt><dd>{preview.podcasts}</dd></div>
          <div><dt>Episodios con progreso</dt><dd>{preview.progress}</dd></div>
        </dl>
        <p>Se conservará tu biblioteca actual. Las listas de la copia se añadirán como listas nuevas, respetando su orden y las canciones repetidas. Importar la misma copia otra vez creará otras listas.</p>
        <div class="actions">
          <button class="primary" onclick={restore} disabled={busy}>{phase === 'importing' ? 'Añadiendo biblioteca…' : 'Añadir a mi biblioteca'}</button>
          <button class="secondary" onclick={cancel} disabled={busy}>Cancelar</button>
        </div>
      </div>
    {/if}
  </div>

  <p class="note">Los archivos de música, las descargas y los ajustes del dispositivo no se incluyen. No necesitas conexión para guardar o importar una copia.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if success}<p class="success" role="status">{success}</p>{/if}
</section>

<style>
  .backup { max-width: 820px; }
  .intro, .card p, .note { color: var(--muted); line-height: 1.6; }
  .intro { margin: 12px 0 28px; }
  .card { margin-bottom: 20px; padding: 24px; border-radius: var(--radius); background: var(--elevated); }
  h2 { font-size: 20px; margin: 0 0 10px; }
  h3 { font-size: 17px; margin: 0 0 8px; }
  .card p { margin: 10px 0 18px; }
  .primary, .secondary { display: inline-flex; align-items: center; justify-content: center; gap: 9px; min-height: 44px; padding: 12px 18px; border-radius: 24px; font-weight: 700; }
  .primary { background: var(--accent); color: #110d1a; }
  .secondary { background: var(--panel); color: var(--text); border: 1px solid rgb(255 255 255 / 0.12); }
  button:disabled, .disabled { opacity: 0.55; cursor: default; }
  .picker { position: relative; cursor: pointer; overflow: hidden; }
  .picker input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: inherit; }
  .picker:focus-within { outline: 2px solid var(--accent); outline-offset: 3px; }
  .review { margin-top: 24px; padding-top: 24px; border-top: 1px solid rgb(255 255 255 / 0.1); }
  .card .file { font-size: 13px; overflow-wrap: anywhere; }
  dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 24px; margin: 20px 0; }
  dl div { display: flex; justify-content: space-between; gap: 12px; }
  dt { color: var(--muted); }
  dd { margin: 0; font-weight: 700; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; }
  .note { font-size: 13px; }
  .error, .success { padding: 16px; margin: 20px 0; border-radius: 12px; line-height: 1.5; }
  .error { color: #ffb6bb; background: rgb(255 80 100 / 0.1); }
  .success { color: var(--text); background: color-mix(in srgb, var(--accent) 14%, transparent); }
  @media (max-width: 500px) { .card { padding: 20px 16px; } dl { grid-template-columns: 1fr; gap: 10px; } }
</style>
