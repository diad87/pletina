import { parseVideoId, resolveAudio } from './resolver.ecb4d1adb7520d25.js'

export function parseQueue(text) {
  const lines = String(text).split(/\r?\n/).map((line, index) => ({ text: line.trim(), line: index + 1 })).filter((item) => item.text)
  if (!lines.length) throw new Error('Añade al menos un enlace o ID de YouTube.')
  if (lines.length > 100) throw new Error('Puedes preparar hasta 100 canciones a la vez.')
  return lines.map((item) => {
    try { return { id: parseVideoId(item.text), title: '', author: '' } }
    catch { throw new Error(`Revisa el enlace de la línea ${item.line}.`) }
  })
}

const clock = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const value = Math.floor(seconds)
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}

export async function mountPlayer(host) {
  if (!host || typeof host.replaceChildren !== 'function') throw new Error('Falta el espacio del reproductor.')
  host.setAttribute('data-pletina-player', '')
  host.innerHTML = `<style>
    [data-pletina-player] { width: 100%; color: #f4efff; font: 16px/1.5 system-ui, sans-serif; }
    [data-pletina-player] * { box-sizing: border-box; }
    [data-pletina-player] h2 { margin: 0 0 8px; font-size: clamp(1.8rem, 7vw, 2.4rem); line-height: 1.15; letter-spacing: -.04em; }
    [data-pletina-player] h3 { margin: 0 0 8px; font-size: 1rem; }
    [data-pletina-player] p { margin: 0 0 16px; color: #ada5ba; }
    [data-pletina-player] .pp-kicker { color: #bba6fa; font-size: .8rem; margin-bottom: 10px; }
    [data-pletina-player] label { display: block; margin-bottom: 8px; font-weight: 600; }
    [data-pletina-player] textarea { display: block; width: 100%; min-height: 112px; resize: vertical; border: 1px solid #504262; border-radius: 12px; padding: 12px; background: #211a2c; color: inherit; font: .9rem/1.55 system-ui, sans-serif; }
    [data-pletina-player] button { min-height: 46px; padding: 10px 14px; border: 1px solid #504262; border-radius: 12px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
    [data-pletina-player] button:disabled { opacity: .4; cursor: default; }
    [data-pletina-player] button:focus-visible, [data-pletina-player] textarea:focus-visible, [data-pletina-player] input:focus-visible { outline: 2px solid #bba6fa; outline-offset: 3px; }
    [data-pletina-player] .pp-primary { background: #bba6fa; border-color: transparent; color: #15121c; font-weight: 650; }
    [data-pletina-player] .pp-prepare { margin-top: 12px; }
    [data-pletina-player] .pp-card { margin-top: 24px; padding: 18px; border: 1px solid #3c3249; border-radius: 18px; background: #1d1726; }
    [data-pletina-player] .pp-title { font-weight: 650; overflow-wrap: anywhere; margin: 0 0 4px; color: #f4efff; }
    [data-pletina-player] .pp-author { font-size: .85rem; min-height: 1.3em; margin-bottom: 16px; }
    [data-pletina-player] .pp-controls { display: flex; flex-wrap: wrap; gap: 8px; }
    [data-pletina-player] .pp-controls .pp-play { flex: 1; }
    [data-pletina-player] .pp-progress { width: 100%; margin: 20px 0 0; accent-color: #bba6fa; touch-action: pan-y; }
    [data-pletina-player] .pp-time { display: flex; justify-content: space-between; font-size: .75rem; color: #ada5ba; font-variant-numeric: tabular-nums; }
    [data-pletina-player] .pp-status { margin: 16px 0 0; min-height: 3em; font-size: .875rem; }
    [data-pletina-player] .pp-queue { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
    [data-pletina-player] .pp-queue button { width: 100%; text-align: left; font-size: .875rem; overflow-wrap: anywhere; }
    [data-pletina-player] .pp-queue button[aria-current=true] { background: #30243f; border-color: #bba6fa; }
    [data-pletina-player] .pp-empty { font-size: .875rem; }
    [data-pletina-player] .pp-help { margin: 8px 0 0; font-size: .75rem; }
    [data-pletina-player] audio { display: none; }
  </style>
  <p class="pp-kicker">Pletina · Audio directo</p>
  <h2>Tu música.</h2>
  <p>Prepara una cola y dale al play.</p>
  <form class="pp-form">
    <label for="pp-links">Enlaces de YouTube</label>
    <textarea id="pp-links" class="pp-links" aria-describedby="pp-links-help" spellcheck="false" autocapitalize="off" autocomplete="off">aqz-KE-bpKQ\naqz-KE-bpKQ</textarea>
    <p class="pp-help" id="pp-links-help">Un enlace o ID por línea. Hay dos ejemplos listos para probar.</p>
    <button class="pp-primary pp-prepare" type="submit">Preparar cola</button>
  </form>
  <section class="pp-card" aria-label="Reproductor">
    <p class="pp-title">Elige lo que quieres escuchar</p>
    <p class="pp-author"></p>
    <div class="pp-controls">
      <button class="pp-previous" type="button" aria-label="Canción anterior" disabled>Anterior</button>
      <button class="pp-primary pp-play" type="button" disabled>Reproducir</button>
      <button class="pp-next" type="button" aria-label="Siguiente canción" disabled>Siguiente</button>
      <button class="pp-stop" type="button" disabled>Detener</button>
    </div>
    <input class="pp-progress" type="range" min="0" max="1" step="0.1" value="0" aria-label="Posición de reproducción" disabled>
    <div class="pp-time"><span class="pp-current">0:00</span><span class="pp-duration">0:00</span></div>
    <p class="pp-status" role="status" aria-live="polite">Pulsa Preparar cola para empezar.</p>
    <audio preload="metadata" playsinline></audio>
  </section>
  <section class="pp-card" aria-label="Cola de reproducción">
    <h3>Tu cola <span class="pp-count"></span></h3>
    <p class="pp-empty">Aquí aparecerán tus canciones.</p>
    <ol class="pp-queue"></ol>
  </section>`

  const find = (name) => host.querySelector(`.pp-${name}`)
  const audio = host.querySelector('audio')
  const playButton = find('play')
  const progress = find('progress')
  const status = find('status')
  const removers = []
  const on = (target, type, listener) => {
    target.addEventListener(type, listener)
    removers.push(() => target.removeEventListener(type, listener))
  }
  let entries = []
  let current = -1
  let phase = 'idle'
  let generation = 0
  let controller
  let prepared = false
  let destroyed = false
  let dragging = false
  let lastPositionUpdate = 0
  const say = (text) => { status.textContent = text }

  try { if (navigator.audioSession) navigator.audioSession.type = 'playback' } catch {}

  function updateSession() {
    if (!navigator.mediaSession) return
    try {
      navigator.mediaSession.playbackState = !prepared ? 'none' : audio.paused ? 'paused' : 'playing'
      if (prepared && Number.isFinite(audio.duration) && audio.duration > 0) {
        navigator.mediaSession.setPositionState?.({ duration: audio.duration, playbackRate: audio.playbackRate,
          position: Math.max(0, Math.min(audio.currentTime, audio.duration)) })
      } else navigator.mediaSession.setPositionState?.()
    } catch {}
  }

  function render() {
    const entry = entries[current]
    find('title').textContent = entry ? entry.title || entry.id : 'Elige lo que quieres escuchar'
    find('author').textContent = entry?.author || (entry ? `Canción ${current + 1} de ${entries.length}` : '')
    playButton.textContent = prepared && !audio.paused ? 'Pausar' : 'Reproducir'
    playButton.disabled = !prepared || phase === 'resolving'
    find('previous').disabled = current <= 0
    find('next').disabled = current < 0 || current >= entries.length - 1
    find('stop').disabled = phase === 'idle'
    progress.disabled = !prepared || !Number.isFinite(audio.duration) || audio.duration <= 0
    host.setAttribute('aria-busy', String(phase === 'resolving'))
    updateSession()
  }

  function renderQueue() {
    find('count').textContent = entries.length ? `(${entries.length})` : ''
    find('empty').hidden = entries.length > 0
    find('queue').replaceChildren(...entries.map((entry, index) => {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.index = String(index)
      button.textContent = `${index + 1}. ${entry.title || entry.id}`
      if (index === current) button.setAttribute('aria-current', 'true')
      item.append(button)
      return item
    }))
  }

  function updateTime() {
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
    if (!dragging) {
      progress.max = String(duration || 1)
      progress.value = String(Math.min(audio.currentTime || 0, duration || 1))
      find('current').textContent = clock(audio.currentTime)
    }
    find('duration').textContent = clock(duration)
    if (Date.now() - lastPositionUpdate > 1000) {
      lastPositionUpdate = Date.now()
      updateSession()
    }
  }

  function cancelPending() {
    generation += 1
    controller?.abort()
    controller = undefined
    return generation
  }

  function clearAudio() {
    prepared = false
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    progress.value = '0'
    find('current').textContent = '0:00'
    find('duration').textContent = '0:00'
  }

  function playAudio() {
    if (!prepared || destroyed) return
    const version = generation
    try {
      // Esta llamada permanece síncrona en el clic de Reproducir.
      const result = audio.play()
      render()
      Promise.resolve(result).catch((error) => {
        if (destroyed || version !== generation || !prepared || (error.name === 'AbortError' && audio.paused)) return
        phase = error.name === 'NotAllowedError' ? 'ready' : 'error'
        if (phase === 'error') prepared = false
        say(error.name === 'NotAllowedError' ? 'La canción está preparada. Pulsa Reproducir para continuar.'
          : 'No se pudo empezar la reproducción. Pulsa la canción en la cola para reintentarlo.')
        render()
      })
    } catch {
      say('La canción está preparada. Pulsa Reproducir para continuar.')
      render()
    }
  }

  async function openTrack(index, shouldPlay) {
    if (destroyed || !entries[index]) return
    const version = cancelPending()
    controller = new AbortController()
    clearAudio()
    current = index
    phase = 'resolving'
    say(`Preparando la canción ${index + 1} de ${entries.length}…`)
    renderQueue()
    render()
    try {
      const source = await resolveAudio(entries[index].id, { signal: controller.signal })
      if (destroyed || version !== generation) return
      controller = undefined
      entries[index].title = source.title
      entries[index].author = source.author
      audio.src = source.url
      prepared = true
      phase = 'ready'
      try {
        if (navigator.mediaSession && typeof MediaMetadata === 'function') {
          navigator.mediaSession.metadata = new MediaMetadata({ title: source.title, artist: source.author, album: 'Pletina' })
        }
      } catch {}
      say('Todo listo. Pulsa Reproducir.')
      renderQueue()
      render()
      if (shouldPlay) playAudio()
    } catch (error) {
      if (destroyed || version !== generation || error.name === 'AbortError') return
      controller = undefined
      phase = 'error'
      say(`${error.message} Puedes pulsar la canción en la cola para reintentarlo.`)
      render()
    }
  }

  on(find('form'), 'submit', (event) => {
    event.preventDefault()
    let nextEntries
    try { nextEntries = parseQueue(find('links').value) }
    catch (error) { say(error.message); return }
    entries = nextEntries
    void openTrack(0, false)
  })
  on(playButton, 'click', () => {
    if (!prepared) return
    if (audio.paused) playAudio()
    else audio.pause()
  })
  on(find('previous'), 'click', () => { void openTrack(current - 1, true) })
  on(find('next'), 'click', () => { void openTrack(current + 1, true) })
  on(find('stop'), 'click', () => {
    cancelPending()
    clearAudio()
    phase = 'idle'
    say('Reproducción detenida. Pulsa una canción de la cola o prepara otra.')
    render()
  })
  on(find('queue'), 'click', (event) => {
    const button = event.target.closest('button[data-index]')
    if (button && find('queue').contains(button)) void openTrack(Number(button.dataset.index), true)
  })
  on(progress, 'input', () => {
    dragging = true
    find('current').textContent = clock(Number(progress.value))
  })
  on(progress, 'change', () => {
    if (prepared && Number.isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(Number(progress.value), audio.duration))
    dragging = false
    updateTime()
    updateSession()
  })
  on(audio, 'loadedmetadata', () => { updateTime(); render() })
  on(audio, 'durationchange', () => { updateTime(); render() })
  on(audio, 'timeupdate', updateTime)
  on(audio, 'playing', () => {
    if (!prepared) return
    phase = 'playing'
    say('Reproduciendo.')
    render()
  })
  on(audio, 'pause', () => {
    if (!prepared || audio.ended || phase === 'error') return
    phase = 'paused'
    say('En pausa.')
    render()
  })
  on(audio, 'waiting', () => { if (prepared && !audio.paused) say('Cargando audio…') })
  on(audio, 'ended', () => {
    if (!prepared) return
    // La búsqueda del siguiente audio sucede aquí, también con la página oculta.
    if (current < entries.length - 1) void openTrack(current + 1, true)
    else {
      phase = 'ended'
      say('La cola ha terminado. Puedes volver a reproducirla o preparar otra.')
      render()
    }
  })
  on(audio, 'error', () => {
    if (!prepared || phase === 'resolving') return
    prepared = false
    phase = 'error'
    say('El audio no se pudo cargar. Pulsa la canción en la cola para volver a intentarlo.')
    render()
  })

  const sessionActions = {
    play: () => playAudio(),
    pause: () => { audio.pause() },
    previoustrack: () => { void openTrack(current - 1, true) },
    nexttrack: () => { void openTrack(current + 1, true) },
    seekto: ({ seekTime }) => {
      if (prepared && Number.isFinite(audio.duration) && Number.isFinite(seekTime)) {
        audio.currentTime = Math.max(0, Math.min(seekTime, audio.duration))
        updateTime()
        updateSession()
      }
    },
  }
  for (const [action, handler] of Object.entries(sessionActions)) {
    try { navigator.mediaSession?.setActionHandler(action, handler) } catch {}
  }
  render()

  return {
    destroy() {
      if (destroyed) return
      destroyed = true
      cancelPending()
      removers.forEach((remove) => remove())
      clearAudio()
      for (const action of Object.keys(sessionActions)) {
        try { navigator.mediaSession?.setActionHandler(action, null) } catch {}
      }
      try {
        if (navigator.mediaSession) {
          navigator.mediaSession.metadata = null
          navigator.mediaSession.playbackState = 'none'
          navigator.mediaSession.setPositionState?.()
        }
      } catch {}
      host.replaceChildren()
      host.removeAttribute('data-pletina-player')
    },
  }
}
