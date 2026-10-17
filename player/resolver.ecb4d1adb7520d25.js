// El frame solo obtiene JSON. No carga reproductores, scripts externos ni cookies.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
let sequence = 0

export function parseVideoId(value) {
  const text = String(value ?? '').trim()
  if (VIDEO_ID.test(text)) return text
  let url
  try { url = new URL(text) } catch { throw new Error('Introduce un enlace de YouTube o un ID válido.') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Introduce un enlace de YouTube válido.')
  }
  const host = url.hostname.toLowerCase()
  let id
  if (host === 'youtu.be' || host === 'www.youtu.be') id = url.pathname.split('/')[1]
  else if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
    id = url.searchParams.get('v')
    if (!id && /^\/(embed|shorts|live)\//.test(url.pathname)) id = url.pathname.split('/')[2]
  }
  if (!id || !VIDEO_ID.test(id)) throw new Error('No se reconoce un vídeo válido en ese enlace.')
  return id
}

export function validAudioUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'))) return url.href
  } catch {}
  throw new Error('No se ha recibido una dirección de audio válida.')
}

async function bridge({ requestId, videoId }) {
  try {
    const post = async (path, body) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      try {
        const response = await fetch('https://www.youtube.com/youtubei/v1/' + path + '?prettyPrint=false', {
          method: 'POST', headers: { 'Content-Type': 'text/plain' }, credentials: 'omit',
          body: JSON.stringify(body), signal: controller.signal,
        })
        if (!response.ok) throw new Error('YouTube no responde ahora. Vuelve a intentarlo en un momento.')
        return await response.json()
      } finally { clearTimeout(timer) }
    }
    const search = await post('search', {
      context: { client: { clientName: 'WEB', clientVersion: '2.20261007.00.00' } }, query: videoId,
    })
    const visitor = search.responseContext?.visitorData
    if (!visitor) throw new Error('No se pudo preparar el audio. Vuelve a intentarlo.')
    const player = await post('player', {
      context: { client: {
        clientName: 'VISIONOS', clientVersion: '1.02', visitorData: visitor,
        deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS',
        osVersion: '26.5.23O471', platform: 'MOBILE',
      } }, videoId, contentCheckOk: true, racyCheckOk: true,
    })
    if (player.playabilityStatus?.status !== 'OK') throw new Error('Este vídeo no está disponible para reproducirlo aquí.')
    const format = player.streamingData?.adaptiveFormats
      ?.filter((item) => item.mimeType?.startsWith('audio/mp4') && typeof item.url === 'string')
      .sort((a, b) => b.bitrate - a.bitrate)[0]
    if (!format) throw new Error('Este vídeo no ofrece audio compatible.')
    parent.postMessage({ type: 'pletina-player-audio', requestId, url: format.url,
      title: String(player.videoDetails?.title || videoId).slice(0, 240),
      author: String(player.videoDetails?.author || '').slice(0, 120) }, '*')
  } catch (error) {
    // Los mensajes se limitan a textos propios, sin respuestas o direcciones firmadas.
    const known = [
      'YouTube no responde ahora. Vuelve a intentarlo en un momento.',
      'No se pudo preparar el audio. Vuelve a intentarlo.',
      'Este vídeo no está disponible para reproducirlo aquí.',
      'Este vídeo no ofrece audio compatible.',
    ]
    const message = error.name === 'AbortError' ? 'La conexión tardó demasiado. Vuelve a intentarlo.'
      : known.includes(error.message) ? error.message : 'No se pudo conectar con YouTube. Vuelve a intentarlo.'
    parent.postMessage({ type: 'pletina-player-audio', requestId, error: message }, '*')
  }
}

export function resolveAudio(videoId, { signal } = {}) {
  if (!VIDEO_ID.test(videoId)) return Promise.reject(new Error('El ID del vídeo no es válido.'))
  if (signal?.aborted) return Promise.reject(new DOMException('Cancelado.', 'AbortError'))
  return new Promise((resolve, reject) => {
    const requestId = ++sequence
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.setAttribute('aria-hidden', 'true')
    frame.sandbox = 'allow-scripts'
    let finished = false
    const finish = (error, value) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      signal?.removeEventListener('abort', abort)
      frame.remove()
      error ? reject(error) : resolve(value)
    }
    const abort = () => finish(new DOMException('Cancelado.', 'AbortError'))
    const receive = (event) => {
      if (event.source !== frame.contentWindow || event.data?.type !== 'pletina-player-audio' || event.data.requestId !== requestId) return
      if (event.data.error) { finish(new Error(String(event.data.error).slice(0, 200))); return }
      try {
        finish(null, {
          url: validAudioUrl(event.data.url),
          title: String(event.data.title || videoId).slice(0, 240),
          author: String(event.data.author || '').slice(0, 120),
        })
      } catch { finish(new Error('No se ha recibido una dirección de audio válida.')) }
    }
    const timer = setTimeout(() => finish(new Error('La conexión tardó demasiado. Vuelve a intentarlo.')), 35000)
    window.addEventListener('message', receive)
    signal?.addEventListener('abort', abort, { once: true })
    frame.srcdoc = '<script>(' + bridge.toString() + ')(' + JSON.stringify({ requestId, videoId }) + ')<' + '/script>'
    ;(document.body || document.documentElement).append(frame)
  })
}
