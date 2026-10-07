#!/usr/bin/env node
/** Read-only evidence aggregation. Inputs are explicit; neither reports nor their history are edited. */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const categories = ['latency', 'switch', 'album', 'quarantine']
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const boolean = value => typeof value === 'boolean' ? value : null
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const parse = text => JSON.parse(text.replace(/^\uFEFF/, ''))
const mojibake = text => typeof text === 'string' && /Ã.|Â.|â€|�/.test(text)
const MAX_AD_EVIDENCE_AGE_MS = 5000
const plainCorpus = value => value?.captureSuite?.corpus ?? value?.corpus ?? value
function interruptionEvidence(input) {
  const value = input.interruption
  if (value === undefined) return { value: null, warnings: [] }
  const reject = reason => ({ value: null, warnings: [`Interrupción adjunta ignorada: ${reason} (${input.interruptionSource ?? 'entrada explícita'})`] })
  if (!value || typeof value !== 'object' || typeof value.report !== 'string' || typeof input.source !== 'string' || !input.source || basename(value.report.replaceAll('\\', '/')) !== basename(input.source)) return reject('el nombre del informe no coincide')
  if (typeof value.reportSha256 !== 'string' || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.reportSha256) || !/^[a-f0-9]{64}$/i.test(input.sha256) || value.reportSha256.toLowerCase() !== input.sha256.toLowerCase()) return reject('SHA256 no coincide con los bytes del informe')
  if (typeof value.stoppedAt !== 'string' || !Number.isFinite(Date.parse(value.stoppedAt))) return reject('falta una fecha de interrupción válida')
  return { value: { ...value, verified: true, verification: 'report-filename+sha256' }, warnings: [] }
}
const allCases = corpus => (corpus?.albums ?? []).flatMap((album, albumIndex) =>
  Array.from({ length: Math.max(album.expectedTracks ?? 0, album.rows?.length ?? 0) }, (_, i) => ({
    ...(album.rows?.[i] ?? { error: album.error ?? 'Pista ausente del corpus' }),
    id: album.rows?.[i]?.id ?? null,
    label: album.rows?.[i]?.label ?? `${album.query ?? 'Álbum'} / pista ${i + 1}`,
    album: album.albumTitle ?? album.rows?.[i]?.albumTitle ?? album.query ?? null,
    corpusPosition: [albumIndex + 1, i + 1],
  })))

function effectiveExperiment(suite, metadata, rows) {
  const fromStatus = rows.flatMap(row => [row.progressiveExperiment, row.status?.progressiveExperiment,
    row.startStatus?.progressiveExperiment]).filter(value => typeof value === 'boolean')
  const values = [...new Set(fromStatus)]
  const value = values.length === 1 ? values[0] : values.length > 1 ? null
    : boolean(metadata?.progressiveExperiment) ?? boolean(suite.experimental)
  const source = values.length ? 'native-status' : typeof metadata?.progressiveExperiment === 'boolean' ? 'metadata' :
    typeof suite.experimental === 'boolean' ? 'report-declaration' : 'unknown'
  const conflicts = []
  if (values.length > 1) conflicts.push('El estado nativo contiene modos experimentales contradictorios')
  for (const [name, declared] of [['metadata', metadata?.progressiveExperiment], ['report', suite.experimental]])
    if (typeof declared === 'boolean' && value !== null && declared !== value)
      conflicts.push(`${name} declara experimental=${declared}, pero ${source} indica ${value}`)
  return { value, source, conflicts, reportDeclaration: boolean(suite.experimental), metadataDeclaration: boolean(metadata?.progressiveExperiment) }
}

function diagnostics(row) {
  const found = [...(Array.isArray(row.failures) ? row.failures : [])]
  for (const key of ['error', 'seekError']) if (row[key]) found.push(`${key}: ${row[key]}`)
  for (const phase of ['status', 'startStatus', 'seekStatus', 'finalStatus'])
    for (const key of ['error', 'softError']) if (row[phase]?.[key]) found.push(`${phase}.${key}: ${row[phase][key]}`)
  return [...new Set(found.map(String))]
}

function diagnosticSnapshot(status) {
  let diagnostic = status.lastDiagnostic ?? null
  if (typeof diagnostic === 'string') try { diagnostic = JSON.parse(diagnostic) } catch { diagnostic = null }
  const evidence = diagnostic?.evidence ?? {}
  return { state: status.state ?? null, adMs: number(status.adMs), lastProgressAgoMs: number(status.lastProgressAgoMs),
    paused: boolean(diagnostic?.paused), rate: number(diagnostic?.rate), adMarker: boolean(evidence.adMarker),
    visibleAd: [evidence.adClassShowing, evidence.adClassInterrupting, evidence.adOverlayVisible, evidence.adTextVisible].some(value => value === true),
    position: number(evidence.position ?? status.lastPosition), mediaDuration: number(evidence.mediaDuration),
    raw: status.lastDiagnostic ?? null }
}

/** This labels an operational timeout, never a proved content-start latency failure. */
function inferAdTimeout(row, failures, snapshot, finished) {
  // A context failure happened before measuring the destination. Cancellation is
  // also distinct from an operational timeout of an active target measurement.
  if (row.failedPhase === 'context' || row.aborted === true || row.phase === 'aborted' || row.failedPhase === 'aborted') return null
  const timedOut = failures.some(failure => /espera operativa|operational timeout/i.test(failure))
  const activePosition = snapshot.position !== null && snapshot.mediaDuration !== null && snapshot.position >= 0 &&
    snapshot.mediaDuration > snapshot.position
  if (!finished || number(row.firstSoundMs) !== null || !timedOut || snapshot.state !== 'ad' || !(snapshot.adMs > 0) ||
      snapshot.lastProgressAgoMs === null || snapshot.lastProgressAgoMs < 0 || snapshot.lastProgressAgoMs > MAX_AD_EVIDENCE_AGE_MS ||
      snapshot.paused !== false || snapshot.adMarker !== true || !snapshot.visibleAd || !activePosition) return null
  return { kind: 'ad-timeout', inferred: true, timingCriterion: 'pending-measurement', operationalAttempt: 'failed',
    rule: 'Sin primer sonido; espera operativa agotada; estado ad con tiempo publicitario positivo y anuncio activo no pausado antes de su final, con progreso reciente',
    maxEvidenceAgeMs: MAX_AD_EVIDENCE_AGE_MS, evidence: snapshot }
}

function metricRow(row, run, rowIndex) {
  const completeSkipped = row.completeNotExercised === true || row.coverageNotExercised === true || run.scope === 'timingOnly'
  const status = row.status ?? row.finalStatus ?? {}
  const failures = diagnostics(row)
  const finished = row.phase === 'finished' || (!run.running && !run.interrupted && row.phase !== 'pending')
  const interrupted = run.interrupted && !finished
  const measured = boolean(row.measurementOk) ?? boolean(row.ok)
  const lastDiagnostic = diagnosticSnapshot(status)
  const inference = inferAdTimeout(row, failures, lastDiagnostic, finished)
  const state = interrupted ? row.phase === 'pending' ? 'not-exercised' : 'interrupted'
    : !finished && run.running ? 'in-progress' : inference ? 'unmeasured/ad-timeout' : failures.length || measured === false ? 'failed'
    : measured === true ? 'measured-pass' : 'not-exercised'
  // An empty normal-gap list after an intentional seek says nothing about full-song continuity.
  const continuityExercised = run.category === 'album' && finished && row.complete === true && row.coverageOk === true &&
    Array.isArray(row.gaps) && row.events?.some(event => event.type === 'ended') === true
  return {
    runId: run.runId, source: run.source, date: run.date, commit: run.commit, category: run.category,
    id: row.videoId ?? row.id ?? null, rowIndex, rawLabel: row.label ?? null, phase: row.phase ?? null,
    state, attemptState: inference ? 'failed' : state, inference, lastDiagnostic,
    interruption: interrupted ? { stoppedAt: run.interruption.stoppedAt, source: run.interruptionSource, reason: run.interruption.reason ?? null } : null,
    timingCriteria: { firstSound: number(row.firstSoundMs) === null ? 'not-measured' : 'measured', seek: number(row.seekMs ?? row.audio?.seekMs) === null ? 'not-measured' : 'measured' },
    reportedMeasurementOk: measured, acceptanceOk: false, guaranteeAds: false, failures,
    metrics: {
      firstSoundMs: number(row.firstSoundMs), firstSoundWithoutAdMs: number(row.firstSoundWithoutAdMs), startAdMs: number(row.startAdMs),
      adSubtractionEvidence: number(row.startAdMs) !== null ? 'startAdMs' : number(row.startStatus?.adMs) !== null ? 'startStatus.adMs' : 'missing-start-snapshot',
      seekMs: number(row.seekMs ?? row.audio?.seekMs), seekOk: boolean(row.seekOk), seekWasCaptured: boolean(row.seekWasCaptured),
      nextTrackMs: number(row.nextTrackMs), unpreparedSwitchMs: number(row.unpreparedSwitchMs),
      unpreparedSwitchWithoutAdMs: number(row.unpreparedSwitchWithoutAdMs), destinationWasCached: boolean(row.destinationWasCached),
      duration: number(row.duration ?? status.duration), audioDuration: number(row.audioDuration ?? status.audioDuration ?? row.audio?.duration),
      completeness: completeSkipped ? 'not-exercised' : row.complete === true ? 'verified' : row.complete === false ? 'incomplete' : 'not-measured',
      coverageOk: completeSkipped ? null : boolean(row.coverageOk), tailMs: number(row.tailMs ?? row.audio?.tailMs),
      elapsedMs: number(row.elapsedMs), legacyExtractionMs: run.protocol === 'legacy-bench' ? number(row.ms) : null,
      legacyAudioStartMs: run.protocol === 'legacy-bench' ? number(row.audio?.startMs) : null,
      normalGapCount: Array.isArray(row.gaps) ? row.gaps.length : null,
      allPlaybackStallCount: Array.isArray(row.allPlaybackStalls) ? row.allPlaybackStalls.length : null,
      continuity: continuityExercised ? (row.gaps.length ? 'observed-gaps' : 'no-waiting-events-observed') : 'not-exercised-for-full-song',
      adsSeen: number(row.adsSeen ?? status.adsSeen), labelledAdsDelivered: number(row.adsDelivered ?? status.adsDelivered),
      adRateViolations: number(row.adRateViolations ?? status.adRateViolations), adRateObservations: number(row.adRateObservations ?? status.adRateObservations),
      semanticAdAbsence: 'unverified',
    },
    rawRow: row,
  }
}

/** Pure aggregation also used by tests. Every provided run remains in runs, including malformed/fatal input. */
export function summarize(inputs, { corpus, corpusSource = null, generatedAt = new Date().toISOString() } = {}) {
  const warnings = [], runs = []
  for (const [inputIndex, input] of inputs.entries()) {
    const report = input.report ?? {}, suite = report.captureSuite ?? (report.mode ? report : {})
    const legacy = !report.captureSuite && Array.isArray(report.tier2)
    const rows = Array.isArray(suite.rows) ? suite.rows : legacy ? report.tier2 : []
    const experiment = effectiveExperiment(suite, input.metadata, rows)
    const interruption = interruptionEvidence(input)
    const mode = suite.mode ?? (legacy ? 'legacy-quarantine' : report.mse ? 'mse' : 'unknown')
    const category = mode === 'catalog' || mode === 'mse' || mode === 'unknown' ? mode
      : legacy || experiment.value === false || suite.scope === 'full-quarantine' ? 'quarantine'
      : mode === 'switch' ? 'switch' : mode === 'album' ? 'album' : 'latency'
    const date = input.metadata?.startedAt ?? report.startedAt ?? suite.startedAt ?? null
    const parsedDate = date === null ? NaN : Date.parse(date)
    const run = {
      runId: `${inputIndex + 1}:${basename(input.source ?? 'input')}`, source: input.source ?? null,
      sha256: input.sha256 ?? null, metadataSource: input.metadataSource ?? null,
      interruptionSource: input.interruptionSource ?? null, interruption: interruption.value, interrupted: !!interruption.value,
      date, dateSource: input.metadata?.startedAt ? 'metadata.startedAt' : date ? 'report.startedAt' : 'unknown',
      commit: input.metadata?.commit ?? report.commit ?? null, branch: input.metadata?.branch ?? null,
      dirtyChanges: input.metadata?.changes ?? null, binarySha256: input.metadata?.binarySha256 ?? null,
      protocol: legacy ? 'legacy-bench' : report.captureSuite || report.mode ? 'capture-suite' : 'other',
      mode, category, scope: suite.scope ?? (legacy ? 'legacy-quarantine' : null),
      experiment, running: suite.running === true && !interruption.value, reportedRunning: boolean(suite.running), reportedOk: boolean(report.ok),
      reportedAcceptanceOk: boolean(suite.acceptanceOk), reportedMeasurementsOk: boolean(suite.measurementsOk),
      fatal: input.error ?? report.fatal ?? null, warnings: [...experiment.conflicts, ...(input.warnings ?? []), ...interruption.warnings],
      selectionOrder: Number.isFinite(parsedDate) ? parsedDate : inputIndex,
      selectionOrderSource: Number.isFinite(parsedDate) ? 'date' : 'explicit-input-order (date unavailable)',
      inputIndex, rows: [], metadata: input.metadata ?? null,
    }
    run.rows = rows.map((row, i) => metricRow(row, run, i))
    if (interruption.value?.completedRows !== undefined && interruption.value.completedRows !== rows.filter(row => row.phase === 'finished').length)
      run.warnings.push('El recuento completedRows de la interrupción no coincide con las filas finished; no se usa para completar ni modificar filas')
    if (!date) run.warnings.push('Fecha no disponible: se conserva el orden explícito de entrada')
    if (rows.some(row => mojibake(row.label))) run.warnings.push('Etiquetas con indicios de decodificación incorrecta; se conserva rawLabel y se muestra el corpus canónico por ID')
    if (rows.some(row => number(row.firstSoundWithoutAdMs) !== null && number(row.startAdMs) === null && number(row.startStatus?.adMs) === null))
      run.warnings.push('Hay tiempos sin publicidad reportados sin snapshot inicial del contador; no se reconstruye el descuento a partir del contador final')
    if (!run.rows.length && mode !== 'catalog' && mode !== 'mse') run.warnings.push('El informe no contiene filas de captura reconocidas')
    if (!corpus && suite.corpus) { corpus = suite.corpus; corpusSource = input.source ?? null }
    runs.push(run)
  }
  corpus = plainCorpus(corpus)
  const corpusRows = allCases(corpus)
  const expectedTracks = corpus?.expectedTracks ?? corpusRows.length
  if (!corpusRows.length) warnings.push('No hay corpus: no se puede afirmar que estén representadas las 30 canciones previstas')
  if (corpusRows.length !== expectedTracks) warnings.push(`Corpus con ${corpusRows.length} filas frente a ${expectedTracks} esperadas; no se ha truncado ninguna`)
  const history = runs.flatMap(run => run.rows).sort((a, b) => {
    const ra = runs[a.runId.split(':')[0] - 1], rb = runs[b.runId.split(':')[0] - 1]
    return ra.selectionOrder - rb.selectionOrder || ra.inputIndex - rb.inputIndex || a.rowIndex - b.rowIndex
  })
  const latest = new Map()
  for (const row of history) if (row.id && categories.includes(row.category)) latest.set(`${row.category}:${row.id}`, row)
  const observedIds = new Set(history.map(row => row.id).filter(Boolean))
  const canonicalIds = new Set(corpusRows.map(row => row.id).filter(Boolean))
  const summarizeCase = value => ({ id: value.id, label: value.label, corpusPosition: value.corpusPosition ?? null,
    album: value.album ?? null, corpusError: value.error ?? null,
    latest: Object.fromEntries(categories.map(category => [category, latest.get(`${category}:${value.id}`) ?? null])),
    history: history.filter(row => row.id && row.id === value.id).map(row => ({ runId: row.runId, category: row.category, rowIndex: row.rowIndex, state: row.state })),
    errorHistory: history.filter(row => row.id && row.id === value.id && row.failures.length).map(row => ({ runId: row.runId, date: row.date, category: row.category,
      state: row.state, attemptState: row.attemptState, inference: row.inference, failures: row.failures })),
  })
  return {
    generatedAt, acceptanceOk: false, guaranteeAds: false,
    interpretation: {
      latestPolicy: 'Última ejecución por fecha/categoría/ID, aunque falle, siga en curso o se haya interrumpido; todos los informes explícitos se conservan en runs',
      measurements: 'measured-pass sólo significa que esa fila declaró cumplir sus mediciones; nunca aceptación del extractor',
      ads: 'labelledAdsDelivered cuenta unidades etiquetadas como anuncio; ausencia semántica no verificada',
      continuity: 'Una lista gaps vacía en smoke/latency con seek/backfill no demuestra cero cortes durante la canción completa',
      labels: 'El corpus canónico aporta la etiqueta por videoID; rawLabel y los bytes/errores de origen permanecen en el historial',
      adTimeout: 'unmeasured/ad-timeout es una inferencia de anuncio activo reciente al agotarse la espera: el intento operativo falló, pero el requisito de primer sonido sigue sin medirse',
      interruption: 'Un auxiliar de interrupción sólo cambia el estado si coincide el nombre y SHA256 del informe; las filas finished conservan resultados, las activas quedan interrumpidas y las pending no ejercitadas',
    },
    corpusSource, expectedTracks, representedTracks: corpusRows.length,
    warnings, cases: corpusRows.map(summarizeCase),
    outsideCorpus: [...observedIds].filter(id => !canonicalIds.has(id)).map(id => summarizeCase({ id, label: history.find(row => row.id === id)?.rawLabel ?? id })),
    inputErrors: runs.filter(run => run.fatal).map(run => ({ runId: run.runId, source: run.source, error: run.fatal })),
    runs,
  }
}

const escape = value => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ')
const ms = value => value === null || value === undefined ? 'n/d' : `${Number(value).toFixed(1)} ms`
function cell(entry) {
  if (!entry) return 'No ejercitado'
  if (entry.state === 'not-exercised' && entry.interruption) return escape(`No ejercitado: ejecución interrumpida [${entry.runId}]`)
  if (entry.state === 'unmeasured/ad-timeout') return escape(`No medido: timeout durante anuncio (inferencia); intento fallido; criterio pendiente [${entry.runId}]`)
  const m = entry.metrics, state = { 'measured-pass': 'Medido ✓', failed: 'FALLO', 'in-progress': 'En curso', interrupted: 'Interrumpido; medición parcial', 'not-exercised': 'No ejercitado' }[entry.state]
  const values = entry.category === 'latency' ? `inicio ${ms(m.firstSoundMs)}; sin anuncio ${ms(m.firstSoundWithoutAdMs)}; seek ${ms(m.seekMs)}`
    : entry.category === 'switch' ? `cambio ${ms(m.unpreparedSwitchMs)}; sin anuncio ${ms(m.unpreparedSwitchWithoutAdMs)}`
    : entry.category === 'album' ? `transición ${ms(m.nextTrackMs)}; EOF ${m.completeness}; cortes ${m.continuity === 'not-exercised-for-full-song' ? 'no verificados' : m.normalGapCount}`
    : `inicio ${ms(m.firstSoundMs)}; EOF ${m.completeness}; final ${ms(m.tailMs)}`
  return escape(`${state}: ${values} [${entry.runId}]`)
}

function diagnosticCell(entry) {
  if (!entry) return 'No ejercitado'
  const d = entry.lastDiagnostic
  if (!d || !d.state) return 'Diagnóstico no disponible'
  return escape(`${d.state}; ${d.position ?? 'n/d'}/${d.mediaDuration ?? 'n/d'} s; marcador anuncio ${d.adMarker ?? 'n/d'}; progreso hace ${d.lastProgressAgoMs ?? 'n/d'} ms${entry.inference ? '; ad-timeout inferido' : ''}`)
}
const latestEntry = row => Object.values(row.latest).filter(Boolean).sort((a, b) =>
  (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || Number(b.runId.split(':')[0]) - Number(a.runId.split(':')[0]))[0]

export function markdown(summary) {
  const lines = [
    '# Evidencia de captura', '', `Generado: ${summary.generatedAt}. Corpus: ${summary.representedTracks}/${summary.expectedTracks} filas.`, '',
    '**Aceptación: no. Ausencia semántica de anuncios: no verificada.** Los contadores publicitarios son etiquetas observadas, no una garantía.', '',
    'Se muestra la última ejecución por categoría e ID, incluso si falla, sigue en curso o se interrumpió. El JSON conserva todas las ejecuciones y las filas originales.', '',
    'Las esperas durante seek/backfill se registran aparte. Un smoke con `gaps: []` no demuestra cero cortes durante una canción completa.', '',
    'Un `ad-timeout` inferido conserva el intento fallido, pero no demuestra incumplimiento de los 3 s: el primer sonido queda pendiente de medición.', '',
    '| # | Canción / vídeo | Latencia | Cambio en frío | Álbum natural | Cuarentena | Diagnóstico último intento |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const [index, row] of summary.cases.entries()) lines.push(`| ${index + 1} | ${escape(row.label)} / ${escape(row.id)} | ${categories.map(category => cell(row.latest[category])).join(' | ')} | ${diagnosticCell(latestEntry(row))} |`)
  if (summary.outsideCorpus.length) {
    lines.push('', '## Casos fuera del corpus', '', '| Caso / vídeo | Latencia | Cambio en frío | Álbum natural | Cuarentena |', '| --- | --- | --- | --- | --- |')
    for (const row of summary.outsideCorpus) lines.push(`| ${escape(row.label)} / ${escape(row.id)} | ${categories.map(category => cell(row.latest[category])).join(' | ')} |`)
  }
  lines.push('', '## Fuentes y ejecuciones conservadas', '', '| Ejecución | Fecha | Commit | Categoría | Estado | Fuente |', '| --- | --- | --- | --- | --- | --- |')
  for (const run of summary.runs) lines.push(`| ${escape(run.runId)} | ${escape(run.date)} | ${escape(run.commit)} | ${escape(run.category)} | ${run.fatal ? 'Error de entrada/ejecución' : run.interrupted ? 'Interrumpida' : run.running ? 'En curso' : 'Finalizada'} | ${escape(run.source)} |`)
  for (const run of summary.runs.filter(run => run.interrupted)) lines.push('', `Interrupción verificada de ${escape(run.runId)}: ${escape(run.interruption.stoppedAt)}. ${escape(run.interruption.reason ?? 'Sin motivo registrado')}. Auxiliar: ${escape(run.interruptionSource)}; SHA256 del informe: ${escape(run.sha256)}.`)
  lines.push('', '## Historial de errores', '')
  const errors = summary.runs.flatMap(run => [
    ...(run.fatal ? [`- ${escape(run.runId)}: ${escape(run.fatal)}`] : []),
    ...run.rows.filter(row => row.failures.length).map(row => `- ${escape(run.runId)} / ${escape(row.id ?? row.rawLabel)}: ${row.inference ? 'Intento fallido; primer sonido no medido; ad-timeout inferido. ' : ''}${row.failures.map(escape).join('; ')}${row.inference ? ` (${diagnosticCell(row)})` : ''}`),
  ])
  lines.push(...(errors.length ? errors : ['No hay errores registrados en los informes proporcionados; esto no implica aceptación.']))
  const warnings = [...summary.warnings, ...summary.runs.flatMap(run => run.warnings.map(warning => `${run.runId}: ${warning}`))]
  if (warnings.length) lines.push('', '## Límites de la evidencia', '', ...warnings.map(warning => `- ${escape(warning)}`))
  return `${lines.join('\n')}\n`
}

export async function readInputs(paths, metadataPaths = []) {
  const explicitMetadata = await Promise.all(metadataPaths.map(async source => ({ source: resolve(source), value: parse(await readFile(source, 'utf8')) })))
  return Promise.all(paths.map(async source => {
    source = resolve(source)
    const warnings = []
    let metadata = explicitMetadata.find(entry => basename(String(entry.value.report ?? '').replaceAll('\\', '/')) === basename(source))
    if (!metadata) {
      const adjacent = join(dirname(source), basename(source).replace(/^result-/, 'metadata-'))
      if (adjacent !== source) try { metadata = { source: adjacent, value: parse(await readFile(adjacent, 'utf8')) } }
      catch (error) { if (error.code !== 'ENOENT') warnings.push(`Metadata adjunta ilegible: ${error.message}`) }
    }
    if (metadata?.value.report && basename(String(metadata.value.report).replaceAll('\\', '/')) !== basename(source)) {
      warnings.push(`Metadata adjunta de otro informe, sin atribuir fecha/commit: ${metadata.source}`)
      metadata = undefined
    }
    let interruption, interruptionSource
    const adjacentInterruption = join(dirname(source), basename(source).replace(/^result-/, 'interruption-'))
    if (adjacentInterruption !== source) try {
      const text = await readFile(adjacentInterruption, 'utf8')
      interruptionSource = adjacentInterruption
      interruption = parse(text)
    } catch (error) { if (error.code !== 'ENOENT') warnings.push(`Interrupción adjunta ilegible: ${error.message}`) }
    try {
      const bytes = await readFile(source)
      return { source, report: parse(bytes.toString('utf8')), sha256: hash(bytes), metadata: metadata?.value,
        metadataSource: metadata?.source, interruption, interruptionSource, warnings }
    } catch (error) { return { source, error: error.message, metadata: metadata?.value, metadataSource: metadata?.source, interruption, interruptionSource, warnings } }
  }))
}

async function main(args) {
  const paths = [], metadataPaths = []
  let corpusPath, jsonPath, markdownPath
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help') {
      process.stdout.write('Uso: node scripts/summarize-capture.mjs [--corpus corpus.json] [--metadata metadata.json] [--json salida.json] [--markdown salida.md] informe1.json informe2.json ...\nSin salidas explícitas imprime Markdown. No descubre ni modifica informes; lee metadata e interruption hermanas cuando existen y verifica nombre/SHA256 de las interrupciones.\n')
      return
    }
    if (['--corpus', '--metadata', '--json', '--markdown'].includes(arg)) {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`Falta ruta después de ${arg}`)
      if (arg === '--corpus') corpusPath = value
      if (arg === '--metadata') metadataPaths.push(value)
      if (arg === '--json') jsonPath = value
      if (arg === '--markdown') markdownPath = value
    } else if (arg.startsWith('--')) throw new Error(`Opción desconocida: ${arg}`)
    else paths.push(arg)
  }
  if (!paths.length) throw new Error('Indica explícitamente al menos un informe JSON')
  const protectedPaths = new Set([...paths, ...metadataPaths, ...(corpusPath ? [corpusPath] : [])].map(path => resolve(path)))
  for (const output of [jsonPath, markdownPath].filter(Boolean)) if (protectedPaths.has(resolve(output))) throw new Error('La salida no puede reemplazar una entrada')
  if (jsonPath && markdownPath && resolve(jsonPath) === resolve(markdownPath)) throw new Error('JSON y Markdown necesitan salidas distintas')
  const inputs = await readInputs(paths, metadataPaths)
  for (const input of inputs) for (const source of [input.metadataSource, input.interruptionSource].filter(Boolean)) protectedPaths.add(resolve(source))
  for (const output of [jsonPath, markdownPath].filter(Boolean)) if (protectedPaths.has(resolve(output))) throw new Error('La salida no puede reemplazar evidencia adjunta')
  const summary = summarize(inputs, { corpus: corpusPath ? parse(await readFile(corpusPath, 'utf8')) : undefined,
    corpusSource: corpusPath ? resolve(corpusPath) : null })
  if (jsonPath) await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  if (markdownPath) await writeFile(markdownPath, markdown(summary), 'utf8')
  if (!jsonPath && !markdownPath) process.stdout.write(markdown(summary))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
