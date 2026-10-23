export function parsePlayer(response: unknown, videoId: string, now = Date.now(), allowOpus = false): StreamInfo {
  const status = string(at(response, 'playabilityStatus', 'status'))
  if (status !== 'OK') {
    throw status === 'ERROR' || status === 'UNPLAYABLE'
      ? new YouTubeError('YouTube no permite reproducir esta fuente de audio en Pletina.', 'unavailable')
      : new YouTubeError('YouTube no permite reproducir este vídeo ahora.', 'restricted')
  }
  const details = object(object(response).videoDetails)
  if (!validVideoId(videoId) || details.videoId !== videoId) throw new YouTubeError('YouTube no confirmó el vídeo solicitado o devolvió otro vídeo distinto.', 'response')
  const available = list(at(response, 'streamingData', 'adaptiveFormats')).map(object)
  // If any audio carries language/track metadata, default alone cannot establish
  // originality for the other encodings. Wholly untagged responses stay valid.
  const requireExplicit = explicitOriginalRequired(available)
  const formats = available
    .filter(format => (string(format.mimeType).startsWith('audio/mp4') || allowOpus === true && /^audio\/webm\s*;\s*codecs\s*=\s*"opus"\s*$/i.test(string(format.mimeType))) &&
      typeof format.url === 'string' && originalAudio(format, !requireExplicit) &&
      (!Object.hasOwn(format, 'drmFamilies') || Array.isArray(format.drmFamilies) && format.drmFamilies.length === 0) &&
      !Object.hasOwn(format, 'licenseInfos') && !Object.hasOwn(format, 'drmTrackType'))
    .sort((a, b) => Number(!string(a.mimeType).startsWith('audio/mp4')) - Number(!string(b.mimeType).startsWith('audio/mp4')) ||
      (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))
  let url: string | undefined
  let selected: Row | undefined
  let expiresAt = 0, expired = false
  for (const format of formats) {
    let candidate: string
    try { candidate = audioUrl(format.url) } catch { continue /* No aceptar otro origen como alternativa. */ }
    const expiration = Number(new URL(candidate).searchParams.get('expire')) * 1000
    if (expiration > 0 && expiration <= now + 60_000) { expired = true; continue }
    url = candidate
    selected = format
    expiresAt = Math.min(now + 20 * 60_000, Number.isFinite(expiration) && expiration > 0 ? expiration - 60_000 : now + 5 * 60_000)
    break
  }
  if (!url) {
    if (expired) throw new YouTubeError('La dirección de audio ha caducado. Vuelve a intentarlo.', 'response')
    throw new YouTubeError(allowOpus ? 'Este vídeo no ofrece audio compatible.' : 'Este vídeo no ofrece audio MP4 compatible.', 'format')
  }
  const seconds = Number(details.lengthSeconds)
  const size = (value: unknown): number | undefined => {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d{1,10}$/.test(value))) return
    const number = Number(value)
    return Number.isSafeInteger(number) && number > 0 && number <= 2 * 1024 ** 3 ? number : undefined
  }
  const declared = size(selected?.contentLength), query = size(new URL(url).searchParams.get('clen'))
  const contentLength = declared && query && declared !== query ? undefined : declared ?? query
  return { videoId, url, title: string(details.title, 300) || videoId,
    channel: string(details.author, 200) || 'YouTube', duration: Number.isFinite(seconds) && seconds > 0 && seconds <= 604800 ? Math.round(seconds) : null, expiresAt,
    ...(contentLength ? { contentLength } : {}) }
}

