<script lang="ts">
  import { tick } from 'svelte'
  import { isPodcast } from '../lib/media'
  import { player } from '../lib/player.svelte'
  import { isSleepMinutes, MAX_SLEEP_MINUTES, MIN_SLEEP_MINUTES, SLEEP_PRESETS } from '../lib/sleep-timer'
  import Icon from './Icon.svelte'

  let { variant = 'bar' }: { variant?: 'bar' | 'header' } = $props()
  const id = $props.id()
  let dialog: HTMLDialogElement
  let customInput = $state<HTMLInputElement>()
  let open = $state(false)
  let custom = $state(false)
  let minutes = $state<number | undefined>(30)
  let busy = $state(false)
  let error = $state('')
  let now = $state(Date.now())

  const timer = $derived(player.sleepTimer)
  const active = $derived(timer.mode !== 'off')
  const podcast = $derived(player.current ? isPodcast(player.current.track.id) : false)
  const endLabel = $derived(podcast ? 'Al terminar el episodio' : 'Al terminar la canción')
  const remaining = $derived(Math.max(0, Math.ceil((timer.endsAt - now) / 1000)))
  const countdown = $derived(formatCountdown(remaining))
  const status = $derived(timer.mode === 'time' ? `Pausa en ${countdown}` : timer.mode === 'end' ? endLabel : 'Temporizador de apagado')
  const pauseTime = $derived(timer.mode === 'time'
    ? new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(timer.endsAt) : '')

  $effect(() => {
    if (timer.mode !== 'time') return
    now = Date.now()
    const interval = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(interval)
  })

  function formatCountdown(seconds: number) {
    const hours = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    const secs = String(seconds % 60).padStart(2, '0')
    return hours ? `${hours}:${String(mins).padStart(2, '0')}:${secs}` : `${mins}:${secs}`
  }

  function show() {
    custom = false
    error = ''
    now = Date.now()
    dialog.showModal()
    open = true
  }

  async function showCustom() {
    custom = !custom
    error = ''
    if (!custom) return
    await tick()
    customInput?.focus()
    customInput?.select()
  }

  async function setTimer(value: number) {
    if (busy) return
    error = ''
    busy = true
    try {
      if (await player.setSleepTimer(value)) dialog.close()
      else error = 'No se pudo cambiar el temporizador. Inténtalo de nuevo.'
    } catch {
      error = 'No se pudo cambiar el temporizador. Inténtalo de nuevo.'
    } finally {
      busy = false
    }
  }

  function submitCustom(event: SubmitEvent) {
    event.preventDefault()
    if (typeof minutes !== 'number' || !isSleepMinutes(minutes)) {
      error = 'Introduce un número entero entre 1 y 1.440 minutos.'
      customInput?.focus()
      return
    }
    void setTimer(minutes)
  }

  function adjustMinutes(delta: number) {
    minutes = Math.max(MIN_SLEEP_MINUTES, Math.min(MAX_SLEEP_MINUTES, (minutes || 30) + delta))
    error = ''
  }

  function closeBackdrop(event: MouseEvent) {
    if (event.target !== dialog) return
    const rect = dialog.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close()
  }
</script>

<button
  class="timer"
  class:header={variant === 'header'}
  class:active
  onclick={show}
  onkeydown={(event) => event.stopPropagation()}
  disabled={!player.current && !active}
  title={status}
  aria-label={status}
  aria-haspopup="dialog"
  aria-expanded={open}
>
  <Icon name="moon" size={20} />
  {#if active}<span class="countdown">{timer.mode === 'time' ? countdown : 'Al final'}</span>{/if}
</button>

<dialog
  bind:this={dialog}
  data-sleep-timer
  aria-labelledby={`${id}-title`}
  aria-describedby={`${id}-description`}
  onclose={() => (open = false)}
  onkeydown={(event) => event.stopPropagation()}
  onpointerdown={(event) => event.stopPropagation()}
  onclick={closeBackdrop}
>
  <span class="handle" aria-hidden="true"></span>
  <header>
    <span class="moon"><Icon name="moon" size={24} /></span>
    <div class="heading">
      <h2 id={`${id}-title`}>Temporizador</h2>
      <p id={`${id}-description`}>Elige cuándo pausar el audio.</p>
    </div>
    <button class="close" onclick={() => dialog.close()} aria-label="Cerrar temporizador"><Icon name="close" size={20} /></button>
  </header>

  {#if active}
    <div class="current" class:editing={custom}>
      <div class="current-label"><span class="dot"></span>Temporizador activo</div>
      {#if timer.mode === 'time'}
        <strong class="remaining">{countdown}</strong>
        <span class="current-hint">El audio se pausará a las {pauseTime}</span>
      {:else}
        <strong class="end-countdown">Al terminar</strong>
        <span class="current-hint">{podcast ? 'este episodio' : 'esta canción'}</span>
      {/if}
    </div>
  {/if}

  <div class="section-label">{active ? 'Cambiar duración' : 'Pausar dentro de'}</div>
  <div class="presets" role="group" aria-label="Minutos hasta la pausa">
    {#each SLEEP_PRESETS as preset}
      <button onclick={() => setTimer(preset)} disabled={busy || !player.current}>
        <strong>{preset}</strong><span>minutos</span>
      </button>
    {/each}
  </div>

  <div class="options">
    <button class="option end-option" class:chosen={timer.mode === 'end'} onclick={() => setTimer(-1)} disabled={busy || !player.current}>
      <span class="option-icon"><Icon name={podcast ? 'podcast' : 'note'} size={20} /></span>
      <span class="option-copy"><span>{endLabel}</span><span class="track-title">{player.current?.track.title ?? ''}</span></span>
      <span class="chevron"><Icon name={timer.mode === 'end' ? 'check' : 'forward'} size={18} /></span>
    </button>
    <button class="option custom-option" class:selected={custom} onclick={showCustom} disabled={busy} aria-expanded={custom} aria-controls={`${id}-custom`}>
      <span class="option-icon"><Icon name="edit" size={19} /></span><span>Personalizado</span><span class="chevron"><Icon name={custom ? 'chevronUp' : 'chevronDown'} size={18} /></span>
    </button>

    {#if custom}
      <form id={`${id}-custom`} onsubmit={submitCustom} novalidate>
        <label for={`${id}-minutes`}>Tiempo en minutos</label>
        <div class="stepper">
          <button type="button" class="step" onclick={() => adjustMinutes(-5)} disabled={busy || (minutes ?? 0) <= MIN_SLEEP_MINUTES} aria-label="Restar 5 minutos"><span aria-hidden="true">−</span></button>
          <div class="number">
            <input
              bind:this={customInput}
              bind:value={minutes}
              id={`${id}-minutes`}
              type="number"
              inputmode="numeric"
              min={MIN_SLEEP_MINUTES}
              max={MAX_SLEEP_MINUTES}
              step="1"
              required
              disabled={busy}
              oninput={() => (error = '')}
              aria-describedby={`${id}-range`}
              aria-invalid={!!error}
            />
            <span aria-hidden="true">min</span>
          </div>
          <button type="button" class="step" onclick={() => adjustMinutes(5)} disabled={busy || (minutes ?? 0) >= MAX_SLEEP_MINUTES} aria-label="Sumar 5 minutos"><span aria-hidden="true">+</span></button>
        </div>
        <span id={`${id}-range`} class="range">De 1 minuto a 24 horas.</span>
        <button type="submit" class="start" disabled={busy || !player.current}>{busy ? 'Activando…' : active ? 'Cambiar temporizador' : 'Iniciar temporizador'}<Icon name="forward" size={18} /></button>
      </form>
    {/if}
  </div>

  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if active}<button class="cancel" onclick={() => setTimer(0)} disabled={busy}><Icon name="close" size={17} />Desactivar temporizador</button>{/if}
</dialog>

<style>
  .timer {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    gap: 6px;
    min-width: 24px;
    min-height: 40px;
    color: var(--muted);
    transition: color 0.15s;
  }
  .timer:hover:not(:disabled) {
    color: var(--text);
  }
  .timer:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .timer.active {
    color: var(--accent);
  }
  .timer.header {
    min-width: 40px;
    min-height: 40px;
    padding: 0 10px;
    border-radius: 20px;
    background: rgb(0 0 0 / 0.3);
  }
  .countdown {
    font-size: 12px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  dialog {
    width: min(410px, calc(100vw - 32px));
    max-height: calc(100dvh - 32px - var(--safe-top) - var(--safe-bottom));
    margin: auto;
    padding: 26px;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: 24px;
    background: linear-gradient(155deg, #222029, var(--panel-2) 48%);
    color: var(--text);
    box-shadow: var(--shadow-3);
    touch-action: pan-y;
    animation: appear 0.2s var(--ease);
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.6);
    backdrop-filter: blur(6px);
  }
  .handle { display: none; }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 26px;
  }
  .heading { flex: 1; min-width: 0; }
  .moon {
    display: grid;
    place-items: center;
    flex: none;
    width: 48px;
    height: 48px;
    border-radius: 16px;
    color: var(--accent);
    background: linear-gradient(135deg, rgb(182 156 255 / 0.18), rgb(182 156 255 / 0.05));
    border: 1px solid rgb(182 156 255 / 0.12);
  }
  .close {
    display: grid;
    place-items: center;
    flex: none;
    width: 40px;
    height: 40px;
    margin-right: -8px;
    border-radius: 50%;
    color: var(--muted);
  }
  .close:hover {
    color: var(--text);
    background: var(--hover);
  }
  h2 {
    margin: 0;
    font-size: 23px;
    line-height: 1.2;
    letter-spacing: -0.02em;
  }
  p {
    margin: 5px 0 0;
    color: var(--muted);
    font-size: 13px;
  }
  .current {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-bottom: 24px;
    padding: 20px 12px 22px;
    border: 1px solid rgb(182 156 255 / 0.17);
    border-radius: 18px;
    background: radial-gradient(ellipse at 50% 0%, rgb(182 156 255 / 0.13), rgb(182 156 255 / 0.03) 80%);
    text-align: center;
  }
  .current-label {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--accent);
    font-size: 12px;
    font-weight: 600;
  }
  .dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .remaining {
    margin: 6px 0 1px;
    font-size: 46px;
    line-height: 1.2;
    font-weight: 600;
    letter-spacing: -0.04em;
    font-variant-numeric: tabular-nums;
  }
  .end-countdown { margin: 12px 0 2px; font-size: 30px; font-weight: 600; letter-spacing: -0.03em; }
  .current-hint { color: var(--muted); font-size: 12px; }
  .current.editing { flex-direction: row; justify-content: space-between; gap: 12px; padding: 12px 14px; margin-bottom: 20px; }
  .current.editing .remaining, .current.editing .end-countdown { margin: 0; font-size: 24px; }
  .current.editing .current-hint { display: none; }
  .section-label { margin: 0 0 10px; color: var(--muted); font-size: 12px; font-weight: 600; }
  .presets {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 16px;
  }
  .presets button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 15px 8px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: rgb(255 255 255 / 0.045);
    transition: background 0.15s, border-color 0.15s, transform 0.15s;
  }
  .presets strong {
    font-size: 27px;
    font-weight: 600;
    line-height: 1.2;
  }
  .presets span {
    color: var(--muted);
    font-size: 11px;
  }
  .presets button:hover:not(:disabled) {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 13%, var(--elevated));
  }
  .presets button:active:not(:disabled) { transform: scale(0.97); }
  .options { overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: rgb(255 255 255 / 0.025); }
  .option {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 58px;
    padding: 12px 14px;
    text-align: left;
    font-size: 14px;
  }
  .option :global(svg) {
    flex: none;
    color: var(--muted);
  }
  .option-icon { display: grid; place-items: center; flex: none; width: 24px; }
  .option-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 3px; }
  .track-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; }
  .custom-option { border-top: 1px solid var(--line); }
  .option.chosen { color: var(--accent); }
  .option.chosen :global(svg) { color: var(--accent); }
  .option:hover:not(:disabled),
  .option.selected {
    background: var(--hover);
  }
  .chevron {
    display: flex;
    margin-left: auto;
  }
  form {
    padding: 8px 14px 16px;
  }
  label {
    display: block;
    margin-bottom: 7px;
    font-size: 12px;
    font-weight: 600;
  }
  .stepper {
    display: flex;
    gap: 10px;
  }
  .step { display: grid; place-items: center; flex: none; width: 48px; height: 48px; border: 1px solid var(--line); border-radius: 10px; background: var(--elevated); font-size: 25px; font-weight: 400; }
  .step:hover:not(:disabled) { background: var(--hover); }
  .number { display: flex; flex: 1; min-width: 0; align-items: center; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); }
  .number:focus-within { border-color: var(--accent); outline: 2px solid rgb(182 156 255 / 0.15); }
  .number > span { padding-right: 14px; color: var(--muted); font-size: 13px; }
  input {
    min-width: 0;
    width: 100%;
    height: 48px;
    padding: 0 8px 0 14px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 22px;
    font-variant-numeric: tabular-nums;
    text-align: center;
    appearance: textfield;
    outline: none;
  }
  input::-webkit-inner-spin-button, input::-webkit-outer-spin-button { margin: 0; appearance: none; }
  .start {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    width: 100%;
    min-height: 46px;
    margin-top: 14px;
    padding: 10px 16px;
    border-radius: 10px;
    background: var(--accent-grad);
    color: #10002b;
    font-weight: 700;
    box-shadow: 0 4px 16px rgb(143 108 255 / 0.12);
  }
  .start:hover:not(:disabled) { filter: brightness(1.07); }
  .range {
    display: block;
    margin-top: 8px;
    color: var(--muted);
    font-size: 11px;
  }
  .cancel {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 46px;
    margin-top: 20px;
    padding: 10px;
    border: 1px solid var(--line);
    border-radius: 10px;
    color: var(--muted);
    font-weight: 600;
  }
  .cancel:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
  }
  dialog button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .error {
    margin: 12px 0 0;
    color: var(--danger);
  }
  @keyframes appear { from { opacity: 0; transform: translateY(8px) scale(0.98); } }
  @keyframes sheet-up { from { transform: translateY(100%); } }
  @media (max-width: 720px) {
    dialog {
      width: 100%;
      max-width: none;
      max-height: calc(100dvh - var(--safe-top) - 12px);
      margin: auto 0 0;
      padding: 10px 24px calc(24px + var(--safe-bottom));
      border-radius: 26px 26px 0 0;
      border-bottom: 0;
      animation: sheet-up 0.25s var(--ease);
    }
    .handle { display: block; width: 36px; height: 4px; margin: 0 auto 20px; border-radius: 2px; background: rgb(255 255 255 / 0.18); }
    header { margin-bottom: 22px; }
    .close { width: 44px; height: 44px; }
  }
  @media (max-width: 360px) {
    dialog {
      padding-right: 18px;
      padding-left: 18px;
    }
    header { gap: 10px; }
    h2 { font-size: 21px; }
    .moon { width: 42px; height: 42px; border-radius: 14px; }
    header p { font-size: 12px; }
    .current { padding-top: 16px; padding-bottom: 18px; margin-bottom: 20px; }
    .timer.header.active {
      flex-direction: column;
      gap: 0;
      padding: 4px 8px;
    }
    .timer.header .countdown {
      font-size: 10px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    dialog { animation: none; }
    .presets button { transition: none; }
  }
</style>
