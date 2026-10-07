import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
import { analyzeAudit, reconstruct, presentationIntervals, startupBracket, delayCandidates, comparePacket, main } from '../scripts/analyze-capture-audit.mjs'

const ID = 'jNY_wLukVW0', mime = 'audio/webm; codecs="opus"'
const settings = { timestampOffset: 0, appendWindowStart: 0, appendWindowEnd: null, mode: 'segments' }
const context = vm.createContext({ Uint8Array, ArrayBuffer })
vm.runInContext(readFileSync(new URL('../src-tauri/src/capture-mp4.js', import.meta.url), 'utf8'), context)
vm.runInContext(readFileSync(new URL('../src-tauri/src/capture-core.js', import.meta.url), 'utf8'), context)
function workspace(t) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'musify-audit-test-'))
  t.after(() => { const path = realpathSync(directory); assert.equal(dirname(path), realpathSync(tmpdir())); assert.ok(basename(path).startsWith('musify-audit-test-')); rmSync(path, { recursive: true, force: true }) })
  const audit = join(directory, 'audit.local'), oracle = join(directory, 'oracle.local'), journal = join(directory, 'journal.local')
  for (const path of [audit, oracle, journal]) mkdirSync(path)
  return { directory, audit, oracle, journal }
}
function builder(directory) {
  const records = []; let sequence = 0, parts = 0, clocks = 0, appendId = 0
  const add = record => records.push({ audit: 1, v: ID, generation: 7, epoch: 1, documentId: 'test-document', sequence: ++sequence, browserNow: 0, ...record })
  const diagnostic = reason => add({ kind: 'diagnostic', reason, statistics: { parts, clocks, dropped: 0, errors: 0 } })
  diagnostic('audit-started')
  return {
    records,
    append(source, bytes, { part = 0, totalParts = 1, totalBytes = bytes.length, append = ++appendId, byteOffset = 0, file = `s${source}.audio`, contentType = mime, tuple = settings } = {}) {
      if (byteOffset === 0) writeFileSync(join(directory, file), bytes)
      else writeFileSync(join(directory, file), Buffer.concat([readFileSync(join(directory, file)), bytes]))
      parts++; add({ kind: 'append', source, s: source, appendId: append, part, parts: totalParts, totalBytes, byteOffset, audioFile: file, bytes: bytes.length, mime: contentType, timelineSettings: tuple })
    },
    clock(source, position, browserNow, state = 'content', extra = {}) {
      clocks++; add({ kind: 'clock', source, s: source, position, duration: 1, browserNow, siteState: state, adMarker: state === 'ad', playbackRate: 1, readyState: 4, paused: false, seeking: false, phase: 'tick', ...extra })
    },
    mutation(source, operation, extra = {}) { add({ kind: 'mutation', source, s: source, operation, ...extra }) },
    finish(marker = true) { if (marker) diagnostic('audit-pagehide'); writeFileSync(join(directory, `${ID}-observations.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n') },
  }
}
function realTone(path, hz, codec = 'libopus') {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=${codec === 'aac' ? '0.384' : '0.4'}`, '-c:a', codec, ...(codec === 'aac' ? ['-movflags', '+frag_keyframe+empty_moov+default_base_moof'] : []), path], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(result.status, 0, 'Real FFmpeg fixture generation is required')
  return readFileSync(path)
}
function allPresented(b, source, bytes, wall = 0, markerAt = Infinity) {
  const parsed = context.__musifyCaptureCore.inspectWebMPrefix(new Uint8Array(bytes), { final: true })
  b.mutation(source, 'endOfStream')
  for (let ms = 0; ms < parsed.codedEnd * 1000; ms += 50) b.clock(source, ms / 1000, wall + ms, ms >= markerAt ? 'ad' : markerAt < Infinity ? 'unknown' : 'content')
  b.clock(source, parsed.codedEnd, wall + parsed.codedEnd * 1000, parsed.codedEnd * 1000 >= markerAt ? 'ad' : 'content', { ended: true, paused: true, sourceEnded: true })
  return parsed
}

test('offline reconstruction accounts for every append part, mutation boundary and final counter marker', t => {
  const w = workspace(t), b = builder(w.audit), bytes = Buffer.from([1, 2, 3])
  b.append(1, bytes); b.mutation(1, 'abort'); b.append(1, bytes, { byteOffset: 3 }); b.finish()
  const [group] = reconstruct(b.records, w.audit)
  assert.equal(group.runs.length, 2); assert.equal(group.runs[0].mutation, 'abort'); assert.deepEqual(group.errors, [])
  const [missingFinal] = reconstruct(b.records.slice(0, -1), w.audit)
  assert.ok(missingFinal.errors.includes('document-has-no-final-counter-marker'))
  const damaged = structuredClone(b.records); damaged[2].sequence++
  assert.ok(reconstruct(damaged, w.audit)[0].errors.includes('missing-or-repeated-document-sequence'))
})

test('an orderly native final marker is accepted only while its counters and transport remain complete', t => {
  const w = workspace(t), b = builder(w.audit)
  b.append(1, Buffer.from([1, 2, 3])); b.finish()
  const records = structuredClone(b.records), marker = records.at(-1)
  marker.reason = 'audit-finalized'; marker.requestId = 'close-7-1'
  assert.deepEqual(reconstruct(records, w.audit)[0].errors, [])
  assert(reconstruct(records.slice(0, -1), w.audit)[0].errors.includes('document-has-no-final-counter-marker'))
  marker.statistics.parts++
  assert(reconstruct(records, w.audit)[0].errors.includes('javascript-native-counter-mismatch-or-drop'))
  marker.statistics.parts--; delete marker.requestId
  assert(reconstruct(records, w.audit)[0].errors.includes('document-has-no-final-counter-marker'))
})

test('a subsequent append revokes a previous native EOF indication', t => {
  const w = workspace(t), b = builder(w.audit), bytes = Buffer.from([1, 2, 3])
  b.append(1, bytes); b.mutation(1, 'endOfStream'); b.append(1, bytes, { byteOffset: 3 }); b.finish()
  assert.equal(reconstruct(b.records, w.audit)[0].runs[0].eof, false)
})

test('truncated append, unlogged tail and paths outside the private artifact are never measured', t => {
  const w = workspace(t), b = builder(w.audit)
  b.append(1, Buffer.from([1, 2, 3]), { totalParts: 2, totalBytes: 131073 }); b.finish()
  assert.ok(reconstruct(b.records, w.audit)[0].errors.includes('truncated-native-append'))
  writeFileSync(join(w.audit, 's1.audio'), Buffer.from([1, 2, 3, 4]))
  assert.ok(reconstruct(b.records, w.audit)[0].errors.includes('unlogged-raw-audio-tail'))
  writeFileSync(join(w.directory, 'outside.audio'), Buffer.from([1, 2, 3]))
  const escaped = structuredClone(b.records); escaped[1].audioFile = '../outside.audio'
  assert.throws(() => reconstruct(escaped, w.audit), /outside-directory/)
})

test('native append framing rejects invalid counts and sizes even if concatenated bytes happen to agree', t => {
  const w = workspace(t), b = builder(w.audit)
  b.append(1, Buffer.from([1, 2, 3])); b.finish()
  for (const change of [{ appendId: 0 }, { parts: 2 }, { part: -1 }, { totalBytes: 4 }]) {
    const records = structuredClone(b.records); Object.assign(records[1], change)
    assert.ok(reconstruct(records, w.audit)[0].errors.includes('invalid-native-append-part'))
  }
})

test('fixed packet matching accounts for duration and rejects ambiguous or misaligned known payloads', () => {
  const packet = { pts: 0, duration: 0.02, size: 3, hash: 'payload' }
  assert.deepEqual(comparePacket(packet, { packets: [{ ...packet }] }, 0, 0.001), { proof: 'canonical-packet', index: 0 })
  for (const change of [{ pts: 1 }, { duration: 0.04 }]) {
    const match = comparePacket(packet, { packets: [{ ...packet, ...change }] }, 0, 0.001)
    assert.equal(match.proof, 'alignment-unmeasured'); assert.equal(match.reason, 'known-payload-with-different-clock-or-duration')
  }
  const ambiguous = comparePacket(packet, { packets: [{ ...packet }, { ...packet, pts: 0.001 }] }, 0, 0.001)
  assert.equal(ambiguous.proof, 'alignment-unmeasured')
  assert.equal(comparePacket(packet, { packets: [{ ...packet, hash: 'other' }] }, 0, 0.001).proof, 'external-candidate')
})

test('clock coverage excludes paused, skipped, accelerated and unobserved intervals', () => {
  const a = { sequence: 1, browserNow: 0, position: 0, paused: false, seeking: false, playbackRate: 1, readyState: 4 }
  const b = { ...a, sequence: 2, browserNow: 100, position: 0.1 }
  assert.equal(presentationIntervals([a, b]).length, 1)
  for (const change of [{ seeking: true }, { playbackRate: 2 }, { position: 5 }, { browserNow: 600 }]) assert.equal(presentationIntervals([a, { ...b, ...change }]).length, 0)
  assert.equal(presentationIntervals([{ ...a, paused: true }, b]).length, 0)
})

test('candidate delay is a bracket and an already visible site marker is not a late semantic-ad assertion', () => {
  const packets = [{ proof: 'external-candidate', start: 0, end: 0.02, presentation: { lower: 0, upper: 50 } }]
  const delayed = delayCandidates(packets, [{ sequence: 1, browserNow: 0, siteState: 'unknown' }, { sequence: 2, browserNow: 100, siteState: 'unknown' }, { sequence: 3, browserNow: 150, siteState: 'ad' }])[0]
  assert.deepEqual(delayed.nonnegativeDelayMs, { lower: 50, upper: 150 }); assert.equal(delayed.semanticAdVerified, false)
  const onTime = delayCandidates(packets, [{ sequence: 1, browserNow: 0, siteState: 'ad' }])[0]
  assert.deepEqual(onTime.nonnegativeDelayMs, { lower: 0, upper: 0 })
  const alreadyAd = delayCandidates([{ ...packets[0], presentation: { lower: 50, upper: 100 } }], [{ sequence: 1, browserNow: 0, siteState: 'ad' }, { sequence: 2, browserNow: 150, siteState: 'ad' }])[0]
  assert.deepEqual(alreadyAd.nonnegativeDelayMs, { lower: 0, upper: 0 }, 'a later heartbeat must not make an already observed signal look delayed')
  assert.equal(delayCandidates(packets, [{ sequence: 1, browserNow: 150, siteState: 'ad' }])[0].measured, false)
})

test('a seek prefix or an unobserved packet cannot establish when candidate external audio began', () => {
  const candidate = { proof: 'external-candidate', start: 80, end: 80.02, presentation: { lower: 0, upper: 50 } }
  const clocks = [{ sequence: 1, browserNow: 0, siteState: 'unknown' }, { sequence: 2, browserNow: 100, siteState: 'ad' }]
  assert.equal(delayCandidates([candidate], clocks)[0].measured, false)
  const prior = { proof: 'canonical-packet', start: 0, end: 0.02, presentation: { lower: 0, upper: 50 } }
  assert.equal(delayCandidates([prior, { ...candidate, start: 0.02, end: 0.04 }], clocks)[0].measured, true)
  assert.equal(delayCandidates([{ ...prior, proof: 'unpresented-or-unobserved', presentation: null }, { ...candidate, start: 0.02, end: 0.04 }], clocks)[0].measured, false)
})

function startupFixture() {
  const clock = (sequence, position, browserNow, extra = {}) => ({ kind: 'clock', epoch: 1, source: 1, s: 1, sequence, position, browserNow, paused: false, ended: false, seeking: false, playbackRate: 1, readyState: 4, phase: 'tick', siteState: 'ad', audioRanges: [{ start: 0, end: 6.041 }], ...extra })
  const clocks = [clock(1, 0, 1052.6, { phase: 'loadedmetadata', readyState: 1 }), clock(2, 0, 1157.7, { readyState: 1 }), clock(3, 0.007308, 1249.2), clock(4, 0.012883, 1254.7, { phase: 'playing' }), clock(5, 0.06873, 1311.5)]
  return { clocks, events: clocks, fresh: true, firstPacket: { start: 0, end: 0.020 } }
}

test('a metadata/paused zero to active fresh-source clock gives only an onset bracket, never presentation coverage', () => {
  for (const paused of [false, true]) {
    const f = startupFixture(); f.clocks[1].paused = paused
    const bracket = startupBracket(f)
    assert.deepEqual({ lower: bracket.lower, upper: bracket.upper }, { lower: 1157.7, upper: 1249.2 })
    assert.equal(bracket.coverageCredit, false)
    assert.equal(presentationIntervals(f.clocks)[0].start, 0.007308, 'ordinary packet presentation still has the original missing beginning')
  }
})

test('startup brackets reject old sources, seeks, parser resets, missing native beginning and implausible clocks', () => {
  for (const change of [
    f => { f.fresh = false },
    f => { f.firstPacket.start = 0.001 },
    f => { f.clocks[0].phase = 'tick' },
    f => { f.clocks[0].position = 0.002 },
    f => { f.clocks[2].paused = true },
    f => { f.clocks[2].seeking = true },
    f => { f.clocks[2].playbackRate = 2 },
    f => { f.clocks[2].browserNow = 1750 },
    f => { f.clocks[2].position = 0.100 },
    f => { f.clocks[1].audioRanges = [{ start: 0.001, end: 6 }] },
    f => { f.events = [...f.events, { kind: 'clock', sequence: 2.5, epoch: 1, s: 1, position: 0, playbackRate: 1, phase: 'seeked' }] },
    f => { f.events = [...f.events, { kind: 'clock', sequence: 2.5, epoch: 1, s: 1, position: 0, playbackRate: 1, phase: 'before-load' }] },
    f => { f.events = [...f.events, { kind: 'mutation', sequence: 2.5, epoch: 1, s: 1, operation: 'abort' }] },
    f => { f.events = [...f.events, { kind: 'append', sequence: 2.5, epoch: 2, s: 1 }] },
    f => { f.events = [...f.events, { kind: 'append', sequence: 2.5, epoch: 1, s: 2 }] },
  ]) { const f = startupFixture(); change(f); assert.equal(startupBracket(f), null) }
})

test('startup candidate delay needs independently different prefix packets and continuous later clock evidence', () => {
  const f = startupFixture(), startup = startupBracket(f)
  const packets = [{ start: 0, end: 0.020, proof: 'unpresented-or-unobserved', payloadProof: 'external-candidate', presentation: null },
    { start: 0.021, end: 0.041, proof: 'external-candidate', payloadProof: 'external-candidate', presentation: { lower: 1254.7, upper: 1311.5 } }]
  const candidate = delayCandidates(packets, f.clocks, startup)[0]
  assert.equal(candidate.measured, true); assert.equal(candidate.onsetMethod, 'fresh-source-clock-bracket')
  assert.deepEqual(candidate.nonnegativeDelayMs, { lower: 0, upper: 0 })
  assert.equal(packets[0].presentation, null); assert.equal(packets[0].proof, 'unpresented-or-unobserved')
  for (const proof of ['canonical-packet', 'alignment-unmeasured', undefined]) assert.equal(delayCandidates([{ ...packets[0], payloadProof: proof }, packets[1]], f.clocks, startup)[0].measured, false)
  const gap = structuredClone(f.clocks); gap[3].seeking = true
  assert.equal(delayCandidates(packets, gap, startup)[0].measured, false, 'an interior clock gap cannot borrow the startup bracket')
})

test('real Opus byte inventories measure preroll candidate delay only after an independent full canonical anchor', t => {
  const w = workspace(t), song = realTone(join(w.directory, 'song.webm'), 997), ad = realTone(join(w.directory, 'different.webm'), 1499)
  writeFileSync(join(w.oracle, `${ID}-251.audio`), song)
  const b = builder(w.audit)
  b.append(1, ad); allPresented(b, 1, ad, 0, 150)
  b.append(2, song); const inventory = allPresented(b, 2, song, 1000); b.finish()
  const first = context.__musifyCaptureCore.remuxWebM(inventory, 0, 2)
  writeFileSync(join(w.journal, '7-1-2-2-1.unit'), Buffer.concat([Buffer.from(first.init), Buffer.from(first.media)]))
  const report = analyzeAudit({ auditDirectory: w.audit, oracleDirectory: w.oracle, journalDirectory: w.journal })
  assert.equal(report.counts.unmeasuredRuns, 0, JSON.stringify(report.runs))
  assert.ok(report.counts.canonicalPackets > 0); assert.ok(report.counts.externalCandidatePackets > 0)
  assert.equal(report.counts.measuredCandidateTransitions, 1)
  assert.equal(report.counts.observedSiteAdSignalEpisodes, 1); assert.equal(report.counts.siteAdSignalEpisodesUnmeasured, 0)
  assert.deepEqual(report.observedMaximumCandidateDelayMs, { lower: 50, upper: 150 })
  assert.equal(report.semanticAdVerification, false); assert.equal(report.universalHoldbackBound, null)
  assert.equal(report.journal.mappedUnits, 1); assert.equal(report.journal.externalCandidatePackets, 0)
  assert.equal(JSON.stringify(report).includes(w.directory), false, 'no private absolute path leaves the artifact')
  assert.equal(JSON.stringify(report).includes('data:'), false)
})

test('real encoded startup candidate gains a bracket without gaining an observed packet or canonical anchor', t => {
  const w = workspace(t), song = realTone(join(w.directory, 'song.webm'), 997), external = realTone(join(w.directory, 'external.webm'), 1499)
  writeFileSync(join(w.oracle, `${ID}-251.audio`), song)
  const parsed = context.__musifyCaptureCore.inspectWebMPrefix(new Uint8Array(external), { final: true })
  const b = builder(w.audit); b.append(1, external); b.mutation(1, 'endOfStream')
  const ranges = [{ start: 0, end: parsed.codedEnd }]
  b.clock(1, 0, 0, 'ad', { phase: 'loadedmetadata', readyState: 1, audioRanges: ranges })
  b.clock(1, 0.007, 90, 'ad', { audioRanges: ranges })
  b.clock(1, 0.015, 100, 'ad', { phase: 'playing', audioRanges: ranges })
  for (let ms = 50; ms < parsed.codedEnd * 1000; ms += 50) b.clock(1, ms / 1000, ms + 85, 'ad', { audioRanges: ranges })
  b.clock(1, parsed.codedEnd, parsed.codedEnd * 1000 + 85, 'ad', { ended: true, paused: true, sourceEnded: true, audioRanges: ranges })
  b.append(2, song); allPresented(b, 2, song, 1000); b.finish()
  const report = analyzeAudit({ auditDirectory: w.audit, oracleDirectory: w.oracle })
  assert.equal(report.counts.measuredCandidateTransitions, 1, JSON.stringify(report.runs))
  assert.deepEqual(report.observedMaximumCandidateDelayMs, { lower: 0, upper: 0 })
  assert.equal(report.runs[0].presentedPackets, parsed.samples.length - 1)
  assert.equal(report.runs[0].canonicalPackets, 0)
  assert.equal(report.candidates[0].startupEvidence.coverageCredit, false)
  assert.equal(report.candidates[0].semanticAdVerified, false)
  const records = structuredClone(b.records), canonicalClocks = records.filter(r => r.kind === 'clock' && r.source === 2)
  for (const clock of canonicalClocks) clock.audioRanges = ranges
  canonicalClocks[0].phase = 'loadedmetadata'; canonicalClocks[0].readyState = 1
  writeFileSync(join(w.audit, `${ID}-observations.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n')
  const missingAnchor = analyzeAudit({ auditDirectory: w.audit, oracleDirectory: w.oracle })
  assert.ok(missingAnchor.runs[1].startupOnsetBracket, 'a startup clock bracket can exist without whole packet presentation')
  assert.equal(missingAnchor.counts.measuredRuns, 0)
  assert.equal(missingAnchor.counts.measuredCandidateTransitions, 0, 'the bracket cannot replace the independent fully observed canonical anchor')
})

test('exact real packets with an unobserved first ready clock get diagnostics without an anchor or delay credit', t => {
  const w = workspace(t), song = realTone(join(w.directory, 'song.webm'), 997), external = realTone(join(w.directory, 'external.webm'), 1499)
  writeFileSync(join(w.oracle, `${ID}-251.audio`), song)
  const inventory = context.__musifyCaptureCore.inspectWebMPrefix(new Uint8Array(song), { final: true })
  const b = builder(w.audit)
  b.append(1, external); allPresented(b, 1, external, 0, 150)
  b.append(2, song); b.mutation(2, 'endOfStream')
  const ranges = [{ start: 0, end: inventory.codedEnd }]
  b.clock(2, 0, 1000, 'content', { phase: 'loadedmetadata', readyState: 1, audioRanges: ranges })
  b.clock(2, 0.008538, 1015, 'content', { phase: 'playing', readyState: 4, audioRanges: ranges })
  for (let ms = 50; ms < inventory.codedEnd * 1000; ms += 50) b.clock(2, ms / 1000, 1000 + ms, 'content', { audioRanges: ranges })
  b.clock(2, inventory.codedEnd, 1000 + inventory.codedEnd * 1000, 'content', { ended: true, paused: true, sourceEnded: true, audioRanges: ranges })
  b.finish()
  const report = analyzeAudit({ auditDirectory: w.audit, oracleDirectory: w.oracle }), run = report.runs[1]
  assert.deepEqual(run.reasons, ['canonical-inventory-exact-presentation-incomplete'])
  assert.equal(run.canonicalInventoryDiagnostics.length, 1)
  const diagnostic = run.canonicalInventoryDiagnostics[0]
  assert.match(diagnostic.referenceHash, /^[a-f0-9]{64}$/)
  assert.equal(diagnostic.exactPackets, inventory.samples.length)
  assert.equal(diagnostic.presentablePackets, inventory.samples.length)
  assert.equal(diagnostic.observedPresentablePackets, inventory.samples.length - 1)
  assert.equal(diagnostic.unobservedPacketCount, 1)
  assert.deepEqual(diagnostic.unobservedPackets, [{ index: 0, start: 0, end: 0.02 }])
  assert.equal(diagnostic.unobservedPacketsTruncated, false)
  assert.equal(run.startupOnsetBracket.coverageCredit, false)
  assert.equal(run.presentedPackets, inventory.samples.length - 1)
  assert.equal(run.referenceHash, null, 'diagnostic evidence is not an accepted encoding anchor')
  assert.equal(run.measured, false); assert.equal(run.canonicalPackets, 0)
  assert.deepEqual(report.runs[0].canonicalInventoryDiagnostics, [], 'different audio does not gain an exact-inventory diagnosis')
  assert.equal(report.counts.measuredRuns, 0); assert.equal(report.counts.measuredCandidateTransitions, 0)
  assert.deepEqual(report.candidates, []); assert.equal(report.observedMaximumCandidateDelayMs, null)
  assert.equal(report.universalHoldbackBound, null)
})

test('matching codec alone, a missing reference, a partial clock and a missing final marker remain unmeasured', t => {
  const w = workspace(t), song = realTone(join(w.directory, 'song.webm'), 997), different = realTone(join(w.directory, 'different.webm'), 1499)
  writeFileSync(join(w.oracle, `${ID}-251.audio`), song)
  const b = builder(w.audit); b.append(1, different); allPresented(b, 1, different, 0, 150); b.finish()
  const report = analyzeAudit({ auditDirectory: w.audit, oracleDirectory: w.oracle })
  assert.equal(report.counts.measuredCandidateTransitions, 0)
  assert.equal(report.counts.observedSiteAdSignalEpisodes, 1); assert.equal(report.counts.siteAdSignalEpisodesUnmeasured, 1)
  assert.ok(report.runs[0].reasons.includes('no-observed-canonical-payload-anchors-encoding-unverified'))
  assert.deepEqual(report.runs[0].canonicalInventoryDiagnostics, [])
  const records = structuredClone(b.records).slice(0, -1)
  writeFileSync(join(w.audit, `${ID}-observations.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n')
  const partial = analyzeAudit({ auditDirectory: w.audit, oracleDirectory: w.oracle })
  assert.ok(partial.runs[0].reasons.includes('document-has-no-final-counter-marker'))
  assert.equal(partial.observedMaximumCandidateDelayMs, null)
})

test('real AAC inventory preserves the declared offset/window and counts every original canonical packet', t => {
  const w = workspace(t), song = realTone(join(w.directory, 'song.m4a'), 997, 'aac')
  writeFileSync(join(w.oracle, `${ID}-140.audio`), song)
  const tuple = { ...settings, timestampOffset: -1600 / 48000, appendWindowEnd: 0.36 }
  const b = builder(w.audit); b.append(1, song, { contentType: 'audio/mp4; codecs="mp4a.40.2"', tuple }); b.mutation(1, 'endOfStream')
  for (let ms = 0; ms < 360; ms += 50) b.clock(1, ms / 1000, ms)
  b.clock(1, 0.36, 360, 'content', { ended: true, paused: true, sourceEnded: true }); b.finish()
  const report = analyzeAudit({ auditDirectory: w.audit, oracleDirectory: w.oracle })
  assert.equal(report.counts.measuredRuns, 1, JSON.stringify(report.runs))
  assert.equal(report.runs[0].codec, 'aac'); assert.ok(report.counts.canonicalPackets > 10)
  assert.ok(report.counts.canonicalPackets < report.runs[0].parserPackets, 'window-excluded packets are inventoried but not claimed as presented')
  assert.equal(report.counts.externalCandidatePackets, 0)
})

test('site ad observations with no associated MSE bytes remain explicitly unmeasured', t => {
  const w = workspace(t), b = builder(w.audit)
  b.clock(null, 0, 0, 'ad'); b.clock(null, 0.1, 100, 'ad'); b.finish()
  const report = analyzeAudit({ auditDirectory: w.audit, oracleDirectory: w.oracle })
  assert.equal(report.counts.unboundClockObservations, 2)
  assert.equal(report.counts.observedSiteAdSignalEpisodes, 1); assert.equal(report.counts.siteAdSignalEpisodesUnmeasured, 1)
  assert.equal(report.observedMaximumCandidateDelayMs, null)
})

test('an EOF-truncated canonical prefix cannot anchor an otherwise compatible encoding', t => {
  const w = workspace(t), song = realTone(join(w.directory, 'song.webm'), 997)
  writeFileSync(join(w.oracle, `${ID}-251.audio`), song)
  const inventory = context.__musifyCaptureCore.inspectWebMPrefix(new Uint8Array(song), { final: true })
  const first = context.__musifyCaptureCore.remuxWebM(inventory, 0, 2)
  const prefix = Buffer.concat([Buffer.from(first.init), Buffer.from(first.media)])
  const b = builder(w.audit); b.append(1, prefix); allPresented(b, 1, prefix); b.finish()
  const report = analyzeAudit({ auditDirectory: w.audit, oracleDirectory: w.oracle })
  assert.equal(report.counts.measuredRuns, 0)
  assert.ok(report.runs[0].reasons.includes('no-observed-canonical-payload-anchors-encoding-unverified'))
  assert.deepEqual(report.runs[0].canonicalInventoryDiagnostics, [])
})

test('journal filenames cannot choose among parser runs sharing an epoch and source binding', t => {
  const w = workspace(t), song = realTone(join(w.directory, 'song.webm'), 997)
  writeFileSync(join(w.oracle, `${ID}-251.audio`), song)
  const b = builder(w.audit); b.append(1, song); allPresented(b, 1, song)
  b.mutation(1, 'abort'); b.append(1, song, { byteOffset: song.length }); allPresented(b, 1, song, 1000); b.finish()
  writeFileSync(join(w.journal, '7-1-1-1-1.unit'), song)
  const report = analyzeAudit({ auditDirectory: w.audit, oracleDirectory: w.oracle, journalDirectory: w.journal })
  assert.equal(report.counts.measuredRuns, 2, JSON.stringify(report.runs))
  assert.equal(report.journal.mappedUnits, 0); assert.equal(report.journal.unmeasuredUnits, 1)
})

test('unpresented prefetch is excluded and byte-identical audio cannot be rescued by a freely chosen offset', t => {
  const w = workspace(t), song = realTone(join(w.directory, 'song.webm'), 997)
  writeFileSync(join(w.oracle, `${ID}-251.audio`), song)
  const b = builder(w.audit); b.append(1, song); b.mutation(1, 'endOfStream'); b.clock(1, 0, 0); b.clock(1, 0.1, 100); b.finish()
  const report = analyzeAudit({ auditDirectory: w.audit, oracleDirectory: w.oracle })
  assert.ok(report.runs[0].presentedPackets < report.runs[0].parserPackets)
  assert.equal(report.counts.measuredCandidateTransitions, 0)
  const bad = analyzeAudit({ auditDirectory: w.audit, oracleDirectory: w.oracle, offsets: { [`${ID}/7/test-document/1/1/1`]: { numerator: 1, denominator: 10, basis: 'best-correlation' } } })
  assert.ok(bad.runs[0].reasons.includes('offset-is-not-an-explicit-fixed-metadata-origin'))
})

test('CLI requires ignored private output and never overwrites source evidence', () => {
  assert.throws(() => main(['--audit', 'a', '--oracle', 'b', '--output', 'report.json']), /ignored/)
  assert.throws(() => main(['--audit', 'a.local', '--oracle', 'b.local', '--output', 'a.local/result.json']), /source evidence/)
})
