// Offline, private benchmark evidence. This never identifies a commercial from
// waveform similarity and never converts a finite observed maximum into a bound.
import { readFileSync, readdirSync, realpathSync, statSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join, dirname, basename, relative, sep, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import vm from 'node:vm'

const MAX_BYTES = 128 * 1024 * 1024, MAX_PART = 128 * 1024, EPSILON = 1e-6
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const finite = n => typeof n === 'number' && Number.isFinite(n)
const positiveInteger = n => Number.isSafeInteger(n) && n > 0
const binding = r => [r.v, r.generation, r.documentId, r.epoch, r.source, r.s].join('/')
const sourceBinding = r => [r.v, r.generation, r.documentId, r.source, r.s].join('/')
const documentBinding = r => [r.v, r.generation, r.documentId].join('/')
const privateOutput = path => resolve(path).split(sep).some(part => part.endsWith('.local'))
function inside(directory, file) {
  const path = realpathSync(resolve(directory, file)), rel = relative(realpathSync(directory), path)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || resolve(directory, rel) !== path) throw new Error('artifact-path-outside-directory')
  return path
}
function files(directory, depth = 0) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) return []
    const path = join(directory, entry.name)
    return entry.isFile() ? [path] : entry.isDirectory() && depth < 3 ? files(path, depth + 1) : []
  })
}
function parser() {
  const context = vm.createContext({ Uint8Array, ArrayBuffer })
  for (const file of ['capture-mp4.js', 'capture-core.js']) vm.runInContext(readFileSync(join(root, 'src-tauri/src', file), 'utf8'), context)
  return (bytes, mime, options = { allowGaps: true }) => /^audio\/webm/i.test(mime) ? context.__musifyCaptureCore.inspectWebMPrefix(new Uint8Array(bytes), options)
    : /^audio\/mp4/i.test(mime) ? context.__musifyCaptureMp4.inspectPrefix(new Uint8Array(bytes), options)
      : (() => { throw new Error('unsupported-audio-container') })()
}
const inspect = parser()

export function probe(path) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_streams', '-show_packets', '-show_data_hash', 'sha256',
    '-show_entries', 'stream=codec_name,profile,sample_rate,channels,channel_layout,time_base,extradata_hash:packet=pts,duration,size,data_hash', '-of', 'json', path],
  { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error('ffprobe-unavailable-or-container-unreadable')
  const json = JSON.parse(result.stdout)
  if (json.streams?.length !== 1 || !json.packets?.length) throw new Error('not-one-complete-audio-inventory')
  const stream = json.streams[0], [numerator, denominator] = String(stream.time_base).split('/').map(Number)
  if (!positiveInteger(numerator) || !positiveInteger(denominator) || numerator / denominator > 0.001 || !['opus', 'aac'].includes(stream.codec_name) || !stream.extradata_hash) throw new Error('unsupported-or-ambiguous-codec-clock')
  const configuration = JSON.stringify([stream.codec_name, stream.profile ?? null, stream.sample_rate, stream.channels, stream.channel_layout, stream.extradata_hash])
  const quantum = numerator / denominator
  const packets = json.packets.map(packet => {
    const size = Number(packet.size)
    if (!Number.isSafeInteger(packet.pts) || !positiveInteger(packet.duration) || !positiveInteger(size) || !/^SHA256:[0-9a-f]{64}$/i.test(packet.data_hash)) throw new Error('packet-without-exact-clock-size-or-hash')
    return { pts: packet.pts * quantum, duration: packet.duration * quantum, size, hash: packet.data_hash, integerPts: packet.pts }
  })
  if (packets.some((packet, i) => i && packet.pts <= packets[i - 1].pts)) throw new Error('overlapping-or-repeated-packet-clock')
  return { configuration, quantum, packets, codec: stream.codec_name, sampleRate: Number(stream.sample_rate), channels: stream.channels }
}

export function readRecords(directory) {
  const records = [], provenance = []
  for (const file of files(directory).filter(file => /-observations\.jsonl$/.test(file)).sort()) {
    const bytes = readFileSync(file)
    if (bytes.length > MAX_BYTES) throw new Error('observation-log-exceeds128MiB')
    const text = bytes.toString('utf8')
    if (text && !text.endsWith('\n')) throw new Error('truncated-observation-json-line')
    for (const line of text.split('\n').filter(Boolean)) records.push(JSON.parse(line))
    provenance.push({ file: basename(file), sha256: sha(bytes), bytes: bytes.length })
  }
  if (!records.length) throw new Error('no-private-audit-observations')
  return { records, provenance }
}

// No continuity is inferred across a missing record, parser mutation or epoch.
export function reconstruct(records, directory) {
  const documents = new Map(), groups = new Map(), originals = new Map()
  for (const record of records) {
    if (record.audit !== 1 || !/^[\w-]{11}$/.test(record.v) || !positiveInteger(record.generation) || !positiveInteger(record.epoch) || !/^[\w-]{1,64}$/.test(record.documentId)) throw new Error('invalid-audit-binding')
    const key = documentBinding(record), doc = documents.get(key) ?? { sequence: 0, parts: 0, clocks: 0, final: false, errors: [] }
    if (record.sequence !== doc.sequence + 1) doc.errors.push('missing-or-repeated-document-sequence')
    doc.sequence = record.sequence; doc.final = false
    if (record.kind === 'append') doc.parts++
    if (record.kind === 'clock') doc.clocks++
    if (record.kind === 'diagnostic' && record.statistics) {
      const stats = record.statistics
      if (stats.parts !== doc.parts || stats.clocks !== doc.clocks || stats.dropped || stats.errors) doc.errors.push('javascript-native-counter-mismatch-or-drop')
      if (record.reason === 'audit-pagehide' || (record.reason === 'audit-finalized' && /^[A-Za-z0-9-]{1,64}$/.test(record.requestId ?? ''))) doc.final = true
    }
    documents.set(key, doc)
    if (!positiveInteger(record.source) || !positiveInteger(record.s)) continue
    const groupKey = binding(record)
    const group = groups.get(groupKey) ?? { key: groupKey, base: record, runs: [], clocks: [], errors: [], current: null }
    groups.set(groupKey, group)
    if (record.kind === 'clock') { group.clocks.push(record); continue }
    if (record.kind === 'mutation') {
      if (record.operation === 'endOfStream' && !record.error) { if (group.current) group.current.eof = true; continue }
      if (group.current) { group.current.untilSequence = record.sequence; group.current.mutation = record.operation; group.current = null }
      if (record.operation === 'source-buffer-error' || record.error) group.errors.push('native-audio-error')
      if (record.operation === 'changeType') group.errors.push('codec-changed-without-new-configuration-proof')
      continue
    }
    if (record.kind !== 'append') continue
    if (!group.current) { group.current = { fromSequence: record.sequence, untilSequence: Infinity, parts: [], settings: record.timelineSettings, mime: record.mime, eof: false }; group.runs.push(group.current) }
    const run = group.current
    run.eof = false // appendBuffer reopens a MediaSource that previously reached EOF.
    if (JSON.stringify(run.settings) !== JSON.stringify(record.timelineSettings) || run.mime !== record.mime) group.errors.push('settings-changed-within-parser-run')
    const file = inside(directory, record.audioFile)
    let original = originals.get(file)
    if (!original) {
      if (statSync(file).size > MAX_BYTES) throw new Error('one-audio-buffer-exceeds128MiB')
      original = { bytes: readFileSync(file), consumed: 0 }; originals.set(file, original)
    }
    if (record.byteOffset !== original.consumed || !positiveInteger(record.bytes) || record.bytes > MAX_PART || record.byteOffset + record.bytes > original.bytes.length) { group.errors.push('missing-or-overlapping-raw-audio-bytes'); continue }
    original.consumed += record.bytes
    run.parts.push({ ...record, bytes: original.bytes.subarray(record.byteOffset, record.byteOffset + record.bytes) })
  }
  for (const group of groups.values()) {
    const doc = documents.get(documentBinding(group.base))
    group.errors.push(...doc.errors)
    if (!doc.final) group.errors.push('document-has-no-final-counter-marker')
    for (const run of group.runs) {
      let append = null
      for (const part of run.parts) {
        const expectedParts = Math.ceil(part.totalBytes / MAX_PART), expectedSize = Math.min(MAX_PART, part.totalBytes - part.part * MAX_PART)
        if (!positiveInteger(part.appendId) || !positiveInteger(part.totalBytes) || part.totalBytes > MAX_BYTES || !Number.isSafeInteger(part.part) || part.part < 0 || part.parts !== expectedParts || part.part >= part.parts || part.bytes.length !== expectedSize) group.errors.push('invalid-native-append-part')
        if (part.part === 0) {
          if (append && append.next !== append.parts) group.errors.push('truncated-native-append')
          append = { id: part.appendId, next: 0, parts: part.parts, total: part.totalBytes, bytes: 0 }
        }
        if (!append || part.appendId !== append.id || part.part !== append.next || part.parts !== append.parts || part.totalBytes !== append.total) { group.errors.push('missing-or-reordered-append-part'); continue }
        append.next++; append.bytes += part.bytes.length
        if (append.next === append.parts && append.bytes !== append.total) group.errors.push('truncated-native-append')
      }
      if (append && append.next !== append.parts) group.errors.push('truncated-native-append')
      run.bytes = Buffer.concat(run.parts.map(part => part.bytes)); delete run.parts
    }
    group.errors = [...new Set(group.errors)]
  }
  for (const original of originals.values()) if (original.consumed !== original.bytes.length) {
    for (const group of groups.values()) group.errors.push('unlogged-raw-audio-tail')
  }
  return [...groups.values()]
}

function hasInitialization(bytes, mime) {
  return /^audio\/webm/i.test(mime) ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) : bytes.subarray(4, 8).toString() === 'ftyp'
}
function offsetFor(key, offsets) {
  const value = offsets?.[key]
  if (!value) return { seconds: 0, kind: 'fixed-zero-origin' }
  if (value.basis !== 'container-metadata' || !Number.isSafeInteger(value.numerator) || !positiveInteger(value.denominator) || Math.abs(value.numerator / value.denominator) > 0.1) throw new Error('offset-is-not-an-explicit-fixed-metadata-origin')
  return { seconds: value.numerator / value.denominator, kind: 'explicit-fixed-container-metadata', numerator: value.numerator, denominator: value.denominator }
}
function referenceIndex(reference) {
  if (!reference.payloads) {
    reference.payloads = new Set(reference.packets.map(p => `${p.hash}/${p.size}`))
  }
  return reference
}
export function comparePacket(packet, reference, offset, quantum) {
  referenceIndex(reference)
  const at = packet.pts + offset
  // This is declared timestamp representation, not a waveform-derived alignment.
  const tolerance = quantum + 1e-9, matches = []
  let low = 0, high = reference.packets.length
  while (low < high) { const mid = (low + high) >>> 1; if (reference.packets[mid].pts < at - tolerance) low = mid + 1; else high = mid }
  for (let i = low; i < reference.packets.length && reference.packets[i].pts <= at + tolerance; i++) {
    const ref = reference.packets[i]
    if (ref.hash === packet.hash && ref.size === packet.size && Math.abs(ref.duration - packet.duration) <= tolerance) matches.push(i)
  }
  if (matches.length === 1) return { proof: 'canonical-packet', index: matches[0] }
  if (matches.length > 1) return { proof: 'alignment-unmeasured', reason: 'ambiguous-fixed-clock-packet-match' }
  if (reference.payloads.has(`${packet.hash}/${packet.size}`)) return { proof: 'alignment-unmeasured', reason: 'known-payload-with-different-clock-or-duration' }
  return { proof: 'external-candidate' }
}
export function presentationIntervals(clocks) {
  const intervals = []
  const ordered = [...clocks].sort((a, b) => a.sequence - b.sequence)
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1], b = ordered[i], wall = b.browserNow - a.browserNow, advance = b.position - a.position
    if (![a.browserNow, b.browserNow, a.position, b.position].every(finite) || a.paused || a.seeking || b.seeking || a.playbackRate !== 1 || b.playbackRate !== 1 || a.readyState < 2 || b.readyState < 2 || wall <= 0 || wall > 500 || advance <= 0 || advance > wall / 1000 + 0.15) continue
    intervals.push({ start: a.position, end: b.position, wallStart: a.browserNow, wallEnd: b.browserNow })
  }
  return intervals
}
function presentedBracket(intervals, start, end) {
  if (!(end > start)) return null
  const spans = intervals.filter(i => i.end > start + EPSILON && i.start < end - EPSILON).sort((a, b) => a.start - b.start)
  let covered = start, lower = null, upper = null
  for (const span of spans) {
    if (span.start > covered + EPSILON) break
    if (lower === null) lower = span.wallStart
    covered = Math.max(covered, span.end); upper = span.wallEnd
    if (covered >= end - EPSILON) return { lower, upper }
  }
  return null
}

// A fresh source can start between metadata-at-zero (HAVE_METADATA, or paused)
// and the first active clock. This bounds the onset; it does NOT fill presentation
// coverage, make a canonical encoding anchor, or claim when a device emitted PCM.
export function startupBracket({ clocks, events, firstPacket, fresh }) {
  if (!fresh || !firstPacket || firstPacket.start !== 0 || !(firstPacket.end > 0)) return null
  const ordered = [...clocks].sort((a, b) => a.sequence - b.sequence), advanced = ordered.find(c => finite(c.position) && c.position > 0)
  if (!advanced || advanced.paused || advanced.ended || advanced.seeking || advanced.playbackRate !== 1 || advanced.readyState < 2) return null
  const initial = ordered.filter(c => c.sequence < advanced.sequence), zero = initial.at(-1)
  const metadata = initial.find(c => c.phase === 'loadedmetadata' && c.position === 0 && c.readyState >= 1)
  if (!metadata || !zero || zero.position !== 0 || zero.readyState < 1 || !finite(zero.browserNow) || !finite(advanced.browserNow)) return null
  const wall = advanced.browserNow - zero.browserNow
  if (wall <= 0 || wall > 500 || advanced.position > wall / 1000 + EPSILON) return null
  const startupEvents = events.filter(r => r.sequence <= advanced.sequence)
  if (startupEvents.some(r => r.epoch !== advanced.epoch ||
    (r.kind === 'mutation' && (r.operation !== 'endOfStream' || r.error)) ||
    (r.kind === 'clock' && (r.seeking || r.ended || r.playbackRate !== 1 || !finite(r.position) || r.position < 0 || r.phase === 'seeking' || r.phase === 'seeked' || String(r.phase).startsWith('before-'))))) return null
  const buffers = new Set(startupEvents.map(r => r.s).filter(positiveInteger))
  if (buffers.size !== 1 || !buffers.has(advanced.s)) return null
  const containsBeginning = c => c.audioRanges?.some(r => finite(r.start) && finite(r.end) && r.start === 0 && r.end >= firstPacket.end)
  if (!containsBeginning(zero) || !containsBeginning(advanced)) return null
  return { lower: zero.browserNow, upper: advanced.browserNow, zeroSequence: zero.sequence, advanceSequence: advanced.sequence, firstActivePosition: advanced.position,
    basis: 'fresh-source-zero-to-active-clock', coverageCredit: false }
}

export function delayCandidates(packets, clocks, startup = null) {
  const candidates = [], sorted = [...clocks].sort((a, b) => a.sequence - b.sequence)
  let wasExternal = false
  for (const [index, packet] of packets.entries()) {
    if (packet.proof !== 'external-candidate' || !packet.presentation) { wasExternal = false; continue }
    if (wasExternal) continue
    wasExternal = true
    const previous = packets.slice(0, index).findLast(p => p.end > p.start)
    let onsetObserved = !previous ? Math.abs(packet.start) <= EPSILON
      : previous.proof === 'canonical-packet' && previous.presentation && Math.abs(previous.end - packet.start) <= EPSILON
    let onset = packet.presentation, onsetMethod = 'fully-observed-packet', onsetPacket = packet
    const prefix = packets.slice(0, index + 1).filter(p => p.end > p.start)
    if (!onsetObserved && startup && prefix[0]?.start === 0 && prefix.every(p => p.payloadProof === 'external-candidate') &&
      presentedBracket(presentationIntervals(sorted.filter(c => c.sequence >= startup.advanceSequence)), startup.firstActivePosition, packet.end)) {
      onsetObserved = true; onset = { lower: startup.lower, upper: startup.upper }; onsetMethod = 'fresh-source-clock-bracket'; onsetPacket = prefix[0]
    }
    if (!onsetObserved) { candidates.push({ measured: false, reason: 'candidate-onset-before-or-between-observed-packets', packetStart: packet.start, packetEnd: packet.end }); continue }
    // A site observation associates this candidate with its ad signal; it is not
    // itself the independent semantic label required to call this a commercial.
    const current = sorted.findLast(c => finite(c.browserNow) && c.browserNow <= onset.lower)
    const ad = current?.siteState === 'ad' ? current
      : sorted.find(c => c.siteState === 'ad' && finite(c.browserNow) && c.browserNow >= onset.lower)
    if (!ad) { candidates.push({ measured: false, reason: 'no-associated-site-ad-observation', packetStart: packet.start, packetEnd: packet.end }); continue }
    const before = sorted.findLast(c => c.sequence < ad.sequence && c.siteState !== 'ad' && finite(c.browserNow))
    const upper = Math.max(0, ad.browserNow - onset.lower)
    if (!before && upper > 0) { candidates.push({ measured: false, reason: 'site-signal-lower-bound-unobserved', packetStart: packet.start, packetEnd: packet.end }); continue }
    const lower = before ? Math.max(0, before.browserNow - onset.upper) : 0
    candidates.push({ measured: true, semanticAdVerified: false, kind: 'external-audio-associated-with-site-ad-signal', packetStart: onsetPacket.start, packetEnd: onsetPacket.end,
      onsetMethod, ...(onsetMethod === 'fresh-source-clock-bracket' ? { startupEvidence: startup, fullyObservedWitnessPacket: { start: packet.start, end: packet.end } } : {}),
      siteSignalSequence: ad.sequence,
      candidateAudioOnsetBrowserMs: onset, siteSignalBrowserMs: { lower: before?.browserNow ?? null, upper: ad.browserNow },
      nonnegativeDelayMs: { lower, upper }, referenceProof: 'different-packet-after-compatible-canonical-encoding-anchors' })
  }
  return candidates
}

function siteAdEpisodes(clocks) {
  const episodes = []; let active = null
  for (const clock of [...clocks].sort((a, b) => a.sequence - b.sequence)) {
    if (clock.siteState !== 'ad') { active = null; continue }
    if (!active) { active = { firstSequence: clock.sequence, lastSequence: clock.sequence, observations: 0 }; episodes.push(active) }
    active.lastSequence = clock.sequence; active.observations++
  }
  return episodes
}

export function analyzeAudit({ auditDirectory, oracleDirectory, journalDirectory = null, offsets = {} }) {
  const auditRoot = realpathSync(auditDirectory), oracleRoot = realpathSync(oracleDirectory)
  const { records, provenance } = readRecords(auditRoot), groups = reconstruct(records, auditRoot)
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'musify-audit-analysis-'))
  try {
    const references = [], referenceErrors = []
    for (const file of files(oracleRoot).sort()) {
      const match = /^([\w-]{11})-(\d+)\.audio$/.exec(basename(file))
      if (!match) continue
      try { const bytes = readFileSync(file); if (bytes.length > MAX_BYTES) throw new Error('reference-exceeds128MiB'); references.push({ videoId: match[1], itag: Number(match[2]), hash: sha(bytes), ...probe(file) }) }
      catch (error) { referenceErrors.push({ file: basename(file), reason: error.message }) }
    }
    const initialization = new Map(), runs = [], anchorPools = new Map()
    for (const group of groups) for (const [index, run] of group.runs.entries()) {
      const clocks = group.clocks.filter(c => c.sequence >= run.fromSequence && c.sequence < run.untilSequence)
      const result = { binding: group.key, run: index, base: group.base, settings: run.settings, errors: [...group.errors], packets: [], candidates: [], canonicalInventoryDiagnostics: [], offset: null, clocks }
      runs.push(result)
      try {
        result.offset = offsetFor(group.key, offsets)
        const base = sourceBinding(group.base), prior = initialization.get(base)
        const fresh = index === 0 && !prior && hasInitialization(run.bytes, run.mime)
        let bytes = run.bytes
        if (!hasInitialization(bytes, run.mime)) { if (!prior) throw new Error('parser-reset-without-preserved-initialization'); bytes = Buffer.concat([prior, bytes]) }
        const inventory = inspect(bytes, run.mime)
        if (!inventory.init || !inventory.samples.length) throw new Error('no-complete-parser-packets')
        initialization.set(base, Buffer.from(inventory.init))
        const file = join(scratch, `run-${runs.length}.audio`); writeFileSync(file, bytes)
        const probed = probe(file)
        if (probed.packets.length !== inventory.samples.length) throw new Error('ffprobe-did-not-account-for-every-original-parser-packet')
        result.configuration = probed.configuration; result.codec = probed.codec; result.quantum = Math.max(probed.quantum, inventory.quantum)
        result.prefixPending = inventory.pending === true; result.inventoryPackets = inventory.samples.length
        if (run.settings?.mode !== 'segments' || !finite(run.settings.timestampOffset) || !finite(run.settings.appendWindowStart) || !(run.settings.appendWindowEnd === null || finite(run.settings.appendWindowEnd))) throw new Error('unverified-MSE-timeline-settings')
        const intervals = presentationIntervals(clocks)
        result.packets = probed.packets.map((packet, i) => {
          const sample = inventory.samples[i], start = Math.max(run.settings.appendWindowStart, sample.start + run.settings.timestampOffset), end = Math.min(run.settings.appendWindowEnd ?? Infinity, sample.end + run.settings.timestampOffset)
          return { ...packet, start, end, presentation: presentedBracket(intervals, start, end) }
        })
        result.startup = startupBracket({ clocks: group.clocks, firstPacket: result.packets.find(p => p.end > p.start), fresh,
          events: records.filter(r => r.v === group.base.v && r.generation === group.base.generation && r.documentId === group.base.documentId && r.source === group.base.source) })
        result.references = references.filter(ref => ref.videoId === group.base.v && ref.configuration === result.configuration)
        if (!result.references.length) throw new Error('no-canonical-reference-with-identical-codec-configuration')
        // Anchors from clean, observed packets establish which canonical encoding
        // this browser actually uses. Merely using the same codec is insufficient.
        for (const reference of result.references) {
          const presentable = result.packets.filter(p => p.end > p.start)
          const matches = result.packets.map(p => comparePacket(p, reference, result.offset.seconds, Math.max(result.quantum, reference.quantum)))
          // A truncated prefix or a complete-but-short source cannot establish a
          // full canonical encoding anchor. Account for every reference packet,
          // including encoded priming packets excluded by the official window.
          let completeInventory = false
          if (run.eof && !inventory.pending && matches.length === reference.packets.length && matches.every((match, i) => match.proof === 'canonical-packet' && match.index === i)) {
            try { const complete = inspect(bytes, run.mime, { final: true, allowGaps: false }); completeInventory = complete.samples.length === result.packets.length } catch { /* Partial runs remain useful only after another source anchors the encoding. */ }
          }
          if (completeInventory) {
            const unobserved = result.packets.flatMap((packet, index) => packet.end > packet.start && !packet.presentation ? [{ index, start: packet.start, end: packet.end }] : [])
            if (unobserved.length) result.canonicalInventoryDiagnostics.push({ referenceHash: reference.hash, exactPackets: matches.length,
              presentablePackets: presentable.length, observedPresentablePackets: presentable.length - unobserved.length,
              unobservedPacketCount: unobserved.length, unobservedPackets: unobserved.slice(0, 32), unobservedPacketsTruncated: unobserved.length > 32 })
          }
          if (completeInventory && presentable.length > 0 && presentable.every(p => p.presentation) && !result.errors.length) {
            const key = [group.base.v, group.base.generation, result.configuration, reference.hash].join('/')
            anchorPools.set(key, (anchorPools.get(key) ?? 0) + presentable.length)
          }
        }
      } catch (error) { result.errors.push(error.message) }
    }
    for (const run of runs) {
      if (run.errors.length) continue
      const anchored = run.references.filter(ref => anchorPools.has([run.base.v, run.base.generation, run.configuration, ref.hash].join('/')))
      const unique = [...new Map(anchored.map(ref => [ref.hash, ref])).values()]
      if (unique.length !== 1) {
        // Exact bytes do not fill missing presentation. Keep anchors and delay
        // denied, but distinguish that missing observation from an encoding mismatch.
        run.errors.push(unique.length ? 'multiple-independently-anchored-reference-encodings'
          : run.canonicalInventoryDiagnostics.length ? 'canonical-inventory-exact-presentation-incomplete'
            : 'no-observed-canonical-payload-anchors-encoding-unverified')
        continue
      }
      run.reference = unique[0]
      let previousMatch = -1
      for (const packet of run.packets) {
        const match = comparePacket(packet, run.reference, run.offset.seconds, Math.max(run.quantum, run.reference.quantum))
        packet.payloadProof = match.proof
        if (!packet.presentation) { packet.proof = 'unpresented-or-unobserved'; continue }
        packet.proof = match.proof
        if (match.proof === 'canonical-packet') {
          if (match.index <= previousMatch) { packet.proof = 'alignment-unmeasured'; packet.reason = 'repeated-or-reordered-canonical-packet' }
          previousMatch = match.index
        } else if (match.reason) packet.reason = match.reason
      }
      run.candidates = delayCandidates(run.packets, run.clocks, run.startup)
    }
    const journal = { supplied: !!journalDirectory, units: 0, mappedUnits: 0, unmeasuredUnits: 0, externalCandidatePackets: 0, errors: [] }
    if (journalDirectory) for (const file of files(realpathSync(journalDirectory)).filter(file => file.endsWith('.unit')).sort()) {
      journal.units++
      const match = /^(\d+)-(\d+)-(\d+)-(\d+)-(\d+)\.unit$/.exec(basename(file))
      const possible = match ? runs.filter(run => !run.errors.length && run.reference && [run.base.generation, run.base.epoch, run.base.source, run.base.s].every((n, i) => n === Number(match[i + 1]))) : []
      // Filenames have no document/run identity or timestamp-settings sidecar.
      // Do not guess which parser reset produced a unit with the same binding.
      if (possible.length !== 1) { journal.unmeasuredUnits++; continue }
      try {
        const run = possible[0], unit = probe(file)
        if (unit.configuration !== run.configuration) throw new Error('unit-configuration-mismatch')
        const matches = unit.packets.map(packet => comparePacket(packet, run.reference, run.offset.seconds, Math.max(run.quantum, unit.quantum, run.reference.quantum)))
        if (matches.some(match => match.proof === 'alignment-unmeasured')) throw new Error('unit-fixed-clock-alignment-unmeasured')
        const indices = matches.filter(match => match.proof === 'canonical-packet').map(match => match.index)
        if (indices.some((index, i) => i && index <= indices[i - 1])) throw new Error('unit-repeated-or-reordered-canonical-packet')
        journal.mappedUnits++
        journal.externalCandidatePackets += matches.filter(match => match.proof === 'external-candidate').length
      } catch (error) { journal.unmeasuredUnits++; journal.errors.push({ file: basename(file), reason: error.message }) }
    }
    const candidates = runs.flatMap(run => run.candidates.map(candidate => ({ videoId: run.base.v, binding: run.binding, ...candidate }))), measured = candidates.filter(c => c.measured)
    // Keep unmeasured site signals visible, including non-MSE media and sources
    // that never yielded a parseable append. These are observations, not a count
    // of unique commercials. Unknown between two ad labels creates two episodes.
    const clockGroups = new Map()
    for (const record of records.filter(r => r.kind === 'clock')) {
      const key = binding(record), list = clockGroups.get(key) ?? []; list.push(record); clockGroups.set(key, list)
    }
    const siteSignals = [...clockGroups].flatMap(([key, clocks]) => siteAdEpisodes(clocks).map(episode => ({ binding: key, ...episode,
      candidateDelayMeasured: measured.some(candidate => candidate.binding === key && candidate.siteSignalSequence >= episode.firstSequence && candidate.siteSignalSequence <= episode.lastSequence) })))
    const summary = { schema: 1, purpose: 'private-offline-candidate-audio-signal-delay', semanticAdVerification: false, universalHoldbackBound: null,
      assumptions: ['Packet payload mismatch is candidate external audio, not a semantic ad label.', 'Origins are fixed before comparison; no correlation or offset search.', 'An encoding anchor accounts for every canonical packet exactly once and observes all presentable packets of the complete source.', 'Canonical anchors do not identify every different packet\'s meaning or exclude re-encoding of the same sound.', 'A fresh-source startup bracket bounds clock onset only; it adds no presented packet, canonical anchor, or coverage credit.', 'Bounds describe observed browser media-clock presentation; device-output latency is unmeasured.', 'Site ad-signal episodes are observations, not unique commercials or semantic ad transitions.', 'A finite measured maximum cannot guarantee future signal latency.'],
      provenance: { observations: provenance, references: references.map(ref => ({ videoId: ref.videoId, itag: ref.itag, sha256: ref.hash, codec: ref.codec })) }, referenceErrors,
      counts: { groups: groups.length, runs: runs.length, measuredRuns: runs.filter(run => !run.errors.length).length, unmeasuredRuns: runs.filter(run => run.errors.length).length,
        presentedPackets: runs.filter(run => !run.errors.length).reduce((sum, run) => sum + run.packets.filter(p => p.presentation).length, 0),
        canonicalPackets: runs.reduce((sum, run) => sum + run.packets.filter(p => p.proof === 'canonical-packet').length, 0), externalCandidatePackets: runs.reduce((sum, run) => sum + run.packets.filter(p => p.proof === 'external-candidate').length, 0), alignmentUnmeasuredPackets: runs.reduce((sum, run) => sum + run.packets.filter(p => p.proof === 'alignment-unmeasured').length, 0),
        measuredCandidateTransitions: measured.length, unmeasuredCandidateTransitions: candidates.length - measured.length,
        observedSiteAdSignalEpisodes: siteSignals.length, siteAdSignalEpisodesWithCandidateDelay: siteSignals.filter(signal => signal.candidateDelayMeasured).length, siteAdSignalEpisodesUnmeasured: siteSignals.filter(signal => !signal.candidateDelayMeasured).length,
        unboundClockObservations: records.filter(r => r.kind === 'clock' && (!positiveInteger(r.source) || !positiveInteger(r.s))).length },
      observedMaximumCandidateDelayMs: measured.length ? { lower: Math.max(...measured.map(c => c.nonnegativeDelayMs.lower)), upper: Math.max(...measured.map(c => c.nonnegativeDelayMs.upper)) } : null,
      runs: runs.map(run => ({ videoId: run.base.v, binding: run.binding, run: run.run, measured: !run.errors.length, reasons: [...new Set(run.errors)], codec: run.codec ?? null,
        offset: run.offset, parserPackets: run.inventoryPackets ?? null, prefixPending: run.prefixPending ?? null, referenceHash: run.reference?.hash ?? null, startupOnsetBracket: run.startup ?? null,
        canonicalInventoryDiagnostics: run.canonicalInventoryDiagnostics,
        presentedPackets: run.packets.filter(p => p.presentation).length, canonicalPackets: run.packets.filter(p => p.proof === 'canonical-packet').length, externalCandidatePackets: run.packets.filter(p => p.proof === 'external-candidate').length,
        alignmentUnmeasuredPackets: run.packets.filter(p => p.proof === 'alignment-unmeasured').length, alignmentReasons: [...new Set(run.packets.map(p => p.reason).filter(Boolean))] })), candidates, siteSignals, journal }
    return summary
  } finally {
    const absolute = realpathSync(scratch), parent = realpathSync(tmpdir())
    if (dirname(absolute) === parent && basename(absolute).startsWith('musify-audit-analysis-')) rmSync(absolute, { recursive: true, force: true })
  }
}

export function main(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    if (!['--audit', '--oracle', '--journal', '--offsets', '--output'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: node scripts/analyze-capture-audit.mjs --audit DIR --oracle DIR [--journal DIR] [--offsets JSON] --output FILE_IN_.local_DIR')
    options[args[i].slice(2)] = args[++i]
  }
  if (!options.audit || !options.oracle || !options.output || !privateOutput(options.output)) throw new Error('Explicit audit/oracle inputs and an ignored .local output directory are required')
  const output = resolve(options.output)
  for (const directory of [options.audit, options.oracle, options.journal].filter(Boolean)) {
    const rel = relative(resolve(directory), output)
    if (!rel || (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== '..')) throw new Error('Analysis output cannot replace or enter a source evidence directory')
  }
  const result = analyzeAudit({ auditDirectory: options.audit, oracleDirectory: options.oracle, journalDirectory: options.journal, offsets: options.offsets ? JSON.parse(readFileSync(options.offsets, 'utf8')) : {} })
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  process.stdout.write(JSON.stringify({ output: basename(output), ...result.counts, observedMaximumCandidateDelayMs: result.observedMaximumCandidateDelayMs, semanticAdVerification: false }) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
