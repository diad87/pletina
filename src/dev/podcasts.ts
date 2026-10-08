// Programas ficticios para revisar búsqueda, idiomas y episodios sin red ni Tauri.
import type { Podcast, PodcastDetail } from '../lib/types'

const artwork = (title: string, color: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><rect width="600" height="600" fill="${color}"/><circle cx="490" cy="100" r="210" fill="#ffffff" opacity=".08"/><circle cx="80" cy="550" r="220" fill="#000000" opacity=".16"/><text x="48" y="80" fill="#ffffff" opacity=".7" font-family="sans-serif" font-size="20" letter-spacing="5">PLETINA · PODCAST</text><foreignObject x="48" y="220" width="504" height="300"><div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Arial,sans-serif;font-size:68px;line-height:1.05;font-weight:800;letter-spacing:-3px;color:white">${title}</div></foreignObject></svg>`)}`

const programs = [
  ['Charlas sin prisa', 'Mesa abierta', 'es-ES', '#664764'],
  ['Un poco de ciencia', 'Laboratorio sonoro', 'es', '#32565d'],
  ['Historias de ida y vuelta', 'Voces del camino', 'es-MX', '#876249'],
  ['La otra cara de la música', 'Estudio 12', 'es', '#534e80'],
  ['Curious minds', 'Open studio', 'en-US', '#506b55'],
  ['A poc a poc', 'Veus obertes', 'ca', '#946e35'],
  ['Entre deux idées', 'Studio libre', 'fr', '#405e83'],
  ['Voces por descubrir', 'Archivo sonoro', null, '#765057'],
] as const

export const podcastFixtures: Podcast[] = [...programs.map(([title, author, language, color], index) => ({
  id: 500_000_000_000_001 + index,
  title,
  author,
  language,
  description: 'Historias, ideas y conversaciones para escuchar a tu ritmo. Un nuevo episodio cada semana.',
  image: artwork(title, color),
  feedUrl: `https://example.com/podcasts/${index + 1}.xml`,
  episodeCount: 3,
})), {
  id: 500_000_000_000_009,
  title: 'Un programa por estrenar',
  author: 'Próximamente',
  language: 'es',
  description: 'El primer episodio llegará pronto. Puedes guardar el programa desde ahora.',
  image: artwork('Un programa por estrenar', '#385565'),
  feedUrl: 'https://example.com/podcasts/9.xml',
  episodeCount: 0,
}, {
  id: 500_000_000_000_010,
  title: 'Charlas en vídeo',
  author: 'Estudio abierto',
  language: null,
  description: 'Conversaciones que también puedes escuchar desde YouTube.',
  image: artwork('Charlas en vídeo', '#814b45'),
  feedUrl: 'youtube:MPSPPLpodcastPreview',
  episodeCount: 3,
}]

export function podcastFixture(feedUrl: string): PodcastDetail {
  const podcast = podcastFixtures.find((item) => item.feedUrl === feedUrl)
  if (!podcast) throw new Error('No se encuentra este podcast de ejemplo')
  const index = podcastFixtures.indexOf(podcast)
  return {
    podcast,
    episodes: ['El valor de escuchar', 'Una pregunta puede cambiarlo todo', 'Volver a empezar'].slice(0, podcast.episodeCount).map((title, episode) => ({
      id: 750_000_000_000_001 + index * 10 + episode,
      title,
      description: episode === 0
        ? 'Hablamos de esas conversaciones que nos hacen mirar el mundo de otra forma. Una pausa para escuchar, compartir experiencias y descubrir algo nuevo.'
        : 'Nos sentamos a conversar sobre las pequeñas ideas que cambian nuestra manera de entender el día a día.',
      publishedAt: `2026-10-0${7 - episode * 2}T08:00:00Z`,
      duration: 2460 - episode * 270,
      // El primero, alojado en una plataforma con anuncios (detrás de un medidor), para ver el aviso.
      audioUrl: podcast.feedUrl.startsWith('youtube:')
        ? `youtube:preview000${episode + 1}`
        : index === 0
        ? `https://dts.podtrac.com/redirect.mp3/traffic.megaphone.fm/EJEMPLO${episode}.mp3`
        : `https://example.com/audio/${index}-${episode}.mp3`,
      image: null,
      explicit: false,
    })),
  }
}
