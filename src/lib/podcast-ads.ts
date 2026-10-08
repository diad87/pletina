import type { PodcastDetail } from './types'

/**
 * Plataformas de alojamiento que pueden meter anuncios en el audio al servirlo (inserción
 * dinámica): el anuncio va dentro del archivo y Pletina no puede quitarlo. Se reconocen por la
 * dirección del audio de los episodios, también cuando pasa antes por un medidor de audiencia
 * (podtrac, chartable…), que la lleva dentro. Es una pista, no una garantía: no todos los programas
 * de estas plataformas llevan anuncios, ni los de las demás quedan libres de los que lea el
 * presentador.
 */
const AD_PLATFORMS: [string, string[]][] = [
  ['Megaphone', ['megaphone.fm']],
  ['Acast', ['acast.com']],
  ['Omny Studio', ['omny.fm', 'omnycontent.com']],
  ['ART19', ['art19.com']],
  ['AdsWizz', ['adswizz.com']],
  ['Audioboom', ['audioboom.com']],
  ['Spreaker', ['spreaker.com']],
  ['Simplecast', ['simplecast.com']],
  ['Libsyn', ['libsyn.com']],
  ['Spotify for Creators', ['anchor.fm', 'podcasters.spotify.com']],
  ['iVoox', ['ivoox.com']],
  ['Podigee', ['podigee.io']],
  ['Ausha', ['ausha.co']],
  ['iHeart', ['iheart.com']],
]

const MATCHERS = AD_PLATFORMS.map(([name, domains]) => ({
  name,
  // El dominio entero o un subdominio suyo, seguido del final o del resto de la dirección.
  pattern: new RegExp(`(?:^|[/.])(?:${domains.map((d) => d.replaceAll('.', '\\.')).join('|')})(?=[/:?#]|$)`),
}))

/** La plataforma que puede meter anuncios en este programa, o null. Los de YouTube no: sus anuncios no suenan. */
export function adPlatform({ podcast, episodes }: PodcastDetail): string | null {
  if (podcast.feedUrl.startsWith('youtube:')) return null
  for (const url of [podcast.feedUrl, ...episodes.map((episode) => episode.audioUrl)]) {
    if (url.startsWith('youtube:')) continue
    const lower = url.toLowerCase().replace(/^https?:\/\//, '')
    const match = MATCHERS.find(({ pattern }) => pattern.test(lower))
    if (match) return match.name
  }
  return null
}
