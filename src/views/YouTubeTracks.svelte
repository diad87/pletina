<script lang="ts">
  import { onDestroy } from 'svelte'
  import Cover from '../components/Cover.svelte'
  import DownloadButton from '../components/DownloadButton.svelte'
  import Icon from '../components/Icon.svelte'
  import Status from '../components/Status.svelte'
  import TrackList from '../components/TrackList.svelte'
  import * as api from '../lib/api'
  import { duration, songs } from '../lib/format'
  import { fromLib, library } from '../lib/library.svelte'
  import { nav } from '../lib/nav.svelte'
  import { player } from '../lib/player.svelte'
  import { theme } from '../lib/theme.svelte'
  import { toast } from '../lib/toast.svelte'
  import type { Entry, YouTubeTrackPreview } from '../lib/types'

  let entries = $state<Entry[] | null>(null)
  let loadError = $state('')
  let error = $state('')
  let url = $state('')
  let preview = $state<YouTubeTrackPreview | null>(null)
  let reading = $state(false)
  let saving = $state(false)
  let disposed = false
  let generation = 0
  let reload = $state(0)
  const items = $derived((entries ?? []).map((entry) => fromLib(entry.track)))
  const message = (e: unknown) => e instanceof Error ? e.message : String(e)

  theme.clear()
  theme.setColor('hsl(8 35% 23%)', 'Canciones de YouTube')
  onDestroy(() => { disposed = true; generation++ })

  $effect(() => {
    void library.version
    void reload
    let alive = true
    loadError = ''
    api.youtubeTracks().then((list) => {
      if (!alive) return
      entries = list
      nav.ready()
    }).catch((e) => { if (alive) loadError = message(e) })
    return () => { alive = false }
  })

  async function read() {
    if (reading || saving || !url.trim()) return
    const token = ++generation
    reading = true
    preview = null
    error = ''
    try {
      const result = await api.previewYouTubeTrack(url.trim())
      if (!disposed && token === generation) preview = result
    } catch (e) {
      if (!disposed && token === generation) error = message(e)
    } finally {
      if (!disposed && token === generation) reading = false
    }
  }

  function reset() {
    if (saving) return
    generation++
    reading = false
    preview = null
    error = ''
  }

  async function save() {
    if (!preview || saving || !preview.title.trim() || !preview.artist.trim()) return
    saving = true
    error = ''
    try {
      const track = await api.saveYouTubeTrack({ ...preview, title: preview.title.trim(), artist: preview.artist.trim() })
      library.version++
      toast.show(`«${track.title}» guardada en Canciones de YouTube`)
      if (!disposed) {
        preview = null
        url = ''
      }
    } catch (e) {
      if (!disposed) error = message(e)
    } finally {
      if (!disposed) saving = false
    }
  }
</script>

<section class="page top">
  <div class="intro">
    <span class="eyebrow">Tu biblioteca</span>
    <h1 class="page-title">Canciones de YouTube</h1>
    <p>Añade canciones y remixes con un enlace de YouTube o YouTube Music.</p>
  </div>

  <div class="import-panel" aria-busy={reading || saving}>
    <form class="url-form" onsubmit={(e) => { e.preventDefault(); read() }}>
      <label for="youtube-url">Enlace del vídeo</label>
      <div class="url-row">
        <input id="youtube-url" type="text" inputmode="url" bind:value={url} disabled={reading || saving || preview !== null}
          placeholder="https://www.youtube.com/watch?v=…" spellcheck="false" autocomplete="off" maxlength={2048} />
        {#if !preview}
          <button class="pill primary" type="submit" disabled={reading || !url.trim()}>{reading ? 'Leyendo…' : 'Continuar'}</button>
        {/if}
      </div>
    </form>
    {#if reading}
      <div class="reading" role="status">Comprobando el vídeo… <button class="link" onclick={reset}>Cancelar</button></div>
    {/if}
    {#if preview}
      <form class="review" onsubmit={(e) => { e.preventDefault(); save() }}>
        <div class="preview-art"><Cover src={preview.cover} /></div>
        <div class="fields">
          <label for="youtube-title">Título</label>
          <input id="youtube-title" bind:value={preview.title} disabled={saving} maxlength={300} required />
          <label for="youtube-artist">Artista o canal</label>
          <input id="youtube-artist" bind:value={preview.artist} disabled={saving} maxlength={200} required />
          <p class="details">YouTube{#if preview.duration > 0} · {duration(preview.duration)}{/if}</p>
          <div class="review-actions">
            <button class="pill primary" type="submit" disabled={saving || !preview.title.trim() || !preview.artist.trim()}>
              {saving ? 'Guardando…' : 'Guardar canción'}
            </button>
            <button class="pill" type="button" onclick={reset} disabled={saving}>Cambiar enlace</button>
          </div>
        </div>
      </form>
      <p class="hint">Puedes corregir el título y el artista. Si ya guardaste este vídeo, se actualizará sin duplicarlo.</p>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>

  <div class="saved-heading"><h2>Tus canciones</h2>{#if entries}<span>{songs(entries.length)}</span>{/if}</div>
  {#if loadError}
    <p class="error" role="alert">{loadError}</p>
    <button class="pill" onclick={() => reload++}>Reintentar</button>
  {:else if !entries}
    <Status />
  {:else if items.length}
    <div class="actions">
      <button class="big-play" title="Reproducir canciones de YouTube" onclick={() => player.playQueue(items, 0, 'Canciones de YouTube')}>
        <Icon name="play" size={26} />
      </button>
      <DownloadButton {items} />
    </div>
    <TrackList {items} variant="list" context="Canciones de YouTube" />
  {:else}
    <div class="empty-state">
      <Icon name="note" size={40} />
      <strong>Tus enlaces, en tu biblioteca</strong>
      <p>Pega un enlace arriba. Después podrás reproducir la canción, añadirla a playlists y descargarla.</p>
    </div>
  {/if}
</section>

<style>
  .intro p { color: var(--muted); margin: 0 0 24px; }
  .eyebrow { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
  .intro h1 { margin-top: 8px; }
  .import-panel { padding: 24px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
  label { display: block; color: var(--text); font-size: 13px; font-weight: 700; margin-bottom: 8px; }
  input { width: 100%; min-width: 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--elevated); color: var(--text); font: inherit; }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  input:disabled { opacity: .65; }
  .url-row { display: flex; gap: 12px; align-items: center; }
  .pill { flex: none; padding: 12px 20px; border: 1px solid var(--line); border-radius: 24px; font-weight: 700; }
  .primary { background: var(--accent); color: #101510; border-color: transparent; }
  button:disabled { opacity: .5; cursor: default; }
  .reading { display: flex; gap: 16px; align-items: center; margin-top: 16px; color: var(--muted); }
  .link { color: var(--text); text-decoration: underline; }
  .review { display: flex; gap: 24px; margin-top: 24px; align-items: start; }
  .preview-art { width: 150px; flex: none; }
  .fields { min-width: 0; flex: 1; }
  .fields input { margin-bottom: 16px; }
  .details, .hint { color: var(--muted); font-size: 13px; line-height: 1.5; }
  .details { margin: 0 0 16px; }
  .hint { margin: 20px 0 0; }
  .review-actions { display: flex; gap: 12px; flex-wrap: wrap; }
  .error { color: #ffb4ab; line-height: 1.5; }
  .saved-heading { display: flex; align-items: baseline; gap: 16px; margin-top: 32px; }
  .saved-heading h2 { font-size: 24px; margin: 0; }
  .saved-heading span { color: var(--muted); font-size: 13px; }
  .empty-state p { max-width: 450px; }
  @media (max-width: 680px) {
    .import-panel { padding: 16px; }
    .url-row { flex-wrap: wrap; }
    .url-row .pill { width: 100%; }
    .review { flex-direction: column; gap: 16px; }
    .preview-art { width: 100px; }
    .fields { width: 100%; }
    .review-actions { gap: 8px; }
    .pill { padding: 12px 16px; }
  }
</style>
