import type {
  Album, AlbumDetail, AlbumRef, Artist, ArtistPage, ArtistRef, Discovery,
  ImportTrack, LibTrack, SearchResults, TopTrack, Track,
} from '../src/lib/types'

type Raw = Record<string, unknown>
export interface CatalogOptions { signal?: AbortSignal }
export interface WebSearchResults extends SearchResults {
  tracks: TopTrack[]
  failedSections: ('artists' | 'albums' | 'tracks')[]
}

const API = 'https://api.deezer.com'
const CATALOG_LIMIT = 250_000_000_000_000
const MAX_PAGES = 10
let requestSequence = 0

function record(value: unknown): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Respuesta inesperada del catálogo.')
  return value as Raw
}
function text(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  return value.replaceAll('&quot;', '"').replaceAll('&#039;', "'").replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}
const optionalText = (value: unknown) => typeof value === 'string' ? text(value) : null
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value >= CATALOG_LIMIT) {
    throw new Error('El elemento no pertenece al catálogo musical.')
  }
  return value
}
function requiredText(value: unknown): string {
  const result = text(value).trim()
  if (!result || result.length > 10_000) throw new Error('Respuesta inesperada del catálogo.')
  return result
}
function artwork(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol === 'http:') url.protocol = 'https:'
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch { return null }
}

function requestURL(path: string): URL {
  const url = new URL(path, API)
  if (url.origin !== API || url.username || url.password || url.hash ||
    !/^\/(?:search(?:\/(?:artist|album|track))?|chart\/0\/(?:albums|artists)|artist\/\d+(?:\/(?:top|albums|related))?|album\/\d+(?:\/tracks)?|track\/(?:\d+|isrc:[A-Z0-9]{12}))$/.test(url.pathname)) {
    throw new Error('Ruta de catálogo no válida.')
  }
  for (const key of url.searchParams.keys()) {
    if (!['q', 'limit', 'index', 'output', 'callback'].includes(key)) throw new Error('Parámetro de catálogo no válido.')
  }
  for (const key of ['limit', 'index']) {
    const raw = url.searchParams.get(key)
    if (raw !== null && (!/^\d+$/.test(raw) || Number(raw) > (key === 'limit' ? 200 : 20_000))) {
      throw new Error('Paginación de catálogo no válida.')
    }
  }
  if ((url.searchParams.get('q') || '').length > 2000) throw new Error('La búsqueda es demasiado larga.')
  url.searchParams.set('output', 'jsonp')
  url.searchParams.set('callback', '__pletinaCatalog')
  return url
}

// JSONP executes only inside this opaque-origin frame, never in the app document.
// The app receives a bounded JSON string and validates it before mapping fields.
function jsonpBridge(config: { requestId: number; url: string }) {
  let sent = false
  const send = (value: { json?: string; error?: string }) => {
    if (sent) return
    sent = true
    parent.postMessage({ type: 'pletina-catalog', requestId: config.requestId, ...value }, '*')
  }
  ;(window as unknown as Record<string, unknown>).__pletinaCatalog = (value: unknown) => {
    try {
      const json = JSON.stringify(value)
      if (typeof json !== 'string' || json.length > 4 * 1024 * 1024) throw new Error('size')
      send({ json })
    } catch { send({ error: 'La respuesta del catálogo no es válida.' }) }
  }
  const script = document.createElement('script')
  script.src = config.url
  script.onerror = () => send({ error: 'No se pudo conectar con el catálogo.' })
  document.head.append(script)
}

export function requestCatalog(path: string, { signal }: CatalogOptions = {}, allowMissing = false): Promise<Raw | null> {
  if (signal?.aborted) return Promise.reject(new DOMException('Cancelado.', 'AbortError'))
  let url: URL
  try { url = requestURL(path) } catch (error) { return Promise.reject(error) }
  return new Promise((resolve, reject) => {
    const requestId = ++requestSequence
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.setAttribute('aria-hidden', 'true')
    frame.sandbox = 'allow-scripts'
    let finished = false
    const finish = (error?: unknown, value?: Raw | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      signal?.removeEventListener('abort', abort)
      frame.remove()
      error ? reject(error) : resolve(value ?? null)
    }
    const abort = () => finish(new DOMException('Cancelado.', 'AbortError'))
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== 'null' ||
        event.data?.type !== 'pletina-catalog' || event.data.requestId !== requestId) return
      if (event.data.error) { finish(new Error('No se pudo conectar con el catálogo.')); return }
      try {
        if (typeof event.data.json !== 'string' || event.data.json.length > 4 * 1024 * 1024) throw new Error('Respuesta de catálogo no válida.')
        const value = record(JSON.parse(event.data.json))
        if (value.error) {
          const error = record(value.error)
          if (allowMissing && error.code === 800) { finish(undefined, null); return }
          throw new Error('El catálogo no está disponible ahora. Vuelve a intentarlo más tarde.')
        }
        finish(undefined, value)
      } catch (error) { finish(error) }
    }
    const timer = setTimeout(() => finish(new Error('La conexión con el catálogo tardó demasiado.')), 20_000)
    window.addEventListener('message', receive)
    signal?.addEventListener('abort', abort, { once: true })
    const args = JSON.stringify({ requestId, url: url.href }).replaceAll('<', '\\u003c')
    frame.srcdoc = '<script>(' + jsonpBridge.toString() + ')(' + args + ')<' + '/script>'
    ;(document.body || document.documentElement).append(frame)
  })
}

function rows(value: Raw | null): unknown[] {
  if (!value || !Array.isArray(value.data)) throw new Error('El catálogo no devolvió una lista válida.')
  return value.data
}
async function allRows(path: string, options: CatalogOptions): Promise<unknown[]> {
  const result: unknown[] = []
  const visited = new Set<string>()
  let next: string | null = path
  for (let page = 0; page < MAX_PAGES && next; page += 1) {
    const canonical = requestURL(next).href
    if (visited.has(canonical)) break
    visited.add(canonical)
    const value: Raw | null = await requestCatalog(canonical, options)
    result.push(...rows(value))
    next = typeof value?.next === 'string' && value.next ? value.next : null
  }
  return result
}

export function mapArtistRef(value: unknown): ArtistRef {
  const row = record(value)
  return { id: id(row.id), name: requiredText(row.name), pictureMedium: artwork(row.picture_medium) }
}
export function mapArtist(value: unknown): Artist {
  const row = record(value)
  return { id: id(row.id), name: requiredText(row.name), pictureMedium: artwork(row.picture_medium),
    pictureXl: artwork(row.picture_xl), nbAlbum: count(row.nb_album), nbFan: count(row.nb_fan) }
}
export function mapAlbumRef(value: unknown): AlbumRef {
  const row = record(value)
  return { id: id(row.id), title: requiredText(row.title), coverMedium: artwork(row.cover_medium), coverBig: artwork(row.cover_big) }
}
export function mapAlbum(value: unknown): Album {
  const row = record(value)
  return { id: id(row.id), title: requiredText(row.title), coverMedium: artwork(row.cover_medium),
    coverXl: artwork(row.cover_xl), releaseDate: optionalText(row.release_date), recordType: optionalText(row.record_type),
    nbTracks: count(row.nb_tracks), explicitLyrics: row.explicit_lyrics === true, fans: count(row.fans),
    artist: row.artist ? mapArtistRef(row.artist) : null }
}
export function mapTrack(value: unknown): Track {
  const row = record(value)
  return { id: id(row.id), title: requiredText(row.title), titleVersion: optionalText(row.title_version),
    duration: count(row.duration), trackPosition: count(row.track_position), diskNumber: count(row.disk_number),
    explicitLyrics: row.explicit_lyrics === true, isrc: optionalText(row.isrc), artist: mapArtistRef(row.artist) }
}
export function mapTopTrack(value: unknown): TopTrack {
  return { ...mapTrack(value), album: mapAlbumRef(record(value).album) }
}
function dedupeAlbums(albums: Album[]): Album[] {
  const best = new Map<string, Album>()
  for (const album of albums) {
    const key = album.title.trim().toLowerCase() + '\u0000' + (album.recordType || '')
    if (!best.has(key) || best.get(key)!.fans < album.fans) best.set(key, album)
  }
  return [...best.values()]
}

export async function search(query: string, options: CatalogOptions = {}): Promise<WebSearchResults> {
  if (typeof query !== 'string' || query.length > 2000) throw new Error('La búsqueda debe tener como máximo 2000 caracteres.')
  const q = encodeURIComponent(query.trim())
  if (!q) return { artists: [], albums: [], tracks: [], localArtists: [], localAlbums: [], failedSections: [] }
  const sections = await Promise.allSettled([
    requestCatalog(`/search/artist?q=${q}&limit=8`, options).then((value) => rows(value).map(mapArtist)),
    requestCatalog(`/search/album?q=${q}&limit=30`, options).then((value) => rows(value).map(mapAlbum)),
    requestCatalog(`/search/track?q=${q}&limit=25`, options).then((value) => rows(value).map(mapTopTrack)),
  ])
  if (options.signal?.aborted) throw new DOMException('Cancelado.', 'AbortError')
  // El catálogo puede interpretar «título de artista» como una frase literal sin resultados.
  // Solo una respuesta vacía válida permite reintentar las canciones; artistas y discos conservan
  // la consulta original y un fallo de conexión nunca se convierte en «sin resultados».
  if (sections[2].status === 'fulfilled' && sections[2].value.length === 0 && /(^|\s)(?:de|by)(?=\s|$)/i.test(query)) {
    const fallback = query.replace(/(^|\s)(?:de|by)(?=\s|$)/gi, '$1').replace(/\s+/g, ' ').trim()
    if (fallback) {
      try {
        const value = await requestCatalog(`/search/track?q=${encodeURIComponent(fallback)}&limit=25`, options)
        sections[2] = { status: 'fulfilled', value: rows(value).map(mapTopTrack) }
      } catch (reason) { sections[2] = { status: 'rejected', reason } }
    }
  }
  if (options.signal?.aborted) throw new DOMException('Cancelado.', 'AbortError')
  if (sections.every((section) => section.status === 'rejected')) throw new Error('No se pudo buscar en el catálogo. Comprueba la conexión.')
  return {
    artists: sections[0].status === 'fulfilled' ? sections[0].value : [],
    albums: sections[1].status === 'fulfilled' ? sections[1].value : [],
    tracks: sections[2].status === 'fulfilled' ? sections[2].value : [],
    localArtists: [], localAlbums: [],
    failedSections: (['artists', 'albums', 'tracks'] as const).filter((_, index) => sections[index].status === 'rejected'),
  }
}
export async function discovery(options: CatalogOptions = {}): Promise<Discovery> {
  const results = await Promise.allSettled([
    requestCatalog('/chart/0/albums?limit=20', options).then((value) => rows(value).map(mapAlbum)),
    requestCatalog('/chart/0/artists?limit=12', options).then((value) => rows(value).map(mapArtist)),
  ])
  if (options.signal?.aborted) throw new DOMException('Cancelado.', 'AbortError')
  if (results.every((result) => result.status === 'rejected')) throw new Error('No se pudo cargar el catálogo. Comprueba la conexión.')
  return { albums: results[0].status === 'fulfilled' ? results[0].value : [],
    artists: results[1].status === 'fulfilled' ? results[1].value : [] }
}
export async function relatedArtists(artistId: number, options: CatalogOptions = {}): Promise<Artist[]> {
  return rows(await requestCatalog(`/artist/${id(artistId)}/related?limit=12`, options)).map(mapArtist)
}
export async function artistAlbums(artistId: number, options: CatalogOptions = {}): Promise<Album[]> {
  return dedupeAlbums(rows(await requestCatalog(`/artist/${id(artistId)}/albums?limit=20`, options)).map(mapAlbum))
    .sort((a, b) => b.fans - a.fans || (b.releaseDate || '').localeCompare(a.releaseDate || '') || a.id - b.id)
}
export async function artist(artistId: number, options: CatalogOptions = {}): Promise<ArtistPage> {
  const value = id(artistId)
  const [details, albums, top] = await Promise.all([
    requestCatalog(`/artist/${value}`, options),
    allRows(`/artist/${value}/albums?limit=100`, options),
    requestCatalog(`/artist/${value}/top?limit=10`, options).then(rows).then((items) => items.map(mapTopTrack)).catch((error) => {
      if (options.signal?.aborted) throw error
      return []
    }),
  ])
  return { artist: mapArtist(details), albums: dedupeAlbums(albums.map(mapAlbum))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '')), top }
}
export async function album(albumId: number, options: CatalogOptions = {}): Promise<AlbumDetail> {
  const value = id(albumId)
  const [details, trackRows] = await Promise.all([
    requestCatalog(`/album/${value}`, options), allRows(`/album/${value}/tracks?limit=200`, options),
  ])
  const raw = record(details)
  const genreRows = raw.genres ? record(raw.genres).data : []
  return { id: id(raw.id), title: requiredText(raw.title), coverBig: artwork(raw.cover_big), coverXl: artwork(raw.cover_xl),
    releaseDate: optionalText(raw.release_date), recordType: optionalText(raw.record_type), label: optionalText(raw.label),
    duration: count(raw.duration), nbTracks: count(raw.nb_tracks), explicitLyrics: raw.explicit_lyrics === true,
    genres: Array.isArray(genreRows) ? genreRows.map((genre) => text(record(genre).name)).filter(Boolean) : [],
    artist: mapArtistRef(raw.artist), tracks: trackRows.map(mapTrack).sort((a, b) => a.diskNumber - b.diskNumber || a.trackPosition - b.trackPosition) }
}

const normalize = (value: string) => value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  .replaceAll('&', ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const versionWords = /\b(live|remix|mix|edit|acoustic|instrumental|karaoke|cover|demo|version|session|sessions|sped|slowed)\b/
function ignorableSuffix(value: string): boolean {
  const normalized = normalize(value)
  return (/^(feat|ft|featuring)\b/.test(normalized) && !versionWords.test(normalized)) ||
    (/\b(remaster|remastered)\b/.test(normalized) && normalized.split(' ').every((word) => /^(remaster|remastered|version|\d+)$/.test(word)))
}
function normalizeTitle(value: string): string {
  if (ignorableSuffix(value)) return ''
  let title = value.replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (all, round, square) => ignorableSuffix(round ?? square) ? ' ' : ' ' + (round ?? square) + ' ')
  const dash = title.lastIndexOf(' - ')
  if (dash >= 0 && ignorableSuffix(title.slice(dash + 3))) title = title.slice(0, dash)
  const normalized = normalize(title)
  for (const marker of [' feat ', ' ft ', ' featuring ']) {
    const index = normalized.indexOf(marker)
    if (index >= 0 && !versionWords.test(normalized.slice(index + marker.length))) return normalized.slice(0, index)
  }
  return normalized
}
function importDistance(track: TopTrack, wanted: ImportTrack): number | null {
  if (!track.duration || normalize(track.artist.name) !== normalize(wanted.artists[0])) return null
  let title = normalizeTitle(track.title)
  const version = normalizeTitle(track.titleVersion || '')
  if (version && title !== version && !title.endsWith(' ' + version)) title += ' ' + version
  if (title !== normalizeTitle(wanted.title)) return null
  if (wanted.durationMs && wanted.durationMs > 0) {
    const distance = Math.abs(track.duration * 1000 - wanted.durationMs)
    return distance <= Math.max(2500, Math.min(6000, wanted.durationMs / 50)) ? distance : null
  }
  return 0
}
const libraryTrack = (track: TopTrack): LibTrack => ({
  id: track.id, title: track.title, duration: track.duration, explicit: track.explicitLyrics,
  artistId: track.artist.id, artistName: track.artist.name, albumId: track.album.id, albumTitle: track.album.title,
  albumArtistId: track.artist.id, cover: track.album.coverBig || track.album.coverMedium,
})
export async function matchImportTrack(wanted: ImportTrack, options: CatalogOptions = {}): Promise<LibTrack | null> {
  if (!wanted.title.trim() || wanted.title.length > 2000 || !wanted.artists.length || !wanted.artists[0].trim()) return null
  const code = (wanted.isrc || '').replace(/[-\s]/g, '').toUpperCase()
  if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(code)) {
    const value = await requestCatalog('/track/isrc:' + code, options, true)
    if (value) {
      const track = mapTopTrack(value)
      if ((track.isrc || '').replace(/[-\s]/g, '').toUpperCase() === code && importDistance(track, wanted) !== null) return libraryTrack(track)
    }
  }
  const query = encodeURIComponent(normalize(wanted.artists[0]) + ' ' + normalizeTitle(wanted.title))
  const candidates = rows(await requestCatalog('/search/track?q=' + query + '&limit=25', options)).map(mapTopTrack)
    .map((track) => ({ track, distance: importDistance(track, wanted) }))
    .filter((candidate): candidate is { track: TopTrack; distance: number } => candidate.distance !== null)
    .sort((a, b) => a.distance - b.distance || a.track.id - b.track.id)
  return candidates.length ? libraryTrack(candidates[0].track) : null
}
