<script lang="ts">
  // "¿No es esta canción?": lista de vídeos candidatos para elegir otro a mano.
  import * as api from '../lib/api'
  import { duration as fmt } from '../lib/format'
  import { player, toQuery } from '../lib/player.svelte'
  import type { Alternative } from '../lib/types'
  import Icon from './Icon.svelte'
  import Status from './Status.svelte'

  let dialog: HTMLDialogElement | undefined = $state()
  let list = $state<Alternative[] | null>(null)
  let error = $state<string | null>(null)
  let link = $state('')
  let linkError = $state(false)
  let choosing = $state<string | null>(null)

  const item = $derived(player.picking)

  $effect(() => {
    const current = item
    list = null
    error = null
    link = ''
    linkError = false
    if (!current) return
    if (dialog && !dialog.open) dialog.showModal()
    let alive = true
    api
      .alternatives(toQuery(current))
      .then((l) => alive && (list = l))
      .catch((e) => alive && (error = String(e)))
    return () => {
      alive = false
    }
  })

  function close() {
    dialog?.close()
  }

  /** Acepta el ID de 11 caracteres o cualquier enlace de YouTube / YouTube Music. */
  function videoIdFrom(text: string): string | null {
    const t = text.trim()
    if (/^[\w-]{11}$/.test(t)) return t
    try {
      const u = new URL(t)
      if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1, 12) || null
      const v = u.searchParams.get('v')
      if (v) return v
      return u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1] ?? null
    } catch {
      return null
    }
  }

  async function choose(videoId: string) {
    choosing = videoId
    const ok = await player.useSource(videoId, item)
    choosing = null
    if (ok) close()
  }

  function submitLink(e: SubmitEvent) {
    e.preventDefault()
    const id = videoIdFrom(link)
    linkError = !id
    if (id) choose(id)
  }

  // Duración muy distinta a la del disco: probablemente otra versión.
  const offDuration = (alt: Alternative) =>
    item != null && alt.duration != null && Math.abs(alt.duration - item.track.duration) > 7
</script>

<dialog
  bind:this={dialog}
  onclose={() => (player.picking = null)}
  onclick={(e) => e.target === dialog && close()}
  aria-label="Elegir otro vídeo"
>
  {#if item}
    <div class="panel">
      <header>
        <div class="heading">
          <h2>¿No es esta canción?</h2>
          <p>
            Elige el vídeo correcto para <strong>{item.track.title}</strong> · {item.track.artist.name} ·
            {fmt(item.track.duration)}. Se recordará para la próxima vez.
          </p>
        </div>
        <button class="close" onclick={close} title="Cerrar (Esc)"><Icon name="close" /></button>
      </header>

      <div class="list">
        {#if error}
          <Status {error} />
        {:else if !list}
          <Status />
        {:else if !list.length}
          <p class="empty">No se ha encontrado nada. Prueba a pegar un enlace abajo.</p>
        {:else}
          {#each list as alt (alt.videoId)}
            <button class="alt" class:current={alt.current} disabled={choosing !== null} onclick={() => choose(alt.videoId)}>
              <img src={`https://i.ytimg.com/vi/${alt.videoId}/mqdefault.jpg`} alt="" loading="lazy" />
              <span class="text">
                <span class="title">{alt.title}</span>
                <span class="sub">{alt.artists}{alt.album ? ` · ${alt.album}` : ''}</span>
              </span>
              <span class="dur" class:off={offDuration(alt)}>{alt.duration != null ? fmt(alt.duration) : '–'}</span>
              <span class="tag" class:in-use={alt.current}>
                {#if choosing === alt.videoId}Cargando…{:else if alt.current}En uso{:else if alt.origin === 'music'}YouTube Music{:else}YouTube{/if}
              </span>
            </button>
          {/each}
        {/if}
      </div>

      <form class="paste" onsubmit={submitLink}>
        <input
          bind:value={link}
          oninput={() => (linkError = false)}
          placeholder="…o pega aquí un enlace de YouTube"
          spellcheck="false"
          class:invalid={linkError}
        />
        <button class="pill" type="submit" disabled={!link.trim() || choosing !== null}>Usar</button>
      </form>
      {#if linkError}<p class="link-error">Ese enlace no parece de un vídeo de YouTube.</p>{/if}
    </div>
  {/if}
</dialog>

<style>
  dialog {
    width: min(760px, calc(100vw - 48px));
    max-height: calc(100vh - 96px);
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
    color: var(--text);
    box-shadow: 0 24px 64px rgb(0 0 0 / 0.6);
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.6);
  }
  .panel {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 98px);
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding: 20px 20px 12px 24px;
  }
  .heading {
    flex: 1;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 20px;
    font-weight: 800;
  }
  header p {
    margin: 0;
    color: var(--muted);
  }
  header strong {
    color: var(--text);
  }
  .close {
    color: var(--muted);
  }
  .close:hover {
    color: var(--text);
  }

  .list {
    flex: 1;
    overflow-y: auto;
    padding: 0 12px;
  }
  .empty {
    padding: 32px 12px;
    color: var(--muted);
  }
  .alt {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr) auto 112px;
    align-items: center;
    gap: 14px;
    width: 100%;
    padding: 8px 12px;
    border-radius: 8px;
    text-align: left;
  }
  .alt:hover:not(:disabled),
  .alt:focus-visible {
    background: var(--hover);
  }
  .alt:disabled {
    cursor: progress;
  }
  .alt.current {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  img {
    width: 96px;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: 4px;
    background: var(--elevated);
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title,
  .sub {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .sub {
    font-size: 13px;
    color: var(--muted);
  }
  .dur {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .dur.off {
    color: #ff8a80;
  }
  .tag {
    font-size: 12px;
    color: var(--faint);
    text-align: right;
  }
  .tag.in-use {
    color: var(--accent);
    font-weight: 700;
  }

  .paste {
    display: flex;
    gap: 12px;
    padding: 16px 24px 4px;
    border-top: 1px solid var(--line);
    margin-top: 8px;
  }
  .paste input {
    flex: 1;
    height: 40px;
    padding: 0 14px;
    border: 2px solid transparent;
    border-radius: 20px;
    background: var(--elevated);
    color: var(--text);
    font: inherit;
    outline: 0;
  }
  .paste input:focus {
    border-color: var(--text);
  }
  .paste input.invalid {
    border-color: #ff8a80;
  }
  .pill:disabled {
    opacity: 0.4;
    cursor: default;
    transform: none;
  }
  .link-error {
    margin: 6px 24px 0;
    font-size: 13px;
    color: #ff8a80;
  }
  .panel > :last-child {
    margin-bottom: 20px;
  }
</style>
