import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSpotifyPlaylist, readPlaylistCsv, readSpotifyPlaylist, spotifyPlaylistId } from '../../web-port/imports.ts'

const id = '3cEYpjA9oz9GiPac4AsH4n'
const track = (title = 'Tema', subtitle = 'Artista', extra = {}) => ({
  uri: 'spotify:track:4rzfv0JLZfVhOhbSQ8o5jZ', title, subtitle, duration: 210500, entityType: 'track', ...extra,
})
const page = (entries, extra = {}, attribute = "type='application/json' id = '__NEXT_DATA__'") =>
  `<html><script src="other.js"></script><script ${attribute}>${JSON.stringify({ props: { pageProps: { state: { data: { entity: {
    type: 'playlist', id, name: 'Mi lista & favoritos', trackList: entries, ...extra,
  } } } } } })}</script></html>`

test('Exportify conserva BOM, orden, duplicados, comillas, comas de artistas, duración e ISRC como APK', () => {
  const csv = '\uFEFFTrack URI,Track Name,Artist Name(s),Duration (ms),ISRC\r\nspotify:track:a,"Song, ""one""","Tyler, The Creator;Guest",180500,USABC1234567\r\nspotify:track:b,Other,Band,190000,\r\nspotify:track:a,"Song, ""one""","Tyler, The Creator;Guest",180500,USABC1234567\r\n'
  assert.deepEqual(readPlaylistCsv(csv, '  Mi lista.csv  '), {
    name: 'Mi lista', tracks: [
      { title: 'Song, "one"', artists: ['Tyler, The Creator', 'Guest'], durationMs: 180500, isrc: 'USABC1234567' },
      { title: 'Other', artists: ['Band'], durationMs: 190000, isrc: null },
      { title: 'Song, "one"', artists: ['Tyler, The Creator', 'Guest'], durationMs: 180500, isrc: 'USABC1234567' },
    ], skipped: 0, warnings: [],
  })
})

test('CSV usa coma, punto y coma o tabulador, cabeceras alternativas, multilínea y terminadores CR/LF', () => {
  for (const delimiter of [',', ';', '\t']) {
    const result = readPlaylistCsv(`\r\nTÍ-TU_LO${delimiter}ARTISTA\r"One\r\nTwo"${delimiter}Björk\n`, '')
    assert.equal(result.name, 'Importada de Spotify')
    assert.deepEqual(result.tracks, [{ title: 'One\r\nTwo', artists: ['Björk'], durationMs: null, isrc: null }])
  }
  assert.equal(readPlaylistCsv('Song Name,Artist Names,Track Duration(ms)\na,b,+003\n', 'x.CSV').tracks[0].durationMs, 3)
  assert.equal(readPlaylistCsv('Name,Artists\na,b', 'x.CsV').name, 'x.CsV', 'only .csv and .CSV suffixes match native parser')
})

test('CSV conserva la leniencia nativa de csv-core sin aceptar columnas desiguales', () => {
  assert.equal(readPlaylistCsv('Title,Artist\n"One"suffix,Band\n', 'x').tracks[0].title, 'Onesuffix')
  assert.equal(readPlaylistCsv('Title,Artist\nSong,"Band', 'x').tracks[0].artists[0], 'Band', 'csv-core accepts a quoted field at EOF')
  assert.equal(readPlaylistCsv('Title,Artist\nOne"Two,Band\n', 'x').tracks[0].title, 'One"Two')
  assert.throws(() => readPlaylistCsv('Title,Artist\nSong,Band,Extra\n', 'x'), /fila 2/)
  assert.throws(() => readPlaylistCsv('Title,Artist\n"One\nTwo",Band\nMissing\n', 'x'), /fila 3/)
})

test('CSV omite episodios, archivos locales y filas insuficientes, con avisos y duración opcional exactos', () => {
  const csv = 'Track URI,Track Name,Artist Name(s),Duration (ms),Is Local\n'
    + 'spotify:track:a,Yes,Band,invalid,false\nspotify:episode:b,Episode,Host,120000,false\n'
    + 'spotify:local:c,Local,Me,1000,false\nspotify:track:d,,Band,123,false\n'
    + 'https://open.spotify.com/episode/x,Podcast,Host,123,false\nspotify:track:e,Local2,Band,123,TRUE\n'
    + 'spotify:track:f,Empty artist list,;,123,false\nspotify:track:g,No duration,Band,,false\n'
  const result = readPlaylistCsv(csv, 'test')
  assert.deepEqual(result.tracks.map((value) => value.title), ['Yes', 'No duration'])
  assert.equal(result.skipped, 6)
  assert.deepEqual(result.warnings, [
    'Se han omitido 6 filas sin título o artista, episodios o archivos locales.',
    '1 canciones tienen una duración no válida; se buscarán por título y artista.',
  ])
  for (const value of ['0', '-1', '1.5', '86400001', '1e3', '18446744073709551616']) {
    const result = readPlaylistCsv(`Title,Artist,Duration ms\na,b,${value}`, 'x')
    assert.equal(result.tracks[0].durationMs, null)
    assert.equal(result.warnings.length, 1)
  }
  assert.equal(readPlaylistCsv('Title,Artist,Duration ms\na,b,86400000', 'x').tracks[0].durationMs, 86400000)
})

test('CSV aplica límites en bytes UTF8, 10000 registros y 100 caracteres de nombre sin deduplicar', () => {
  assert.throws(() => readPlaylistCsv('x'.repeat(10 * 1024 * 1024 + 1), 'x'), /10 MB/)
  assert.throws(() => readPlaylistCsv('é'.repeat(5 * 1024 * 1024 + 1), 'x'), /10 MB/)
  assert.throws(() => readPlaylistCsv(`Title,Artist\n${'é'.repeat(1001)},Band`, 'x'), /demasiado largos/)
  assert.throws(() => readPlaylistCsv(`Title,Artist,ISRC\na,b,${'é'.repeat(51)}`, 'x'), /ISRC/)
  const all = readPlaylistCsv('Title,Artist\n' + 'a,b\n'.repeat(10000) + '\n\r\n', '😀'.repeat(101) + '.csv')
  assert.equal(all.tracks.length, 10000)
  assert.equal([...all.name].length, 100)
  assert.throws(() => readPlaylistCsv('Title,Artist\n' + 'a,b\n'.repeat(10001), 'x'), /10.000 filas/)
  assert.throws(() => readPlaylistCsv('Title,Artist\n' + ',\n'.repeat(10001), 'x'), /10.000 filas/, 'skipped records also count toward the limit')
  const artists = Array.from({ length: 101 }, (_, i) => `a${i}`).join(';')
  const skipped = readPlaylistCsv(`Title,Artist\na,${artists}\nb,Band`, 'x')
  assert.equal(skipped.skipped, 1)
  for (const content of ['', 'Track URI\nspotify:track:a', 'Title,Artist\n', 'Title,Artist\n,']) assert.throws(() => readPlaylistCsv(content, 'x'))
})

test('Spotify valida exactamente enlaces completos y URI admitidos sin seguir hosts del usuario', () => {
  for (const value of [` https://open.spotify.com/playlist/${id}?si=test `, `https://open.spotify.com/intl-es/playlist/${id}`,
    `https://open.spotify.com/embed/playlist/${id}/`, `http://open.spotify.com/playlist/${id}`, `spotify:playlist:${id}`, `spotify:user:someone:playlist:${id}`]) {
    assert.equal(spotifyPlaylistId(value), id)
  }
  for (const value of [`https://open.spotify.com.evil.test/playlist/${id}`, `https://evil.test/playlist/${id}`,
    `https://someone@open.spotify.com/playlist/${id}`, `https://open.spotify.com:444/playlist/${id}`,
    `https://open.spotify.com/track/${id}`, `https://open.spotify.com/intl-e/playlist/${id}`, `https://open.spotify.com/playlist/${id}/extra`,
    'file:///playlist/test', 'spotify:playlist:../../etc/passwd', id, 'x'.repeat(4097)]) assert.throws(() => spotifyPlaylistId(value), /enlace completo/)
  assert.throws(() => spotifyPlaylistId('https://spotify.link/short'), /enlace corto/)
  assert.throws(() => spotifyPlaylistId('https://spoti.fi/short'), /enlace corto/)
})

test('la vista pública conserva identidad, orden y artistas con comas sin ejecutar HTML o scripts', () => {
  const first = track('First', 'Tyler, The Creator,\u00a0Kali Uchis')
  const source = parseSpotifyPlaylist(page([first, track('Second & third', 'Björk'), first]), id)
  assert.equal(source.name, 'Mi lista & favoritos')
  assert.deepEqual(source.tracks.map((row) => row.title), ['First', 'Second & third', 'First'])
  assert.deepEqual(source.tracks[0].artists, ['Tyler, The Creator', 'Kali Uchis'])
  assert.equal(source.tracks[0].durationMs, 210500)
  assert.equal(source.tracks[0].isrc, null)
  assert.equal(source.warnings.length, 1)
  assert.equal(parseSpotifyPlaylist(page([], {}, 'ID=__NEXT_DATA__ type="application/json"'), id).tracks.length, 0)
  for (const html of ['<html>Login</html>', '<script id="__NEXT_DATA__">{}</script>', page([], { id: 'wrong' }), page([], { type: 'album' }), page([], { name: null, title: 'Do not substitute' })]) {
    assert.throws(() => parseSpotifyPlaylist(html, id), /vista pública/)
  }
})

test('la vista pública conserva los avisos nativos de truncamiento y entradas omitidas', () => {
  const entries = [...Array.from({ length: 98 }, () => track()), track('Episode', 'Host', { uri: 'spotify:episode:' + id }), track('')]
  const source = parseSpotifyPlaylist(page(entries), id)
  assert.equal(source.tracks.length, 98)
  assert.equal(source.skipped, 2)
  assert.equal(source.warnings.length, 3)
  assert.ok(source.warnings.some((warning) => warning.includes('100')))
  assert.ok(source.warnings.some((warning) => warning.includes('omitido 2')))
})

test('el lector Spotify usa solo el embed HTTPS validado, sin cookies, redirecciones ni credenciales', async () => {
  const calls = []
  const source = await readSpotifyPlaylist(`spotify:playlist:${id}`, { fetch: async (url, options) => {
    calls.push({ url, options })
    return new Response(page([track()]))
  } })
  assert.equal(source.tracks.length, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `https://open.spotify.com/embed/playlist/${id}`)
  assert.equal(calls[0].options.credentials, 'omit')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal('headers' in calls[0].options, false)
  await assert.rejects(readSpotifyPlaylist('https://evil.test/playlist/' + id, { fetch: () => { throw new Error('Must not fetch') } }), /enlace completo/)
})

test('CORS o errores públicos producen fallo visible, nunca una playlist ficticia ni búsqueda por nombre', async () => {
  await assert.rejects(readSpotifyPlaylist(`spotify:playlist:${id}`, { fetch: async () => { throw new TypeError('Failed to fetch') } }), /navegador.*CSV/)
  for (const [status, pattern] of [[404, /No se encontró/], [429, /limitado/], [403, /no permite/]]) {
    await assert.rejects(readSpotifyPlaylist(`spotify:playlist:${id}`, { fetch: async () => new Response('', { status }) }), pattern)
  }
  await assert.rejects(readSpotifyPlaylist(`spotify:playlist:${id}`, { fetch: async () => new Response(page([], { id: 'other' })) }), /vista pública/)
})

test('la lectura pública limita los bytes anunciados y reales y rechaza UTF8 inválido', async () => {
  await assert.rejects(readSpotifyPlaylist(`spotify:playlist:${id}`, { fetch: async () => new Response('', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }) }), /demasiado grande/)
  let cancelled = false
  await assert.rejects(readSpotifyPlaylist(`spotify:playlist:${id}`, { fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)) },
    cancel() { cancelled = true },
  })) }), /demasiado grande/)
  assert.equal(cancelled, true)
  await assert.rejects(readSpotifyPlaylist(`spotify:playlist:${id}`, { fetch: async () => new Response(new Uint8Array([0xC3, 0x28])) }), /no se pudo leer/)
})
