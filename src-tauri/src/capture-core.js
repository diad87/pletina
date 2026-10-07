// Capture API 3. No site selectors; normal mode quarantines complete sources until verified.
(() => {
  class CaptureError extends Error {
    constructor(code, message) { super(`${code}: ${message}`); this.name = 'CaptureError'; this.code = code }
  }
  const fail = (code, message) => { throw new CaptureError(code, message) }
  // Comparing two calculations of the same media timestamp needs only floating-
  // point roundoff, not codec quantum or the ledger's presentation tolerance.
  const timeAtOrAfter = (actual, expected) => Number.isFinite(actual) && Number.isFinite(expected) &&
    (actual >= expected || expected - actual <= 4 * Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected)))
  // Chromium's terminal native clock can truncate a rational sample timestamp to
  // whole microseconds. This is only a candidate: finish must still prove EOF,
  // immutable bytes, native ranges and the clean presentation before authorizing it.
  const nativeFinalClockCandidate = (snapshot, end) => {
    const clock = snapshot?.position, range = snapshot?.audioRanges?.at(-1)
    return Number.isFinite(clock) && Number.isFinite(end) && clock >= 0 &&
      snapshot.ended === true && snapshot.paused === true && snapshot.sourceEnded === true &&
      snapshot.successfulEndOfStream === true && snapshot.sourceReadyState === 'ended' &&
      snapshot.source?.successfulEndOfStream === true && snapshot.source?.native?.readyState === 'ended' &&
      snapshot.seeking === false && snapshot.playbackRate === 1 && snapshot.updating === false && snapshot.readyState >= 2 &&
      clock === snapshot.duration && clock === Math.round(clock * 1e6) / 1e6 &&
      end > clock && end - clock < 0.000001 && Math.floor(end * 1e6) / 1e6 === clock &&
      Number.isFinite(range?.end) && Math.abs(range.end - end) <= 0.000001
  }
  const copy = (data) => ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(data).slice()
  const join = (chunks) => {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
    let at = 0
    for (const c of chunks) { out.set(c, at); at += c.byteLength }
    return out
  }
  const settingsOf = (settings = {}) => ({ timestampOffset: settings.timestampOffset ?? 0, appendWindowStart: settings.appendWindowStart ?? 0, appendWindowEnd: (settings.appendWindowEnd ?? Infinity) === Infinity ? null : settings.appendWindowEnd, mode: settings.mode ?? 'segments' })
  const defaultSettings = (s) => s.timestampOffset === 0 && s.appendWindowStart === 0 && s.appendWindowEnd === null && s.mode === 'segments'
  const nativeRanges = (buffer) => {
    const ranges = []
    try { for (let i = 0; i < (buffer?.buffered?.length ?? 0); i++) ranges.push({ start: buffer.buffered.start(i), end: buffer.buffered.end(i) }) } catch { return [] }
    return ranges
  }
  function projectTimeline(parsed, settings, ranges) {
    if (parsed.codedFrames) {
      // Chromium's WebM SourceBuffer ranges use coded PTS+packet duration; codec delay
      // and discard padding are consumed by the decoder, not subtracted from buffered.
      // Keep both inventories, and require the clock to cover the longer coded range.
      parsed = { ...parsed, containerAudibleRange: { start: parsed.start, end: parsed.end }, frames: parsed.codedFrames, start: parsed.codedStart, end: parsed.codedEnd }
    }
    if (defaultSettings(settings)) return { ...parsed, timelineSettings: settings }
    // MSE §5.5.8 permits full-frame dropping or optional audio boundary splicing.
    // Predict both, then require the actual official AUDIO SourceBuffer to select a range.
    // Excluded bytes are retained and must be replayed with this exact immutable tuple.
    const from = settings.appendWindowStart, until = settings.appendWindowEnd ?? Infinity
    const shifted = parsed.frames.map(f => ({ start: f.start + settings.timestampOffset, end: f.end + settings.timestampOffset }))
    const drop = shifted.filter(f => f.start >= from - 1e-9 && f.end <= until + 1e-9)
    const splice = shifted.filter(f => f.end > from && f.start < until).map(f => ({ start: Math.max(from, f.start), end: Math.min(until, f.end) }))
    const epsilon = parsed.quantum + 0.000001, actual = ranges?.[0]
    const predictions = [drop, splice].filter(frames => frames.length && frames[0].start <= epsilon && frames[0].start >= -epsilon && ranges?.length === 1 && Number.isFinite(actual?.start) && Number.isFinite(actual?.end) && Math.abs(actual.start - frames[0].start) <= epsilon && Math.abs(actual.end - frames.at(-1).end) <= epsilon && frames.every((f, i) => !i || Math.abs(f.start - frames[i - 1].end) <= epsilon))
    if (!predictions.length) fail('CAPTURE_UNSUPPORTED_APPEND_WINDOW', `Official audio ranges match neither complete-frame discard nor boundary splice: settings=${JSON.stringify(settings)}, rawStart=${parsed.start}, rawEnd=${parsed.end}, drop=${drop.length ? `${drop[0].start}..${drop.at(-1).end}` : 'empty'}, splice=${splice.length ? `${splice[0].start}..${splice.at(-1).end}` : 'empty'}, native=${JSON.stringify(ranges)}, quantum=${parsed.quantum}`)
    predictions.sort((a, b) => b.at(-1).end - a.at(-1).end)
    const frames = predictions[0]
    return { ...parsed, frames, start: frames[0].start, end: frames.at(-1).end, timelineSettings: settings }
  }

  // Restricted demux inspection. buffered ranges alone hide overwritten/duplicate frames.
  // Unsupported structures fail closed instead of pretending that every byte was presented.
  function parseWebMOpus(bytes, options = {}) {
    const error = (message) => fail('CAPTURE_UNSUPPORTED_WEBM', message)
    const incomplete = {}
    let pending = false
    const vint = (at, id = false) => {
      if (at >= bytes.length && options.prefix) throw incomplete
      const first = bytes[at]
      if (!first) error('Invalid or truncated EBML integer')
      let width = 1
      while (width <= 8 && !(first & (0x80 >> (width - 1)))) width++
      if (width > (id ? 4 : 8)) error('Truncated EBML integer')
      if (at + width > bytes.length) { if (options.prefix) throw incomplete; error('Truncated EBML integer') }
      let value = id ? first : first & (0xff >> width)
      let unknown = !id && value === (0xff >> width)
      for (let i = 1; i < width; i++) { value = value * 256 + bytes[at + i]; unknown &&= bytes[at + i] === 255 }
      if (!unknown && !Number.isSafeInteger(value)) error('Oversized EBML integer')
      return { value, width, unknown }
    }
    const element = (at, limit, mseSegment = false, streamingParent = false) => {
      const id = vint(at, true), size = vint(at + id.width)
      const start = at + id.width + size.width, declaredEnd = size.unknown ? Infinity : start + size.value
      // MSE WebM §3 defines this as an initialization header, not a complete file.
      // Its finite size only has to cover Info+Tracks; unappended Cues are not media.
      // Every child still has to fit in the bytes actually appended to SourceBuffer.
      let end = mseSegment && id.value === 0x18538067 ? limit : size.unknown ? limit : declaredEnd
      const partial = end > bytes.length
      if (options.prefix && streamingParent && partial) {
        if (id.value !== 0x1f43b675) throw incomplete
        end = bytes.length; pending = true
      }
      if (end > limit || start > limit) error(`Truncated EBML element id=0x${id.value.toString(16)} offset=${at} expectedEnd=${declaredEnd} parentEnd=${limit} actualLength=${bytes.length}`)
      if (options.prefix && partial && !streamingParent) throw incomplete
      return { id: id.value, at, start, end, declaredEnd, unknown: size.unknown, partial }
    }
    const uint = (el) => {
      if (el.unknown || el.end - el.start > 6) error('Unsupported integer size')
      let value = 0
      for (let i = el.start; i < el.end; i++) value = value * 256 + bytes[i]
      return value
    }
    const signed = (el) => {
      let value = 0n
      for (let i = el.start; i < el.end; i++) value = (value << 8n) | BigInt(bytes[i])
      if (bytes[el.start] & 128) value -= 1n << BigInt((el.end - el.start) * 8)
      const number = Number(value)
      if (!Number.isSafeInteger(number)) error('Oversized signed integer')
      return number
    }
    const children = (start, end, visit) => {
      for (let at = start; at < end;) {
        const el = element(at, end)
        if (el.unknown) error('Unknown-size nested element')
        visit(el); at = el.end
      }
    }
    const text = (el) => String.fromCharCode(...bytes.subarray(el.start, el.end))
    const opusDuration = (start, end) => {
      if (start >= end) error('Empty Opus packet')
      const toc = bytes[start], config = toc >> 3, mode = toc & 3
      const frameMs = config >= 16 ? 2.5 * (1 << (config & 3)) : config >= 12 ? 10 * (1 << (config & 1)) : (config & 3) === 3 ? 60 : 10 * (1 << (config & 3))
      if (mode === 3 && start + 1 >= end) error('Truncated Opus packet')
      const count = mode === 0 ? 1 : mode === 3 ? bytes[start + 1] & 63 : 2
      if (!count || count * frameMs > 120) error('Invalid Opus frame count')
      return count * frameMs / 1000
    }
    let scale = 1e6, track = null, headerSeen = false, infoSeen = false, tracksSeen = false, segmentSeen = false
    const frames = [], codedFrames = [], samples = []
    let headerBytes = null, infoBytes = null, tracksBytes = null
    let lastBlock = null
    const levelOne = new Set([0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0x1c53bb6b, 0x1254c367, 0x1941a469, 0x1043a770])
    const block = (el, clock, padding = 0, unit = el) => {
      if (!track || clock === null) error('Block before track or cluster timestamp')
      const number = vint(el.start), at = el.start + number.width
      if (number.value !== track.number || at + 3 > el.end) error('Unknown track or truncated block')
      if (bytes[at + 2] & 6) error('Laced blocks need a separately verified parser')
      let relative = bytes[at] * 256 + bytes[at + 1]
      if (relative >= 32768) relative -= 65536
      const codedStart = (clock + relative) * scale / 1e9, rawStart = codedStart - track.delay
      const length = opusDuration(at + 3, el.end)
      if (padding < 0) error('Negative discard padding is not supported')
      const start = Math.max(0, rawStart), end = rawStart + length - padding / 1e9
      if (end <= start) error('Invalid coded-frame range')
      frames.push({ start, end })
      codedFrames.push({ start: codedStart, end: codedStart + length })
      if (options.inventory) samples.push({ offset: unit.at, size: unit.end - unit.at, clock, start: codedStart, end: codedStart + length, audibleStart: start, audibleEnd: end, padding })
      lastBlock = { codedStart, packetDuration: length, codecDelay: track.delay, discardPadding: padding / 1e9, codedEnd: codedStart + length, audibleStart: start, audibleEnd: end }
    }
    const cluster = (el) => {
      let at = el.start, clock = null
      while (at < el.end) {
        // A partial outer Cluster does not make a partial Block/BlockGroup valid.
        // Its full child must be present before it can enter the sample inventory.
        const child = element(at, el.unknown && options.prefix ? Infinity : el.partial ? el.declaredEnd : el.end)
        if (el.unknown && levelOne.has(child.id)) break
        if (child.unknown) error('Unknown-size cluster child')
        if (child.id === 0xe7) clock = uint(child)
        else if (child.id === 0xa3) block(child, clock)
        else if (child.id === 0xa0) {
          let media = null, padding = 0
          children(child.start, child.end, (entry) => {
            if (entry.id === 0xa1) { if (media) error('Multiple blocks in one group'); media = entry }
            else if (entry.id === 0x75a2) padding = signed(entry)
            else if (![0x9b, 0xfb, 0xfa, 0xec, 0xbf].includes(entry.id)) error('Unsupported block-group metadata')
          })
          if (!media) error('Block group without media')
          block(media, clock, padding, child)
        } else if (![0xa7, 0xab, 0xec, 0xbf].includes(child.id)) error('Unsupported cluster element')
        at = child.end
      }
      return at
    }
    const segment = (el) => {
      for (let at = el.start; at < el.end;) {
        const child = element(at, el.end, false, !!options.prefix)
        if (child.id === 0x1549a966) {
          if (infoSeen || tracksSeen || child.end > el.declaredEnd) error('Invalid or repeated initialization timing')
          infoSeen = true
          infoBytes = bytes.subarray(child.at, child.end)
          children(child.start, child.end, (entry) => { if (entry.id === 0x2ad7b1) scale = uint(entry) })
          if (!scale || scale > 1e6) error('Timestamp scale is too coarse to verify packet continuity')
        } else if (child.id === 0x1654ae6b) {
          if (!infoSeen || tracksSeen || child.end > el.declaredEnd) error('Invalid or repeated initialization tracks')
          tracksSeen = true
          tracksBytes = bytes.subarray(child.at, child.end)
          children(child.start, child.end, (entry) => {
            if (entry.id !== 0xae) return
            const next = { number: 0, type: 0, codec: '', delay: 0, preroll: 0 }
            children(entry.start, entry.end, (field) => {
              if (field.id === 0xd7) next.number = uint(field)
              if (field.id === 0x83) next.type = uint(field)
              if (field.id === 0x86) next.codec = text(field)
              if (field.id === 0x56aa) next.delay = uint(field) / 1e9
              if (field.id === 0x56bb) next.preroll = uint(field) / 1e9
            })
            if (track || next.type !== 2 || next.codec !== 'A_OPUS' || !next.number) error('Only a single Opus audio track is verified')
            track = next
          })
        } else if (child.id === 0x1f43b675) { at = cluster(child); continue }
        else if (![0x114d9b74, 0x1c53bb6b, 0x1254c367, 0x1941a469, 0x1043a770, 0xec, 0xbf].includes(child.id)) error('Unsupported segment element or repeated initialization')
        if (child.unknown) error('Unknown-size non-cluster element')
        at = child.end
      }
    }
    try {
      for (let at = 0; at < bytes.length;) {
        const el = element(at, bytes.length, true, !!options.prefix)
        if (el.id === 0x1a45dfa3 && !headerSeen && !segmentSeen && !el.unknown) { headerSeen = true; headerBytes = bytes.subarray(el.at, el.end) }
        else if (el.id === 0x18538067 && headerSeen && !segmentSeen) { segmentSeen = true; segment(el) }
        else error('Missing or repeated WebM initialization')
        at = el.end
      }
    } catch (e) { if (e !== incomplete) throw e; pending = true }
    if (!headerSeen || !track || !frames.length) {
      if (!options.prefix) error('Incomplete WebM/Opus source')
      if (!track) return { pending: true, samples: [], init: null }
    }
    let until = 0
    for (const frame of frames) {
      // WebM rounds timestamps to TimestampScale. Permit only that quantization error.
      if (Math.abs(frame.start - until) > Math.max(scale / 1e9, 0.000001) + 1e-9 && !(options.allowGaps && frame.start > until)) fail('CAPTURE_AMBIGUOUS_TIMELINE', 'Gap, overlap or overwritten coded frames')
      until = frame.end
    }
    let codedUntil = 0
    for (const frame of codedFrames) {
      if (Math.abs(frame.start - codedUntil) > Math.max(scale / 1e9, 0.000001) + 1e-9 && !(options.allowGaps && frame.start > codedUntil)) fail('CAPTURE_AMBIGUOUS_TIMELINE', 'Gap, overlap or overwritten coded timestamps')
      codedUntil = frame.end
    }
    const result = { frames, start: frames[0]?.start ?? 0, end: until, codedFrames, codedStart: codedFrames[0]?.start ?? 0, codedEnd: codedUntil, lastBlock, codec: track.codec, quantum: scale / 1e9 }
    if (options.inventory) Object.assign(result, { pending, samples, bytes, seekPreRoll: track.preroll, init: headerBytes && infoBytes && tracksBytes ? join([headerBytes, Uint8Array.of(0x18, 0x53, 0x80, 0x67, 0xff), infoBytes, tracksBytes]) : null })
    return result
  }

  const ebmlSize = value => {
    for (let width = 1; width <= 6; width++) if (value < 2 ** (7 * width) - 1) {
      const out = new Uint8Array(width)
      for (let i = width - 1; i >= 0; i--) { out[i] = value % 256; value = Math.floor(value / 256) }
      out[0] |= 1 << (8 - width); return out
    }
    fail('CAPTURE_UNSUPPORTED_WEBM', 'Remux EBML element is too large')
  }
  const ebmlInteger = value => {
    if (!Number.isSafeInteger(value) || value < 0) fail('CAPTURE_UNSUPPORTED_WEBM', 'Invalid remux timestamp')
    const out = []
    do { out.unshift(value % 256); value = Math.floor(value / 256) } while (value)
    return Uint8Array.from(out)
  }
  const ebmlElement = (id, parts) => { const body = join(parts); return join([Uint8Array.from(id), ebmlSize(body.length), body]) }
  function remuxWebM(inventory, first, count) {
    if (!inventory?.init || !Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 0 || count <= 0 || first + count > inventory.samples.length) fail('CAPTURE_UNSUPPORTED_WEBM', 'Invalid remux sample selection')
    const selected = inventory.samples.slice(first, first + count), clusters = []
    let clock = null, parts = []
    const flush = () => { if (parts.length) clusters.push(ebmlElement([0x1f, 0x43, 0xb6, 0x75], [ebmlElement([0xe7], [ebmlInteger(clock)]), ...parts])) }
    for (const sample of selected) {
      if (sample.offset + sample.size > inventory.bytes.length) fail('CAPTURE_UNSUPPORTED_WEBM', 'Incomplete remux sample')
      if (clock !== sample.clock) { flush(); parts = []; clock = sample.clock }
      parts.push(inventory.bytes.subarray(sample.offset, sample.offset + sample.size))
    }
    flush()
    return { init: inventory.init, media: join(clusters), frames: count, start: selected[0].start, end: selected.at(-1).end }
  }
  const inspectWebMPrefix = (bytes, { final = false, allowGaps = false } = {}) => parseWebMOpus(bytes, { prefix: !final, inventory: true, allowGaps })

  class SessionTracker {
    constructor({ maxBytes = 96 * 1024 * 1024, onDiagnostic = () => {} } = {}) {
      this.maxBytes = maxBytes; this.onDiagnostic = onDiagnostic; this.sources = new Map()
      this.nextSource = 0; this.nextBuffer = 0; this.bytes = 0
    }
    createSource() {
      const source = { id: ++this.nextSource, state: 'unknown', buffers: [], seen: new Set(), observations: [], sealed: false, error: null, successfulEndOfStream: false }
      this.sources.set(source.id, source); return source
    }
    createBuffer(source, mime) {
      source.parsedTimeline = null; source.projectedTimeline = null
      const webm = /^audio\/webm\s*;\s*codecs\s*=\s*["']?opus["']?\s*$/i.test(mime)
      const aac = /^audio\/mp4\s*;\s*codecs\s*=\s*["']?mp4a\.40\.2["']?\s*$/i.test(mime)
      const parser = webm ? parseWebMOpus : aac ? globalThis.__musifyCaptureMp4?.parse : null
      const buffer = { id: ++this.nextBuffer, mime, chunks: [], source, parser, webm }
      source.buffers.push(buffer)
      if (!parser) this.reject(source, 'CAPTURE_UNSUPPORTED_FORMAT', `Unverified audio format or missing parser: ${mime}`)
      if (source.buffers.length !== 1) this.reject(source, 'CAPTURE_AMBIGUOUS_SOURCE', 'Multiple audio buffers in one source')
      return buffer
    }
    reject(source, code, reason) {
      source.state = 'ambiguous'; source.error ||= new CaptureError(code, reason)
      source.parsedTimeline = null; source.projectedTimeline = null
      this.onDiagnostic({ state: source.state, source: source.id, code, reason, bytesQuarantined: this.bytes })
    }
    append(buffer, data, settings = {}) {
      const source = buffer.source
      if (source.sealed) return this.reject(source, 'CAPTURE_AMBIGUOUS_SOURCE', 'Append after source was sealed')
      source.successfulEndOfStream = false
      source.parsedTimeline = null; source.projectedTimeline = null
      const tuple = settingsOf(settings)
      if (!Number.isFinite(tuple.timestampOffset) || !Number.isFinite(tuple.appendWindowStart) || tuple.appendWindowStart < 0 || (tuple.appendWindowEnd !== null && (!Number.isFinite(tuple.appendWindowEnd) || tuple.appendWindowEnd <= tuple.appendWindowStart)) || tuple.mode !== 'segments') return this.reject(source, 'CAPTURE_UNSUPPORTED_TIMELINE', `Invalid SourceBuffer timeline settings: ${JSON.stringify(tuple)}, mime=${buffer.mime}`)
      if (buffer.webm && !defaultSettings(tuple)) return this.reject(source, 'CAPTURE_UNSUPPORTED_TIMELINE', `Non-default WebM/Opus timeline settings require a separate browser probe: ${JSON.stringify(tuple)}`)
      if (buffer.timelineSettings && JSON.stringify(buffer.timelineSettings) !== JSON.stringify(tuple)) return this.reject(source, 'CAPTURE_UNSUPPORTED_TIMELINE', `SourceBuffer settings changed: previous=${JSON.stringify(buffer.timelineSettings)}, current=${JSON.stringify(tuple)}, mime=${buffer.mime}`)
      buffer.timelineSettings ||= tuple
      if (source.error || source.state === 'ad') return
      const bytes = copy(data)
      if (this.bytes + bytes.byteLength > this.maxBytes) return this.reject(source, 'CAPTURE_QUARANTINE_LIMIT', 'Quarantined audio exceeded the memory budget')
      this.bytes += bytes.byteLength; buffer.chunks.push(bytes)
    }
    observe(source, evidence, { position, now, duration, ended = false, element = null }) {
      if (!source || source.sealed) return
      if (element && source.element && source.element !== element) this.reject(source, 'CAPTURE_AMBIGUOUS_SOURCE', 'One source was presented by multiple elements')
      source.element ||= element
      const content = evidence?.state === 'content' && evidence.sourceBound === true && evidence.signals?.length >= 2
      const observed = content ? 'content' : evidence?.state === 'ad' && evidence.sourceBound === true ? 'ad' : 'unknown'
      source.seen.add(observed)
      if (observed === 'unknown' || source.seen.size > 1) this.reject(source, 'CAPTURE_IDENTITY_UNCERTAIN', `Unknown or mixed identity while this source was presented; seen=${[...source.seen].join(',')}; evidence=${evidence?.reason || JSON.stringify(evidence?.evidence ?? {})}`)
      else if (!source.error) source.state = observed
      if (observed === 'ad') this.drop(source)
      if (observed === 'content' && !source.error) {
        const last = source.observations.at(-1)
        if (!Number.isFinite(position) || !Number.isFinite(now) || !Number.isFinite(duration) || duration <= 0) this.reject(source, 'CAPTURE_PARTIAL_PRESENTATION', 'Missing finite presentation timing')
        else if (!last && position > 0.05) this.reject(source, 'CAPTURE_PARTIAL_PRESENTATION', 'The beginning of this source was not observed')
        else if (last && (position < last.position - 0.001 || position - last.position > (now - last.now) / 1000 + 0.15 || (position > last.position && now - last.now > 500))) this.reject(source, 'CAPTURE_PARTIAL_PRESENTATION', 'Seek, accelerated presentation or an unobserved interval')
        else source.observations.push({ position, now, duration, ended })
      }
      this.onDiagnostic({ state: source.state, source: source.id, position, duration, bytesQuarantined: this.bytes })
    }
    drop(source) {
      source.parsedTimeline = null; source.projectedTimeline = null
      for (const buffer of source.buffers) { this.bytes -= buffer.chunks.reduce((n, c) => n + c.byteLength, 0); buffer.chunks = [] }
    }
    inspect(source, ranges = null) {
      if (source.buffers.length !== 1 || !source.buffers[0].parser) fail('CAPTURE_UNSUPPORTED_FORMAT', 'Exactly one parsed audio buffer is required')
      const buffer = source.buffers[0]
      const actual = ranges ?? nativeRanges(buffer.native), key = JSON.stringify(actual)
      if (source.successfulEndOfStream && source.projectedTimeline?.key === key) return source.projectedTimeline.value
      const parsed = source.parsedTimeline ?? buffer.parser(join(buffer.chunks))
      const result = projectTimeline(parsed, buffer.timelineSettings ?? settingsOf(), actual)
      // EOF makes the byte inventory final; do not repeatedly concatenate/parse a song
      // while waiting for its clock to reach the final audio frame. Native ranges remain
      // part of the cache key so eviction or changed coverage cannot reuse stale proof.
      if (source.successfulEndOfStream) { source.parsedTimeline = parsed; source.projectedTimeline = { key, value: result } }
      return result
    }
    seal(source, terminal = null) {
      if (!source || source.sealed) fail('CAPTURE_AMBIGUOUS_SOURCE', 'Missing or already sealed source')
      source.sealed = true
      if (source.error) throw source.error
      if (source.state !== 'content' || source.seen.size !== 1) fail('CAPTURE_IDENTITY_UNCERTAIN', 'Source is not confirmed content')
      const first = source.observations[0], last = source.observations.at(-1)
      if (!first || !last || (!terminal && (!last.ended || Math.abs(last.position - last.duration) > 0.05))) fail('CAPTURE_PARTIAL_PRESENTATION', 'Complete presentation was not observed')
      if (source.buffers.length !== 1) fail('CAPTURE_UNSUPPORTED_FORMAT', 'Exactly one audio buffer is required')
      const buffer = source.buffers[0], timeline = this.inspect(source, terminal?.audioRanges)
      const epsilon = timeline.quantum + 0.000001
      if (terminal) {
        // The complete captured buffer might be only the downloaded prefix of a song.
        // A full clock/range match is insufficient until the official source declares EOF.
        const nativeEnded = terminal.ended === true && Math.abs(last.position - last.duration) <= epsilon
        if (!nativeEnded && terminal.sourceEnded !== true) fail('CAPTURE_PARTIAL_PRESENTATION', `Official source completion was not observed: clock=${last.position}, duration=${last.duration}, nativeEnded=${terminal.ended}, audioEnd=${timeline.end}, MediaSource.readyState=${terminal.sourceReadyState}, successfulEndOfStream=${terminal.successfulEndOfStream}`)
        const range = terminal.audioRanges?.[0]
        if (terminal.source !== source || terminal.position !== last.position || terminal.seeking !== false || terminal.playbackRate !== 1 || terminal.readyState < 2 || terminal.updating !== false || terminal.audioRanges?.length !== 1 || !range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || Math.abs(range.start - timeline.start) > epsilon || Math.abs(range.end - timeline.end) > epsilon || last.position + epsilon < timeline.end || timeline.end > last.duration + epsilon) fail('CAPTURE_PARTIAL_PRESENTATION', `Pre-detach clock/ranges do not prove complete audio: clock=${last.position}, duration=${last.duration}, start=${timeline.start}, end=${timeline.end}, quantum=${timeline.quantum}, audioRanges=${JSON.stringify(terminal.audioRanges)}, seeking=${terminal.seeking}, rate=${terminal.playbackRate}, readyState=${terminal.readyState}, updating=${terminal.updating}`)
      }
      if (timeline.start > timeline.quantum || (!terminal && Math.abs(timeline.end - last.duration) > epsilon)) fail('CAPTURE_UNPRESENTED_BYTES', `Coded audio does not match the complete presentation: start=${timeline.start}, end=${timeline.end}, duration=${last.duration}, quantum=${timeline.quantum}`)
      return { source: source.id, session: buffer.id, mime: buffer.mime, chunks: buffer.chunks, timeline, timelineSettings: buffer.timelineSettings ?? settingsOf() }
    }
  }

  const mergeRanges = (ranges, epsilon = 0) => {
    const result = []
    for (const r of ranges.filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start).sort((a, b) => a.start - b.start)) {
      const last = result.at(-1)
      if (last && r.start <= last.end + epsilon) last.end = Math.max(last.end, r.end)
      else result.push({ start: r.start, end: r.end })
    }
    return result
  }
  const covers = (ranges, start, end, epsilon = 0) => ranges.some(r => start >= r.start - epsilon && end <= r.end + epsilon)
  // API 3 distinguishes the byte inventory from presentation coverage. A download gap
  // is permitted in an inventory after an explicit seek, but is never filled in coverage.
  class ProgressiveTracker extends SessionTracker {
    constructor({ epoch, experimental = false, ...options } = {}) {
      super(options)
      if (!Number.isSafeInteger(epoch) || epoch < 1) fail('CAPTURE_PROTOCOL_MISMATCH', 'Missing native capture epoch')
      this.epoch = epoch; this.experimental = experimental === true; this.nextUnit = 0; this.coverage = []; this.initializations = []; this.seek = null
    }
    createSource() {
      const source = super.createSource()
      source.progress = { epoch: this.epoch, ranges: [], emitted: new Set() }
      return source
    }
    createBuffer(source, mime) {
      const buffer = super.createBuffer(source, mime)
      buffer.inspectPrefix = buffer.webm ? inspectWebMPrefix : globalThis.__musifyCaptureMp4?.inspectPrefix
      buffer.remux = buffer.webm ? remuxWebM : globalThis.__musifyCaptureMp4?.remux
      buffer.version = 0
      return buffer
    }
    append(buffer, data, settings) {
      if (buffer.resetAfterSeek) {
        const init = buffer.prefix?.value?.init
        this.bytes -= buffer.chunks.reduce((n, c) => n + c.byteLength, 0)
        buffer.chunks = []; buffer.resetInit = init?.slice(); buffer.awaitingStart = true
        buffer.timelineSettings = null
        buffer.resetAfterSeek = false
      }
      buffer.version++; buffer.prefix = null
      super.append(buffer, data, settings)
      if (buffer.awaitingStart && !buffer.source.error) {
        const input = join(buffer.chunks)
        if (input.length >= 8) {
          const initialization = buffer.webm ? input[0] === 0x1a && input[1] === 0x45 && input[2] === 0xdf && input[3] === 0xa3 : String.fromCharCode(...input.subarray(4, 8)) === 'ftyp'
          if (!initialization && buffer.resetInit) { buffer.chunks.unshift(buffer.resetInit); this.bytes += buffer.resetInit.length }
          buffer.resetInit = null; buffer.awaitingStart = false
        }
      }
    }
    beginEpoch(epoch, at) {
      if (!Number.isSafeInteger(epoch) || epoch <= this.epoch || !Number.isFinite(at) || at < 0) fail('CAPTURE_PROTOCOL_MISMATCH', 'Seek epoch must advance and have a finite target')
      this.epoch = epoch; this.seek = { at, assigned: false, active: true }
      for (const source of this.sources.values()) {
        source.observations = []; source.progress = { epoch, ranges: [], emitted: new Set() }
      }
    }
    restartBeginning(source) {
      if (source.error || source.observations.length || source.progress.emitted.size) fail('CAPTURE_PARTIAL_PRESENTATION', 'Cannot repair an already observed presentation by rewinding')
      this.seek = { at: 0, assigned: false, active: true, startup: true }
    }
    onTimeAssignment(source, element, value) {
      if (!this.seek?.active || this.seek.assigned || source?.error || Math.abs(value - this.seek.at) > 0.000001) return false
      if (!this.seek.startup) {
        try { this.inventory(source) } catch { return false }
        for (const buffer of source.buffers) {
          buffer.preSeekRanges = { native: buffer.native, source, tuple: JSON.stringify(buffer.timelineSettings ?? settingsOf()), ranges: nativeRanges(buffer.native) }
          buffer.resetAfterSeek = true
        }
      }
      this.seek.assigned = true
      return true
    }
    onSeekMutation(buffer, operation) {
      if (!this.seek?.active || !this.seek.assigned || buffer.source.error || !['abort', 'remove'].includes(operation)) return false
      // A successful abort can discard the tail of the official parser input. Keep a
      // previous complete inventory available for a buffered seek; rebuild from init if
      // the site subsequently appends a new range. No partial parser input is reused.
      try { this.inventory(buffer.source) } catch { return false }
      if (operation === 'abort') buffer.resetAfterSeek = true
      return true
    }
    observe(source, evidence, { position, now, duration, element = null, playbackRate = 1, seeking = false } = {}) {
      if (!source || source.sealed || seeking) return
      if (element && source.element && source.element !== element) this.reject(source, 'CAPTURE_AMBIGUOUS_SOURCE', 'One source was presented by multiple elements')
      source.element ||= element
      const content = evidence?.state === 'content' && evidence.sourceBound === true && evidence.signals?.length >= 2
      const state = content ? 'content' : evidence?.state === 'ad' && evidence.sourceBound === true ? 'ad' : 'unknown'
      source.seen.add(state)
      if (state === 'unknown' || source.seen.size > 1) this.reject(source, 'CAPTURE_IDENTITY_UNCERTAIN', `Unconfirmed presentation interval; seen=${[...source.seen]}; evidence=${evidence?.reason ?? JSON.stringify(evidence?.evidence ?? {})}`)
      else if (!source.error) source.state = state
      if (state === 'ad') this.drop(source)
      if (content && !source.error) {
        const last = source.observations.at(-1)
        if (!Number.isFinite(position) || !Number.isFinite(now) || !Number.isFinite(duration) || duration <= 0 || position < 0 || playbackRate !== 1) this.reject(source, 'CAPTURE_PARTIAL_PRESENTATION', 'Progressive presentation needs finite timing at rate 1')
        else if (last && (position < last.position - 0.001 || position - last.position > (now - last.now) / 1000 + 0.15 || (position > last.position && now - last.now > 500))) this.reject(source, 'CAPTURE_PARTIAL_PRESENTATION', 'Unrequested seek or unobserved progressive interval')
        else {
          if (last && position > last.position) source.progress.ranges = mergeRanges([...source.progress.ranges, { start: last.position, end: position }])
          source.observations.push({ position, now, duration })
          if (this.seek?.assigned) this.seek.active = false
        }
      }
      this.onDiagnostic({ state: source.state, source: source.id, epoch: this.epoch, position, duration, playbackRate, browserNow: now, bytesQuarantined: this.bytes })
    }
    inventory(source, final = false) {
      const buffer = source.buffers[0]
      if (source.buffers.length !== 1 || !buffer?.inspectPrefix || !buffer.remux) fail('CAPTURE_UNSUPPORTED_FORMAT', 'Progressive capture requires a verified sample parser and remuxer')
      if (buffer.awaitingStart) {
        if (final) fail('CAPTURE_PARTIAL_PRESENTATION', 'EOF before a seek initialization header became complete')
        return { pending: true, samples: [], init: null }
      }
      if (buffer.prefix?.version === buffer.version && (!final || buffer.prefix.final)) return buffer.prefix.value
      const value = buffer.inspectPrefix(join(buffer.chunks), { final, allowGaps: !!this.seek && !this.seek.startup })
      buffer.prefix = { version: buffer.version, final, value }
      return value
    }
    initializationKey(init, settings) {
      const tuple = JSON.stringify(settings)
      let index = this.initializations.findIndex(entry => entry.tuple === tuple && entry.init.length === init.length && entry.init.every((b, i) => b === init[i]))
      if (index < 0) { index = this.initializations.length; this.initializations.push({ tuple, init: init.slice() }) }
      return `configuration-${index + 1}`
    }
    sampleRange(sample, settings) {
      const start = Math.max(settings.appendWindowStart, sample.start + settings.timestampOffset)
      const end = Math.min(settings.appendWindowEnd ?? Infinity, sample.end + settings.timestampOffset)
      return { start, end }
    }
    completeCertificate(source, buffer) {
      const certificate = source.completeCertificate
      if (!certificate || certificate.epoch !== this.epoch || source.progress.epoch !== this.epoch || certificate.buffer !== buffer || certificate.native !== buffer.native || certificate.version !== buffer.version || certificate.settings !== JSON.stringify(buffer.timelineSettings ?? settingsOf()) || !source.sealed) fail('CAPTURE_PARTIAL_PRESENTATION', 'The complete-source certificate no longer identifies this immutable source and epoch')
      return certificate
    }
    clockCovers(source, snapshot, end) {
      if (timeAtOrAfter(snapshot.position, end)) return true
      const proof = source.nativeFinalClock, buffer = source.buffers[0]
      return !!proof && proof.epoch === this.epoch && source.progress.epoch === this.epoch &&
        proof.buffer === buffer && proof.native === buffer.native && proof.nativeSource === source.native &&
        proof.version === buffer.version && proof.settings === JSON.stringify(buffer.timelineSettings ?? settingsOf()) &&
        proof.position === snapshot.position && proof.duration === snapshot.duration &&
        proof.ranges === JSON.stringify(snapshot.audioRanges) && source.observations.at(-1)?.position === snapshot.position &&
        nativeFinalClockCandidate(snapshot, proof.end) && timeAtOrAfter(proof.end, end)
    }
    pull(source, snapshot, { maxSeconds = 0.5, maxBytes = 4 * 1024 * 1024 } = {}) {
      if (!source || source.error) { if (source?.error) throw source.error; return [] }
      if (source.state !== 'content' || source.seen.size !== 1 || snapshot?.source !== source || snapshot.seeking !== false || snapshot.playbackRate !== 1 || snapshot.readyState < 2 || snapshot.updating !== false) return []
      if (!this.experimental && source.verifiedFinalEpoch !== this.epoch) return []
      const buffer = source.buffers[0], inventory = this.inventory(source)
      if (!inventory.init || !inventory.samples.length) return []
      const settings = buffer.timelineSettings ?? settingsOf(), coverageEpsilon = 0.000001, codecEpsilon = inventory.quantum + coverageEpsilon
      const certificate = this.experimental ? null : this.completeCertificate(source, buffer)
      if (certificate && (!this.clockCovers(source, snapshot, certificate.proof.timeline.end) || snapshot.audioRanges?.length !== 1 || Math.abs(snapshot.audioRanges[0].start - certificate.proof.timeline.start) > codecEpsilon || Math.abs(snapshot.audioRanges[0].end - certificate.proof.timeline.end) > codecEpsilon)) fail('CAPTURE_PARTIAL_PRESENTATION', 'The current native clock/range no longer covers the complete-source certificate')
      const units = [], available = inventory.samples.map(s => this.sampleRange(s, settings))
      const normalEmitted = []
      for (let first = 0; first < available.length;) {
        const eligible = index => {
          const r = available[index]
          return r.end > r.start && r.start >= 0 && this.clockCovers(source, snapshot, r.end) && !source.progress.emitted.has(index) && covers(source.progress.ranges, r.start, r.end, coverageEpsilon) && covers(snapshot.audioRanges ?? [], r.start, r.end, codecEpsilon)
        }
        if (!eligible(first)) { first++; continue }
        let until = first + 1, bytes = inventory.init.length + inventory.samples[first].size + 128
        if (certificate) {
          // Only a completely observed, sealed source may retain the same intraframe
          // timestamp quantization already accepted by API 2's strict parser. Keep
          // that connection INSIDE one remux unit; the ledger still joins at 1us.
          const quantum = Math.max(certificate.proof.timeline.quantum, coverageEpsilon) + 1e-9
          let exactCut = null
          while (true) {
            const more = until < available.length && eligible(until)
            const gap = more ? Math.abs(available[until].start - available[until - 1].end) : 0
            if (!more || gap <= coverageEpsilon) {
              exactCut = until
              if (!more || available[until - 1].end - available[first].start >= maxSeconds) break
            }
            if (gap > quantum) fail('CAPTURE_AMBIGUOUS_TIMELINE', 'A complete-source unit crosses more than certified codec quantization')
            const nextBytes = bytes + inventory.samples[until].size + 32
            if (nextBytes > maxBytes) {
              if (exactCut === null) fail('CAPTURE_UNIT_LIMIT', 'An indivisible codec-quantized chain exceeds the unit transport budget')
              until = exactCut; break
            }
            bytes = nextBytes; until++
          }
        } else {
          while (until < available.length && eligible(until) && Math.abs(available[until].start - available[until - 1].end) <= coverageEpsilon && available[until].end - available[first].start <= maxSeconds && bytes + inventory.samples[until].size + 32 <= maxBytes) { bytes += inventory.samples[until].size + 32; until++ }
        }
        const unit = ++this.nextUnit, media = buffer.remux(inventory, first, until - first, unit)
        const data = join([media.init, media.media])
        if (data.byteLength > maxBytes) fail('CAPTURE_UNIT_LIMIT', 'One verified unit exceeds the transport budget')
        const rangeStart = available[first].start, rangeEnd = available[until - 1].end
        for (let i = first; i < until; i++) { if (certificate) normalEmitted.push(i); else source.progress.emitted.add(i) }
        if (!certificate) this.coverage = mergeRanges([...this.coverage, { start: rangeStart, end: rangeEnd }], coverageEpsilon)
        units.push({ epoch: this.epoch, source: source.id, s: buffer.id, unit, initKey: this.initializationKey(media.init, settings), initBytes: media.init.length, mime: buffer.mime, rangeStart, rangeEnd, decodeStart: rangeStart, decodeEnd: rangeEnd, frames: until - first, timelineSettings: settings, data })
        first = until
      }
      // No units escape this call if a later indivisible chain fails. Do not credit
      // earlier prepared units until the entire normal-mode publication succeeds.
      if (certificate) {
        for (const index of normalEmitted) source.progress.emitted.add(index)
        this.coverage = mergeRanges([...this.coverage, ...units.map(unit => ({ start: unit.rangeStart, end: unit.rangeEnd }))], coverageEpsilon)
      }
      return units
    }
    finish(source, snapshot) {
      if (source?.error) throw source.error
      if (!source || source.state !== 'content' || source.seen.size !== 1 || snapshot?.source !== source || snapshot.seeking !== false || snapshot.playbackRate !== 1 || snapshot.updating !== false || snapshot.readyState < 2) fail('CAPTURE_PARTIAL_PRESENTATION', 'Native final state does not identify the captured source')
      const buffer = source.buffers[0], inventory = this.inventory(source, true), settings = buffer.timelineSettings ?? settingsOf(), coverageEpsilon = 0.000001, codecEpsilon = inventory.quantum + coverageEpsilon
      // Codec quantization can explain native buffered bounds. It cannot fill an
      // unobserved presentation interval or a hole between published epochs.
      const ranges = mergeRanges(inventory.samples.map(sample => this.sampleRange(sample, settings)), codecEpsilon), end = ranges.at(-1)?.end
      const prior = buffer.preSeekRanges
      const previousRanges = prior?.native === buffer.native && prior?.source === source && prior?.tuple === JSON.stringify(settings) ? prior.ranges : []
      const knownNativeRanges = mergeRanges([...ranges, ...previousRanges], coverageEpsilon)
      const nativeEnded = snapshot.ended === true && Math.abs(snapshot.position - snapshot.duration) <= codecEpsilon
      const knownNative = r => covers(ranges, r.start, r.end, codecEpsilon) || covers(knownNativeRanges, r.start, r.end, coverageEpsilon)
      const quantizedFinalClock = !timeAtOrAfter(snapshot.position, end) && nativeFinalClockCandidate(snapshot, end)
      if ((!snapshot.sourceEnded && !nativeEnded) || !Number.isFinite(end) || source.observations.at(-1)?.position !== snapshot.position || (!timeAtOrAfter(snapshot.position, end) && !quantizedFinalClock) || !snapshot.audioRanges?.length || !snapshot.audioRanges.every(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start && knownNative(r)) || Math.abs(snapshot.audioRanges.at(-1).end - end) > codecEpsilon) fail('CAPTURE_PARTIAL_PRESENTATION', `Final EOF/range proof is incomplete: end=${end}, clock=${snapshot.position}, duration=${snapshot.duration}, native=${JSON.stringify(snapshot.audioRanges)}, priorNative=${JSON.stringify(previousRanges)}, eof=${snapshot.sourceEnded}, ended=${snapshot.ended}, paused=${snapshot.paused}, sourceReadyState=${snapshot.sourceReadyState}, successfulEndOfStream=${snapshot.successfulEndOfStream}, quantizedFinalClock=${quantizedFinalClock}`)
      if (!this.experimental) {
        if (source.observations[0]?.position !== 0 || !covers(source.progress.ranges, 0, end, coverageEpsilon)) fail('CAPTURE_PARTIAL_PRESENTATION', 'Safe capture requires the whole source presentation from zero; a seek or missing beginning remains incomplete')
        if (!source.completeCertificate) {
          // Seal once, with the original complete-source parser (no seek-gap option),
          // one native audio range and immutable bytes/settings. Observation coverage
          // above remains exact; codec quantum never repairs an unobserved interval.
          const proof = super.seal(source, snapshot)
          source.completeCertificate = { epoch: this.epoch, buffer, native: buffer.native, version: buffer.version, settings: JSON.stringify(settings), proof }
        }
        const certificate = this.completeCertificate(source, buffer)
        if (snapshot.audioRanges.length !== 1 || Math.abs(snapshot.audioRanges[0].start - certificate.proof.timeline.start) > codecEpsilon || Math.abs(snapshot.audioRanges[0].end - certificate.proof.timeline.end) > codecEpsilon) fail('CAPTURE_PARTIAL_PRESENTATION', 'The native audio range changed after complete-source certification')
        source.verifiedFinalEpoch = this.epoch
      }
      if (quantizedFinalClock) {
        // Never authorize in pull from an ended-looking snapshot alone. This record
        // is issued only AFTER every final gate above succeeds, and cannot survive
        // another epoch, append, setting, native buffer, clock or range mutation.
        source.nativeFinalClock = { epoch: this.epoch, buffer, native: buffer.native, nativeSource: source.native, version: buffer.version, settings: JSON.stringify(settings), position: snapshot.position, duration: snapshot.duration, ranges: JSON.stringify(snapshot.audioRanges), end }
      }
      return { eof: true, complete: covers(this.coverage, 0, end, coverageEpsilon), duration: snapshot.duration, end, ranges: this.coverage.map(r => ({ ...r })) }
    }
  }

  function install({ scope = globalThis, tracker = new SessionTracker(), onBeforeDetach = () => {}, forcePlaybackRateOne = false, onRateAttempt = () => {} } = {}) {
    if (!scope.MediaSource || !scope.SourceBuffer) fail('CAPTURE_UNSUPPORTED_PIPELINE', 'Main-thread Media Source is unavailable')
    const mediaPrototype = scope.HTMLMediaElement?.prototype
    const rateStatistics = { attempts: 0, corrections: 0 }
    if (forcePlaybackRateOne) {
      const descriptors = ['playbackRate', 'defaultPlaybackRate'].map(property => [property, mediaPrototype && Object.getOwnPropertyDescriptor(mediaPrototype, property)])
      if (descriptors.some(([, descriptor]) => !descriptor?.get || !descriptor.set || !descriptor.configurable)) fail('CAPTURE_UNSUPPORTED_RATE_CONTROL', 'Native media rate setters cannot be fixed at 1x')
      const setRate = (element, property, descriptor, value, phase) => {
        const previous = descriptor.get.call(element) // Preserve the native receiver check.
        const requested = +value // Web IDL double conversion, including Symbol/BigInt errors.
        if (!Number.isFinite(requested)) throw new TypeError('Media playback rate must be finite')
        // Never apply the requested 2x preference even transiently. This opt-in guard
        // belongs only to the dedicated official capture window, not the app player.
        const result = descriptor.set.call(element, 1)
        const effective = descriptor.get.call(element)
        if (effective !== 1) fail('CAPTURE_UNSUPPORTED_RATE_CONTROL', 'Native media rate did not remain at 1x')
        if (requested !== 1 || previous !== 1) {
          if (requested !== 1) rateStatistics.attempts++
          if (previous !== 1) rateStatistics.corrections++
          onRateAttempt(element, { property, requested, previous, effective, phase, ...rateStatistics })
        }
        return result
      }
      for (const [property, descriptor] of descriptors) Object.defineProperty(mediaPrototype, property, { ...descriptor, set(value) { return setRate(this, property, descriptor, value, 'setter') } })
      // Usually empty at document initialization. If installed into an existing
      // document, correct it synchronously and disclose the pre-guard rate.
      for (const element of scope.document?.querySelectorAll('audio,video') ?? []) {
        if (!(element instanceof scope.HTMLMediaElement)) continue
        for (const [property, descriptor] of descriptors) if (descriptor.get.call(element) !== 1) setRate(element, property, descriptor, 1, 'installation')
      }
    }
    const sources = new WeakMap(), buffers = new WeakMap(), urls = new Map()
    const sourceFor = (media) => { if (!sources.has(media)) { const source = tracker.createSource(); source.native = media; sources.set(media, source) }; return sources.get(media) }
    const originalURL = scope.URL.createObjectURL
    scope.URL.createObjectURL = function (object) {
      const url = originalURL.call(this, object)
      if (object instanceof scope.MediaSource) urls.set(url, sourceFor(object))
      return url
    }
    const originalEnd = scope.MediaSource.prototype.endOfStream
    if (originalEnd) scope.MediaSource.prototype.endOfStream = function (...args) {
      const result = originalEnd.apply(this, args)
      const source = sourceFor(this)
      source.successfulEndOfStream = args[0] === undefined && this.readyState === 'ended'
      if (args[0] !== undefined) tracker.reject(source, 'CAPTURE_PARTIAL_PRESENTATION', `Official source ended with an error: ${String(args[0])}`)
      return result
    }
    const originalAdd = scope.MediaSource.prototype.addSourceBuffer
    scope.MediaSource.prototype.addSourceBuffer = function (mime) {
      const sb = originalAdd.call(this, mime), source = sourceFor(this)
      if (mime.startsWith('audio/')) { const buffer = tracker.createBuffer(source, mime); buffer.native = sb; buffers.set(sb, buffer) }
      else if (/opus|mp4a|vorbis|flac/i.test(mime)) tracker.reject(source, 'CAPTURE_UNSUPPORTED_MULTIPLEXED', 'Audio and video share a source buffer')
      sb.addEventListener('error', () => tracker.reject(source, 'CAPTURE_SOURCEBUFFER_ERROR', 'The official SourceBuffer rejected media'))
      return sb
    }
    const originalAppend = scope.SourceBuffer.prototype.appendBuffer
    scope.SourceBuffer.prototype.appendBuffer = function (data) {
      const buffer = buffers.get(this), bytes = buffer ? copy(data) : null
      const result = originalAppend.call(this, data)
      if (buffer) tracker.append(buffer, bytes, this)
      return result
    }
    const originalAbort = scope.SourceBuffer.prototype.abort
    if (originalAbort) scope.SourceBuffer.prototype.abort = function (...args) {
      const buffer = buffers.get(this), hadBytes = buffer?.chunks.some(chunk => chunk.byteLength > 0)
      // Native abort may discard parser-input bytes already copied into quarantine.
      // Reject immediately after success, before its queued abort event or a detach can
      // seal that inventory. A native exception did not perform the operation.
      const result = originalAbort.apply(this, args)
      if (hadBytes && !tracker.onSeekMutation?.(buffer, 'abort')) tracker.reject(buffer.source, 'CAPTURE_AMBIGUOUS_TIMELINE', 'SourceBuffer.abort discarded or reset captured parser input')
      return result
    }
    const originalChange = scope.SourceBuffer.prototype.changeType
    if (originalChange) scope.SourceBuffer.prototype.changeType = function (mime) {
      const buffer = buffers.get(this)
      const result = originalChange.call(this, mime)
      if (buffer) tracker.reject(buffer.source, 'CAPTURE_UNSUPPORTED_FORMAT_CHANGE', `SourceBuffer changed to ${mime}`)
      return result
    }
    const originalRemove = scope.SourceBuffer.prototype.remove
    scope.SourceBuffer.prototype.remove = function (start, end) {
      const buffer = buffers.get(this)
      const result = originalRemove.call(this, start, end)
      if (buffer && !tracker.onSeekMutation?.(buffer, 'remove')) tracker.reject(buffer.source, 'CAPTURE_AMBIGUOUS_TIMELINE', 'SourceBuffer ranges were removed or overwritten')
      return result
    }
    const sourceOf = (element) => element.srcObject ? sources.get(element.srcObject) ?? null : urls.get(element.currentSrc || element.src) ?? null
    const snapshotOf = (element, operation = 'snapshot') => {
      const source = sourceOf(element)
      if (!source) return null
      const native = source.buffers[0]?.native
      return { source, operation, position: element.currentTime, duration: element.duration, seeking: element.seeking, paused: element.paused, ended: element.ended, readyState: element.readyState, playbackRate: element.playbackRate, updating: native?.updating ?? true, audioRanges: nativeRanges(native), sourceReadyState: source.native?.readyState, successfulEndOfStream: source.successfulEndOfStream, sourceEnded: source.successfulEndOfStream && source.native?.readyState === 'ended' }
    }
    const beforeDetach = (element, operation) => {
      const source = sourceOf(element)
      if (!source || source.sealed || (!source.seen.has('content') && !(source.state === 'ad' && source.seen.size === 1 && source.seen.has('ad')))) return
      onBeforeDetach(element, snapshotOf(element, operation))
    }
    for (const property of ['src', 'srcObject', 'currentTime']) {
      const descriptor = mediaPrototype && Object.getOwnPropertyDescriptor(mediaPrototype, property)
      if (!descriptor?.set || !descriptor.configurable) continue
      Object.defineProperty(mediaPrototype, property, { ...descriptor, set(value) {
        if (property === 'currentTime') {
          const source = sourceOf(this)
          if (source?.state === 'content' && !source.sealed && !tracker.onTimeAssignment?.(source, this, value)) tracker.reject(source, 'CAPTURE_PARTIAL_PRESENTATION', 'A currentTime assignment invalidates presentation before its asynchronous seeking event')
        } else beforeDetach(this, `${property} setter`)
        return descriptor.set.call(this, value)
      } })
    }
    if (mediaPrototype?.load) {
      const originalLoad = mediaPrototype.load
      mediaPrototype.load = function (...args) { beforeDetach(this, 'load'); return originalLoad.apply(this, args) }
    }
    // Reflected DOM setters do not have to call an overridden IDL setter.
    for (const method of ['setAttribute', 'removeAttribute', 'setAttributeNS', 'removeAttributeNS']) {
      const prototype = scope.Element?.prototype, original = prototype?.[method]
      if (!original) continue
      prototype[method] = function (...args) {
        const name = String(args[method.endsWith('NS') ? 1 : 0]).toLowerCase()
        if (scope.HTMLMediaElement && this instanceof scope.HTMLMediaElement && name === 'src') beforeDetach(this, method)
        return original.apply(this, args)
      }
    }
    return { tracker, sourceOf, snapshotOf, rateStatistics }
  }
  globalThis.__musifyCaptureCore = { CaptureError, timeAtOrAfter, nativeFinalClockCandidate, parseWebMOpus, inspectWebMPrefix, remuxWebM, projectTimeline, SessionTracker, ProgressiveTracker, mergeRanges, install }
})()
