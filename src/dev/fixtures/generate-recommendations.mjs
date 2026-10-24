// Actualiza el snapshot de Inicio desde Deezer: node src/dev/fixtures/generate-recommendations.mjs
// Solo desarrollo. Discos completos y relaciones reales, sin audios ni credenciales.
import { readFile, writeFile } from 'node:fs/promises'

const api = 'https://api.deezer.com'
const seeds = [399, 554792, 1, 14295]
const known = new Set()
for (let i = 1; i <= 4; i++) {
  known.add(JSON.parse(await readFile(new URL(`album-${i}.json`, import.meta.url), 'utf8')).id)
}
const snapshot = { discovery: { albums: [], artists: [] }, related: {}, artists: {}, artistAlbums: {}, albums: {} }
const text = (value = '') => value.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
async function get(path) {
  // Por debajo de la cuota pública, incluso al regenerar todas las carátulas y pistas.
  await new Promise((resolve) => setTimeout(resolve, 150))
  const response = await fetch(path.startsWith('https:') ? path : `${api}${path}`)
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  const value = await response.json()
  if (value.error) throw new Error(`${path}: ${value.error.message}`)
  return value
}
const artistRef = (raw) => ({ id: raw.id, name: text(raw.name), pictureMedium: raw.picture_medium ?? null })
const artist = (raw) => ({ ...artistRef(raw), pictureXl: raw.picture_xl ?? null, nbAlbum: raw.nb_album ?? 0, nbFan: raw.nb_fan ?? 0 })
const track = (raw) => ({
  id: raw.id, title: text(raw.title), titleVersion: raw.title_version == null ? null : text(raw.title_version),
  duration: raw.duration, trackPosition: raw.track_position ?? 0, diskNumber: raw.disk_number ?? 0,
  explicitLyrics: raw.explicit_lyrics ?? false, isrc: raw.isrc ?? null, artist: artistRef(raw.artist),
})
async function saveAlbum(id) {
  if (snapshot.albums[id]) return
  const raw = await get(`/album/${id}`)
  const tracks = [...raw.tracks.data]
  let next = raw.tracks.next
  while (next) {
    const page = await get(next)
    tracks.push(...page.data)
    next = page.next
  }
  snapshot.albums[id] = {
    id: raw.id, title: text(raw.title), coverBig: raw.cover_big ?? null, coverXl: raw.cover_xl ?? null,
    releaseDate: raw.release_date ?? null, recordType: raw.record_type ?? null, label: raw.label == null ? null : text(raw.label),
    duration: raw.duration ?? 0, nbTracks: raw.nb_tracks ?? tracks.length, explicitLyrics: raw.explicit_lyrics ?? false,
    genres: (raw.genres?.data ?? []).map((genre) => text(genre.name)), artist: artistRef(raw.artist),
    tracks: tracks.map(track), fans: raw.fans ?? 0,
  }
}
for (const seed of seeds) {
  const related = (await get(`/artist/${seed}/related?limit=2`)).data
  snapshot.related[seed] = related.map((value) => value.id)
  for (const value of related) snapshot.artists[value.id] = artist(value)
}
const chartAlbums = (await get('/chart/0/albums?limit=6')).data
const chartArtists = (await get('/chart/0/artists?limit=6')).data
snapshot.discovery.albums = chartAlbums.map((value) => value.id)
snapshot.discovery.artists = chartArtists.map((value) => value.id)
for (const value of chartAlbums) snapshot.artists[value.artist.id] = artist(value.artist)
for (const value of chartArtists) snapshot.artists[value.id] = artist(value)
for (const id of new Set([...seeds, ...Object.keys(snapshot.artists).map(Number)])) {
  snapshot.artists[id] = artist(await get(`/artist/${id}`))
  const candidates = (await get(`/artist/${id}/albums?limit=20`)).data
    .filter((album) => !known.has(album.id) && album.record_type === 'album')
    .sort((a, b) => (b.fans ?? 0) - (a.fans ?? 0))
  const selected = []
  const titles = new Set()
  for (const album of candidates) {
    const title = album.title.trim().toLowerCase()
    if (titles.has(title)) continue
    titles.add(title)
    selected.push(album.id)
    if (selected.length >= (seeds.includes(id) ? 2 : 1)) break
  }
  snapshot.artistAlbums[id] = selected
  for (const albumId of selected) await saveAlbum(albumId)
}
for (const id of snapshot.discovery.albums) await saveAlbum(id)
await writeFile(new URL('recommendations.json', import.meta.url), `${JSON.stringify(snapshot)}\n`)
console.log(`Snapshot: ${Object.keys(snapshot.artists).length} artistas, ${Object.keys(snapshot.albums).length} discos completos.`)
