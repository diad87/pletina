<script lang="ts">
  import { onDestroy } from 'svelte'
  import Icon from '../components/Icon.svelte'
  import * as api from '../lib/api'
  import { library } from '../lib/library.svelte'
  import { nav } from '../lib/nav.svelte'
  import { theme } from '../lib/theme.svelte'
  import { toast } from '../lib/toast.svelte'
  import type { ImportSource, ImportTrack, LibTrack } from '../lib/types'

  type Phase = 'input' | 'reading' | 'matching' | 'paused' | 'review' | 'saving'
  type Result = { original: ImportTrack; match: LibTrack | null }

  let phase = $state<Phase>('input')
  let url = $state('')
  let file = $state<File | null>(null)
  let source = $state<ImportSource | null>(null)
  let name = $state('')
  let results = $state<Result[]>([])
  let error = $state('')
  let generation = 0
  let disposed = false
  let requested = false
  const cache = new Map<string, LibTrack | null>()

  const found = $derived(results.flatMap((row) => row.match ? [row.match] : []))
  const missing = $derived(results.filter((row) => !row.match).map((row) => row.original))
  const omitted = $derived((source?.skipped ?? 0) + missing.length)
  const progress = $derived(source?.tracks.length ? Math.round(results.length / source.tracks.length * 100) : 0)
  const isCurrent = (token: number) => !disposed && token === generation
  const message = (e: unknown) => e instanceof Error ? e.message : String(e)

  theme.clear()
  theme.setColor('hsl(155 28% 20%)', 'Importar de Spotify')
  nav.ready()

  onDestroy(() => {
    disposed = true
    generation++
  })

  function cancel() {
    if (phase === 'saving') return
    generation++
    phase = 'input'
    source = null
    results = []
    file = null
    error = ''
    cache.clear()
  }

  async function read(kind: 'spotify' | 'csv') {
    if (phase !== 'input' || disposed) return
    if (kind === 'spotify' ? !url.trim() : !file) return
    const token = ++generation
    phase = 'reading'
    error = ''
    results = []
    source = null
    cache.clear()
    requested = false
    try {
      let imported: ImportSource
      if (kind === 'csv') {
        const selected = file!
        if (selected.size > 10 * 1024 * 1024) throw new Error('El archivo CSV no puede superar los 10 MB.')
        const content = await selected.text()
        if (!isCurrent(token)) return
        imported = await api.readPlaylistCsv(content, selected.name.replace(/\.csv$/i, ''))
      } else {
        imported = await api.readSpotifyPlaylist(url.trim())
      }
      if (!isCurrent(token)) return
      source = imported
      name = imported.name
      await match(token, imported)
    } catch (e) {
      if (!isCurrent(token)) return
      error = `No se pudo leer la lista: ${message(e)}`
      if (kind === 'csv') file = null
      phase = 'input'
    }
  }

  async function match(token: number, imported: ImportSource) {
    if (!isCurrent(token)) return
    phase = 'matching'
    error = ''
    // Se reanuda desde la primera pendiente y se conserva cada aparición de una canción.
    for (let i = results.length; i < imported.tracks.length; i++) {
      const original = imported.tracks[i]
      const key = JSON.stringify(original)
      try {
        let matched = cache.get(key)
        if (!cache.has(key)) {
          if (requested) await new Promise((resolve) => setTimeout(resolve, 150))
          if (!isCurrent(token)) return
          requested = true
          matched = await api.matchImportTrack(original)
          if (!isCurrent(token)) return
          cache.set(key, matched)
        }
        if (!isCurrent(token)) return
        results.push({ original, match: matched ?? null })
      } catch (e) {
        if (!isCurrent(token)) return
        // Un fallo de red deja la canción pendiente; no se cuenta como no encontrada.
        error = `Se ha detenido la búsqueda: ${message(e)}`
        phase = 'paused'
        return
      }
    }
    if (isCurrent(token)) phase = 'review'
  }

  function retry() {
    if (phase !== 'paused' || !source || disposed) return
    void match(++generation, source)
  }

  async function save() {
    if (phase !== 'review' || !name.trim() || !found.length || disposed) return
    const token = generation
    const tracks = [...found]
    phase = 'saving'
    error = ''
    try {
      const created = await api.createPlaylist(name.trim(), tracks)
      // Si se sale de la vista durante el guardado, el cambio ya confirmado sigue en la biblioteca.
      await library.load()
      library.version++
      toast.show(`«${created.name}» importada con ${tracks.length === 1 ? '1 canción' : `${tracks.length} canciones`}`)
      if (isCurrent(token)) nav.go({ name: 'playlist', id: created.id })
    } catch (e) {
      if (!isCurrent(token)) return
      error = `No se pudo guardar la playlist: ${message(e)}`
      phase = 'review'
    }
  }
</script>

<section class="page top import-page">
  <header class="intro">
    <span class="eyebrow"><Icon name="library" size={16} /> Tu biblioteca</span>
    <h1 class="page-title">Importar de Spotify</h1>
    <p>Trae tus listas a Pletina. Las canciones se buscan en el catálogo de Pletina y podrás revisar el resultado antes de guardarlo.</p>
  </header>

  {#if !api.inTauri}
    <p class="notice demo"><strong>Vista de demostración.</strong> En el navegador, tanto los enlaces como los archivos CSV usan datos de ejemplo. La importación real está disponible en la app.</p>
  {/if}

  {#if error}
    <p class="notice error" role="alert">{error}</p>
  {/if}

  {#if phase === 'input'}
    <form class="card" onsubmit={(e) => { e.preventDefault(); void read('spotify') }}>
      <div class="card-heading"><span class="badge"><Icon name="download" size={22} /></span><h2>Pega el enlace de tu playlist</h2></div>
      <p>En Spotify, abre una lista pública y elige Compartir → Copiar enlace de la playlist.</p>
      <label for="spotify-url">Enlace de Spotify</label>
      <input id="spotify-url" type="text" inputmode="url" bind:value={url} placeholder="https://open.spotify.com/playlist/…" autocomplete="off" spellcheck="false" required />
      <p class="hint">El enlace público puede incluir solo las primeras 100 canciones. Para listas privadas o más largas, usa un archivo CSV.</p>
      <button class="pill primary" type="submit" disabled={!url.trim()}>Buscar canciones</button>
    </form>

    <details class="card csv">
      <summary>Importar un archivo CSV</summary>
      <p>Si ya tienes una exportación de tu lista de Spotify, selecciona el archivo con los títulos y artistas.</p>
      <label for="playlist-csv">Archivo de la playlist</label>
      <input id="playlist-csv" type="file" accept=".csv,text/csv" onchange={(e) => { file = e.currentTarget.files?.[0] ?? null }} />
      <p class="hint">Columnas: Track Name y Artist Name(s), o Title y Artist. También se pueden incluir Duration (ms) e ISRC. Máximo 10 MB y 10.000 canciones.</p>
      <button class="pill secondary" disabled={!file} onclick={() => read('csv')}>Buscar canciones del CSV</button>
    </details>
  {:else if phase === 'reading'}
    <div class="card loading">
      <div class="status" role="status"><span class="spinner"></span><h2>Leyendo tu lista…</h2></div>
      <p>Preparando los títulos y artistas para buscar sus canciones.</p>
      <button class="pill secondary" onclick={cancel}>Cancelar</button>
    </div>
  {:else if source}
    <div class="card result">
      {#if phase === 'matching' || phase === 'paused'}
        <div class="status">
          {#if phase === 'matching'}<span class="spinner"></span>{/if}
          <h2>{phase === 'matching' ? 'Buscando canciones…' : 'Búsqueda en pausa'}</h2>
        </div>
        <p class="source-name">{source.name}</p>
        <progress value={results.length} max={source.tracks.length || 1} aria-label="Canciones revisadas"></progress>
        <p class="progress-label" role="status">{results.length} de {source.tracks.length} canciones revisadas · {progress} %</p>
        {#if phase === 'matching' && source.tracks[results.length]}
          <p class="current">{source.tracks[results.length].title} · {source.tracks[results.length].artists.join(', ')}</p>
        {/if}
      {:else}
        <div class="card-heading"><span class="badge"><Icon name="check" size={22} /></span><h2>Revisa tu playlist</h2></div>
        <label for="playlist-name">Nombre de la playlist</label>
        <input id="playlist-name" type="text" bind:value={name} disabled={phase === 'saving'} maxlength="100" />
      {/if}

      <div class="totals">
        <div><strong>{found.length}</strong><span>Encontradas</span></div>
        <div><strong>{omitted}</strong><span>Omitidas</span></div>
      </div>

      {#if source.warnings.length}
        <div class="notice warnings">
          {#each source.warnings as warning}<p>{warning}</p>{/each}
        </div>
      {/if}

      {#if source.skipped}
        <p class="hint">{source.skipped === 1 ? '1 entrada no contiene una canción importable.' : `${source.skipped} entradas no contienen canciones importables.`}</p>
      {/if}

      {#if phase === 'review' || phase === 'saving'}
        {#if missing.length}
          <details class="track-details" open={!found.length}>
            <summary>No encontradas ({missing.length})</summary>
            <ul>{#each missing as track}<li><strong>{track.title}</strong><span>{track.artists.join(', ')}</span></li>{/each}</ul>
          </details>
        {/if}
        {#if found.length}
          <details class="track-details">
            <summary>Canciones que se guardarán ({found.length})</summary>
            <ol>{#each found as track}<li><strong>{track.title}</strong><span>{track.artistName}</span></li>{/each}</ol>
          </details>
          <p class="hint">Se creará una playlist nueva con las canciones encontradas, en el mismo orden.</p>
        {:else}
          <p class="notice">No se han encontrado canciones para guardar. Prueba con otro enlace o un CSV con títulos y artistas.</p>
        {/if}
      {/if}

      <div class="actions">
        {#if phase === 'paused'}
          <button class="pill primary" onclick={retry}>Reintentar búsqueda</button>
        {:else if phase === 'review' || phase === 'saving'}
          <button class="pill primary" disabled={phase === 'saving' || !found.length || !name.trim()} onclick={save}>
            {phase === 'saving' ? 'Guardando…' : 'Guardar playlist'}
          </button>
        {/if}
        <button class="pill secondary" disabled={phase === 'saving'} onclick={cancel}>
          {phase === 'review' ? 'Importar otra lista' : 'Cancelar'}
        </button>
      </div>
    </div>
  {/if}
</section>

<style>
  .import-page { max-width: 840px; }
  .intro { margin: 0 12px 28px; }
  .eyebrow { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; font-weight: 600; }
  .intro .page-title { margin: 12px 0; }
  .intro p { max-width: 610px; color: var(--muted); line-height: 1.6; }
  .card { margin: 0 12px 20px; padding: 26px; border: 1px solid rgb(255 255 255 / 0.08); border-radius: 14px; background: color-mix(in srgb, var(--panel) 86%, transparent); }
  .card-heading { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
  .badge { display: grid; place-items: center; flex: none; width: 44px; height: 44px; border-radius: 12px; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  h2 { margin: 0; font-size: 20px; letter-spacing: -0.02em; }
  p { margin: 0 0 18px; line-height: 1.5; }
  .card > p { color: var(--muted); }
  label { display: block; margin: 18px 0 8px; font-size: 13px; font-weight: 700; }
  input { width: 100%; min-width: 0; padding: 13px 14px; border: 1px solid rgb(255 255 255 / 0.18); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  input[type='file'] { font-size: 13px; margin-bottom: 18px; }
  input[type='file']::file-selector-button { margin-right: 12px; padding: 8px 10px; border: 0; border-radius: 5px; background: var(--elevated); color: var(--text); cursor: pointer; }
  .hint { margin: 12px 0 20px; color: var(--muted); font-size: 13px; }
  .pill { min-height: 44px; padding: 11px 20px; }
  .primary { background: var(--accent); color: #10002b; }
  .secondary { background: var(--elevated); color: var(--text); }
  button:disabled { cursor: default; opacity: 0.45; }
  summary { cursor: pointer; font-weight: 700; }
  .csv[open] summary { margin-bottom: 18px; }
  .notice { margin: 0 12px 20px; padding: 14px 16px; border-radius: 8px; background: var(--elevated); color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .demo { border-left: 3px solid var(--accent); }
  .error { color: #ffc5c5; background: rgb(210 70 70 / 0.15); }
  .status { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .spinner { flex: none; width: 20px; height: 20px; border: 2px solid rgb(255 255 255 / 0.2); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  .source-name { font-weight: 700; overflow-wrap: anywhere; }
  progress { width: 100%; height: 8px; border: 0; border-radius: 8px; overflow: hidden; accent-color: var(--accent); background: var(--elevated); }
  progress::-webkit-progress-bar { background: var(--elevated); }
  progress::-webkit-progress-value { background: var(--accent); }
  .progress-label { margin: 10px 0 8px; font-size: 13px; }
  .current { overflow-wrap: anywhere; font-size: 13px; }
  .totals { display: flex; gap: 48px; margin: 24px 0; }
  .totals div { display: flex; flex-direction: column; gap: 4px; }
  .totals strong { font-size: 30px; font-weight: 800; letter-spacing: -0.03em; }
  .totals div:first-child strong { color: var(--accent); }
  .totals span { color: var(--muted); font-size: 13px; }
  .result .notice { margin: 0 0 20px; }
  .warnings p { margin: 0; }
  .warnings p + p { margin-top: 10px; }
  .track-details { margin: 20px 0; }
  .track-details ul, .track-details ol { max-height: 320px; overflow-y: auto; padding: 0 8px 0 28px; margin-top: 16px; }
  .track-details li { padding: 7px 0 7px 4px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .track-details strong { display: block; color: var(--text); font-weight: 600; }
  .track-details span { display: block; margin-top: 3px; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 24px; padding: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  @media (max-width: 600px) {
    .intro { margin-bottom: 22px; }
    .intro .page-title { font-size: 30px; }
    .card { padding: 20px 16px; }
    .card-heading { gap: 10px; }
    h2 { font-size: 18px; }
    .badge { width: 36px; height: 36px; border-radius: 10px; }
    .actions { flex-direction: column; align-items: stretch; }
    .card > .pill { width: 100%; }
  }
</style>
