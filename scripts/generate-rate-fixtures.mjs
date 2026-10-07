// Local synthetic AAC-LC fixture: content tone / reference ad tone / content tone.
// This does not contact YouTube. AAC's first 1024-sample priming frame is trimmed
// using the same explicit MSE tuple later applied by the browser benchmark.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import vm from 'node:vm'

const args = ['-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=1',
  '-f', 'lavfi', '-i', 'sine=frequency=1499:sample_rate=48000:duration=0.5',
  '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=0.548',
  '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]', '-map', '[a]',
  '-ac', '2', '-c:a', 'aac', '-b:a', '96k',
  '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000', '-f', 'mp4', 'pipe:1']
const encoded = spawnSync('ffmpeg', args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
if (encoded.error || encoded.status !== 0) throw encoded.error ?? new Error(encoded.stderr.toString())
const context = vm.createContext({ Uint8Array, ArrayBuffer, DataView })
vm.runInContext(readFileSync(new URL('../src-tauri/src/capture-mp4.js', import.meta.url), 'utf8'), context)
const inventory = context.__musifyCaptureMp4.inspectPrefix(new Uint8Array(encoded.stdout), { final: true })
const offset = -1024 / 48000, duration = 2.048
if (inventory.samples.length !== 97 || Math.abs(inventory.samples.at(-1).end + offset - duration) > 1 / 48000)
  throw new Error('Unexpected synthetic encoder inventory; do not silently change the reference clock')
const fixture = {
  provenance: { generator: 'scripts/generate-rate-fixtures.mjs',
    encoder: spawnSync('ffmpeg', ['-version'], { windowsHide: true, encoding: 'utf8' }).stdout.split(/\r?\n/)[0],
    description: 'Synthetic 997 Hz content and 1499 Hz reference ad, AAC-LC 48 kHz stereo; no remote media.',
    referenceAdStart: 1, referenceAdEnd: 1.5, contentHz: 997, adHz: 1499, args },
  probe: { label: 'synthetic-rate-aac-2s', mime: 'audio/mp4; codecs="mp4a.40.2"',
    base64: encoded.stdout.toString('base64'), quantum: 1 / 48000,
    settings: { timestampOffset: offset, appendWindowStart: 0, appendWindowEnd: duration, mode: 'segments' },
    expected: { start: 0, end: duration } },
}
writeFileSync(new URL('../tests/fixtures/mse-rates.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n')
console.log(JSON.stringify({ bytes: encoded.stdout.length, frames: inventory.samples.length, duration, output: 'tests/fixtures/mse-rates.json' }))
