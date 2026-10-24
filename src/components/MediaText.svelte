<script lang="ts">
  import * as api from '../lib/api'
  import { duration } from '../lib/format'
  import { activeCue, textSourceUrl } from '../lib/media-text'
  import { isPodcast } from '../lib/media'
  import { player } from '../lib/player.svelte'
  import type { QueueItem } from '../lib/queue'
  import type { TextDocument } from '../lib/types'
  import { toast } from '../lib/toast.svelte'
  import Icon from './Icon.svelte'

  let { item }: { item: QueueItem } = $props()
  const podcast = $derived(isPodcast(item.track.id))
  const label = $derived(podcast ? 'Transcripción' : 'Letra')
  let document = $state<TextDocument | null>(null)
  let loading = $state(true)
  let error = $state('')
  let attempt = $state(0)
  let follow = $state(true)
  let scroller: HTMLDivElement | undefined = $state()
  const cues = $derived(document?.cues ?? [])
  const active = $derived(activeCue(cues, player.status === 'loading' ? -1 : player.time))
  const sourceUrl = $derived(document ? textSourceUrl(document.sourceUrl) : null)

  $effect(() => {
    const current = item
    const isEpisode = isPodcast(current.track.id)
    attempt
    let alive = true
    document = null
    error = ''
    loading = true
    // Las transcripciones usan los tiempos del RSS. Otra versión puede tener anuncios distintos.
    follow = !isEpisode
    const request = isEpisode ? api.podcastTranscript(current.track.id) : api.lyricsGet({
      title: current.track.title, titleVersion: current.track.titleVersion, artist: current.track.artist.name,
      album: current.albumTitle, duration: current.track.duration,
    })
    request.then((value) => { if (alive) document = value })
      .catch((cause: unknown) => { if (alive) error = String(cause) })
      .finally(() => { if (alive) loading = false })
    return () => { alive = false }
  })

  $effect(() => {
    if (!follow || active < 0 || !scroller) return
    const line = scroller.querySelector<HTMLElement>(`[data-cue="${active}"]`)
    if (!line) return
    // Se desplaza solo este panel, sin mover la página o los controles de reproducción.
    scroller.scrollTo({ top: Math.max(0, line.offsetTop - scroller.clientHeight / 3),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  })

  function openSource(event: MouseEvent) {
    if (!api.inTauri || !sourceUrl) return
    event.preventDefault()
    void api.openTextSource(sourceUrl).catch(() => toast.show('No se pudo abrir la fuente en el navegador'))
  }
</script>

<section class="media-text" aria-label={label}>
  <div class="heading">
    <h2>{label}</h2>
    {#if cues.length}
      <button class="follow" class:on={follow} aria-pressed={follow} onclick={() => (follow = !follow)}>
        <Icon name="play" size={12} /> Seguir
      </button>
    {/if}
  </div>
  {#if loading}
    <div class="state" role="status"><span class="spinner"></span>Buscando {podcast ? 'transcripción' : 'letra'}…</div>
  {:else if error}
    <div class="state" role="status">
      <Icon name="text" size={32} />
      <p>No se pudo cargar {podcast ? 'la transcripción' : 'la letra'}.</p>
      <p class="detail">{error}</p>
      <button class="retry" onclick={() => attempt++}>Reintentar</button>
    </div>
  {:else if !document}
    <div class="state" role="status">
      <Icon name="text" size={32} />
      <p>{podcast ? 'Este episodio no tiene una transcripción disponible.' : 'No hay letra disponible para esta canción.'}</p>
      {#if podcast}<p class="detail">Aparecerá aquí cuando el programa la publique en su RSS en un formato compatible.</p>{/if}
    </div>
  {:else if document.instrumental}
    <div class="state" role="status"><Icon name="note" size={32} /><p>Esta canción es instrumental.</p></div>
  {:else}
    {#if podcast && cues.length}
      <p class="timing-note">Los tiempos corresponden al audio del RSS y pueden variar en otras versiones.</p>
    {/if}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (El panel desplazable necesita foco para leerlo con el teclado.) -->
    <div class="reading" bind:this={scroller} tabindex="0" role="region" aria-label={podcast ? 'Texto de la transcripción' : 'Texto de la letra'}>
      {#if cues.length}
        {#each cues as cue, index (index)}
          <button class="cue" class:active={active === index} data-cue={index}
            aria-current={active === index ? 'true' : undefined}
            onclick={() => player.seek(cue.start)} aria-label={`${duration(cue.start)}: ${cue.text || 'Pausa'}`}>
            {#if podcast}<span class="time">{duration(cue.start)}</span>{/if}
            <span>{cue.text || '♪'}</span>
          </button>
        {/each}
      {:else}
        <p class="plain">{document.text}</p>
      {/if}
    </div>
  {/if}
  {#if document}
    <p class="source">Fuente: {#if sourceUrl}<a href={sourceUrl} target="_blank" rel="noopener noreferrer" onclick={openSource}>{document.source} ↗</a>{:else}{document.source}{/if}</p>
  {/if}
</section>

<style>
  .media-text { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--text); }
  .heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 12px 12px; }
  h2 { margin: 0; font-size: 18px; font-weight: 800; }
  .follow { display: flex; align-items: center; gap: 5px; padding: 6px 10px; border-radius: 20px; background: rgb(255 255 255 / 0.08); color: rgb(255 255 255 / 0.7); font-size: 12px; }
  .follow.on { color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent); }
  .reading { position: relative; flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 8px 12px 35%; scrollbar-width: thin; touch-action: pan-y; }
  .plain { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 19px; font-weight: 600; line-height: 1.7; }
  .cue { display: flex; flex-direction: column; gap: 3px; width: 100%; padding: 10px 4px; border-radius: 8px; text-align: left; color: rgb(255 255 255 / 0.58); font-size: 22px; font-weight: 750; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; transition: color 0.2s; }
  .cue:hover, .cue:focus-visible { background: rgb(255 255 255 / 0.07); color: var(--text); }
  .cue.active { color: var(--text); }
  .time { font-size: 11px; font-weight: 500; opacity: 0.7; font-variant-numeric: tabular-nums; }
  .state { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px 12px; color: rgb(255 255 255 / 0.75); text-align: center; }
  .state p { margin: 0; }
  .detail, .timing-note { font-size: 12px; line-height: 1.5; color: rgb(255 255 255 / 0.55); overflow-wrap: anywhere; }
  .timing-note { margin: 0 12px 6px; }
  .retry { padding: 8px 16px; border-radius: 20px; background: rgb(255 255 255 / 0.12); color: var(--text); font-weight: 700; }
  .source { flex: none; margin: 12px 12px 0; font-size: 12px; color: rgb(255 255 255 / 0.6); }
  .source a { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
  .spinner { width: 22px; height: 22px; border: 2px solid rgb(255 255 255 / 0.2); border-top-color: var(--text); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .cue { transition: none; } }
  @media (max-width: 720px) {
    .heading { padding-bottom: 8px; }
    .cue { font-size: 21px; padding: 8px 4px; }
    .plain { font-size: 17px; }
    .source { margin-top: 8px; }
  }
</style>
