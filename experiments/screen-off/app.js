(() => {
  const $ = (id) => document.getElementById(id)
  const audio = $('audio')
  const controls = [$('first-video'), $('next-video'), $('mode')]
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  const storeKey = 'pletina:screen-off:test1:' + new URL('./', location.href).pathname
  const finite = (value) => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null
  let phase = 'idle'
  let slot = 0
  let token = 0
  let firstSource
  let nextSource
  let settings
  let busy = false
  let prepared = false
  let transitioning = false
  let lastTimeUpdate = 0
  let nextPlayingReported = false
  let storageAvailable = true

  function freshLog() {
    return {
      schema: 'pletina-screen-off-1', createdAt: Date.now(),
      environment: {
        build: '__SCREEN_OFF_VERSION__',
        userAgent: navigator.userAgent, platform: navigator.platform,
        origin: location.origin, path: location.pathname, standalone: isStandalone(),
        secureContext: window.isSecureContext, mediaSession: 'mediaSession' in navigator,
        audioSession: 'audioSession' in navigator,
      },
      physicalScreenOffConfirmed: false,
      physicalConfirmationEvidence: 'operator-declaration-only', events: [],
    }
  }
  let data = freshLog()
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) || 'null')
    if (saved?.schema === data.schema && Array.isArray(saved.events)) data = saved
  } catch { storageAvailable = false }

  function snapshot() {
    return {
      slot, phase, hidden: document.hidden, time: finite(audio.currentTime),
      duration: finite(audio.duration), paused: audio.paused, ended: audio.ended,
      muted: audio.muted, volume: finite(audio.volume),
      readyState: audio.readyState, networkState: audio.networkState,
      mediaError: audio.error?.code || null,
      audioSessionType: navigator.audioSession?.type || null,
      audioSessionState: navigator.audioSession?.state || null,
    }
  }
  function render() {
    $('summary').textContent = [
      'Contexto: ' + (isStandalone() ? 'icono instalado' : 'página del navegador'),
      'Fuente actual: ' + slot + ' · Fase: ' + phase,
      'Cambio a la segunda fuente registrado: ' + (data.events.some((item) => item.event === 'next-playing') ? 'sí' : 'no'),
      'Pantalla apagada: ' + (data.physicalScreenOffConfirmed ? 'declarada manualmente' : 'sin confirmar'),
      storageAvailable ? 'Registro guardado en este navegador.' : 'Sin almacenamiento local; exporta antes de cerrar.',
    ].join('\n')
    $('log').textContent = JSON.stringify(data.events.slice(-16), null, 2)
  }
  function record(event, details = {}) {
    data.events.push({ at: new Date().toISOString(), elapsedMs: Date.now() - data.createdAt,
      event, ...snapshot(), ...details })
    if (data.events.length > 1200) data.events.splice(0, data.events.length - 1200)
    try { localStorage.setItem(storeKey, JSON.stringify(data)) } catch { storageAvailable = false }
    render()
  }
  const say = (message) => { $('status').textContent = message }
  function setBusy(value) {
    busy = value
    controls.forEach((control) => { control.disabled = value })
    $('prepare').disabled = value
  }
  function updateMediaMetadata() {
    if (!('mediaSession' in navigator)) return
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: (slot === 2 ? 'Segunda fuente' : 'Primera fuente') + ' · ' + (settings?.[slot === 2 ? 'nextVideo' : 'firstVideo'] || ''),
        artist: 'Pletina · prueba de bloqueo', album: 'Audio directo',
      })
    } catch { record('media-session-metadata-unavailable') }
  }
  function updatePosition() {
    if (!navigator.mediaSession?.setPositionState || !Number.isFinite(audio.duration) || audio.duration <= 0) return
    try { navigator.mediaSession.setPositionState({ duration: audio.duration,
      position: Math.min(audio.duration, Math.max(0, audio.currentTime)), playbackRate: audio.playbackRate }) } catch { /* Optional API. */ }
  }
  function usePlaybackSession() {
    if (!('audioSession' in navigator)) { record('audio-session-unavailable'); return }
    try {
      navigator.audioSession.type = 'playback'
      record('audio-session-configured')
    } catch (error) { record('audio-session-error', { errorName: error.name }) }
  }
  async function resolveSource(which, video, currentToken) {
    record('resolver-start', { which, videoId: video })
    try {
      const result = await window.ScreenOffResolver.resolveAudio(video)
      if (currentToken !== token) return null
      record('resolver-end', { which, itag: result.itag, mime: result.mime })
      return result
    } catch (error) {
      if (currentToken === token) record('resolver-error', { which, errorName: error.name })
      throw error
    }
  }
  function waitForMedia(condition, milliseconds = 25000) {
    return new Promise((resolve, reject) => {
      const events = ['loadedmetadata', 'durationchange', 'seeked', 'canplay', 'error']
      const cleanup = () => { clearTimeout(timer); events.forEach((event) => audio.removeEventListener(event, check)) }
      const check = () => {
        if (audio.error) { cleanup(); reject(new Error('No se pudo cargar el audio.')) }
        else if (condition()) { cleanup(); resolve() }
      }
      const timer = setTimeout(() => { cleanup(); reject(new Error('El audio agotó el tiempo de espera.')) }, milliseconds)
      events.forEach((event) => audio.addEventListener(event, check))
      check()
    })
  }
  function onPlayError(error, context) {
    record('playback-rejected', { context, errorName: error.name })
    $('resume').hidden = error.name !== 'NotAllowedError'
    say(error.name === 'NotAllowedError'
      ? 'El navegador exige otro toque. Este cambio no se ha iniciado automáticamente.'
      : 'La reproducción ha fallado. Exporta el registro y prepara una prueba nueva.')
  }
  async function goNext(reason) {
    if (!settings || slot !== 1 || transitioning) return
    const currentToken = token
    transitioning = true
    phase = 'next-resolving'
    record('transition-start', { reason, mode: settings.mode })
    say('Cambiando a la segunda fuente…')
    try {
      const source = settings.mode === 'prepared' ? nextSource
        : await resolveSource('next-after-ended', settings.nextVideo, currentToken)
      if (currentToken !== token) return
      if (!source) throw new Error('La siguiente fuente no está preparada.')
      slot = 2
      phase = 'next-loading'
      nextPlayingReported = false
      record('next-source-assigned', { preparedInForeground: settings.mode === 'prepared' })
      updateMediaMetadata()
      audio.src = source.url
      audio.load()
      audio.play().catch((error) => onPlayError(error, 'next'))
    } catch (error) {
      if (currentToken === token) {
        phase = 'next-error'
        record('transition-error', { errorName: error.name })
        say('No se pudo cambiar de fuente. Exporta el registro; el audio no ha continuado.')
      }
    } finally { if (currentToken === token) transitioning = false }
  }

  $('prepare').addEventListener('click', async () => {
    if (busy) return
    let firstVideo, nextVideo
    try {
      firstVideo = window.ScreenOffResolver.parseVideoId($('first-video').value)
      nextVideo = window.ScreenOffResolver.parseVideoId($('next-video').value)
    } catch (error) { say(error.message); return }
    const currentToken = ++token
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    data = freshLog()
    settings = { firstVideo, nextVideo, mode: $('mode').value, firstTailSeconds: 30 }
    data.settings = settings
    $('physical-off').checked = false
    firstSource = nextSource = null
    prepared = false
    transitioning = false
    nextPlayingReported = false
    slot = 1
    phase = 'preparing'
    $('start').disabled = true
    $('stop').disabled = true
    $('resume').hidden = true
    setBusy(true)
    record('prepare-start', { mode: settings.mode })
    say('Preparando la primera fuente y sus últimos 30 segundos…')
    try {
      firstSource = await resolveSource('first', firstVideo, currentToken)
      if (currentToken !== token || !firstSource) return
      audio.src = firstSource.url
      audio.load()
      await waitForMedia(() => audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0)
      audio.currentTime = Math.max(0, audio.duration - settings.firstTailSeconds)
      await waitForMedia(() => !audio.seeking)
      if (settings.mode === 'prepared') {
        say('Preparando también la siguiente URL con la pantalla encendida…')
        nextSource = await resolveSource('next-foreground', nextVideo, currentToken)
      }
      if (currentToken !== token) return
      phase = 'ready'
      prepared = true
      updateMediaMetadata()
      updatePosition()
      $('start').disabled = false
      say('Preparada. Pulsa Empezar y apaga físicamente la pantalla durante 2 minutos.')
      record('prepare-ready', { nextPrepared: Boolean(nextSource) })
    } catch (error) {
      if (currentToken === token) {
        phase = 'prepare-error'
        record('prepare-error', { errorName: error.name })
        say(error.message || 'No se pudo preparar la prueba.')
      }
    } finally { if (currentToken === token) setBusy(false) }
  })

  $('start').addEventListener('click', () => {
    if (!prepared || busy) return
    prepared = false
    phase = 'first'
    $('start').disabled = true
    $('stop').disabled = false
    setBusy(true)
    record('user-start')
    usePlaybackSession()
    say('Reproduciendo. Apaga ahora la pantalla con el botón físico.')
    // Sin await antes de play: conserva la activación del clic real.
    audio.play().catch((error) => onPlayError(error, 'first'))
  })
  $('stop').addEventListener('click', () => {
    ++token
    audio.pause()
    phase = 'stopped'
    prepared = false
    transitioning = false
    setBusy(false)
    $('stop').disabled = true
    $('start').disabled = true
    $('resume').hidden = true
    record('user-stop')
    say('Prueba detenida. Confirma el apagado físico si corresponde y exporta el registro.')
  })
  $('resume').addEventListener('click', () => {
    record('manual-resume')
    usePlaybackSession()
    audio.play().catch((error) => onPlayError(error, 'manual-resume'))
  })
  controls.forEach((control) => control.addEventListener('change', () => {
    if (busy) return
    prepared = false
    $('start').disabled = true
    say('La configuración ha cambiado. Pulsa Preparar de nuevo.')
  }))
  $('physical-off').addEventListener('change', () => {
    data.physicalScreenOffConfirmed = $('physical-off').checked
    record('physical-screen-off-declaration', { confirmed: data.physicalScreenOffConfirmed })
  })
  $('export').addEventListener('click', () => {
    record('export')
    const report = { ...data, exportedAt: new Date().toISOString(),
      screenOffAutomaticallyVerified: false, current: snapshot() }
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'pletina-screen-off-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })

  for (const event of ['play', 'pause', 'loadedmetadata', 'seeking', 'seeked', 'waiting', 'stalled', 'error']) {
    audio.addEventListener(event, () => {
      record('audio-' + event)
      if (event === 'pause' && navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'
      if (event === 'error') say('Error de audio. Exporta el registro antes de preparar otra prueba.')
    })
  }
  audio.addEventListener('playing', () => {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'
    record('audio-playing')
    $('resume').hidden = true
    if (slot === 2 && !nextPlayingReported) {
      nextPlayingReported = true
      phase = 'second'
      record('next-playing')
      say('La segunda fuente ha empezado. Mantén el móvil bloqueado y exporta el registro al volver.')
    }
  })
  audio.addEventListener('timeupdate', () => {
    if (Date.now() - lastTimeUpdate >= 5000) {
      lastTimeUpdate = Date.now()
      record('audio-timeupdate')
      updatePosition()
    }
  })
  audio.addEventListener('ended', () => {
    record('audio-ended')
    if (slot === 1) void goNext('ended')
    else { phase = 'finished'; setBusy(false); $('stop').disabled = true; record('run-finished'); say('La segunda fuente terminó. Exporta el registro.') }
  })
  document.addEventListener('visibilitychange', () => record('visibilitychange'))
  window.addEventListener('pagehide', (event) => record('pagehide', { persisted: event.persisted }))
  window.addEventListener('pageshow', (event) => record('pageshow', { persisted: event.persisted }))
  if (navigator.audioSession) navigator.audioSession.addEventListener('statechange', () => record('audio-session-statechange'))
  if (navigator.mediaSession) {
    const handlers = {
      play: () => { record('media-session-play'); audio.play().catch((error) => onPlayError(error, 'media-session')) },
      pause: () => { record('media-session-pause'); audio.pause() },
      nexttrack: () => { record('media-session-next'); void goNext('media-session') },
      seekto: (details) => { if (Number.isFinite(details.seekTime)) { audio.currentTime = details.seekTime; record('media-session-seek') } },
      seekbackward: (details) => { audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10)); record('media-session-seek-back') },
      seekforward: (details) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (details.seekOffset || 10)); record('media-session-seek-forward') },
    }
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, handler) } catch { /* Action unavailable on this browser. */ }
    }
  }
  $('physical-off').checked = Boolean(data.physicalScreenOffConfirmed)
  $('context').textContent = (isStandalone() ? 'Abierta desde el icono instalado.' : 'Abierta como página del navegador.') +
    ' Audio Session: ' + ('audioSession' in navigator ? 'disponible' : 'no disponible') +
    '. Media Session: ' + ('mediaSession' in navigator ? 'disponible' : 'no disponible') + '.'
  record('page-load')
  if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
      .then(() => navigator.serviceWorker.ready)
      .then(() => { $('offline').textContent = 'Archivos de la prueba disponibles sin conexión. El audio directo necesita red.'; record('static-offline-ready') })
      .catch((error) => { $('offline').textContent = 'No se pudo preparar la caché de esta herramienta.'; record('service-worker-error', { errorName: error.name }) })
  } else {
    $('offline').textContent = 'Como archivo local puedes probar el escritorio. La instalación en el móvil requiere la dirección HTTPS.'
  }
})()
