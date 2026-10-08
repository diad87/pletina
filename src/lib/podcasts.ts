import { SvelteSet } from 'svelte/reactivity'
import type { QueueItem } from './queue'
import type { PodcastDetail } from './types'

export { isPodcast } from './media'

export const PODCAST_LANGUAGES = [
  { code: 'all', label: 'Todos los idiomas' },
  { code: 'es', label: 'Español' },
  { code: 'en', label: 'Inglés' },
  { code: 'ca', label: 'Catalán' },
  { code: 'eu', label: 'Euskera' },
  { code: 'gl', label: 'Gallego' },
  { code: 'fr', label: 'Francés' },
  { code: 'pt', label: 'Portugués' },
  { code: 'de', label: 'Alemán' },
  { code: 'it', label: 'Italiano' },
] as const

export function podcastLanguage(code: string | null): string {
  if (!code) return 'Idioma sin indicar'
  const primary = code.trim().toLowerCase().split(/[-_]/)[0]
  return PODCAST_LANGUAGES.find((language) => language.code === primary)?.label ?? code
}

/**
 * Episodios de YouTube Music (son vídeos): se pueden descargar como las canciones. Se apuntan al
 * abrir su programa (ver PodcastView); los del RSS no se descargan.
 */
export const youtubeEpisodes = new SvelteSet<number>()

export function noteYoutubeEpisodes({ episodes }: PodcastDetail) {
  for (const episode of episodes) if (episode.audioUrl.startsWith('youtube:')) youtubeEpisodes.add(episode.id)
}

/** Los episodios comparten cola, favoritos e historial con la música. */
export function episodeQueue({ podcast, episodes }: PodcastDetail): QueueItem[] {
  return episodes.map((episode, index) => ({
    track: {
      id: episode.id,
      title: episode.title,
      titleVersion: null,
      duration: episode.duration,
      trackPosition: index + 1,
      diskNumber: 1,
      explicitLyrics: episode.explicit,
      isrc: null,
      artist: { id: podcast.id, name: podcast.author || podcast.title },
    },
    albumId: podcast.id,
    albumTitle: podcast.title,
    artistId: podcast.id,
    cover: episode.image ?? podcast.image,
  }))
}
