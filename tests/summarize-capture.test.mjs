import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { summarize, markdown, readInputs } from '../scripts/summarize-capture.mjs'

const corpus = { expectedTracks: 30, albums: [{ query: 'Corpus', expectedTracks: 30,
  rows: Array.from({ length: 30 }, (_, i) => ({ id: `video-${i + 1}`, label: `Canción ${i + 1}` })) }] }
const report = (date, rows, changes = {}) => ({ startedAt: date, captureSuite: { mode: 'latency', scope: 'timingOnly',
  experimental: true, running: false, rows, ...changes } })

test('la última ejecución fallida sustituye al éxito anterior, conservando 30 filas y todo el historial', () => {
  const failed = { videoId: 'video-1', label: 'uno', ok: false, phase: 'finished', firstSoundMs: 5000,
    completeNotExercised: true, failures: ['Supera 3 s'] }
  const passed = { videoId: 'video-1', label: 'uno', ok: true, phase: 'finished', firstSoundMs: 1000, failures: [] }
  const summary = summarize([
    { source: 'new.json', report: report('2026-10-07T09:00:00Z', [failed]) },
    { source: 'old.json', report: report('2026-10-07T08:00:00Z', [passed]) },
  ], { corpus, generatedAt: '2026-10-07T10:00:00Z' })
  assert.equal(summary.cases.length, 30)
  assert.equal(summary.cases[0].latest.latency.source, 'new.json')
  assert.equal(summary.cases[0].latest.latency.state, 'failed')
  assert.equal(summary.cases[0].latest.latency.metrics.completeness, 'not-exercised')
  assert.equal(summary.cases[0].history.length, 2)
  assert.deepEqual(summary.cases[0].errorHistory[0].failures, ['Supera 3 s'])
  assert.equal(summary.cases[29].latest.latency, null)
  assert.equal(summary.runs.length, 2)
  assert.equal(summary.acceptanceOk, false)
  assert.match(markdown(summary), /Canción 30/)
  assert.match(markdown(summary), /No ejercitado/)
})

test('el snapshot en curso no se omite; etiquetas canónicas y métricas no prometen cero anuncios ni cortes', () => {
  const rawLabel = 'Radiohead â€” Airbag'
  const summary = summarize([
    { source: 'old.json', report: report('2026-10-07T08:00:00Z', [{ videoId: 'video-1', ok: true, failures: [] }]) },
    { source: 'running.json', report: report('2026-10-07T09:00:00Z', [{ videoId: 'video-1', label: rawLabel,
      phase: 'backfill', ok: false, failures: [], gaps: [], adsDelivered: 0, complete: false }], { mode: 'smoke', scope: 'complete', running: true }) },
  ], { corpus })
  const row = summary.cases[0].latest.latency
  assert.equal(summary.cases[0].label, 'Canción 1')
  assert.equal(row.rawLabel, rawLabel)
  assert.equal(row.rawRow.label, rawLabel)
  assert.equal(row.state, 'in-progress')
  assert.equal(row.metrics.labelledAdsDelivered, 0)
  assert.equal(row.metrics.semanticAdAbsence, 'unverified')
  assert.equal(row.metrics.normalGapCount, 0)
  assert.equal(row.metrics.allPlaybackStallCount, null)
  assert.equal(row.metrics.continuity, 'not-exercised-for-full-song')
  assert(summary.runs[1].warnings.some(warning => /decodificación incorrecta/.test(warning)))
  assert.match(markdown(summary), /no demuestra cero cortes/)
})

test('metadata adjunta aporta fecha/commit y conflictos; un JSON roto sigue visible como error de entrada', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'musify-summary-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const resultPath = join(directory, 'result-20261007-082319.json')
  const invalidPath = join(directory, 'broken.json')
  await writeFile(resultPath, JSON.stringify(report('2026-10-07T06:23:20Z', [
    { videoId: 'outside', label: 'Control', ok: false, failures: ['Latencia de cuarentena'], complete: true },
  ], { mode: 'smoke', scope: 'complete' })))
  await writeFile(join(directory, 'metadata-20261007-082319.json'), JSON.stringify({
    report: resultPath, startedAt: '2026-10-07T08:23:19+02:00', commit: '85cb60b', progressiveExperiment: false,
  }))
  await writeFile(invalidPath, '{ unfinished')
  const inputs = await readInputs([resultPath, invalidPath])
  const summary = summarize(inputs, { corpus })
  assert.equal(summary.runs.length, 2)
  assert.equal(summary.runs[0].commit, '85cb60b')
  assert.equal(summary.runs[0].dateSource, 'metadata.startedAt')
  assert.equal(summary.runs[0].category, 'quarantine')
  assert(summary.runs[0].experiment.conflicts.some(conflict => /report declara/.test(conflict)))
  assert.equal(summary.outsideCorpus[0].id, 'outside')
  assert.equal(summary.outsideCorpus[0].latest.quarantine.metrics.completeness, 'verified')
  assert.equal(summary.inputErrors.length, 1)
  assert.equal(summary.inputErrors[0].source, invalidPath)
  assert(summary.runs[0].sha256.length === 64)
})

test('timeout durante anuncio activo es una inferencia no medida; unknown o evidencia vieja no lo son', () => {
  const status = { state: 'ad', adMs: 117683, lastProgressAgoMs: 311,
    lastDiagnostic: JSON.stringify({ paused: false, rate: 1, evidence: { adMarker: true, adClassShowing: true,
      adOverlayVisible: true, position: 106.343803, mediaDuration: 381.221 } }) }
  const attempt = { videoId: 'video-1', phase: 'finished', ok: false, firstSoundMs: null,
    failures: ['Error: Se agotó la espera operativa; el criterio temporal no se ha superado'], status }
  const inputs = [
    { source: 'ad-timeout.json', report: report('2026-10-07T08:00:00Z', [attempt]) },
    { source: 'retry.json', report: report('2026-10-07T09:00:00Z', [{ ...attempt, firstSoundMs: 1200, ok: true, failures: [], status: { state: 'content' } }]) },
    { source: 'unknown.json', report: report('2026-10-07T08:00:00Z', [{ ...attempt, videoId: 'video-2', status: { ...status, state: 'unknown' } }]) },
    { source: 'stale.json', report: report('2026-10-07T08:00:00Z', [{ ...attempt, videoId: 'video-3', status: { ...status, lastProgressAgoMs: 6000 } }]) },
  ]
  const summary = summarize(inputs, { corpus })
  const timeout = summary.runs[0].rows[0]
  assert.equal(timeout.state, 'unmeasured/ad-timeout')
  assert.equal(timeout.attemptState, 'failed')
  assert.equal(timeout.timingCriteria.firstSound, 'not-measured')
  assert.equal(timeout.inference.inferred, true)
  assert.equal(timeout.inference.evidence.mediaDuration, 381.221)
  assert.deepEqual(timeout.rawRow, attempt)
  assert.equal(summary.cases[0].latest.latency.state, 'measured-pass')
  assert.equal(summary.cases[0].errorHistory[0].state, 'unmeasured/ad-timeout')
  assert.equal(summary.cases[1].latest.latency.state, 'failed')
  assert.equal(summary.cases[1].latest.latency.inference, null)
  assert.equal(summary.cases[2].latest.latency.inference, null)
  assert.match(markdown(summary), /primer sonido no medido; ad-timeout inferido/)
  assert.match(markdown(summary), /106\.343803\/381\.221 s/)
})
