import type { Playable, TrackQuery } from '../src/lib/types'
import { readPodcastEpisode } from './storage'
import { checkAbort, stream, validVideoId } from './youtube'

const EPISODE_BASE = 750_000_000_000_000
const LOCAL_BASE = 1_000_000_000_000_000

/** El enclosure publicado por el RSS, nunca código ni un archivo del equipo. */
export function podcastAudioUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('La dirección de audio de este episodio no es válida.')
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
    url.hash = ''
    return url.href
  } catch {
    throw new Error('Este episodio necesita una dirección de audio HTTPS para reproducirse en la web.')
  }
}

/** Misma identidad y fuente de episodio que la app: RSS directo o vídeo del programa. */
export async function resolvePodcastTrack(track: TrackQuery, refresh = false, signal?: AbortSignal): Promise<Playable> {
  checkAbort(signal)
  if (!Number.isSafeInteger(track.id) || track.id < EPISODE_BASE || track.id >= LOCAL_BASE) {
    throw new Error('El identificador no corresponde a un episodio de pódcast.')
  }
  const episode = await readPodcastEpisode(track.id)
  checkAbort(signal)
  if (!episode || episode.id !== track.id) throw new Error('Este episodio ya no está disponible. Vuelve a abrir su pódcast.')
  if (episode.audioUrl.startsWith('youtube:')) {
    const videoId = episode.audioUrl.slice('youtube:'.length)
    if (!validVideoId(videoId)) throw new Error('El vídeo de este episodio no es válido.')
    const audio = await stream(videoId, refresh, signal)
    checkAbort(signal)
    return { videoId, url: audio.url, title: track.title, channel: track.artist, local: false }
  }
  return { videoId: '', url: podcastAudioUrl(episode.audioUrl), title: track.title, channel: track.artist, local: false }
}
