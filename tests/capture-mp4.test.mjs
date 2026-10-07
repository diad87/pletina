import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const parserCode = readFileSync(new URL('../src-tauri/src/capture-mp4.js', import.meta.url), 'utf8')
const context = vm.createContext({ Uint8Array, ArrayBuffer, DataView })
vm.runInContext(parserCode, context)
const parse = bytes => context.__musifyCaptureMp4.parse(new Uint8Array(bytes))
// Generated locally with FFmpeg 8.1: anullsrc=r=48000:cl=stereo, -t .064 -c:a aac
// -b:a 64k -movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration 43000
// -fflags +bitexact -flags:a +bitexact. ffprobe independently reports 4 packets of
// 1024 ticks (48 kHz), 6 bytes each, in two fragments. AAC encoder priming remains
// in this empty_moov fixture; its declared coded length is 4096/48000, not .064.
const real = Buffer.from('AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAphtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAABv3RyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAVttZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAEGbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAADKc3RibAAAAH5zdHNkAAAAAAAAAAEAAABubXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAA2ZXNkcwAAAAADgICAJQABAASAgIAXQBUAAAAAAPoAAAD6AAWAgIAFEZBW5QAGgICAAQIAAAAUYnRydAAAAAAAAPoAAAD6AAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAD11ZHRhAAAANW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAACGlsc3QAAABkbW9vZgAAABBtZmhkAAAAAAAAAAEAAABMdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAQAAAAABgIAAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAABR0cnVuAAAAAQAAAAMAAABsAAAAGm1kYXQhEARgjBwhEARgjBwhEARgjBwAAABkbW9vZgAAABBtZmhkAAAAAAAAAAIAAABMdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAQAAAAABgIAAAAAAAAUdGZkdAEAAAAAAAAAAAAMAAAAABR0cnVuAAAAAQAAAAEAAABsAAAADm1kYXQhEARgjBwAAABWbWZyYQAAAD50ZnJhAQAAAAAAAAEAAAAAAAAAAgAAAAAAAAAAAAAAAAAAArQBAQEAAAAAAAAMAAAAAAAAAAMyAQEBAAAAEG1mcm8AAAAAAAAAVg==', 'base64')
const cat = (...parts) => Buffer.concat(parts.map(p => Buffer.from(p)))
const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b }
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0); return b }
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b }
const box = (type, ...parts) => { const payload = cat(...parts); return cat(u32(payload.length + 8), Buffer.from(type), payload) }
const full = (type, version, flags, ...parts) => box(type, u32(version * 0x1000000 + flags), ...parts)
const packet = Buffer.from('211004608c1c', 'hex')
function boxes(bytes, start = 0, end = bytes.length) {
  const found = []
  for (let at = start; at < end;) { const size = bytes.readUInt32BE(at); found.push({ at, start: at + 8, end: at + size, type: bytes.toString('ascii', at + 4, at + 8) }); at += size }
  return found
}
const childStart = b => b.start + (b.type === 'stsd' || b.type === 'dref' ? 8 : b.type === 'mp4a' ? 28 : 0)
function path(bytes, names) {
  const ancestors = []
  let start = 0, end = bytes.length
  for (const type of names.split('/')) { const b = boxes(bytes, start, end).find(b => b.type === type); assert(b, `Fixture missing ${type}`); ancestors.push(b); start = childStart(b); end = b.end }
  return ancestors
}
const find = (bytes, names) => path(bytes, names).at(-1)
function change(bytes, names, relative, value, width = 4) {
  const out = Buffer.from(bytes), b = find(out, names)
  if (width === 8) out.writeBigUInt64BE(BigInt(value), b.start + relative)
  else if (width === 2) out.writeUInt16BE(value, b.start + relative)
  else if (width === 1) out[b.start + relative] = value
  else out.writeUInt32BE(value >>> 0, b.start + relative)
  return out
}
function insert(bytes, names, addition) {
  const ancestors = path(bytes, names), parent = ancestors.at(-1)
  const out = cat(bytes.subarray(0, parent.end), addition, bytes.subarray(parent.end))
  for (const b of ancestors) out.writeUInt32BE(b.end - b.at + addition.length, b.at)
  return out
}
const baseInit = real.subarray(0, boxes(real).find(b => b.type === 'moof').at)
function fragment({ sequence = 1, clock = 0, count = 2, tfhdFlags = 0x020038,
  defaultDuration = 1024, defaultSize = 6, defaultFlags = 0x02000000,
  trunFlags = 1, duration = 1024, size = 6, flags = 0x02000000, composition = 0,
  offsetDelta = 0, trackId = 1, version = 0 } = {}) {
  const headerParts = [u32(trackId)]
  if (tfhdFlags & 2) headerParts.push(u32(1))
  if (tfhdFlags & 8) headerParts.push(u32(defaultDuration))
  if (tfhdFlags & 16) headerParts.push(u32(defaultSize))
  if (tfhdFlags & 32) headerParts.push(u32(defaultFlags))
  const tfhd = full('tfhd', 0, tfhdFlags, ...headerParts), tfdt = full('tfdt', 1, 0, u64(clock))
  const trun = offset => {
    const parts = [u32(count)]
    if (trunFlags & 1) parts.push(u32(offset))
    if (trunFlags & 4) parts.push(u32(flags))
    for (let i = 0; i < count; i++) {
      if (trunFlags & 0x100) parts.push(u32(duration))
      if (trunFlags & 0x200) parts.push(u32(size))
      if (trunFlags & 0x400) parts.push(u32(flags))
      if (trunFlags & 0x800) parts.push(u32(composition))
    }
    return full('trun', version, trunFlags, ...parts)
  }
  const moof = offset => box('moof', full('mfhd', 0, 0, u32(sequence)), box('traf', tfhd, tfdt, trun(offset)))
  const dataOffset = moof(0).length + 8 + offsetDelta
  return cat(moof(dataOffset), box('mdat', ...Array.from({ length: count }, () => packet)))
}
const synthetic = options => cat(baseInit, fragment(options))
const unsupported = bytes => assert.throws(() => parse(bytes), /CAPTURE_(UNSUPPORTED_MP4|AMBIGUOUS_TIMELINE)/)

function withAsc(config) {
  const descriptor = (tag, ...parts) => {
    const payload = cat(...parts)
    assert(payload.length < 128)
    return cat([tag, payload.length], payload)
  }
  const replacement = full('esds', 0, 0, descriptor(3, u16(1), [0],
    descriptor(4, [0x40, 0x15, 0, 0, 0], u32(64000), u32(64000), descriptor(5, config)), descriptor(6, [2])))
  const ancestors = path(real, 'moov/trak/mdia/minf/stbl/stsd/mp4a/esds')
  const old = ancestors.at(-1), delta = replacement.length - (old.end - old.at)
  const out = cat(real.subarray(0, old.at), replacement, real.subarray(old.end))
  for (const b of ancestors.slice(0, -1)) out.writeUInt32BE(b.end - b.at + delta, b.at)
  return out
}

// Positive evidence comes from a real encoder, independent of our fixture constructors.
test('real AAC-LC ISO-BMFF fixture matches independently inspected packet timing', () => {
  const result = parse(real)
  assert.equal(result.codec, 'mp4a.40.2')
  assert.equal(result.frames.length, 4)
  assert.equal(result.quantum, 1 / 48000)
  assert.equal(result.start, 0)
  assert.equal(result.end, 4096 / 48000)
  for (let i = 0; i < 4; i++) { assert.equal(result.frames[i].start, i * 1024 / 48000); assert.equal(result.frames[i].end, (i + 1) * 1024 / 48000) }
})

test('sample defaults follow trun over tfhd over trex without guessing missing durations', () => {
  assert.equal(parse(synthetic({ defaultDuration: 0, defaultSize: 0, trunFlags: 0x701 })).frames.length, 2)
  let init = change(baseInit, 'moov/mvex/trex', 12, 1024)
  init = change(init, 'moov/mvex/trex', 16, 6)
  init = change(init, 'moov/mvex/trex', 20, 0x02000000)
  assert.equal(parse(cat(init, fragment({ tfhdFlags: 0x020000 }))).frames.length, 2)
  unsupported(synthetic({ defaultDuration: 0 }))
  unsupported(synthetic({ defaultSize: 0 }))
  unsupported(synthetic({ defaultDuration: 512 }))
  unsupported(synthetic({ defaultDuration: 2048 }))
})

test('repeated, missing and overwritten decode intervals fail instead of widening tolerance', () => {
  for (const clock of [0, 2047, 2049, 4096])
    unsupported(cat(baseInit, fragment(), fragment({ sequence: 2, clock })))
  assert.equal(parse(cat(baseInit, fragment(), fragment({ sequence: 2, clock: 2048 }))).frames.length, 4)
  unsupported(cat(baseInit, fragment(), fragment({ sequence: 1, clock: 2048 })))
  unsupported(cat(baseInit, fragment(), fragment({ sequence: 3, clock: 2048 })))
  unsupported(synthetic({ clock: Number.MAX_SAFE_INTEGER + 1 }))
})

test('every sample must cover exactly its own mdat bytes, without holes or trailing payload', () => {
  for (const offsetDelta of [-1, 1, 100000]) unsupported(synthetic({ offsetDelta }))
  unsupported(synthetic({ defaultSize: 5 }))
  unsupported(synthetic({ defaultSize: 7 }))
  unsupported(cat(synthetic(), box('mdat', packet)))
  const truncated = synthetic().subarray(0, synthetic().length - 1)
  unsupported(truncated)
  unsupported(synthetic({ trunFlags: 0 }))
  unsupported(synthetic({ tfhdFlags: 0x020039 }))
})

test('multiple runs and mdats require exact, nonoverlapping sample ownership', () => {
  const grouped = (separate, overlap = false) => {
    const header = full('tfhd', 0, 0x020038, u32(1), u32(1024), u32(6), u32(0x02000000))
    const decode = full('tfdt', 1, 0, u64(0))
    const moof = offset => box('moof', full('mfhd', 0, 0, u32(1)), box('traf', header, decode,
      full('trun', 0, 1, u32(1), u32(offset)),
      separate || overlap
        ? full('trun', 0, 1, u32(1), u32(offset + (overlap ? 0 : 14)))
        : full('trun', 0, 0, u32(1))))
    return cat(baseInit, moof(moof(0).length + 8), separate
      ? cat(box('mdat', packet), box('mdat', packet))
      : box('mdat', packet, packet))
  }
  assert.equal(parse(grouped(false)).frames.length, 2)
  assert.equal(parse(grouped(true)).frames.length, 2)
  unsupported(grouped(false, true))
  unsupported(grouped(true, true))
})

test('only one clear audio track and one AAC sample configuration are accepted', () => {
  const track = find(baseInit, 'moov/trak')
  unsupported(insert(real, 'moov', baseInit.subarray(track.at, track.end)))
  unsupported(synthetic({ trackId: 2 }))
  const encrypted = Buffer.from(real), entry = find(encrypted, 'moov/trak/mdia/minf/stbl/stsd/mp4a')
  encrypted.write('enca', entry.at + 4)
  unsupported(encrypted)
  unsupported(insert(real, 'moov', box('pssh', u32(0))))
  unsupported(insert(real, 'moov/trak/mdia/minf/stbl/stsd/mp4a', box('sinf')))
  unsupported(change(real, 'moov/trak/mdia/minf/dinf/dref/url ', 0, 0))
  unsupported(change(real, 'moov/trak/mdia/minf/stbl/stsd', 4, 2))
  unsupported(change(real, 'moov/trak/mdia/hdlr', 8, 0x76696465))
})

test('AAC configuration, sample table, timescale and track defaults must agree', () => {
  unsupported(change(real, 'moov/trak/mdia/mdhd', 12, 0))
  unsupported(change(real, 'moov/trak/mdia/mdhd', 12, 1000))
  unsupported(change(real, 'moov/mvhd', 20, 0x20000))
  unsupported(change(real, 'moov/trak/mdia/minf/stbl/stsd/mp4a', 24, 44100 * 65536))
  unsupported(change(real, 'moov/trak/mdia/minf/stbl/stsd/mp4a', 16, 1, 2))
  unsupported(change(real, 'moov/trak/mdia/minf/stbl/stts', 4, 1))
  unsupported(change(real, 'moov/mvex/trex', 4, 2))
  const unsupportedCodec = Buffer.from(real)
  const ascAt = unsupportedCodec.indexOf(Buffer.from('119056e500', 'hex'))
  assert(ascAt > 0)
  unsupportedCodec[ascAt] = 0x29 // object type 5 (SBR), not type 2.
  unsupported(unsupportedCodec)
  const shortFrames = Buffer.from(real); shortFrames[ascAt + 1] |= 4
  unsupported(shortFrames)
  const enabledSbr = Buffer.from(real); enabledSbr[ascAt + 4] |= 0x80
  unsupported(enabledSbr)
})

test('initial movie header durations do not replace the appended fragment timeline', () => {
  let declared = change(real, 'moov/trak/mdia/mdhd', 16, 2048)
  declared = change(declared, 'moov/mvhd', 16, 500)
  declared = change(declared, 'moov/trak/tkhd', 20, 1000)
  const result = parse(declared), expected = parse(real)
  assert.deepEqual(result.frames, expected.frames)
  assert.equal(result.end, 4096 / 48000)
  assert.deepEqual({ ...result.durationMetadata }, {
    mdhd: 2048, mediaTimescale: 48000, mvhd: 500, tkhd: 1000, mehd: null,
    movieTimescale: 1000, decodedTicks: 4096, sampleCount: 4, editStartTicks: 0,
    editLengthSeconds: null,
  })
  // Hints cannot turn missing/reordered decode intervals into valid media.
  const init = change(baseInit, 'moov/trak/mdia/mdhd', 16, 100000)
  unsupported(cat(init, fragment(), fragment({ sequence: 3, clock: 2048 })))
  unsupported(cat(init, fragment(), fragment({ sequence: 2, clock: 3072 })))
  unsupported(cat(init, fragment({ defaultSize: 5 })))
})

test('mehd remains a full fragmented duration check with exact diagnostic values', () => {
  const complete = insert(real, 'moov/mvex', full('mehd', 0, 0, u32(85)))
  assert.equal(parse(complete).end, 4096 / 48000)
  const wrong = insert(real, 'moov/mvex', full('mehd', 0, 0, u32(500)))
  assert.throws(() => parse(wrong), /mehd=500, movieTimescale=1000, calculatedRange=0\.\.0\.08533333333333333, calculatedMovieTicks=85\.33333333333333/)
  const top = boxes(complete), second = top.filter(b => b.type === 'moof')[1]
  const mdat = top[top.indexOf(second) + 1]
  const missingTail = cat(complete.subarray(0, second.at), complete.subarray(mdat.end))
  assert.throws(() => parse(missingTail), /Movie fragment duration conflicts.*"decodedTicks":3072/)
})

test('AAC-LC accepts a wholly zero ASC tail without inventing a sync extension', () => {
  for (const length of [0, 1, 2, 3, 16, 40]) {
    const config = cat(Buffer.from('1190', 'hex'), Buffer.alloc(length))
    assert.deepEqual(parse(withAsc(config)), parse(real), `${length} zero tail bytes`)
  }
  // Same AAC-LC syntax at 44.1 kHz as the common 1210000000 configuration.
  let at44100 = withAsc(Buffer.from('1210000000', 'hex'))
  at44100 = change(at44100, 'moov/trak/mdia/mdhd', 12, 44100)
  at44100 = change(at44100, 'moov/trak/mdia/minf/stbl/stsd/mp4a', 24, 44100 * 65536)
  const result = parse(at44100)
  assert.equal(result.frames.length, 4)
  assert.equal(result.end, 4096 / 44100)
  assert.deepEqual(parse(withAsc(cat(Buffer.from('119056e500', 'hex'), Buffer.alloc(16)))), parse(real))
})

test('unknown nonzero ASC tails, enabled SBR and truncated sync flags remain rejected with bounded diagnostics', () => {
  for (const config of ['1190000001', '1190010000', '119056e400', '119056e580', '119056e5', '2990'])
    assert.throws(() => parse(withAsc(Buffer.from(config, 'hex'))), error => {
      assert.match(error.message, /CAPTURE_UNSUPPORTED_MP4/)
      assert.match(error.message, new RegExp(`ASC=${config};`))
      assert.match(error.message, /objectType=\d+; sync=/)
      assert.match(error.message, /extensionObjectType=.+; sbrPresent=/)
      return true
    })
  assert.throws(() => parse(withAsc(Buffer.from('119056e580', 'hex'))), /sync=0x2b7; extensionObjectType=5; sbrPresent=1/)
  const long = cat(Buffer.from('1190', 'hex'), Buffer.alloc(40)); long[long.length - 1] = 1
  assert.throws(() => parse(withAsc(long)), error => {
    const hex = /ASC=([0-9a-f]+)(\.\.\.)?;/.exec(error.message)
    assert(hex)
    assert.equal(hex[1].length, 64)
    assert.equal(hex[2], '...')
    return true
  })
})

test('nonzero composition offsets, dependent samples and encrypted fragments fail closed', () => {
  assert.equal(parse(synthetic({ trunFlags: 0x801, composition: 0 })).frames.length, 2)
  unsupported(synthetic({ trunFlags: 0x801, composition: 1 }))
  unsupported(synthetic({ trunFlags: 0x801, composition: -1, version: 1 }))
  unsupported(synthetic({ defaultFlags: 0x01000000 }))
  unsupported(synthetic({ defaultFlags: 0x02010000 }))
  unsupported(insert(synthetic(), 'moof/traf', full('senc', 0, 0, u32(0))))
  unsupported(insert(synthetic(), 'moof/traf', full('sbgp', 0, 0, u32(0))))
})

const edit = (length, start, rate = 1, count = 1) => box('edts', full('elst', 0, 0, u32(count), u32(length), u32(start), u16(rate), u16(0)))
test('only explicit single rate-1 AAC priming and final subframe edit trims are supported', () => {
  const primed = insert(real, 'moov/trak', edit(64, 1024))
  const result = parse(primed)
  assert.equal(result.frames.length, 3)
  assert.equal(result.start, 0)
  assert.equal(result.end, 0.064)
  const tail = parse(insert(real, 'moov/trak', edit(80, 0)))
  assert.equal(tail.frames.length, 4)
  assert.equal(tail.end, 0.08)
  unsupported(insert(real, 'moov/trak', edit(40, 0)))
  unsupported(insert(real, 'moov/trak', edit(100, 0)))
  unsupported(insert(real, 'moov/trak', edit(64, -1)))
  unsupported(insert(real, 'moov/trak', edit(64, 2048)))
  unsupported(insert(real, 'moov/trak', edit(64, 1024, 0)))
  unsupported(insert(real, 'moov/trak', edit(64, 1024, 1, 2)))
})

test('initialization and nested structure must be complete and unique', () => {
  unsupported(cat(baseInit, real))
  unsupported(real.subarray(0, real.length - 1))
  unsupported(real.subarray(baseInit.length))
  unsupported(insert(real, 'moov/trak/mdia/minf/stbl', box('test')))
  const zeroSize = Buffer.from(real); zeroSize.writeUInt32BE(0, 0); unsupported(zeroSize)
  const hugeSize = Buffer.from(real); hugeSize.writeUInt32BE(0xffffffff, 0); unsupported(hugeSize)
  const first = boxes(real)[0]
  const extended = cat(u32(1), Buffer.from('ftyp'), u64(first.end + 8), real.subarray(first.start, first.end), real.subarray(first.end))
  assert.equal(parse(extended).frames.length, 4)
})

test('free and skip padding in initialization containers leaves the AAC timeline unchanged', () => {
  const containers = ['moov', 'moov/trak', 'moov/trak/mdia', 'moov/trak/mdia/minf',
    'moov/trak/mdia/minf/dinf', 'moov/trak/mdia/minf/stbl',
    'moov/trak/mdia/minf/stbl/stsd/mp4a', 'moov/mvex']
  for (const type of ['free', 'skip']) {
    for (const container of containers) {
      // Payload is opaque, including bytes that would be invalid boxes if traversed.
      const padded = insert(real, container, cat(box(type), box(type, [0xff, 0, 0x73])))
      assert.deepEqual(parse(padded), parse(real), `${container}/${type}`)
    }
    const edited = insert(real, 'moov/trak', edit(80, 0))
    assert.deepEqual(parse(insert(edited, 'moov/trak/edts', box(type, [1, 2]))), parse(edited))
    const extended = cat(u32(1), Buffer.from(type), u64(19), [0xff, 0, 1])
    assert.deepEqual(parse(insert(real, 'moov', extended)), parse(real))
  }
})

test('padding still requires a complete declared size inside its own container', () => {
  for (const type of ['free', 'skip']) {
    for (const malformed of [
      cat(u32(0), Buffer.from(type)),
      cat(u32(7), Buffer.from(type)),
      cat(u32(16), Buffer.from(type), [1]),
      cat(u32(1), Buffer.from(type)),
      cat(u32(1), Buffer.from(type), u64(12)),
      cat(u32(1), Buffer.from(type), u64(BigInt(Number.MAX_SAFE_INTEGER) + 1n)),
      cat(box(type), [0]),
    ]) unsupported(insert(real, 'moov/trak/mdia/minf/stbl', malformed))
  }
})

test('fragment padding never repairs stale offsets or relaxes mdat sample ownership', () => {
  for (const type of ['free', 'skip']) {
    for (const container of ['moof', 'moof/traf']) {
      const padded = insert(synthetic(), container, box(type, [7, 8, 9]))
      unsupported(padded) // The previous data offset now points into metadata.
      const moof = find(padded, 'moof')
      const correct = change(padded, 'moof/traf/trun', 8, moof.end - moof.at + 8)
      assert.deepEqual(parse(correct), parse(synthetic()))
      unsupported(change(correct, 'moof/traf/trun', 8, moof.end - moof.at + 9))
      unsupported(change(correct, 'moof/traf/tfhd', 12, 5))
    }
  }
})

test('padding does not whitelist unknown boxes or replace required or counted entries', () => {
  for (const type of ['sinf', 'senc', 'saiz', 'test']) {
    unsupported(insert(real, 'moov/trak/mdia/minf/stbl/stsd/mp4a', box(type)))
    unsupported(insert(real, 'moov/mvex', box(type)))
  }
  for (const type of ['free', 'skip']) {
    const missingDefaults = Buffer.from(real)
    missingDefaults.write(type, find(missingDefaults, 'moov/mvex/trex').at + 4, 4, 'ascii')
    unsupported(missingDefaults)
    unsupported(insert(real, 'moov/trak/mdia/minf/stbl/stsd', box(type)))
    unsupported(insert(real, 'moov/trak/mdia/minf/dinf/dref', box(type)))
  }
})
