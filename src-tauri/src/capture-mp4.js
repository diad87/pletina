// Strict MSE ISO-BMFF inspection, not a general MP4 demuxer or AAC entropy decoder.
// References: https://www.w3.org/TR/mse-byte-stream-format-isobmff/
// Field/default precedence cross-checked with FFmpeg libavformat/mov.c (tfhd/trun).
// Supported edits: one rate-1 edit, at most one AAC frame of leading encoder delay,
// and an explicitly declared tail trim smaller than one frame. No empty/looping edits.
(() => {
  const MAX_SAMPLES = 262144
  const unsupported = message => { const e = new Error(`CAPTURE_UNSUPPORTED_MP4: ${message}`); e.code = 'CAPTURE_UNSUPPORTED_MP4'; throw e }
  const timelineError = message => { const e = new Error(`CAPTURE_AMBIGUOUS_TIMELINE: ${message}`); e.code = 'CAPTURE_AMBIGUOUS_TIMELINE'; throw e }

  function parse(input) {
    if (!(input instanceof Uint8Array)) unsupported('Expected a complete Uint8Array source')
    const bytes = input, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let boxesRead = 0
    const need = (at, size, limit = bytes.length) => {
      if (!Number.isSafeInteger(at) || size < 0 || at < 0 || at + size > limit) unsupported('Truncated or oversized field')
    }
    const u16 = (at, limit) => { need(at, 2, limit); return view.getUint16(at) }
    const u32 = (at, limit) => { need(at, 4, limit); return view.getUint32(at) }
    const i32 = (at, limit) => { need(at, 4, limit); return view.getInt32(at) }
    const u64 = (at, limit) => {
      need(at, 8, limit)
      const value = view.getBigUint64(at)
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) unsupported('Integer exceeds exact range')
      return Number(value)
    }
    const durationValue = (at, version, limit) => {
      need(at, version ? 8 : 4, limit)
      if (version && view.getBigUint64(at) === 0xffffffffffffffffn) return 0
      const value = version ? u64(at, limit) : u32(at, limit)
      return !version && value === 0xffffffff ? 0 : value
    }
    const fourcc = at => { need(at, 4); return String.fromCharCode(...bytes.subarray(at, at + 4)) }
    const box = (at, limit) => {
      if (++boxesRead > 100000) unsupported('Too many boxes')
      need(at, 8, limit)
      const type = fourcc(at + 4)
      let size = u32(at, limit), header = 8
      if (size === 1) { size = u64(at + 8, limit); header = 16 }
      if (size < header || at + size > limit) unsupported(`Invalid ${type} box size`)
      return { type, at, start: at + header, end: at + size }
    }
    const children = parent => {
      const list = []
      for (let at = parent.start; at < parent.end;) { const child = box(at, parent.end); list.push(child); at = child.end }
      return list
    }
    // ISO/IEC 14496-12:2015 §8.1.2: free/skip are opaque free space in a file or box.
    // children() has already validated their complete size and parent bounds. They are
    // not substitutes for entries in the counted stsd/dref arrays below.
    const only = (list, types, padding = true) => {
      for (const b of list)
        if (!types.includes(b.type) && !(padding && ['free', 'skip'].includes(b.type))) unsupported(`Unsupported ${b.type} box`)
    }
    const one = (list, type, required = true) => {
      const hits = list.filter(b => b.type === type)
      if (hits.length > 1 || (required && hits.length !== 1)) unsupported(`Expected ${required ? 'one' : 'at most one'} ${type}`)
      return hits[0]
    }
    const full = (b, versions = [0], flags = 0) => {
      need(b.start, 4, b.end)
      const version = bytes[b.start], actualFlags = u32(b.start, b.end) & 0xffffff
      if (!versions.includes(version) || (flags !== null && actualFlags !== flags)) unsupported(`Unsupported ${b.type} version or flags`)
      return { version, flags: actualFlags, at: b.start + 4 }
    }
    const exact = (at, b) => { if (at !== b.end) unsupported(`Unexpected ${b.type} fields`) }
    const brand = b => {
      const known = ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'iso8', 'mp41', 'mp42', 'dash', 'cmfa', 'M4A ']
      need(b.start, 8, b.end)
      if ((b.end - b.start) % 4 || !known.includes(fourcc(b.start))) unsupported('Unsupported file/segment brand')
      for (let at = b.start + 8; at < b.end; at += 4) if (!known.includes(fourcc(at))) unsupported('Unsupported compatible brand')
    }
    const descriptor = (at, end) => {
      need(at, 2, end)
      const tag = bytes[at++]
      let size = 0, count = 0, value
      do { need(at, 1, end); value = bytes[at++]; size = size * 128 + (value & 127); count++ } while ((value & 128) && count < 4)
      if (value & 128 || at + size > end) unsupported('Invalid MPEG-4 descriptor')
      return { tag, start: at, end: at + size }
    }
    const descriptors = (at, end) => {
      const out = []
      while (at < end) { const d = descriptor(at, end); out.push(d); at = d.end }
      return out
    }
    const asc = d => {
      let bit = d.start * 8
      let objectType = null, syncType = null, extensionType = null, sbrPresent = null
      const invalid = message => {
        const hex = [...bytes.subarray(d.start, Math.min(d.end, d.start + 32))].map(b => b.toString(16).padStart(2, '0')).join('')
        unsupported(`${message}; ASC=${hex}${d.end - d.start > 32 ? '...' : ''}; objectType=${objectType}; sync=${syncType === null ? null : `0x${syncType.toString(16)}`}; extensionObjectType=${extensionType}; sbrPresent=${sbrPresent}`)
      }
      const take = count => {
        if (bit + count > d.end * 8) invalid('Truncated AudioSpecificConfig')
        let value = 0
        for (let i = 0; i < count; i++, bit++) value = value * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1)
        return value
      }
      objectType = take(5)
      const frequency = take(4)
      const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
      const rate = frequency === 15 ? take(24) : rates[frequency]
      const channels = take(4)
      if (objectType !== 2 || !rate || rate > 65535 || ![1, 2].includes(channels)) invalid('Only AAC-LC mono/stereo with a declared sample rate is verified')
      if (take(1) || take(1) || take(1)) invalid('Unsupported AAC frame length, core dependency or extension')
      // ISO/IEC 14496-3:2009 Table 1.15 gates the extension on syncExtensionType==0x2b7,
      // not merely on remaining length. A wholly zero tail contains no extension.
      // FFmpeg mpeg4audio.c likewise searches for the sync marker; we still reject
      // every unknown nonzero tail and only support the explicit SBR-absent form.
      if (d.end * 8 - bit >= 16) {
        syncType = take(11)
        if (syncType === 0x2b7) {
          extensionType = take(5)
          if (extensionType !== 5) invalid('Unknown AAC sync extension object type')
          sbrPresent = take(1)
          if (sbrPresent !== 0) invalid('SBR is not verified')
        } else if (syncType !== 0) invalid('Unknown AAC sync extension')
      }
      while (bit < d.end * 8) if (take(1)) invalid('Unverified AAC configuration extension')
      return { rate, channels }
    }
    const audioConfig = esds => {
      const h = full(esds)
      const es = descriptor(h.at, esds.end)
      if (es.tag !== 3 || es.end !== esds.end) unsupported('Missing unique ES descriptor')
      need(es.start, 3, es.end)
      if (bytes[es.start + 2] !== 0) unsupported('External or dependent ES descriptor')
      const list = descriptors(es.start + 3, es.end)
      if (list.length !== 2 || list[0].tag !== 4 || list[1].tag !== 6) unsupported('Unverified decoder descriptors')
      const config = list[0], sl = list[1]
      need(config.start, 13, config.end)
      if (bytes[config.start] !== 0x40 || bytes[config.start + 1] !== 0x15) unsupported('Not an MPEG-4 audio decoder configuration')
      if (sl.end - sl.start !== 1 || bytes[sl.start] !== 2) unsupported('Unsupported SL configuration')
      const specific = descriptors(config.start + 13, config.end)
      if (specific.length !== 1 || specific[0].tag !== 5) unsupported('Missing unique AudioSpecificConfig')
      return asc(specific[0])
    }

    const top = children({ start: 0, end: bytes.length })
    if (top[0]?.type !== 'ftyp') unsupported('Missing initial ftyp')
    brand(top[0])
    one(top, 'ftyp'); const moov = one(top, 'moov')
    if (top.findIndex(b => b.type === 'moof') < top.indexOf(moov)) unsupported('Fragment precedes initialization')
    const movie = children(moov)
    only(movie, ['mvhd', 'trak', 'mvex', 'udta', 'iods', 'free'])
    const mvhd = one(movie, 'mvhd'), mvh = full(mvhd, [0, 1])
    exact(mvhd.start + (mvh.version ? 112 : 100), mvhd)
    const movieScale = u32(mvhd.start + (mvh.version ? 20 : 12), mvhd.end)
    if (!movieScale) unsupported('Invalid movie timescale')
    if (u32(mvhd.start + (mvh.version ? 32 : 20), mvhd.end) !== 0x10000) unsupported('Non-unit movie playback rate')
    const movieDuration = durationValue(mvhd.start + (mvh.version ? 24 : 16), mvh.version, mvhd.end)
    const trak = one(movie, 'trak'), track = children(trak)
    only(track, ['tkhd', 'mdia', 'edts', 'udta', 'free'])
    const tkhd = one(track, 'tkhd'), tkh = full(tkhd, [0, 1], null)
    if (!(tkh.flags & 1) || tkh.flags & ~7) unsupported('Disabled or unsupported track flags')
    exact(tkhd.start + (tkh.version ? 96 : 84), tkhd)
    const trackDuration = durationValue(tkhd.start + (tkh.version ? 28 : 20), tkh.version, tkhd.end)
    const trackId = u32(tkhd.start + (tkh.version ? 20 : 12), tkhd.end)
    if (!trackId || u32(tkhd.end - 8) || u32(tkhd.end - 4)) unsupported('Invalid audio track identity/dimensions')
    const media = children(one(track, 'mdia'))
    only(media, ['mdhd', 'hdlr', 'minf', 'free'])
    const mdhd = one(media, 'mdhd'), mdh = full(mdhd, [0, 1])
    exact(mdhd.start + (mdh.version ? 36 : 24), mdhd)
    const scale = u32(mdhd.start + (mdh.version ? 20 : 12), mdhd.end)
    const declaredDuration = durationValue(mdhd.start + (mdh.version ? 24 : 16), mdh.version, mdhd.end)
    if (!scale) unsupported('Invalid media timescale')
    const hdlr = one(media, 'hdlr'), handler = full(hdlr)
    need(handler.at, 20, hdlr.end)
    if (fourcc(handler.at + 4) !== 'soun') unsupported('Only one audio track is permitted')
    const minf = children(one(media, 'minf'))
    only(minf, ['smhd', 'dinf', 'stbl', 'free'])
    const smhd = one(minf, 'smhd'); full(smhd); exact(smhd.start + 8, smhd)
    const dinf = children(one(minf, 'dinf')); only(dinf, ['dref'])
    const dref = one(dinf, 'dref'), dr = full(dref)
    if (u32(dr.at, dref.end) !== 1) unsupported('Multiple data references')
    const urls = children({ start: dr.at + 4, end: dref.end })
    const url = one(urls, 'url '); only(urls, ['url '], false); full(url, [0], 1); exact(url.start + 4, url)
    const table = children(one(minf, 'stbl'))
    only(table, ['stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64', 'stss', 'ctts', 'free'])
    for (const type of ['stts', 'stsc', 'stco', 'co64', 'stss', 'ctts']) {
      const b = one(table, type, ['stts', 'stsc'].includes(type))
      if (b) { const h = full(b, type === 'ctts' ? [0, 1] : [0]); if (u32(h.at, b.end)) unsupported('Initialization contains media samples'); exact(h.at + 4, b) }
    }
    if (table.filter(b => ['stco', 'co64'].includes(b.type)).length !== 1) unsupported('Missing unique empty chunk-offset table')
    const stsz = one(table, 'stsz'), sz = full(stsz)
    if (u32(sz.at, stsz.end) || u32(sz.at + 4, stsz.end)) unsupported('Initialization contains sample sizes')
    exact(sz.at + 8, stsz)
    const stsd = one(table, 'stsd'), sd = full(stsd)
    if (u32(sd.at, stsd.end) !== 1) unsupported('Multiple sample descriptions')
    const entries = children({ start: sd.at + 4, end: stsd.end })
    only(entries, ['mp4a'], false); const sample = one(entries, 'mp4a')
    need(sample.start, 28, sample.end)
    if (u16(sample.start + 6) !== 1 || u16(sample.start + 8) || u16(sample.start + 10) || u32(sample.start + 12)) unsupported('Unsupported or external audio sample entry')
    if (u16(sample.start + 18) !== 16 || u16(sample.start + 20) || u16(sample.start + 22)) unsupported('Unsupported audio sample representation')
    const sampleChildren = children({ start: sample.start + 28, end: sample.end })
    only(sampleChildren, ['esds', 'btrt', 'free'])
    const config = audioConfig(one(sampleChildren, 'esds'))
    if (u16(sample.start + 16) !== config.channels || u32(sample.start + 24) / 65536 !== config.rate) unsupported('Conflicting sample entry and decoder configuration')
    const frameTicks = 1024 * scale / config.rate
    if (!Number.isSafeInteger(frameTicks) || !frameTicks) unsupported('AAC frame duration is not exact in this timescale')
    const extendsBoxes = children(one(movie, 'mvex'))
    only(extendsBoxes, ['trex', 'mehd', 'free'])
    const mehd = one(extendsBoxes, 'mehd', false)
    let fragmentDuration = null
    if (mehd) {
      const mh = full(mehd, [0, 1])
      exact(mh.at + (mh.version ? 8 : 4), mehd)
      fragmentDuration = durationValue(mh.at, mh.version, mehd.end)
    }
    const trex = one(extendsBoxes, 'trex'), tx = full(trex)
    exact(tx.at + 20, trex)
    if (u32(tx.at) !== trackId || u32(tx.at + 4) !== 1) unsupported('Defaults refer to another track/sample description')
    const defaults = { duration: u32(tx.at + 8), size: u32(tx.at + 12), flags: u32(tx.at + 16) }
    let editStart = 0, editLength = null
    const edts = one(track, 'edts', false)
    if (edts) {
      const edits = children(edts); only(edits, ['elst'])
      const elst = one(edits, 'elst'), el = full(elst, [0, 1])
      if (u32(el.at, elst.end) !== 1) unsupported('Only a single nonempty rate-1 edit is verified')
      let at = el.at + 4
      const length = el.version ? u64(at, elst.end) : u32(at, elst.end); at += el.version ? 8 : 4
      editStart = el.version ? u64(at, elst.end) : i32(at, elst.end); at += el.version ? 8 : 4
      if (editStart < 0 || editStart > frameTicks || u16(at, elst.end) !== 1 || u16(at + 2, elst.end)) unsupported('Unsupported edit offset or rate')
      exact(at + 4, elst)
      editLength = length ? length / movieScale : null
    }

    let decodeUntil = 0, previousSequence = null, sawFragment = false
    const rawFrames = []
    const sampleFlags = flags => { if (flags !== 0 && flags !== 0x02000000) unsupported('Unverified AAC sample flags') }
    const fragment = (moof, mdats) => {
      const contents = children(moof); only(contents, ['mfhd', 'traf'])
      const mfhd = one(contents, 'mfhd'), mh = full(mfhd); exact(mh.at + 4, mfhd)
      const sequence = u32(mh.at)
      if (previousSequence !== null && sequence !== previousSequence + 1) timelineError('Missing, repeated or reordered fragment sequence')
      previousSequence = sequence
      const traf = one(contents, 'traf'), parts = children(traf)
      only(parts, ['tfhd', 'tfdt', 'trun'])
      const tfhd = one(parts, 'tfhd'), th = full(tfhd, [0], null)
      if (th.flags & ~(0x020000 | 0x000002 | 0x000008 | 0x000010 | 0x000020)) unsupported('Absolute offsets, empty fragments or unknown tfhd flags')
      let at = th.at
      if (u32(at, tfhd.end) !== trackId) unsupported('Fragment belongs to another track')
      at += 4
      if (th.flags & 2) { if (u32(at, tfhd.end) !== 1) unsupported('Fragment changed sample description'); at += 4 }
      const current = { ...defaults }
      for (const [flag, name] of [[8, 'duration'], [16, 'size'], [32, 'flags']]) if (th.flags & flag) { current[name] = u32(at, tfhd.end); at += 4 }
      exact(at, tfhd)
      const tfdt = one(parts, 'tfdt'), td = full(tfdt, [0, 1])
      const clock = td.version ? u64(td.at, tfdt.end) : u32(td.at, tfdt.end)
      exact(td.at + (td.version ? 8 : 4), tfdt)
      if (clock !== decodeUntil) timelineError('Gap, overlap or overwritten AAC decode timestamps')
      const runs = parts.filter(b => b.type === 'trun')
      if (!runs.length || parts.indexOf(tfhd) > parts.indexOf(runs[0]) || parts.indexOf(tfdt) > parts.indexOf(runs[0])) unsupported('Missing or unordered fragment timing')
      let previousEnd = null, mdatIndex = 0, payloadAt = mdats[0]?.start
      if (payloadAt === undefined) unsupported('Fragment without mdat')
      for (const [index, run] of runs.entries()) {
        const rh = full(run, [0, 1], null)
        if (rh.flags & ~0x000f05 || ((rh.flags & 4) && (rh.flags & 0x400))) unsupported('Unknown/conflicting trun flags')
        let at = rh.at
        const count = u32(at, run.end); at += 4
        if (!count || rawFrames.length + count > MAX_SAMPLES) unsupported('Invalid or excessive sample count')
        let dataAt = previousEnd
        if (rh.flags & 1) { dataAt = moof.at + i32(at, run.end); at += 4 }
        else if (!index) unsupported('First run lacks moof-relative data offset')
        let firstFlags = current.flags
        if (rh.flags & 4) { firstFlags = u32(at, run.end); at += 4 }
        for (let i = 0; i < count; i++) {
          let duration = current.duration, size = current.size, flags = i ? current.flags : firstFlags
          if (rh.flags & 0x100) { duration = u32(at, run.end); at += 4 }
          if (rh.flags & 0x200) { size = u32(at, run.end); at += 4 }
          if (rh.flags & 0x400) { flags = u32(at, run.end); at += 4 }
          if (rh.flags & 0x800) { if (u32(at, run.end) !== 0) unsupported('AAC composition offsets are not verified'); at += 4 }
          sampleFlags(flags)
          if (duration !== frameTicks || !size) unsupported('Unknown sample size or AAC duration inconsistent with its configuration')
          if (payloadAt === mdats[mdatIndex].end && mdatIndex + 1 < mdats.length) payloadAt = mdats[++mdatIndex].start
          if (dataAt !== payloadAt || dataAt + size > mdats[mdatIndex].end) unsupported('Sample data overlaps, leaves gaps or falls outside mdat')
          const end = decodeUntil + duration
          if (!Number.isSafeInteger(end)) unsupported('AAC timeline exceeds exact range')
          rawFrames.push({ start: decodeUntil / scale, end: end / scale })
          decodeUntil = end; dataAt += size; payloadAt = dataAt
        }
        exact(at, run)
        previousEnd = dataAt
      }
      if (mdatIndex !== mdats.length - 1 || payloadAt !== mdats[mdatIndex].end) unsupported('Unreferenced bytes remain in mdat')
    }
    for (let i = 1; i < top.length; i++) {
      const b = top[i]
      if (b === moov) { if (sawFragment) unsupported('Repeated initialization'); continue }
      if (b.type === 'moof') {
        const mdats = []
        while (top[i + 1]?.type === 'mdat') mdats.push(top[++i])
        fragment(b, mdats); sawFragment = true
      } else if (b.type === 'styp') brand(b)
      else if (!['free', 'skip', 'sidx', 'mfra'].includes(b.type)) unsupported(`Unsupported top-level ${b.type}`)
    }
    if (!sawFragment || !rawFrames.length) unsupported('Source has no complete AAC fragments')
    const delay = editStart / scale, rawEnd = decodeUntil / scale - delay
    const durationMetadata = {
      mdhd: declaredDuration, mediaTimescale: scale, mvhd: movieDuration, tkhd: trackDuration,
      mehd: fragmentDuration, movieTimescale: movieScale, decodedTicks: decodeUntil,
      sampleCount: rawFrames.length, editStartTicks: editStart, editLengthSeconds: editLength,
    }
    if (editLength !== null && (editLength > rawEnd + 1 / scale || rawEnd - editLength >= frameTicks / scale)) unsupported(`Edit excludes complete frames or extends beyond coded audio: rawEnd=${rawEnd}; durationMetadata=${JSON.stringify(durationMetadata)}`)
    const frames = []
    for (const frame of rawFrames) {
      const start = Math.max(0, frame.start - delay), end = Math.min(frame.end - delay, editLength ?? Infinity)
      if (end > start) frames.push({ start, end })
    }
    if (!frames.length || frames[0].start !== 0) timelineError('No verified audio beginning at zero')
    // W3C MSE ISO-BMFF §3 has empty initialization sample tables; tfdt/trun describe
    // appended media. ISO/IEC 14496-12:2015 Annex A.8 says the initial moov does not
    // describe the full fragmented duration. Its mdhd/mvhd/tkhd durations are not an
    // inventory of these fragments. §8.8.2 specifically assigns that role to mehd.
    // https://www.w3.org/TR/mse-byte-stream-format-isobmff/#initialization-segments
    // ISO text: https://hezhaojiang.github.io/slave/MP4/ISO-IEC-14496-12-Base-Format-2015.pdf
    // Exact sample ownership/sequence/timestamps above and the external native EOF,
    // SourceBuffer range and presentation-clock gate still prove completeness of the
    // observed official source, not of a canonical remote recording.
    const end = frames.at(-1).end
    if (fragmentDuration && Math.abs(fragmentDuration - end * movieScale) > 1 + 1e-9)
      unsupported(`Movie fragment duration conflicts with its presentation: mehd=${fragmentDuration}, movieTimescale=${movieScale}, calculatedRange=0..${end}, calculatedMovieTicks=${end * movieScale}; durationMetadata=${JSON.stringify(durationMetadata)}`)
    return { frames, start: 0, end, quantum: 1 / scale, codec: 'mp4a.40.2', durationMetadata }
  }
  globalThis.__musifyCaptureMp4 = { parse }
})()
