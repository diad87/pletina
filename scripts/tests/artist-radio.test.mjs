import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

// Compila el generador real; no necesita window, Tauri ni un servicio externo.
const source = await readFile(new URL('../../src/lib/artist-radio.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const exports = {}
new Function('exports', compiled)(exports)
const { createArtistRadio, isRadioArtist, sameRadioPlayback, RADIO_LIMIT } = exports

const artist = (id) => ({ id, name: `Artista ${id}`, pictureMedium: null, pictureXl: null, nbAlbum: 4, nbFan: 100 })
const track = (id, artistId, extra = {}) => ({
  id, title: `Canción ${id}`, titleVersion: null, duration: 180, trackPosition: 1, diskNumber: 1,
  explicitLyrics: false, isrc: `ISRC${id}`, artist: artist(artistId),
  album: { id: id + 10000, title: `Disco ${artistId}`, coverBig: null, coverMedium: `cover-${id}` },
  ...extra,
})
const page = (id, count = 10) => ({ artist: artist(id), albums: [], top: Array.from({ length: count }, (_, i) => track(id * 100 + i, id)) })
const sources = (overrides = {}) => ({
  relatedArtists: async () => Array.from({ length: 6 }, (_, i) => artist(i + 2)),
  artist: async (id) => page(id),
  ...overrides,
})
const fixed = () => 0.99

test('builds 45 real queue entries, starts with seed, alternates artists, and leaves source data unchanged', async () => {
  const seed = page(1)
  const before = structuredClone(seed)
  const result = await createArtistRadio(seed, sources(), fixed)
  assert.equal(result.items.length, RADIO_LIMIT)
  assert.equal(result.items[0].track.artist.id, 1)
  assert.equal(result.artistCount, 7)
  assert.equal(result.failedSources, 0)
  assert.equal(new Set(result.items.map((item) => item.track.id)).size, RADIO_LIMIT)
  assert.ok(result.items.every((item, i) => i === 0 || item.track.artist.id !== result.items[i - 1].track.artist.id))
  for (const item of result.items) {
    assert.equal(item.albumId, item.track.album.id)
    assert.equal(item.albumTitle, item.track.album.title)
    assert.equal(item.artistId, item.track.artist.id)
    assert.equal(item.cover, item.track.album.coverMedium)
  }
  assert.deepEqual(seed, before)
})

test('deduplicates track IDs and ISRC across albums and handles duplicate related artists', async () => {
  const calls = []
  const seed = page(1, 1)
  const result = await createArtistRadio(seed, sources({
    relatedArtists: async () => [artist(1), artist(2), artist(2), artist(3)],
    artist: async (id) => {
      calls.push(id)
      return { top: [track(100, id), track(id * 100, id, { isrc: ' isrc100 ' }), track(id * 100 + 1, id)] }
    },
  }), fixed)
  assert.deepEqual(calls, [2, 3])
  assert.deepEqual(result.items.map((item) => item.track.id), [100, 201, 301])
})

test('rejects local, podcast, YouTube and malformed seeds without calling catalogue sources', async () => {
  const forbidden = [0, -1, 1.2, NaN, Infinity, 250_000_000_000_000, 500_000_000_000_001, 1_000_000_000_000_001]
  let calls = 0
  for (const id of forbidden) {
    assert.equal(isRadioArtist(id), false)
    const result = await createArtistRadio(page(id), sources({ relatedArtists: async () => { calls++; return [] } }))
    assert.deepEqual(result, { items: [], artistCount: 0, failedSources: 0 })
  }
  assert.equal(calls, 0)
  assert.equal(isRadioArtist(249_999_999_999_999), true)
})

test('filters non-catalog related artists and tracks before building the radio', async () => {
  const calls = []
  const result = await createArtistRadio(page(1, 1), sources({
    relatedArtists: async () => [artist(0), artist(250_000_000_000_000), artist(500_000_000_000_000), artist(1_000_000_000_000_000), artist(2)],
    artist: async (id) => {
      calls.push(id)
      return { top: [track(250_000_000_000_001, id), track(201, 500_000_000_000_001), track(202, id)] }
    },
  }), fixed)
  assert.deepEqual(calls, [2])
  assert.deepEqual(result.items.map((item) => item.track.id), [100, 202])
})

test('uses successful sources after partial failures and falls back to seed if related lookup fails', async () => {
  const partial = await createArtistRadio(page(1, 2), sources({
    relatedArtists: async () => [artist(2), artist(3), artist(4)],
    artist: (id) => {
      if (id === 2) throw new Error('Synchronous source failure')
      return id === 3 ? Promise.reject(new Error('Offline')) : Promise.resolve(page(id, 2))
    },
  }), fixed)
  assert.equal(partial.items.length, 4)
  assert.equal(partial.artistCount, 2)
  assert.equal(partial.failedSources, 2)
  const fallback = await createArtistRadio(page(1, 3), sources({ relatedArtists: async () => { throw new Error('Offline') } }), fixed)
  assert.equal(fallback.items.length, 3)
  assert.equal(fallback.artistCount, 1)
  assert.equal(fallback.failedSources, 1)
})

test('empty catalogue returns no items and related requests remain bounded', async () => {
  let calls = 0
  const result = await createArtistRadio(page(1, 0), sources({
    relatedArtists: async () => Array.from({ length: 100 }, (_, i) => artist(i + 2)),
    artist: async () => { calls++; return { top: [] } },
  }), fixed)
  assert.equal(calls, 6)
  assert.deepEqual(result, { items: [], artistCount: 0, failedSources: 0 })
})

test('snapshot accepts fresh Android array wrappers and DJ additions, rejects replaced queue and changed playback', () => {
  const one = { track: track(100, 1) }, two = { track: track(200, 2) }
  const before = { queue: [one, two], current: one, context: 'Lista actual', status: 'playing' }
  assert.equal(sameRadioPlayback(before, { ...before, queue: [...before.queue], userQueue: [{ key: 1, item: two }] }), true)
  assert.equal(sameRadioPlayback(before, { ...before, queue: [structuredClone(one), structuredClone(two)] }), false)
  assert.equal(sameRadioPlayback(before, { ...before, current: two }), false)
  assert.equal(sameRadioPlayback(before, { ...before, status: 'paused' }), false)
  assert.equal(sameRadioPlayback(before, { ...before, context: 'Otra lista' }), false)
})
