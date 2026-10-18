// Experimento: HTTP directo desde un frame de origen opaco. Sin proxy ni código remoto ejecutado.
window.ScreenOffResolver = (() => {
  let sequence = 0
  function parseVideoId(value) {
    const text = value.trim()
    if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text
    let url
    try { url = new URL(text) } catch { throw new Error('Introduce un enlace de YouTube o un ID válido.') }
    const host = url.hostname.toLowerCase()
    let id
    if (['http:', 'https:'].includes(url.protocol)) {
      if (host === 'youtu.be' || host === 'www.youtu.be') id = url.pathname.split('/')[1]
      else if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
        id = url.searchParams.get('v')
        if (!id && /^\/(embed|shorts|live)\//.test(url.pathname)) id = url.pathname.split('/')[2]
      }
    }
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('No se reconoce un vídeo válido en ese enlace.')
    return id
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
          if (!response.ok) throw new Error('YouTube respondió HTTP ' + response.status + '.')
          return await response.json()
        } finally { clearTimeout(timer) }
      }
      const search = await post('search', {
        context: { client: { clientName: 'WEB', clientVersion: '2.20261007.00.00' } }, query: videoId,
      })
      const visitor = search.responseContext?.visitorData
      if (!visitor) throw new Error('No se pudo preparar la sesión anónima.')
      const player = await post('player', {
        context: { client: {
          clientName: 'VISIONOS', clientVersion: '1.02', visitorData: visitor,
          deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS',
          osVersion: '26.5.23O471', platform: 'MOBILE',
        } }, videoId, contentCheckOk: true, racyCheckOk: true,
      })
      if (player.playabilityStatus?.status !== 'OK') throw new Error('YouTube no permite reproducir el vídeo ahora.')
      const format = player.streamingData?.adaptiveFormats
        ?.filter((item) => item.mimeType?.startsWith('audio/mp4') && typeof item.url === 'string')
        .sort((a, b) => b.bitrate - a.bitrate)[0]
      if (!format) throw new Error('No hay audio MP4 directo compatible.')
      parent.postMessage({ type: 'pletina-screen-off-audio', requestId, url: format.url,
        itag: format.itag, mime: format.mimeType }, '*')
    } catch (error) {
      // Solo mensajes propios: nunca enviar las respuestas completas, cookies o tokens.
      parent.postMessage({ type: 'pletina-screen-off-audio', requestId,
        error: error.name === 'AbortError' ? 'La conexión agotó el tiempo de espera.' : error.message }, '*')
    }
  }

  function resolveAudio(videoId) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return Promise.reject(new Error('ID no válido.'))
    return new Promise((resolve, reject) => {
      const requestId = ++sequence
      const frame = document.createElement('iframe')
      frame.hidden = true
      frame.sandbox = 'allow-scripts'
      const finish = (error, value) => {
        clearTimeout(timer)
        window.removeEventListener('message', receive)
        frame.remove()
        error ? reject(error) : resolve(value)
      }
      const receive = (event) => {
        if (event.source !== frame.contentWindow || event.data?.type !== 'pletina-screen-off-audio' || event.data.requestId !== requestId) return
        if (event.data.error) { finish(new Error(String(event.data.error))); return }
        try {
          const url = new URL(event.data.url)
          if (url.protocol !== 'https:' || !(url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'))) throw new Error('Dirección de audio no válida.')
          finish(null, { url: url.href, itag: Number(event.data.itag), mime: String(event.data.mime) })
        } catch { finish(new Error('Dirección de audio no válida.')) }
      }
      const timer = setTimeout(() => finish(new Error('La resolución del audio agotó el tiempo de espera.')), 35000)
      window.addEventListener('message', receive)
      frame.srcdoc = '<script>(' + bridge.toString() + ')(' + JSON.stringify({ requestId, videoId }) + ')<' + '/script>'
      document.body.append(frame)
    })
  }
  return { parseVideoId, resolveAudio }
})()
