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

test('el modo nativo incluye snapshots latest/final/seek y nunca oculta una contradicción con el plan', () => {
  for (const key of ['latestStatus', 'finalStatus', 'seekStatus']) {
    const summary = summarize([{ source: `${key}.json`, report: report('2026-10-07T09:00:00Z', [
      { videoId: 'video-1', phase: 'listening', [key]: { progressiveExperiment: false } },
    ], { running: true }) }], { corpus })
    assert.equal(summary.runs[0].experiment.value, false, key)
    assert.equal(summary.runs[0].experiment.source, 'native-status', key)
    assert.equal(summary.runs[0].category, 'quarantine', key)
    assert.ok(summary.runs[0].experiment.conflicts.some(value => value.includes('report declara experimental=true')), key)
    assert.match(markdown(summary), /Normal: cuarentena completa \(native-status\)/)
  }
  const mixed = summarize([{ source: 'mixed.json', report: report('2026-10-07T09:00:00Z', [
    { videoId: 'video-1', status: { progressiveExperiment: true }, latestStatus: { progressiveExperiment: false } },
  ]) }], { corpus })
  assert.equal(mixed.runs[0].experiment.value, null)
  assert.ok(mixed.runs[0].warnings.some(value => value.includes('contradictorios')))
  assert.match(markdown(mixed), /Desconocido o contradictorio/)
})

test('treinta cambios, cuatro reintentos y dos normales mantienen categorías e historial independientes', () => {
  const row = (id, ok, extra = {}) => ({ videoId: `video-${id}`, phase: 'finished', ok,
    failures: ok ? [] : ['Fallo de este intento'], status: { progressiveExperiment: true, adsSeen: 2, adsDelivered: 0 }, ...extra })
  const baseline = Array.from({ length: 30 }, (_, i) => row(i + 1, i !== 0, { unpreparedSwitchMs: 1200 }))
  const retry = Array.from({ length: 4 }, (_, i) => row(i + 1, i !== 1, { unpreparedSwitchMs: i === 1 ? 6000 : 1100 }))
  const normal = [1, 2].map(id => row(id, true, { firstSoundMs: 250000, complete: true, coverageOk: true,
    status: { progressiveExperiment: false, adsSeen: 1, adsDelivered: 0 } }))
  const summary = summarize([
    { source: 'switch30.json', report: report('2026-10-07T09:00:00Z', baseline, { mode: 'switch', scope: 'cold-switch' }) },
    { source: 'retry4.json', report: report('2026-10-07T10:00:00Z', retry, { mode: 'switch', scope: 'cold-switch' }) },
    { source: 'normal2.json', report: report('2026-10-07T11:00:00Z', normal, { mode: 'smoke', scope: 'full-quarantine', experimental: false }) },
  ], { corpus })
  assert.deepEqual(summary.runs.map(run => run.rows.length), [30, 4, 2])
  assert.deepEqual(summary.runs.map(run => run.category), ['switch', 'switch', 'quarantine'])
  assert.equal(summary.cases[0].latest.switch.source, 'retry4.json')
  assert.equal(summary.cases[0].latest.switch.state, 'measured-pass')
  assert.equal(summary.cases[0].errorHistory[0].runId, '1:switch30.json')
  assert.equal(summary.cases[1].latest.switch.state, 'failed')
  assert.equal(summary.cases[1].latest.quarantine.metrics.firstSoundMs, 250000)
  assert.equal(summary.cases[1].latest.quarantine.metrics.completeness, 'verified')
  assert.equal(summary.cases[4].latest.switch.source, 'switch30.json')
  assert.equal(summary.cases[0].history.length, 3)
  assert.equal(summary.acceptanceOk, false); assert.equal(summary.guaranteeAds, false)
  const output = markdown(summary)
  assert.match(output, /Modo efectivo/)
  assert.match(output, /Progresivo experimental \(native-status\)/)
  assert.match(output, /Normal: cuarentena completa \(native-status\)/)
  assert.match(output, /1:switch30.json \/ video-1: Fallo de este intento/)
  assert.match(output, /2:retry4.json \/ video-2: Fallo de este intento/)
  assert.match(output, /no anuncios únicos/)
})

test('tablas publicitarias separan fuentes observadas y unidades declaradas por categoría sin sumar snapshots ni ocultar intentos', () => {
  const summary = summarize([
    { source: 'old-album.json', report: report('2026-10-07T08:00:00Z', [{ videoId: 'video-1', phase: 'finished', ok: false,
      adsSeen: 2, adsDelivered: 0, failures: ['Fallo previo conservado'] }], { mode: 'album', scope: 'complete' }) },
    { source: 'album.json', report: report('2026-10-07T09:00:00Z', [{ videoId: 'video-1', phase: 'finished', ok: false,
      adsSeen: 1, adsDelivered: 0, status: { adsSeen: 1, adsDelivered: 0, adObservations: 39 }, startStatus: { adsSeen: 1 },
      failures: ['EOF sin verificación completa'] }], { mode: 'album', scope: 'complete' }) },
    { source: 'latency.json', report: report('2026-10-07T09:00:00Z', [{ videoId: 'video-1', phase: 'finished', ok: true,
      adsSeen: 3, adsDelivered: 0, status: { adsSeen: 3, adsDelivered: 0 }, startStatus: { adsSeen: 2 }, failures: [] }]) },
    { source: 'switch.json', report: report('2026-10-07T09:00:00Z', [{ videoId: 'video-1', phase: 'finished', ok: false,
      failures: ['Preparación fallida'] }], { mode: 'switch' }) },
    { source: 'running.json', report: report('2026-10-07T10:00:00Z', [{ videoId: 'video-2', phase: 'listening', ok: false,
      latestStatus: { adsSeen: 4, adsDelivered: 0 }, failures: [] }], { mode: 'album', scope: 'complete', running: true }) },
  ], { corpus })
  const output = markdown(summary), ads = output.split('## Anuncios observados por caso y categoría')[1].split('## Reproducción observada')[0]
  assert.match(ads, /Anuncios observados \(fuentes\)/)
  assert.match(ads, /Unidades etiquetadas anuncio entregadas \(filtro\)/)
  assert.match(ads, /\| Canción 1 \/ video-1 \| Álbum natural \| 1 \| 0 \| 2:album\.json \|/)
  assert.match(ads, /\| Canción 1 \/ video-1 \| Latencia \| 3 \| 0 \| 3:latency\.json \|/)
  assert.match(ads, /\| Canción 1 \/ video-1 \| Cambio en frío \| n\/d \| n\/d \| 4:switch\.json \|/)
  assert.match(ads, /\| Canción 2 \/ video-2 \| Álbum natural \| 4 \| 0 \| 5:running\.json \|/)
  assert.equal(summary.cases[0].latest.album.metrics.adObservations, 39)
  assert.equal(summary.cases[0].history.length, 4)
  assert.equal(summary.cases[0].errorHistory.length, 3)
  assert.match(output, /Fallo previo conservado/)
  assert.match(output, /EOF sin verificación completa/)
  assert.match(output, /Un 0 no detecta publicidad mal etiquetada/)
  assert.match(output, /No se suman snapshots/)
  assert.equal(summary.runs.length, 5)
  assert.equal(summary.acceptanceOk, false)
  assert.equal(summary.guaranteeAds, false)
})

test('ended y cobertura MSE observados permanecen visibles aunque el registro global siga incompleto', () => {
  const ended = { type: 'ended', ms: 213456.7, position: 212.981, phase: 'listening' }
  const row = { videoId: 'video-1', phase: 'finished', ok: false, complete: false, coverageOk: true,
    endedPosition: 212.981, gaps: [], allPlaybackStalls: [], events: [{ type: 'playing', ms: 500, position: 0, phase: 'startup' }, ended],
    failures: ['EOF sin verificación completa'] }
  const summary = summarize([{ source: 'album.json', report: report('2026-10-07T09:00:00Z', [row], { mode: 'album', scope: 'complete' }) }], { corpus })
  const entry = summary.cases[0].latest.album, m = entry.metrics, output = markdown(summary)
  assert.equal(m.nativeEndedObserved, true)
  assert.equal(m.nativeEndedEventCount, 1)
  assert.equal(m.nativeEndedAtMs, 213456.7)
  assert.equal(m.nativeEndedPosition, 212.981)
  assert.equal(m.nativeEndedPhase, 'listening')
  assert.equal(m.normalGapCount, 0)
  assert.equal(m.allPlaybackStallCount, 0)
  assert.equal(m.coverageOk, true)
  assert.equal(m.completeness, 'incomplete')
  assert.equal(m.continuity, 'not-exercised-for-full-song', 'existing continuity inference is unchanged')
  assert.equal(entry.state, 'failed')
  assert.deepEqual(entry.rawRow, row)
  assert.match(output, /\| Sí; pos 212\.981000 s; t\+213456\.7 ms; listening \| 0; 0 abiertos; duración 0\.0 ms \| 0 \| Sí \| Incompleta \|/)
  assert.match(output, /Cero eventos observados no equivale a cero huecos PCM/)
  assert.match(output, /puede haber ended y un rango MSE continuo mientras el registro global sigue incompleto/)
})

test('esperas abiertas y ended tras seek se muestran sin inventar duración ni escuchar la canción completa', () => {
  const summary = summarize([{ source: 'smoke.json', report: report('2026-10-07T09:00:00Z', [
    { videoId: 'video-1', phase: 'finished', ok: false, complete: false, failures: ['Cola sin verificar'],
      events: [{ type: 'playing', ms: 0, position: 0, phase: 'startup' }, { type: 'waiting', ms: 10, position: 0.01, phase: 'listening' },
        { type: 'playing', ms: 40, position: 0.01, phase: 'listening' }, { type: 'waiting', ms: 90, position: 0.06, phase: 'tail' },
        { type: 'stalled', ms: 110, position: 0.06, phase: 'tail' }, { type: 'ended', ms: 200, position: 0.1, phase: 'tail' }],
      gaps: [{ startMs: 10, endMs: 40, position: 0.01, phase: 'listening' }, { startMs: 90, position: 0.06, phase: 'tail' }],
      allPlaybackStalls: [{ ms: 10 }, { ms: 60, phase: 'seek' }, { ms: 90 }] },
    { videoId: 'video-2', phase: 'finished', ok: false, failures: ['No arrancó'], events: [] },
    { videoId: 'video-3', phase: 'finished', ok: false, failures: ['Sin eventos'], endedPosition: 99 },
  ], { mode: 'smoke', scope: 'complete' }) }], { corpus })
  const m = summary.cases[0].latest.latency.metrics
  assert.equal(m.normalGapCount, 2)
  assert.equal(m.openNormalGapCount, 1)
  assert.equal(m.normalGapDurationMs, null, 'an unfinished wait does not get zero or a fabricated final timestamp')
  assert.equal(m.allPlaybackStallCount, 3)
  assert.equal(m.nativeEndedObserved, true)
  assert.equal(m.nativeEndedPhase, 'tail')
  assert.equal(m.continuity, 'not-exercised-for-full-song')
  assert.equal(summary.cases[1].latest.latency.metrics.nativeEndedObserved, false)
  assert.equal(summary.cases[2].latest.latency.metrics.nativeEndedObserved, null, 'a position alone cannot invent an ended event')
  const output = markdown(summary)
  assert.match(output, /2; 1 abiertos; duración n\/d \| 3 \|/)
  assert.match(output, /pos 0\.100000 s; t\+200\.0 ms; tail/)
  assert.match(output, /No observado/)
  assert.match(output, /por sí solo no acredita escuchar la canción entera/)
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
