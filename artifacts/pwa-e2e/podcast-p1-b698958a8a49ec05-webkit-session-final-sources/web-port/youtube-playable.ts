import type { Playable } from '../src/lib/types'
import { MAX_DOWNLOAD_BYTES } from './download-store'
import { validVideoId, type StreamInfo } from './youtube'

/** La música y los episodios conservan el mismo formato original elegido. */
export function youtubePlayable(info: StreamInfo, title = info.title, channel = info.channel): Playable {
  const permitted = validVideoId(info.videoId) && Number.isSafeInteger(info.contentLength) && info.contentLength! > 0 &&
    info.contentLength! <= MAX_DOWNLOAD_BYTES && typeof info.duration === 'number' && Number.isFinite(info.duration) &&
    info.duration > 0 && info.duration <= 86400
  return { videoId: info.videoId, url: info.url, title, channel, local: false,
    ...(info.transport === 'p1' ? { source: { provider: 'youtube-p1' as const, id: info.videoId, expiresAt: info.expiresAt,
      // Son metadatos declarados del formato, no un hash ni bytes observados.
      // La descarga comprueba su duración local y el final decodificable antes
      // de guardar la copia sin conexión.
      download: permitted ? { allowed: true, contentLength: info.contentLength, duration: info.duration! } : { allowed: false } } } : {}),
  }
}
