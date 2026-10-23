import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

// Exercise the actual PWA parsers without a DOM, provider requests or native host.
const code = ts.transpileModule(await readFile(new URL('../../web-port/youtube.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const api = {}; new Function('exports', code)(api)
const id = 'DJzjkMBMook', otherId = 'aqz-KE-bpKQ', now = 1_800_000_000_000
const format = (name, extra = {}) => ({ mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000,
  url: `https://r1.googlevideo.com/${name}?expire=${now / 1000 + 3600}`, ...extra })
const player = formats => ({ playabilityStatus: { status: 'OK' }, videoDetails: { videoId: id, title: 'Requested song', author: 'Requested artist', lengthSeconds: '209' }, streamingData: { adaptiveFormats: formats } })
const select = formats => api.parsePlayer(player(formats), id, now)
const rejected = value => assert.throws(() => api.parsePlayer(value, id, now), error => error.code === 'format')
const varint = value => { const bytes = []; do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7 } while (value); return bytes }
const field = (key, bytes) => [key << 3 | 2, ...varint(bytes.length), ...bytes]
const tags = pairs => Buffer.from(pairs.flatMap(([key, value]) => field(1, [...field(1, [...Buffer.from(key)]), ...field(2, [...Buffer.from(value)])]))).toString('base64url')
const song = { musicResponsiveListItemRenderer: { playlistItemData: { videoId: id }, flexColumns: [
  { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Epoitaitaye' }] } } },
  { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Pirritx Porrotx eta Marimotots' }, { text: ' • ' }, { text: '3:29' }] } } },
] } }
const section = { musicShelfRenderer: { contents: [song] } }

test('P1 flat and tabbed Music containers keep the same primary candidates and recognize real empty results', () => {
  const flat = { contents: { sectionListRenderer: { contents: [section] } } }
  const tabbed = { contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [section] } } } }] } } }
  assert.deepEqual(api.parseMusicResults(flat), api.parseMusicResults(tabbed))
  assert.equal(api.parseMusicResults(flat)[0].videoId, id)
  for (const value of [{ contents: { sectionListRenderer: { contents: [] } } }, { contents: { tabbedSearchResultsRenderer: { tabs: [] } } }]) assert.deepEqual(api.parseMusicResults(value), [])
  for (const value of [{}, { contents: { tabbedSearchResultsRenderer: { tabs: [{}] } } }, { arbitrary: { contents: [section] } }]) assert.throws(() => api.parseMusicResults(value), error => error.code === 'response')
})

test('an API error or ERROR alert cannot masquerade as a valid Music shelf or an empty result', () => {
  for (const contents of [{ sectionListRenderer: { contents: [section] } }, { tabbedSearchResultsRenderer: { tabs: [] } }]) {
    for (const failure of [{ error: { code: 403 } }, { error: false }, { alerts: [{ alertRenderer: { type: 'ERROR' } }] }]) assert.throws(() => api.parseMusicResults({ contents, ...failure }), error => error.code === 'response')
  }
  assert.equal(api.parseMusicResults({ error: null, alerts: [{ alertRenderer: { type: 'INFO' } }], contents: { sectionListRenderer: { contents: [section] } } }).length, 1)
})

test('unknown nested renderers and promotions are not promoted to primary song matches', () => {
  assert.deepEqual(api.parseMusicResults({ contents: { sectionListRenderer: { contents: [{ adSlotRenderer: section }, { musicShelfRenderer: { contents: [{ promotedVideoRenderer: song }] } }] } } }), [])
})

test('OK is insufficient without an exact valid video identity', () => {
  for (const value of [undefined, null, '', 'invalid id', otherId, 123]) {
    const response = player([format('audio')]); response.videoDetails.videoId = value
    assert.throws(() => api.parsePlayer(response, id, now), error => error.code === 'response')
  }
  const noDetails = player([format('audio')]); delete noDetails.videoDetails
  assert.throws(() => api.parsePlayer(noDetails, id, now), error => error.code === 'response')
  assert.throws(() => api.parsePlayer({ playabilityStatus: { status: 'UNPLAYABLE' } }, id, now), error => error.code === 'unavailable')
  assert.throws(() => api.parsePlayer({ playabilityStatus: { status: 'LOGIN_REQUIRED' } }, id, now), error => error.code === 'restricted')
})

test('wholly untagged MP4 responses preserve the existing highest-bitrate compatible selection', () => {
  const result = select([format('low', { bitrate: 64000 }), format('high', { bitrate: 256000, contentLength: '54321' }),
    format('opus', { bitrate: 320000, mimeType: 'audio/webm; codecs="opus"' })])
  assert.match(result.url, /\/high\?/)
  assert.equal(result.contentLength, 54321)
  assert.equal(result.duration, 209)
})

test('default auto-dub never outranks explicitly original audio even when original is not default', () => {
  const original = format('original', { audioTrack: { audioIsDefault: false, displayName: 'Basque (original)' }, xtags: tags([['lang', 'eu'], ['acont', 'original']]) })
  const dub = format('dub', { bitrate: 999999, audioTrack: { audioIsDefault: true, displayName: 'English (auto-dubbed)' }, xtags: tags([['acont', 'dubbed-auto']]) })
  assert.match(select([dub, original]).url, /\/original\?/)
  rejected(player([dub]))
})

test('metadata anywhere in an audio response requires explicit originality for every encoding', () => {
  for (const marker of [{ language: 'eu' }, { languageCode: 'eu' }, { audioTrack: { audioIsDefault: true, displayName: 'Spanish' } }, { xtags: tags([['lang', 'eu']]) }]) {
    rejected(player([format('untagged-high', { bitrate: 999999 }), format('tagged', marker)]))
  }
  assert.match(select([format('untagged-high', { bitrate: 999999 }), format('original', { audioTrack: { displayName: 'Basque original', audioIsDefault: false } })]).url, /\/original\?/)
  assert.match(select([format('null-tags', { audioTrack: null, xtags: null, language: null, languageCode: null })]).url, /\/null-tags\?/)
})

test('corrupt, oversized or contradictory xtags cannot authorize a track', () => {
  const invalid = ['%%%', 'Cg==', '&tags=', '', 'CgMKAWs=', 'a'.repeat(4097), 123,
    tags([['acont', 'original'], ['acont', 'dubbed']]), tags([['acont', 'original'], ['drc', '1']]),
    Buffer.from(field(1, [...field(1, [...Buffer.from('acont')]), ...field(1, [...Buffer.from('acont')]), ...field(2, [...Buffer.from('original')])])).toString('base64url'),
    Buffer.from(field(1, [...field(1, [255]), ...field(2, [...Buffer.from('original')])])).toString('base64url'),
    Buffer.from(Array(65).fill([16, 1]).flat()).toString('base64url'),
    Buffer.from([10, 127, 1]).toString('base64url'),
  ]
  for (const xtags of invalid) rejected(player([format('bad-tags', { xtags, audioTrack: { displayName: 'Original' } })]))
  for (const acont of ['dubbed', 'dubbed-auto', 'descriptive', 'secondary', 'unknown']) rejected(player([format('other-track', { xtags: tags([['acont', acont]]), audioTrack: { audioIsDefault: true, displayName: 'Original' } })]))
})

test('URL-safe and percent-encoded standard FormatXTags both confirm explicit original audio', () => {
  const value = tags([['lang', 'eu'], ['acont', 'original']])
  for (const xtags of [value, Buffer.from(value, 'base64url').toString('base64'), encodeURIComponent(Buffer.from(value, 'base64url').toString('base64'))]) {
    assert.match(select([format('confirmed', { xtags, audioTrack: { audioIsDefault: false } })]).url, /\/confirmed\?/)
  }
})

test('noncanonical trailing bits and a BOM cannot be normalized into original identity', () => {
  const canonical = tags([['acont', 'original']]), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const corrupted = canonical.slice(0, -1) + alphabet[alphabet.indexOf(canonical.at(-1)) + 1]
  assert.ok(Buffer.from(corrupted, 'base64url').equals(Buffer.from(canonical, 'base64url')), 'Permissive decoders otherwise hide the corrupted trailing bits')
  rejected(player([format('bad-padding', { xtags: corrupted, audioTrack: { displayName: 'Original' } })]))
  rejected(player([format('bom-key', { xtags: tags([['\uFEFFacont', 'original']]) })]))
  rejected(player([format('bom-value', { xtags: tags([['acont', '\uFEFForiginal']]) })]))
  assert.match(select([format('canonical', { xtags: canonical })]).url, /\/canonical\?/)
})

test('DRC, described/secondary tracks and every DRM metadata form fail closed', () => {
  for (const change of [{ isDrc: true }, { drmFamilies: ['WIDEVINE'] }, { drmFamilies: null }, { drmFamilies: 'WIDEVINE' },
    { licenseInfos: [] }, { licenseInfos: null }, { drmTrackType: null }, { drmTrackType: 'DRM' },
    ...['Dubbed', 'Descriptive', 'Audio description', 'Secondary'].map(name => ({ audioTrack: { audioIsDefault: true, displayName: name + ' Original' } }))]) {
    rejected(player([format('forbidden', change)]))
  }
  assert.match(select([format('clear-original', { drmFamilies: [], xtags: tags([['acont', 'original']]) })]).url, /\/clear-original\?/)
})
