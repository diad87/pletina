import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/extractor/bench.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import[^\n]+\n/gm, '')
const { rateEvidence } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('rate evidence measures native clock advance against wall time, not the requested rate', () => {
  const result = rateEvidence([{ wallMs: 0, mediaTime: 0, rate: 16 }, { wallMs: 500, mediaTime: 1, rate: 16 }, { wallMs: 1000, mediaTime: 2, rate: 16 }], 1, 1.5)
  assert.equal(result.measuredRate, 2)
  assert.equal(result.clockSlope, 2)
  assert.equal(result.unsafeAdMediaMs, 500)
  assert.equal(result.unsafeAdWallMs, 250)
})

test('a native rate switch before the reference ad leaves no accelerated ad interval', () => {
  const result = rateEvidence([{ wallMs: 0, mediaTime: 0, rate: 4 }, { wallMs: 225, mediaTime: 0.9, rate: 4 },
    { wallMs: 225, mediaTime: 0.9, rate: 1 }, { wallMs: 825, mediaTime: 1.5, rate: 1 }, { wallMs: 1373, mediaTime: 2.048, rate: 1 }], 1, 1.5)
  assert.equal(result.adMediaMs, 500)
  assert.equal(result.unsafeAdMediaMs, 0)
})

test('a marker 120 ms late exposes its already-presented ad interval instead of relabeling it', () => {
  const result = rateEvidence([{ wallMs: 0, mediaTime: 0, rate: 4 }, { wallMs: 225, mediaTime: 0.9, rate: 4 },
    { wallMs: 280, mediaTime: 1.12, rate: 4 }, { wallMs: 280, mediaTime: 1.12, rate: 1 },
    { wallMs: 660, mediaTime: 1.5, rate: 1 }, { wallMs: 1208, mediaTime: 2.048, rate: 1 }], 1, 1.5)
  assert.ok(Math.abs(result.unsafeAdMediaMs - 120) < 0.000001)
  assert.ok(Math.abs(result.unsafeAdWallMs - 30) < 0.000001)
  assert.equal(result.adMediaMs, 500)
})

test('a clock discontinuity cannot masquerade as native playback throughput', () => {
  assert.throws(() => rateEvidence([{ wallMs: 0, mediaTime: 1, rate: 1 }, { wallMs: 10, mediaTime: 0, rate: 1 }], 1, 1.5), /retrocedió/)
})

test('a 16x native clock can remain accelerated after playbackRate already reports 1', () => {
  // Subset of WebView2 result-20261007-081251, early marker at mediaTime 0.988873.
  const result = rateEvidence([
    { wallMs: 98, mediaTime: 0.898118, rate: 16 },
    { wallMs: 103, mediaTime: 0.988873, rate: 16 },
    { wallMs: 103, mediaTime: 0.988873, rate: 1 },
    { wallMs: 107.5, mediaTime: 0.989305, rate: 1 },
    { wallMs: 117.90000009536745, mediaTime: 0.989305, rate: 1 },
    { wallMs: 123.30000019073486, mediaTime: 1.272888, rate: 1 },
    { wallMs: 137.5, mediaTime: 1.287008, rate: 1 },
    { wallMs: 142.80000019073486, mediaTime: 1.587968, rate: 1 },
  ], 1, 1.5)
  assert.equal(result.unsafeAdMediaMs, 0, 'the applied property alone would have claimed success')
  assert.equal(result.adClockTooFast, true)
  assert.equal(result.adClockStatus, 'incompatible-with-1x')
  assert.ok(result.adPaceLowerBound > 19)
  assert.ok(result.acceleratedAdMediaMs > 480)
})

test('coherent 1x clock brackets remain only consistency evidence, not an identity guarantee', () => {
  const result = rateEvidence([{ wallMs: 0, mediaTime: 0.99, rate: 1 }, { wallMs: 20, mediaTime: 1.01, rate: 1 },
    { wallMs: 490, mediaTime: 1.48, rate: 1 }, { wallMs: 520, mediaTime: 1.51, rate: 1 }], 1, 1.5)
  assert.equal(result.adClockTooFast, false)
  assert.equal(result.adClockStatus, 'consistent-with-1x-not-proof')
})
