<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import Icon from '../src/components/Icon.svelte'
  import { duration as fmt } from '../src/lib/format'
  import { player } from '../src/lib/player.svelte'
  import { closeOfficialYouTube, officialYouTube } from './official-youtube.svelte'
  import { officialEmbedUrl } from './official-youtube'
  import type { TrackQuery } from '../src/lib/types'

  let dialog: HTMLDialogElement | undefined = $state()
  let previousTrack: TrackQuery | null = null
  let wasOpened = false
  const sourceUrl = $derived(officialYouTube.selected ? officialEmbedUrl(officialYouTube.selected.videoId, window.location.origin, officialYouTube.automatic, officialYouTube.startAt) : null)

  $effect(() => {
    const opened = officialYouTube.opened, track = officialYouTube.track
    if (!opened) {
      wasOpened = false
      previousTrack = null
      if (dialog?.open) dialog.close()
      return
    }
    if (!wasOpened || track !== previousTrack) {
      wasOpened = true
      previousTrack = track
      untrack(() => { if (player.status === 'playing' || player.status === 'loading') player.toggle() })
    }
    if (dialog && !dialog.open) dialog.showModal()
  })

  // Hardware/media controls can resume normal audio while this top-layer dialog is open.
  $effect(() => {
    if (officialYouTube.opened && (player.status === 'playing' || player.status === 'loading')) closeOfficialYouTube()
  })

  onDestroy(closeOfficialYouTube)
  function closeDialog() { if (!dialog?.open && officialYouTube.opened) closeOfficialYouTube() }
  function cancel(event: Event) { event.preventDefault(); closeOfficialYouTube() }
  function backdrop(event: MouseEvent) {
    if (event.target !== dialog || !dialog) return
    const rect = dialog.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeOfficialYouTube()
  }
</script>

<dialog bind:this={dialog} data-official-youtube aria-label="Ver en YouTube" aria-describedby="official-youtube-help"
  onclose={closeDialog} oncancel={cancel} onclick={backdrop}>
  {#if officialYouTube.opened}
    <header>
      <div><h2>{officialYouTube.automatic ? 'Reproducción' : 'Ver en YouTube'}</h2>{#if officialYouTube.track}<p class="track">{officialYouTube.track.title} · {officialYouTube.track.artist}</p>{/if}</div>
      <button id="official-youtube-close" type="button" class="close" aria-label="Cerrar reproductor de YouTube" onclick={closeOfficialYouTube}><Icon name="close" size={22} /></button>
    </header>
    <div class="content">
      <p id="official-youtube-help" class="notice">YouTube necesita el vídeo abierto. Sin descarga ni reproducción en segundo plano garantizada.</p>
      {#if officialYouTube.automatic}
        <p class="individual">Si el navegador bloquea el inicio automático, usa el botón del vídeo.</p>
      {:else}
        <p class="individual">Reproducción individual con los controles de YouTube.</p>
      {/if}
      {#if officialYouTube.automatic && officialYouTube.selected}
        <p class="sr-only" role="status">Abriendo reproducción…</p>
      {:else if officialYouTube.status === 'loading'}
        <p class="status" role="status">Buscando vídeos…</p>
      {:else if officialYouTube.error}
        <p class="error" role="alert">{officialYouTube.error}</p>
        {#if officialYouTube.track}<button id="official-youtube-retry" class="pill" type="button" onclick={() => officialYouTube.retry()}>Reintentar</button>{/if}
      {:else if !officialYouTube.sources.length}
        <p class="status" role="status">No se han encontrado coincidencias suficientemente cercanas para esta canción.</p>
        <button id="official-youtube-retry" class="pill" type="button" onclick={() => officialYouTube.retry()}>Reintentar</button>
      {:else}
        <p class="intro">Elige un vídeo y pulsa su botón de reproducción.</p>
        <div class="sources" aria-label="Vídeos coincidentes">
          {#each officialYouTube.sources as source (source.videoId)}
            <button type="button" class="source" data-official-source data-video-id={source.videoId}
              aria-pressed={officialYouTube.selected?.videoId === source.videoId} onclick={() => officialYouTube.select(source.videoId)}>
              <Icon name="play" size={20} />
              <span class="details"><strong>{source.title}</strong><span>{source.artists}</span></span>
              <span class="duration">{source.duration === null ? '–' : fmt(source.duration)}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if sourceUrl && officialYouTube.selected}
        <div class="video">
          {#key officialYouTube.selected.videoId}
            <iframe data-official-video data-video-id={officialYouTube.selected.videoId} title="Reproductor oficial de YouTube"
              src={sourceUrl} width="640" height="360" allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
          {/key}
        </div>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  dialog { width: min(760px, calc(100vw - 24px)); min-width: 224px; max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); padding: 0; overflow: auto; overscroll-behavior: contain; border: 1px solid var(--line); border-radius: 16px; background: var(--panel); color: var(--text); box-shadow: 0 24px 64px #0009; }
  dialog::backdrop { background: #000b; }
  header { position: sticky; top: 0; z-index: 1; display: flex; align-items: flex-start; gap: 16px; padding: 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
  header > div { flex: 1; min-width: 0; }
  h2 { margin: 0 0 4px; font-size: 20px; }
  p { margin: 0; }
  .track { color: var(--muted); overflow-wrap: anywhere; }
  .close { flex: 0 0 44px; display: grid; place-items: center; width: 44px; min-height: 44px; border-radius: 10px; }
  .close:hover { background: var(--hover); }
  .content { padding: 20px; min-width: 0; }
  .notice { padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; color: var(--muted); line-height: 1.5; }
  .status, .error { margin: 20px 0 12px; line-height: 1.5; }
  .error { color: var(--text); }
  .intro { margin: 20px 0 12px; color: var(--muted); }
  .individual { margin: 10px 0 0; color: var(--muted); font-size: 13px; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  .sources { display: grid; gap: 8px; }
  .source { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 64px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; text-align: left; }
  .source:hover { background: var(--hover); }
  .source[aria-pressed='true'] { border-color: var(--accent); }
  .details { display: grid; flex: 1; min-width: 0; gap: 4px; overflow-wrap: anywhere; }
  .details > span, .duration { color: var(--muted); font-size: 13px; }
  .video { min-width: 200px; margin-top: 20px; }
  iframe { display: block; width: 100%; min-width: 200px; height: auto; aspect-ratio: 16 / 9; min-height: 200px; max-height: max(200px, calc(100dvh - 140px)); border: 0; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  @media (max-width: 480px), (max-height: 420px) { header, .content { padding: 12px; } .source { padding: 10px; gap: 10px; } }
</style>
