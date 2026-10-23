import test from 'node:test'
import assert from 'node:assert/strict'
import { compareRecordingWaveform } from './helpers/recording-waveform.mjs'

const RATE = 2205
function noise(seconds, seed) {
  const samples = new Float32Array(seconds * RATE)
  let state = seed
  for (let index = 0; index < samples.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    samples[index] = (state / 0x100000000 - 0.5) * 0.6
  }
  return samples
}
const buffer = samples => ({ sampleRate: RATE, length: samples.length, duration: samples.length / RATE,
  numberOfChannels: 1, getChannelData: () => samples })
const reference = noise(30, 113)
const negative = buffer(noise(30, 919))

test('a known excerpt is aligned despite an offset, changed gain and a DC offset', () => {
  const candidate = noise(60, 311), offset = Math.round(12.25 * RATE)
  candidate.set(reference.map(value => value * 0.4 + 0.08), offset)
  const result = compareRecordingWaveform(buffer(candidate), buffer(reference), negative)
  assert.equal(result.matched, true)
  assert.ok(Math.abs(result.full.offsetSeconds - offset / RATE) < 1 / RATE)
  assert.ok(result.full.correlation > 0.999)
})

test('unrelated recordings do not pass', () => {
  const result = compareRecordingWaveform(buffer(noise(60, 553)), buffer(reference), negative)
  assert.equal(result.matched, false)
  assert.ok(result.full.correlation < 0.1)
})

test('a matching eight-second sample alone does not approve a different recording', () => {
  const candidate = noise(60, 557)
  candidate.set(reference.subarray(0, 8 * RATE), 12 * RATE)
  const result = compareRecordingWaveform(buffer(candidate), buffer(reference), negative)
  assert.equal(result.matched, false)
})

test('a silent reference is rejected instead of being considered a match', () => {
  assert.throws(() => compareRecordingWaveform(buffer(noise(60, 557)), buffer(new Float32Array(30 * RATE)), negative),
    /insufficient non-silent energy/)
})

test('absence of a musical negative control does not approve a candidate', () => {
  const candidate = noise(60, 557)
  candidate.set(reference, 12 * RATE)
  const result = compareRecordingWaveform(buffer(candidate), buffer(reference), null)
  assert.equal(result.matched, false)
})

test('an excerpt match cannot establish the identity of unreferenced audio', () => {
  // Deliberately different audio surrounds an identical 30-second excerpt.
  // This documents the information limit; it is not a full-master acceptance gate.
  const candidate = noise(60, 557)
  candidate.set(reference, 12 * RATE)
  const result = compareRecordingWaveform(buffer(candidate), buffer(reference), negative)
  assert.equal(result.matched, true)
  assert.match(result.coverageLimit, /not a proof of every second/)
})
