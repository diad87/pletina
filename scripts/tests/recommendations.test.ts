import assert from 'node:assert/strict'
import test from 'node:test'
import { recommend } from '../../src/lib/recommendations.ts'
import type { RecommendationInput, RecommendationSource } from '../../src/lib/recommendations.ts'
import type { Album, Artist, Entry, SavedAlbum } from '../../src/lib/types.ts'

const artist = (id: number): Artist => ({
  id, name: `Artist ${id}`, pictureMedium: null, pictureXl: null, nbAlbum: 20, nbFan: 100,
})
const album = (id: number, artistId = 1): Album => ({
  id, title: `Album ${id}`, coverMedium: null, coverXl: null, releaseDate: null,
  recordType: 'album', nbTracks: 10, explicitLyrics: false, fans: 100, artist: artist(artistId),
})
const entry = (artistId: number, albumId: number, at = 100): Entry => ({
  entryId: albumId, at,
  track: {
    id: albumId * 10, albumId, artistId, albumArtistId: artistId, artistName: `Artist ${artistId}`,
    albumTitle: `Album ${albumId}`, title: 'Track', duration: 180, explicit: false, cover: null,
  },
})
const saved = (id: number, artistId: number): SavedAlbum => ({
  id, artistId, artistName: `Artist ${artistId}`, title: `Album ${id}`, cover: null,
  releaseDate: null, recordType: 'album',
})
const empty: RecommendationInput = { history: [], liked: [], saved: [] }
const source = (overrides: Partial<RecommendationSource> = {}): RecommendationSource => ({
  discovery: async () => ({ albums: [album(1000)], artists: [artist(100)] }),
  artistAlbums: async () => [],
  relatedArtists: async () => [],
  ...overrides,
})

test('cold start labels popular suggestions and excludes non-catalog IDs and duplicates', async () => {
  const result = await recommend(empty, source({
    discovery: async () => ({
      albums: [album(100), album(100), album(0), album(250_000_000_000_000), album(500_000_000_000_000), album(200)],
      artists: [artist(8), artist(8), artist(-1), artist(1.5), artist(250_000_000_000_000), artist(1_000_000_000_000_000)],
    }),
  }))
  assert.deepEqual(result.albums.map(({ album }) => album.id), [100, 200])
  assert.deepEqual(result.artists.map(({ artist }) => artist.id), [8])
  assert.ok([...result.albums, ...result.artists].every((item) => item.reason === 'Popular en Deezer'))
  assert.equal(result.personalized, false)
  assert.equal(result.failed, false)
})

test('chooses at most three musical seeds and excludes history, favourites and saved albums', async () => {
  const requested: number[] = []
  const result = await recommend({
    history: [entry(1, 10), entry(2, 20, 99), entry(3, 30, 98), entry(4, 40, 97), entry(999, 500_000_000_000_000)],
    liked: [entry(2, 21), entry(2, 22)],
    saved: [saved(31, 3), saved(1_000_000_000_000_000, 888)],
  }, source({
    artistAlbums: async (id) => {
      requested.push(id)
      return [album(10), album(20), album(21), album(22), album(30), album(31), album(40), album(200 + id, id)]
    },
    relatedArtists: async () => [artist(1), artist(2), artist(3), artist(4)],
  }))
  assert.deepEqual(requested, [2, 3, 1])
  assert.deepEqual(result.albums.map(({ album }) => album.id), [202, 203, 201])
  assert.deepEqual(result.artists, [])
  assert.equal(result.personalized, true)
})

test('interleaves seeds, discovers albums from two new artists and caps deduplicated results', async () => {
  const requested: number[] = []
  const result = await recommend({ ...empty, liked: [entry(1, 10), entry(2, 20), entry(3, 30)] }, source({
    artistAlbums: async (id) => {
      requested.push(id)
      return Array.from({ length: 20 }, (_, index) => ({ ...album(id * 100 + index, id), artist: null }))
    },
    relatedArtists: async (id) => [artist(1), artist(9), ...Array.from({ length: 10 }, (_, index) => artist(id * 10 + index + 10))],
  }))
  assert.equal(result.albums.length, 12)
  assert.equal(result.artists.length, 12)
  assert.equal(new Set(result.artists.map(({ artist }) => artist.id)).size, 12)
  assert.deepEqual(requested, [1, 2, 3, 9, 30])
  assert.deepEqual(result.albums.slice(0, 5).map(({ album }) => album.id), [100, 200, 300, 900, 3000])
  assert.deepEqual(result.albums[3].album.artist, { id: 9, name: 'Artist 9' })
  assert.equal(result.albums[3].reason, 'Similar a Artist 1')
})

test('does not duplicate the same album returned by different seeds', async () => {
  const result = await recommend({ ...empty, liked: [entry(1, 10), entry(2, 20)] }, source({
    artistAlbums: async (id) => [album(500), album(500 + id, id)],
  }))
  assert.deepEqual(result.albums.map(({ album }) => album.id), [500, 502, 501])
})

test('keeps usable personal recommendations when independent requests fail', async () => {
  const result = await recommend({ ...empty, history: [entry(1, 10)] }, source({
    discovery: async () => { throw new Error('Must not fall back') },
    artistAlbums: async () => { throw new Error('Unavailable albums') },
    relatedArtists: async () => [artist(2)],
  }))
  assert.equal(result.personalized, true)
  assert.equal(result.failed, false)
  assert.deepEqual(result.albums, [])
  assert.deepEqual(result.artists.map(({ artist }) => artist.id), [2])
})

test('falls back clearly to popular suggestions when the personalized catalog is exhausted', async () => {
  const result = await recommend({ ...empty, history: [entry(1, 10)] }, source({
    artistAlbums: async () => [album(10)],
    relatedArtists: async () => [artist(1)],
  }))
  assert.equal(result.personalized, false)
  assert.equal(result.failed, false)
  assert.equal(result.albums[0].reason, 'Popular en Deezer')
})

test('reports total failure and permits a subsequent successful retry', async () => {
  const unavailable = async () => { throw new Error('Offline') }
  const input = { ...empty, history: [entry(1, 10)] }
  assert.deepEqual(await recommend(input, source({
    discovery: unavailable, artistAlbums: unavailable, relatedArtists: unavailable,
  })), { albums: [], artists: [], personalized: false, failed: true })
  assert.equal((await recommend(input, source())).failed, false)
})

test('YouTube, podcasts and local music alone use discovery without artist lookups', async () => {
  const unexpected = async () => { assert.fail('Non-catalog artist lookup') }
  const result = await recommend({
    history: [entry(1, 250_000_000_000_000), entry(1, 500_000_000_000_000), entry(1, 1_000_000_000_000_000)],
    liked: [entry(250_000_000_000_000, 10), entry(1_000_000_000_000_000, 10)],
    saved: [saved(250_000_000_000_000, 1), saved(1_000_000_000_000_000, 1)],
  }, source({ artistAlbums: unexpected, relatedArtists: unexpected }))
  assert.equal(result.personalized, false)
  assert.equal(result.albums.length, 1)
})
