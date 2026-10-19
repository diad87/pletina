import type { ImportSource, ImportTrack } from '../src/lib/types'

const MAX_CSV_BYTES = 10 * 1024 * 1024
const MAX_TRACKS = 10_000
const MAX_PAGE_BYTES = 4 * 1024 * 1024
const encoder = new TextEncoder()
const bytes = (value: string) => encoder.encode(value).length
const trim = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
const invalidUrl = 'Pega el enlace completo de una playlist de Spotify (https://open.spotify.com/playlist/…)'
const unsupported = 'No se pudo leer la vista pública de Spotify. La playlist puede ser privada, no estar disponible o haber cambiado el formato de Spotify'

// Mirrors csv-core's default state machine: quote only at a field's start, doubled
// quote escaping, CR/LF/CRLF record ends, blank records ignored, permissive EOF.
function* records(content: string, delimiter: string): Generator<string[]> {
  let row: string[] = [], field = '', state: 'record' | 'start' | 'field' | 'quoted' | 'quote' = 'record'
  for (let i = 0; i < content.length; i++) {
    const character = content[i]!
    if (state === 'record') {
      if (character === '\r' || character === '\n') continue
      state = 'start'
    }
    if (state === 'quoted') {
      if (character === '"') state = 'quote'
      else field += character
      continue
    }
    if (state === 'quote' && character === '"') { field += '"'; state = 'quoted'; continue }
    if (state === 'start' && character === '"') { state = 'quoted'; continue }
    if (character === delimiter) { row.push(field); field = ''; state = 'start'; continue }
    if (character === '\r' || character === '\n') {
      row.push(field)
      yield row
      row = []; field = ''; state = 'record'
      if (character === '\r' && content[i + 1] === '\n') i++
      continue
    }
    field += character
    state = 'field'
  }
  if (state !== 'record') { row.push(field); yield row }
}

const header = (value: string) => [...value.replace(/^\uFEFF+/, '')]
  .filter((character) => /[\p{Alphabetic}\p{Number}]/u.test(character)).map((character) => character.toLowerCase()).join('')
const column = (headers: string[], names: string[]) => {
  for (const name of names) { const index = headers.indexOf(name); if (index !== -1) return index }
  return undefined
}

export function readPlaylistCsv(content: string, name: string): ImportSource {
  if (typeof content !== 'string' || typeof name !== 'string') throw new Error('Los datos del CSV no son válidos.')
  if (bytes(content) > MAX_CSV_BYTES) throw new Error('El CSV supera los 10 MB. Divide la lista en varios archivos.')
  content = content.replace(/^\uFEFF+/, '')
  let selected: { iterator: Generator<string[]>; headers: string[]; title: number; artist: number } | undefined
  for (const delimiter of [',', ';', '\t']) {
    const iterator = records(content, delimiter)
    const raw = iterator.next().value
    if (!raw) continue
    const headers = raw.map(header)
    const title = column(headers, ['trackname', 'songname', 'title', 'name', 'título', 'titulo', 'canción', 'cancion'])
    const artist = column(headers, ['artistnames', 'artistname', 'artists', 'artist', 'artistas', 'artista'])
    if (title !== undefined && artist !== undefined) { selected = { iterator, headers, title, artist }; break }
  }
  if (!selected) throw new Error('El CSV debe incluir las columnas «Track Name» y «Artist Name(s)» (también «Title» y «Artist»).')
  const { iterator, headers, title: titleColumn, artist: artistColumn } = selected
  const duration = column(headers, ['durationms', 'trackdurationms'])
  const isrcColumn = column(headers, ['isrc'])
  const uriColumn = column(headers, ['trackuri', 'spotifyuri', 'uri', 'trackurl'])
  const local = column(headers, ['islocal', 'local'])
  const tracks: ImportTrack[] = []
  let skipped = 0, missingDuration = 0, index = 0
  for (const row of iterator) {
    if (index >= MAX_TRACKS) throw new Error('El CSV supera las 10.000 filas. Divide la lista en varios archivos.')
    const line = index++ + 2
    if (row.length !== headers.length) throw new Error(`No se pudo leer la fila ${line} del CSV. Comprueba las comillas y el número de columnas.`)
    const value = (at: number | undefined) => at === undefined ? '' : trim(row[at] ?? '')
    const title = value(titleColumn), artist = value(artistColumn), uri = value(uriColumn)
    if (!title || !artist || uri.startsWith('spotify:episode:') || uri.includes('open.spotify.com/episode/')
      || uri.startsWith('spotify:local:') || value(local).toLowerCase() === 'true') {
      skipped++; continue
    }
    if (bytes(title) > 2000 || bytes(artist) > 10_000) throw new Error(`El título o los artistas de la fila ${line} son demasiado largos.`)
    const artists = artist.split(';').map(trim).filter(Boolean)
    if (!artists.length || artists.length > 100 || artists.some((name) => bytes(name) > 1000)) { skipped++; continue }
    const durationText = value(duration)
    const number = /^\+?[0-9]+$/.test(durationText) ? Number(durationText) : NaN
    const durationMs = Number.isInteger(number) && number > 0 && number <= 86_400_000 ? number : null
    if (durationText && durationMs === null) missingDuration++
    const isrc = value(isrcColumn)
    if (bytes(isrc) > 100) throw new Error(`El ISRC de la fila ${line} es demasiado largo. Corrígelo o vacía esa celda.`)
    tracks.push({ title, artists, durationMs, isrc: isrc || null })
  }
  if (!tracks.length) throw new Error('El CSV no contiene canciones con título y artista. Los episodios y archivos locales no se importan.')
  const warnings: string[] = []
  if (skipped) warnings.push(`Se han omitido ${skipped} filas sin título o artista, episodios o archivos locales.`)
  if (missingDuration) warnings.push(`${missingDuration} canciones tienen una duración no válida; se buscarán por título y artista.`)
  name = trim(name)
  if (name.endsWith('.csv') || name.endsWith('.CSV')) name = name.slice(0, -4)
  name = trim(name)
  return { name: name ? [...name].slice(0, 100).join('') : 'Importada de Spotify', tracks, skipped, warnings }
}

export function spotifyPlaylistId(input: string): string {
  if (typeof input !== 'string') throw new Error(invalidUrl)
  input = trim(input)
  if (bytes(input) > 4096) throw new Error(invalidUrl)
  const valid = (id: string) => /^[A-Za-z0-9]{22}$/.test(id)
  if (input.startsWith('spotify:playlist:')) {
    const id = input.slice('spotify:playlist:'.length)
    if (valid(id)) return id
    throw new Error(invalidUrl)
  }
  if (input.startsWith('spotify:user:')) {
    const parts = input.split(':')
    if (parts.length === 5 && parts[2] && parts[3] === 'playlist' && valid(parts[4]!)) return parts[4]!
    throw new Error(invalidUrl)
  }
  let url: URL
  try { url = new URL(input) } catch { throw new Error(invalidUrl) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error(invalidUrl)
  if (['spotify.link', 'spoti.fi'].includes(url.hostname)) {
    throw new Error('Abre el enlace corto en el navegador y copia la dirección completa de la playlist, que empieza por https://open.spotify.com/playlist/')
  }
  if (url.hostname !== 'open.spotify.com') throw new Error(invalidUrl)
  const parts = url.pathname.split('/').filter(Boolean)
  const id = parts.length === 2 && parts[0] === 'playlist' ? parts[1]
    : parts.length === 3 && parts[0] === 'embed' && parts[1] === 'playlist' ? parts[2]
      : parts.length === 3 && /^intl-[A-Za-z-]{2,16}$/.test(parts[0]!) && parts[1] === 'playlist' ? parts[2] : undefined
  if (!id || !valid(id)) throw new Error(invalidUrl)
  return id
}

function nextData(html: string): string | undefined {
  let position = 0
  for (;;) {
    const start = html.indexOf('<script', position)
    if (start === -1) return
    position = start + '<script'.length
    if (!/[\t\n\v\f\r >]/.test(html[position] ?? '')) continue
    const end = html.indexOf('>', position)
    if (end === -1) return
    const tag = html.slice(position, end)
    const close = html.indexOf('</script>', end + 1)
    if (close === -1) return
    const attributes = tag.matchAll(/([^\s=]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)
    for (const attribute of attributes) {
      if (attribute[1]!.toLowerCase() === 'id' && (attribute[2] ?? attribute[3] ?? attribute[4]) === '__NEXT_DATA__') return html.slice(end + 1, close)
    }
    position = close + '</script>'.length
  }
}
type Row = Record<string, unknown>
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}

export function parseSpotifyPlaylist(html: string, expectedId: string): ImportSource {
  let data: unknown
  try { data = JSON.parse(nextData(html) ?? '') } catch { throw new Error(unsupported) }
  const entity = object(object(object(object(object(data).props).pageProps).state).data).entity
  const playlist = object(entity)
  const rawName = 'name' in playlist ? playlist.name : playlist.title
  const name = typeof rawName === 'string' ? trim(rawName) : ''
  if (playlist.type !== 'playlist' || playlist.id !== expectedId || !name || !Array.isArray(playlist.trackList)) throw new Error(unsupported)
  const source: ImportSource = { name, tracks: [], skipped: 0, warnings: [
    'Se lee la vista pública de Spotify, que puede mostrar solo parte de la playlist. Revisa las canciones antes de importar; las playlists privadas no se pueden leer mediante su enlace',
  ] }
  if (playlist.trackList.length >= 100) source.warnings.push(`Spotify ha mostrado ${playlist.trackList.length} entradas. Esta vista suele limitarse a las primeras 100; la playlist puede tener más canciones que no aparecen aquí`)
  for (const value of playlist.trackList) {
    const row = object(value), uri = typeof row.uri === 'string' ? row.uri : ''
    const title = typeof row.title === 'string' ? trim(row.title) : ''
    const artists = (typeof row.subtitle === 'string' ? row.subtitle : '').split(',\u00a0').map(trim).filter(Boolean)
    if (!/^spotify:track:[A-Za-z0-9]{22}$/.test(uri) || !title || !artists.length || bytes(title) > 2000
      || artists.length > 100 || artists.some((artist) => bytes(artist) > 1000)
      || (typeof row.entityType === 'string' && row.entityType !== 'track')) { source.skipped++; continue }
    const durationMs = typeof row.duration === 'number' && Number.isSafeInteger(row.duration) && row.duration > 0 ? row.duration : null
    source.tracks.push({ title, artists, durationMs, isrc: null })
  }
  if (source.skipped) source.warnings.push(`Se han omitido ${source.skipped} entradas sin datos suficientes, archivos locales o episodios de podcast`)
  return source
}

export async function readSpotifyPlaylist(input: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<ImportSource> {
  const id = spotifyPlaylistId(input)
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    let response: Response
    try {
      response = await (options.fetch ?? fetch)(`https://open.spotify.com/embed/playlist/${id}`, {
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      })
    } catch {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Importación cancelada.', 'AbortError')
      throw new Error('No se pudo leer directamente esta playlist de Spotify desde el navegador. Spotify puede bloquear esta lectura; exporta la playlist como CSV e importa ese archivo.')
    }
    if (response.status === 404) throw new Error('No se encontró la playlist. Comprueba el enlace y que sea pública')
    if (response.status === 429) throw new Error('Spotify ha limitado las consultas. Espera un momento y vuelve a intentarlo')
    if (response.status !== 200 || response.redirected) throw new Error('Spotify no permite leer esta playlist. Comprueba que sea pública y vuelve a intentarlo')
    const length = Number(response.headers.get('content-length'))
    if (length > MAX_PAGE_BYTES) { void response.body?.cancel(); throw new Error('La respuesta de Spotify es demasiado grande') }
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Spotify devolvió una respuesta que no se pudo leer')
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_PAGE_BYTES) { await reader.cancel(); throw new Error('La respuesta de Spotify es demasiado grande') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const content = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length }
    let html: string
    try { html = new TextDecoder('utf-8', { fatal: true }).decode(content) }
    catch { throw new Error('Spotify devolvió una respuesta que no se pudo leer') }
    return parseSpotifyPlaylist(html, id)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
