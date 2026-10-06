// Nivel garantizado del motor propio. Se inyecta en la ventana oculta de YouTube Music antes que
// su código: deja que el reproductor oficial haga todo (PO token, descifrado, SABR...) y copia el
// audio que le entrega al navegador (Media Source Extensions). Lo manda a Rust por el canal nativo
// de la WebView (`chrome.webview.postMessage`), que solo existe en esta ventana.
(() => {
  const bridge = window.chrome?.webview
  if (!bridge || window.__musifyCapture) return
  window.__musifyCapture = true
  const target = new URLSearchParams(location.search).get('v')
  // Seguir una captura desde un segundo concreto (lo pone Rust; YouTube no lo usa).
  const startAt = Number(/musify-t=([\d.]+)/.exec(location.hash)?.[1] ?? 0)

  // Los mensajes salen en orden (la codificación a base64 es asíncrona).
  let queue = Promise.resolve()
  // Como texto con prefijo: wry (la base de Tauri) solo deja pasar al resto de receptores los
  // mensajes de texto, y Tauri descarta en el primer carácter los que no son suyos.
  const post = (msg) => bridge.postMessage('musify:' + JSON.stringify({ musify: 1, v: target, ...msg }))
  const event = (type, data = {}) => (queue = queue.then(() => post({ kind: 'event', type, ...data })))
  const toBase64 = (bytes) =>
    new Promise((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1))
      r.readAsDataURL(new Blob([bytes]))
    })

  // Página de consentimiento de cookies (UE): "Rechazar todo", sin depender del idioma si se puede.
  if (location.hostname === 'consent.youtube.com') {
    const reject = () => {
      const form = [...document.forms].find((f) => f.querySelector('input[name="set_eom"][value="true"]'))
      const button =
        form?.querySelector('button') ||
        [...document.querySelectorAll('button')].find((b) => /rechazar|reject|ablehnen|refuser|rifiuta/i.test(b.textContent || ''))
      if (!button) return false
      event('consent')
      button.click()
      return true
    }
    if (!reject()) document.addEventListener('DOMContentLoaded', reject)
    return
  }
  if (!target) return

  // Que el reproductor use Media Source en la propia página (donde se copia) y no dentro de un
  // Worker: YouTube tiene que funcionar igual en los navegadores que no lo admiten.
  try {
    Object.defineProperty(MediaSource, 'canConstructInDedicatedWorker', { get: () => false })
  } catch {}

  const player = () => document.querySelector('#movie_player')
  // Salto que pide Rust. Si aún no suena nuestra canción, se aplica en cuanto empiece.
  let pendingSeek = startAt > 0 ? startAt : null
  window.__musifySeek = (t) => {
    if (started && playing() === target && player()?.seekTo) player().seekTo(t, true)
    else pendingSeek = t
  }
  // Qué vídeo está sonando de verdad (un anuncio tiene otro id).
  const playing = () => player()?.getVideoData?.()?.video_id

  // Copia de lo que el reproductor mete en sus buffers de audio.
  let session = 0
  const addSourceBuffer = MediaSource.prototype.addSourceBuffer
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = addSourceBuffer.call(this, mime)
    if (mime.startsWith('audio/')) sb.__musify = { session: ++session, mime }
    return sb
  }
  const appendBuffer = SourceBuffer.prototype.appendBuffer
  SourceBuffer.prototype.appendBuffer = function (data) {
    const c = this.__musify
    if (c) {
      // Si aún no se sabe qué vídeo es, se da por bueno (un anuncio siempre tiene su id).
      const id = playing()
      const ad = !!id && id !== target
      const bytes = ArrayBuffer.isView(data) ? data.slice() : data.slice(0)
      const encoded = toBase64(bytes)
      queue = queue.then(async () => post({ kind: 'seg', s: c.session, mime: c.mime, ad, data: await encoded }))
    }
    return appendBuffer.call(this, data)
  }

  // El reproductor: siempre en silencio. Los anuncios, como haría una persona: esperar o saltarlos
  // en cuanto se pueda. La canción, a 16x para que la copia vaya muy por delante de lo que se oye.
  let started = false
  let finished = false
  const t0 = Date.now()
  // Duración del reproductor de YouTube (la del <video> puede ser solo lo que lleva cargado).
  const info = () => {
    const p = player()
    const d = p?.getVideoData?.() ?? {}
    const duration = p?.getDuration?.()
    return { duration: duration > 0 ? duration : null, title: d.title ?? '', author: d.author ?? '' }
  }
  let meta = false
  // Fin de la canción: se avisa y se deja la página en blanco para que YouTube no siga con la
  // siguiente de su lista ni gaste datos.
  const finish = (why) => {
    if (finished) return
    finished = true
    clearInterval(tick)
    const v = document.querySelector('video')
    v?.pause()
    event('ended', { ...info(), why: `${why} · ${location.search} · ${playing()} · ${v?.currentTime}/${v?.duration}` })
    queue.then(() => location.replace('about:blank'))
  }
  let beat = 0
  const tick = setInterval(() => {
    const v = document.querySelector('video')
    const p = player()
    // Latido cada segundo (también durante los anuncios): Rust sabe que la página sigue viva.
    if (++beat % 10 === 0 && !finished)
      event('progress', { position: playing() === target && v ? v.currentTime : null })
    if (!v || finished) return
    v.muted = true
    // YouTube ya ha pasado a otra canción: la nuestra terminó.
    if (started && new URLSearchParams(location.search).get('v') !== target) return finish('otra canción')
    if (playing() !== target) {
      document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')?.click()
      if (v.paused) v.play().catch(() => {})
      // Error del propio YouTube (vídeo no disponible, etc.).
      const error = document.querySelector('.ytp-error, yt-playability-error-supported-renderers, ytmusic-player .error')
      if (error && Date.now() - t0 > 3000) {
        finished = true
        event('error', { reason: (error.textContent || 'YouTube no puede reproducirlo').trim().slice(0, 200) })
      }
      return
    }
    // Salto pendiente (pedido antes de que sonara nuestra canción).
    if (pendingSeek !== null && p?.seekTo) {
      p.seekTo(pendingSeek, true)
      pendingSeek = null
    }
    if (!started) {
      started = true
      v.addEventListener('ended', () => finish('ended'))
      // El vídeo no hace falta: la calidad más baja posible.
      p?.setPlaybackQualityRange?.('tiny', 'tiny')
      event('playing', info())
    }
    // Título y duración en cuanto se sepan.
    if (!meta) {
      const i = info()
      if (i.duration && i.title) {
        meta = true
        event('meta', i)
      }
    }
    // Los últimos segundos más despacio, para no saltarse el final.
    const left = (info().duration ?? Infinity) - v.currentTime
    const rate = left > 6 ? 16 : 2
    if (v.playbackRate !== rate) v.playbackRate = rate
    if (v.paused && !v.ended) v.play().catch(() => {})
    // Fin: el propio vídeo, el estado del reproductor de YouTube (0 = terminado) o la posición.
    if (v.ended) finish('v.ended')
    else if (p?.getPlayerState?.() === 0) finish('estado')
    else if (left < 0.3) finish('posición')
  }, 100)
})()
