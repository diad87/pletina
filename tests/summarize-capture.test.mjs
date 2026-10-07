import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { summarize, markdown, readInputs } from '../scripts/summarize-capture.mjs'

const corpus = { expectedTracks: 30, albums: [{ query: 'Corpus', expectedTracks: 30,
  rows: Array.from({ length: 30 }, (_, i) => ({ id: `video-${i + 1}`, label: `Canción ${i + 1}` })) }] }
const report = (date, rows, changes = {}) => ({ startedAt: date, captureSuite: { mode: 'latency', scope: 'timingOnly',
  experimental: true, running: false, rows, ...changes } })
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

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

test('un anuncio al fallar el contexto o abortar no se atribuye como timeout publicitario del destino', () => {
  const attempt = { videoId: 'video-1', phase: 'finished', ok: false, firstSoundMs: null,
    failures: ['Error: Se agotó la espera operativa'], status: { state: 'ad', adMs: 20000, lastProgressAgoMs: 100,
      lastDiagnostic: JSON.stringify({ paused: false, rate: 1, evidence: { adMarker: true, adClassShowing: true, position: 20, mediaDuration: 120 } }) } }
  for (const changes of [{ failedPhase: 'context' }, { aborted: true }, { phase: 'aborted' }, { failedPhase: 'aborted' }]) {
    const row = { ...attempt, ...changes }
    const summary = summarize([{ source: 'switch.json', report: report('2026-10-07T09:00:00Z', [row], { mode: 'switch' }) }], { corpus })
    const result = summary.runs[0].rows[0]
    assert.equal(result.inference, null)
    assert.notEqual(result.state, 'unmeasured/ad-timeout')
    assert.equal(result.timingCriteria.firstSound, 'not-measured')
    assert.equal(result.metrics.unpreparedSwitchMs, null)
    assert.equal(result.metrics.unpreparedSwitchWithoutAdMs, null)
    assert.deepEqual(result.rawRow, row)
  }
  const target = summarize([{ source: 'switch.json', report: report('2026-10-07T09:00:00Z', [{ ...attempt, failedPhase: 'switching' }], { mode: 'switch' }) }], { corpus })
  assert.equal(target.runs[0].rows[0].state, 'unmeasured/ad-timeout', 'an actually started destination measurement retains the existing rule')
})

test('interrupción hermana verificada conserva seis resultados terminados, medición parcial y pendientes sin cambiar el raw', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'musify-summary-interruption-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const resultPath = join(directory, 'result-20261007-085653.json')
  const interruptionPath = join(directory, 'interruption-20261007-085653.json')
  const rows = Array.from({ length: 30 }, (_, i) => ({ videoId: `video-${i + 1}`, label: `Canción ${i + 1}`,
    phase: i < 6 ? 'finished' : i === 6 ? 'listening' : 'pending', ok: false,
    ...(i <= 6 ? { firstSoundMs: 1200 + i, nextTrackMs: i === 0 ? undefined : 420 } : {}),
    failures: i < 6 ? ['EOF sin verificación completa'] : [],
  }))
  const original = '\uFEFF' + JSON.stringify(report('2026-10-07T08:56:53+02:00', rows, { mode: 'album', scope: 'complete', running: true }))
  const sidecar = { report: 'result-20261007-085653.json', reportSha256: sha256(original).toUpperCase(),
    stoppedAt: '2026-10-07T09:27:36+02:00', completedRows: 6, reason: 'Repetición con nueva versión; conservar intento parcial' }
  await writeFile(resultPath, original)
  await writeFile(interruptionPath, JSON.stringify(sidecar))
  const inputs = await readInputs([resultPath])
  const summary = summarize(inputs, { corpus })
  const run = summary.runs[0]
  assert.equal(run.reportedRunning, true)
  assert.equal(run.running, false)
  assert.equal(run.interrupted, true)
  assert.equal(run.interruption.verified, true)
  assert.equal(run.interruption.verification, 'report-filename+sha256')
  assert.equal(run.interruptionSource, interruptionPath)
  assert.equal(run.sha256, sha256(original))
  assert.deepEqual(run.rows.slice(0, 6).map(row => row.state), Array(6).fill('failed'))
  assert.equal(summary.cases.filter(row => row.errorHistory.length).length, 6)
  assert.equal(run.rows[6].state, 'interrupted')
  assert.equal(run.rows[6].attemptState, 'interrupted')
  assert.equal(run.rows[6].metrics.firstSoundMs, 1206, 'retain an existing partial measurement')
  assert.equal(run.rows[6].metrics.elapsedMs, null, 'do not invent the duration of an interrupted row')
  assert.equal(run.rows[6].metrics.completeness, 'not-measured')
  assert.equal(run.rows[6].timingCriteria.firstSound, 'measured')
  assert.deepEqual(run.rows[6].failures, [])
  for (const row of run.rows.slice(7)) {
    assert.equal(row.state, 'not-exercised')
    assert.equal(row.metrics.firstSoundMs, null)
    assert.equal(row.metrics.nextTrackMs, null)
    assert.equal(row.metrics.elapsedMs, null)
    assert.equal(row.timingCriteria.firstSound, 'not-measured')
    assert.equal(row.interruption.stoppedAt, sidecar.stoppedAt)
    assert.deepEqual(row.failures, [])
  }
  assert.equal(run.rows.some(row => ['in-progress', 'measured-pass'].includes(row.state)), false)
  assert.equal(run.rows.every(row => row.acceptanceOk === false), true)
  const output = markdown(summary)
  assert.match(output, /Interrumpida/)
  assert.match(output, /Interrumpido; medición parcial/)
  assert.match(output, /No ejercitado: ejecución interrumpida/)
  assert.doesNotMatch(output, /En curso/)
  assert.equal((output.match(/EOF sin verificación completa/g) ?? []).length, 6)
  assert.equal(await readFile(resultPath, 'utf8'), original, 'input bytes, including BOM and running:true, are unchanged')
  assert.equal(inputs[0].report.captureSuite.running, true)
})

test('nombre o hash contradictorios y auxiliar ilegible nunca convierten una ejecución activa en interrumpida', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'musify-summary-invalid-interruption-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const resultPath = join(directory, 'result-test.json'), interruptionPath = join(directory, 'interruption-test.json')
  const raw = JSON.stringify(report('2026-10-07T09:00:00Z', [{ videoId: 'video-1', phase: 'listening', ok: false, failures: [] }], { running: true }))
  await writeFile(resultPath, raw)
  const valid = { report: 'result-test.json', reportSha256: sha256(raw), stoppedAt: '2026-10-07T10:00:00Z' }
  for (const [changes, warning] of [[{ report: 'result-other.json' }, /nombre del informe/],
    [{ reportSha256: '0'.repeat(64) }, /SHA256/], [{ reportSha256: null }, /SHA256/], [{ reportSha256: [sha256(raw)] }, /SHA256/],
    [{ stoppedAt: 'sin fecha' }, /fecha de interrupción/], [null, /ilegible/]]) {
    await writeFile(interruptionPath, changes === null ? '{ unfinished' : JSON.stringify({ ...valid, ...changes }))
    const inputs = await readInputs([resultPath]), summary = summarize(inputs, { corpus })
    assert.equal(summary.runs[0].running, true)
    assert.equal(summary.runs[0].interrupted, false)
    assert.equal(summary.runs[0].interruption, null)
    assert.equal(summary.cases[0].latest.latency.state, 'in-progress')
    assert(summary.runs[0].warnings.some(value => warning.test(value)))
    assert.match(markdown(summary), /En curso/)
    assert.equal(await readFile(resultPath, 'utf8'), raw)
  }
  const unverified = summarize([{ source: resultPath, report: JSON.parse(raw), interruption: valid }], { corpus })
  assert.equal(unverified.runs[0].interrupted, false, 'pure aggregation also requires the actual input hash')
})

test('completedRows no sustituye fases del raw y el CLI protege el auxiliar de sobrescritura', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'musify-summary-interruption-protection-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const resultPath = join(directory, 'result-test.json'), interruptionPath = join(directory, 'interruption-test.json')
  const raw = JSON.stringify(report('2026-10-07T09:00:00Z', [{ videoId: 'video-1', phase: 'pending', ok: false, failures: [] }], { running: true }))
  const sidecar = JSON.stringify({ report: resultPath, reportSha256: sha256(raw), stoppedAt: '2026-10-07T10:00:00Z', completedRows: 30 })
  await writeFile(resultPath, raw); await writeFile(interruptionPath, sidecar)
  const summary = summarize(await readInputs([resultPath]), { corpus })
  assert.equal(summary.runs[0].interrupted, true)
  assert.equal(summary.runs[0].rows[0].state, 'not-exercised')
  assert(summary.runs[0].warnings.some(value => /completedRows/.test(value)))
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/summarize-capture.mjs', import.meta.url)), '--json', interruptionPath, resultPath], { encoding: 'utf8', windowsHide: true })
  assert.equal(cli.status, 1)
  assert.match(cli.stderr, /evidencia adjunta/)
  assert.equal(await readFile(resultPath, 'utf8'), raw)
  assert.equal(await readFile(interruptionPath, 'utf8'), sidecar)
})
