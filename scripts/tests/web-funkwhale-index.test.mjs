import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { LIMITS, validateInput, selectCanonical, hydrateCanonical, assertSourceClaims, providerCandidates, verifiedEntry, buildIndex } from '../build-funkwhale-identity-index.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const input = { title: 'A Recording', titleVersion: '', artist: 'An Artist', album: 'An Album' }
const raw = (extra = {}) => ({ id: 123, title: input.title, title_version: '', artist: { id: 11, name: input.artist }, album: { id: 22, title: input.album },
  duration: 105, isrc: 'GBKPL1370800', preview: 'https://sample.dzcdn.net/reference.mp3', ...extra })
const canonical = hydrateCanonical(raw(), raw())
const negative = { ...canonical, id: 124, isrc: 'GBKPL1370801', title: 'Another Recording' }
const uuid = number => `${String(number).padStart(8, '0')}-0000-4000-8000-000000000000`
const upload = (number = 1, extra = {}) => ({ uuid: uuid(number), duration: 105, size: 4000,
  listen_url: `https://open.audio/api/v2/listen/${uuid(9)}/?upload=${uuid(number)}`, mimetype: 'audio/mpeg', extension: 'mp3', bitrate: 320000, is_local: true, ...extra })
const provider = (uploads = [upload()], extra = {}) => ({ id: 321, title: input.title, album: { title: input.album }, artist_credit: [{ credit: input.artist }],
  is_local: true, is_playable: true, content_category: 'music', mbid: null, license: null, uploads, ...extra })
const source = () => providerCandidates(canonical, { results: [provider()] })[0]
const comparison = () => ({ matched: true, full: { correlation: .99 },
  windows: [0, 10, 20].map(referenceStartSeconds => ({ referenceStartSeconds, correlation: .99, inferredPreviewStartInCandidateSeconds: 20 })),
  alignmentSpreadSeconds: 0, selfControl: { correlation: 1 }, negativeControl: { correlation: .05 } })
const evidence = (candidate = source(), extra = {}) => ({ status: 200, type: 'cors', bytes: candidate.contentLength, sha256: digest(candidate.uploadUuid),
  mime: candidate.mime, duration: 105.3, sampleRate: 22050, channels: 2, identifiers: { isrcs: [], recordingMbids: [] }, totalBytesRead: candidate.contentLength + 1000,
  reference: { bytes: 500, sha256: digest('official reference'), duration: 29.99 }, negative: { bytes: 500, sha256: digest('distinct negative'), duration: 29.99 },
  comparison: comparison(), ...extra })
const makeEntry = (candidate = source(), proof = evidence(candidate)) => verifiedEntry(canonical, negative, candidate, proof, '2026-10-23T00:00:00.000Z')
const makeIndex = entries => ({ schemaVersion: 1, policy: { identityScope: 'official-excerpt-only', fullMasterVerified: false, downloadAllowed: false, mediaPersisted: false }, entries })
const code = ts.transpileModule(await readFile(new URL('../../web-port/funkwhale-identity.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
function runtime(index = makeIndex([makeEntry()])) {
  const api = {}
  new Function('exports', 'require', code)(api, name => { assert.equal(name, './funkwhale-identity-index.json'); return index })
  return api
}
const query = () => ({ id: canonical.id, title: canonical.title, titleVersion: canonical.titleVersion, artist: canonical.artist, album: canonical.album, duration: canonical.duration, isrc: canonical.isrc })

test('generation accepts generic labels and refuses source locators or catalog IDs in its input', () => {
  assert.deepEqual(validateInput(input), input)
  for (const extra of [{ source: 'https://example.invalid/audio.mp3' }, { catalogId: 123 }, { uploadUuid: uuid(1) }]) assert.throws(() => validateInput({ ...input, ...extra }))
  assert.throws(() => validateInput({ ...input, artist: '' }))
})

test('canonical selection rejects ambiguous releases and hydration cannot change entity, version or duration', () => {
  assert.equal(selectCanonical(input, { data: [raw({ title_version: 'Live' }), raw()] }).id, canonical.id)
  assert.throws(() => selectCanonical(input, { data: [raw(), raw({ id: 125 })] }), /ambiguous/)
  for (const changed of [{ id: 125 }, { title_version: 'Remastered' }, { duration: 106 }, { artist: { id: 12, name: input.artist } }, { album: { id: 23, title: input.album } }, { isrc: 'malformed' }]) {
    assert.throws(() => hydrateCanonical(raw(), raw(changed)))
  }
})

test('homonyms, unplayable/private metadata and explicit conflicting identities never become candidates', () => {
  for (const extra of [{ artist_credit: [{ credit: 'Someone Else' }] }, { album: { title: 'Another Album' } }, { title_version: 'Live' },
    { is_local: false }, { is_local: 'true' }, { is_playable: false }, { content_category: 'podcast' }, { isrc: negative.isrc }, { isrc: 'bad' }, { mbid: uuid(4) }]) {
    assert.deepEqual(providerCandidates(canonical, { results: [provider([upload()], extra)] }), [], JSON.stringify(extra))
  }
  for (const extra of [{ is_local: false }, { duration: 109 }, { size: LIMITS.candidateBytes + 1 }, { isrc: negative.isrc }, { recording_mbid: uuid(4) }]) {
    assert.deepEqual(providerCandidates(canonical, { results: [provider([upload(1, extra)])] }), [], JSON.stringify(extra))
  }
  assertSourceClaims(canonical, { isrc: 'GB-KPL-13-70800' })
  assert.throws(() => assertSourceClaims(canonical, { isrcs: [negative.isrc] }))
  assert.throws(() => assertSourceClaims(canonical, { recordingMbids: [uuid(4)] }))
})

test('all original encodings remain eligible and transcode/foreign routes never become frozen locators', () => {
  const formats = [upload(1), upload(2, { mimetype: 'audio/flac', extension: 'flac', bitrate: 900000, size: 9000 }),
    upload(3, { mimetype: 'audio/ogg', extension: 'opus', codec: 'opus', bitrate: 192000 }),
    upload(4, { listen_url: `https://open.audio/api/v2/listen/${uuid(9)}/?upload=${uuid(4)}&to=mp3` }),
    upload(5, { listen_url: `https://attacker.invalid/api/v2/listen/${uuid(9)}/?upload=${uuid(5)}` })]
  const candidates = providerCandidates(canonical, { results: [provider(formats)] })
  assert.deepEqual(candidates.map(item => item.codec), ['flac', 'mp3', 'opus'])
  assert.equal(candidates.length, 3)
  assert.ok(candidates.every(item => !Object.keys(item).some(key => /url/i.test(key))))
})

test('a successful aggregate score cannot override failed windows, controls, file length or reference provenance', () => {
  const candidate = source()
  const altered = [
    { bytes: candidate.contentLength - 1 }, { status: 206 }, { type: 'opaque' }, { duration: 109 }, { sha256: 'x'.repeat(64) },
    { reference: { ...evidence().reference, sha256: '' } }, { identifiers: { isrcs: [negative.isrc] } },
    { comparison: { ...comparison(), windows: comparison().windows.map((window, index) => ({ ...window, correlation: index ? .99 : .79 })) } },
    { comparison: { ...comparison(), negativeControl: { correlation: .6 } } },
    { comparison: { ...comparison(), windows: comparison().windows.map((window, index) => ({ ...window, inferredPreviewStartInCandidateSeconds: 20 + index })) } },
  ]
  for (const change of altered) assert.throws(() => makeEntry(candidate, evidence(candidate, change)))
  assert.throws(() => verifiedEntry(canonical, { ...negative, isrc: canonical.isrc }, candidate, evidence(candidate), '2026-10-23T00:00:00.000Z'))
})

function services(providerResponse) {
  const verified = [], requested = []
  const fetchJson = async url => {
    requested.push(url)
    if (url.includes('nodeinfo')) return { metadata: { library: { anonymousCanListen: true } }, software: { version: '2.0.test' } }
    if (url.includes('/search/track?')) return { data: [raw()] }
    if (url.endsWith('/track/123')) return raw()
    if (url.includes('/album/22/tracks')) return { data: [raw({ id: 124, title: negative.title, isrc: negative.isrc })] }
    if (url.endsWith('/track/124')) return raw({ id: 124, title: negative.title, isrc: negative.isrc })
    if (url.includes('/api/v2/tracks/?')) return providerResponse
    throw new Error('Unexpected URL')
  }
  return { requested, verified, fetchJson, verify: async candidate => { verified.push(candidate); return evidence(candidate) }, now: () => '2026-10-23T00:00:00.000Z' }
}

test('the generic pipeline independently verifies and indexes every eligible encoding', async () => {
  const api = services({ results: [provider([upload(1), upload(2, { mimetype: 'audio/flac', extension: 'flac', bitrate: 900000, size: 9000 })])] })
  const index = await buildIndex([input], api)
  assert.equal(index.entries.length, 2)
  assert.equal(api.verified.length, 2)
  assert.notEqual(index.entries[0].file.sha256, index.entries[1].file.sha256)
  assert.deepEqual(index.entries.map(entry => entry.file.bytes), [9000, 4000])
  assert.ok(index.entries.every(entry => entry.proof.fullMasterVerified === false && entry.downloadAllowed === false))
  assert.doesNotMatch(JSON.stringify(index), /https:\/\/[^" ]+\?(?:[^" ]*signature|[^" ]*upload=)/i)
})

test('a rejected candidate cannot reset the aggregate generation byte budget', async () => {
  const api = services({ results: [provider([upload(1, { size: LIMITS.candidateBytes }), upload(2, { size: LIMITS.candidateBytes })])] })
  let called = 0
  api.verify = async () => { called++; throw new Error('Decode failed after reading full bytes') }
  const index = await buildIndex([input], api)
  assert.equal(called, 1)
  assert.equal(index.entries.length, 0)
  assert.ok(index.inputs[0].rejected.some(item => item.reason === 'Aggregate audio byte budget'))
})

test('unindexed and incomplete queries expose no approved locators', () => {
  const api = runtime()
  assert.equal(api.hasIndexedFunkwhaleCatalogId(999), false)
  for (const change of [{ id: 999 }, { isrc: null }, { isrc: negative.isrc }, { title: 'Same Artist Other Song' }, { artist: 'Other Artist' },
    { album: 'Other Album' }, { titleVersion: 'Live' }, { duration: 109 }, { duration: NaN }, { titleVersion: 1 }]) assert.deepEqual(api.getVerifiedFunkwhaleEntries({ ...query(), ...change }), [])
  assert.equal(api.hasIndexedFunkwhaleCatalogId(canonical.id), true)
  assert.equal(api.getVerifiedFunkwhaleEntries({ ...query(), isrc: 'GB-KPL-13-70800', titleVersion: null }).length, 1)
  assert.deepEqual(api.getVerifiedFunkwhaleEntries(null), [])
  assert.equal(api.matchVerifiedFunkwhaleCandidate(null, source()), null)
})

test('runtime approval binds metadata and each encoding to its precise locator and full-file hash', () => {
  const candidate = source(), flac = { ...candidate, uploadUuid: uuid(2), mime: 'audio/flac', extension: 'flac', codec: 'flac', bitrate: 900000, lossless: true, contentLength: 9000 }
  const api = runtime(makeIndex([makeEntry(candidate), makeEntry(flac)])), entries = api.getVerifiedFunkwhaleEntries(query())
  assert.equal(entries.length, 2)
  assert.equal(api.matchVerifiedFunkwhaleCandidate(query(), candidate, entries[0]), true)
  assert.equal(api.matchVerifiedFunkwhaleCandidate(query(), flac, entries[1]), true)
  assert.equal(api.matchVerifiedFunkwhaleCandidate(query(), flac, entries[0]), false)
  for (const change of [{ uploadUuid: uuid(3) }, { trackUuid: uuid(3) }, { trackId: 322 }, { contentLength: 4001 }, { mime: 'audio/aac' },
    { codec: 'aac' }, { extension: 'aac' }, { lossless: true }, { bitrate: 64000 }, { isrc: negative.isrc }, { recordingMbid: uuid(3) }, { titleVersion: 'Live' }, { duration: 109 }]) {
    assert.equal(api.matchVerifiedFunkwhaleCandidate(query(), { ...candidate, ...change }, entries[0]), false, JSON.stringify(change))
  }
  assert.equal(api.matchVerifiedFunkwhaleCandidate(query(), candidate, { ...entries[0], file: { ...entries[0].file, sha256: digest('changed file') } }), false)
  assert.throws(() => { entries[0].file.sha256 = digest('mutable locator') }, TypeError)
})

test('missing, tampered or overclaimed proof never enables a source', () => {
  const valid = makeEntry()
  for (const change of [{ proof: { ...valid.proof, fullMasterVerified: true } }, { file: { ...valid.file, sha256: digest('changed file') } },
    { proof: { ...valid.proof, reference: { ...valid.proof.reference, catalogId: 999 } } },
    { proof: { ...valid.proof, comparison: { ...valid.proof.comparison, negativeControl: { correlation: .5 } } } },
    { proof: { ...valid.proof, negative: { ...valid.proof.negative, artist: 1 } } },
    { source: { ...valid.source, recordingMbid: uuid(3) } }, { downloadAllowed: true }]) {
    const api = runtime(makeIndex([{ ...valid, ...change }]))
    assert.equal(api.hasIndexedFunkwhaleCatalogId(canonical.id), false)
    assert.deepEqual(api.getVerifiedFunkwhaleEntries(query()), [])
  }
  const badPolicy = makeIndex([valid]); badPolicy.policy.fullMasterVerified = true
  assert.equal(runtime(badPolicy).hasIndexedFunkwhaleCatalogId(canonical.id), false)
})

test('the generated production index carries only stable metadata and excerpt-scoped proof', async () => {
  const index = JSON.parse(await readFile(new URL('../../web-port/funkwhale-identity-index.json', import.meta.url), 'utf8'))
  assert.ok(index.entries.length >= 3, 'Regenerate the index before running this contract test')
  const api = runtime(index)
  for (const entry of index.entries) {
    assert.equal(api.getVerifiedFunkwhaleEntries({ ...entry.catalog }).length >= 1, true)
    assert.ok(HASH_PATTERN.test(entry.file.sha256))
    assert.equal(entry.proof.fullMasterVerified, false)
    assert.equal(entry.proof.physicalBackgroundVerified, false)
    assert.equal(entry.downloadAllowed, false)
    assert.equal(entry.source.pod, 'https://open.audio')
    assert.ok(!Object.keys(entry.source).some(key => /url/i.test(key)))
  }
  const serialized = JSON.stringify(index)
  assert.doesNotMatch(serialized, /(?:X-Amz-(?:Credential|Signature)|data:audio|blob:|[?&](?:sig|signature|token)=)/i)
})
const HASH_PATTERN = /^[a-f0-9]{64}$/
