// Consolidate explicit completed runs. A later run must be chosen explicitly;
// this collector never replaces failed evidence with a different run silently.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installationScenarioInventory } from './installation-scenarios.mjs'
import { libraryScenarioInventory } from './library-scenarios.mjs'
import { mediaScenarioInventory } from './media-scenarios.mjs'
import { responsiveScenarioInventory } from './responsive-scenarios.mjs'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const args = process.argv.slice(2)
const values = key => args.flatMap((value, index) => value === key ? [args[index + 1]] : [])
const inputs = values('--run')
assert.ok(inputs.length, 'Pass --run <summary.json> for every complete run being reported')
const output = resolve(values('--out')[0] || 'artifacts/pwa-e2e/coverage.json')
const statuses = ['pass', 'fail', 'blocked', 'unsupported']
const expectedNames = ['setup.open: install shell and open compiled application', 'setup.fixture: opaque-frame catalog requests are controlled']
// The three UI modules use literal labels; media also has generated failure cases,
// whose exact IDs are declared by its executable inventory.
for (const file of ['./installation-scenarios.mjs', './library-scenarios.mjs', './podcast-recovery-scenario.mjs', './responsive-scenarios.mjs']) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8')
  const labels = [...source.matchAll(/check\('([^']+)'/g)].map(match => match[1])
  assert.ok(labels.length > 0, 'The coverage collector must recognize the UI module check labels')
  expectedNames.push(...labels)
}
expectedNames.push(...mediaScenarioInventory.map(item => item.id))
const result = { schemaVersion: 1, generatedAt: new Date().toISOString(), build: null,
  allRequestedPlatformsVerified: false, sources: [], profiles: [], platforms: [], matrix: [], additionalEvidence: [], runErrors: [],
  inventory: [...installationScenarioInventory, ...libraryScenarioInventory, ...responsiveScenarioInventory, ...mediaScenarioInventory],
  interpretation: 'Rows are actual executed checks, including grouped actions. A failed grouped check does not prove later actions ran. Browser layout emulation, synthetic providers, virtual clocks and DOM gestures do not verify physical operating systems or cars.' }
for (const input of inputs) {
  const source = resolve(input)
  const run = JSON.parse(await readFile(source, 'utf8'))
  assert.ok(run.finishedAt && run.serverClosed, 'Only a completed run with a closed test server can be consolidated')
  assert.equal(run.suite, 'all', 'Consolidation requires a complete all suite; use standalone reports for partial runs')
  assert.ok(run.profiles?.length, 'A complete run must include at least one browser profile')
  assert.match(run.build, /^[a-f0-9]{16}$/)
  result.runErrors.push(...(run.errors ?? []).filter(error => !error.handledExpected))
  assert.ok(!result.build || result.build === run.build, 'Do not combine different product builds')
  result.build = run.build
  result.sources.push(relative(workspace, source).replaceAll('\\', '/'))
  for (const profile of run.profiles) {
    assert.ok(!result.profiles.some(other => other.profile === profile.profile), 'Choose exactly one complete run per profile')
    assert.ok(profile.browserClosed && profile.contextClosed, 'The test browser/context must be closed')
    for (const field of ['puppeteerBrowserClosed', 'networkTransportClosed']) if (Object.hasOwn(profile, field)) assert.equal(profile[field], true, field + ' must be confirmed')
    assert.ok(profile.checks?.length > 0, 'Empty profiles cannot prove coverage')
    const errors = profile.errors ?? []
    result.profiles.push({ profile: profile.profile, engine: profile.engine, browserVersion: profile.browserVersion,
      kind: profile.kind, physical: false, host: profile.host ?? run.host ?? null, source: result.sources.at(-1),
      unexpectedErrors: errors.filter(error => !error.handledExpected), expectedHandledErrors: errors.filter(error => error.handledExpected),
      counts: Object.fromEntries(statuses.map(status => [status, profile.checks.filter(check => check.status === status).length])),
      checks: profile.checks.map(check => ({ name: check.name, status: check.status, reason: check.reason ?? check.error ?? null })) })
  }
  for (const platform of run.platforms) if (!result.platforms.some(other => other.id === platform.id)) result.platforms.push(platform)
}
const names = [...new Set([...expectedNames, ...result.profiles.flatMap(profile => profile.checks.map(check => check.name))])]
result.matrix = names.map(name => ({ name, profiles: Object.fromEntries(result.profiles.map(profile => {
  const check = profile.checks.find(check => check.name === name)
  return [profile.profile, check ? { status: check.status, reason: check.reason } : { status: 'not-executed', reason: 'Absent from selected run' }]
})) }))
result.counts = Object.fromEntries(statuses.map(status => [status, result.profiles.reduce((sum, profile) => sum + profile.counts[status], 0)]))
result.missingChecks = result.profiles.flatMap(profile => expectedNames.filter(name => !profile.checks.some(check => check.name === name))
  .map(name => ({ profile: profile.profile, name, status: 'not-executed' })))
result.coverageComplete = result.missingChecks.length === 0
for (const input of values('--update')) {
  const source = resolve(input)
  const update = JSON.parse(await readFile(source, 'utf8'))
  assert.equal(update.baseDistributionVersion, result.build, 'Update evidence must start from the selected product distribution')
  assert.ok(update.finishedAt && update.browserClosed && update.localServerClosed && update.temporarySiteRemoved, 'Update evidence needs confirmed completion and cleanup')
  result.additionalEvidence.push({ kind: 'service-worker-update-and-data-migration', source: relative(workspace, source).replaceAll('\\', '/'),
    testedAt: update.testedAt, finishedAt: update.finishedAt, baseDistributionVersion: update.baseDistributionVersion,
    passed: update.passed === true, checks: update.checks.map(check => ({ name: check.name, status: check.pass ? 'pass' : 'fail' })),
    scope: update.scope, physical: false })
}
for (const input of values('--live')) {
  const source = resolve(input)
  const live = JSON.parse(await readFile(source, 'utf8'))
  assert.equal(live.build, result.build, 'Live provider evidence must identify the same product build')
  assert.ok(live.finishedAt && live.checks.length > 0, 'Live evidence must contain completed checks')
  result.additionalEvidence.push({ kind: 'live-provider-search-and-playback', source: relative(workspace, source).replaceAll('\\', '/'),
    passed: live.passed === true, checks: live.checks.map(check => ({ name: check.name, status: check.pass ? 'pass' : 'fail' })),
    scope: live.scope, physical: false })
}
result.noBrowserFailuresOrBlocks = result.coverageComplete && result.counts.fail === 0 && result.counts.blocked === 0 && result.runErrors.length === 0 &&
  result.profiles.every(profile => profile.unexpectedErrors.length === 0)
result.everyBrowserCasePassed = result.noBrowserFailuresOrBlocks && result.counts.unsupported === 0
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify(result, null, 2) + '\n')
const escapeCell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
const lines = [
  '# Cobertura E2E de Pletina PWA',
  '', 'Build: ' + result.build + '. Generado: ' + result.generatedAt + '.',
  '', 'Resultados de comprobaciones de navegador: ' + statuses.map(status => status + ' ' + result.counts[status]).join(', ') + '.',
  '', 'Casos del inventario actual ausentes en las ejecuciones elegidas: ' + result.missingChecks.length + '.',
  '', 'Android físico e iPhone físico pendientes; Android Auto y CarPlay no están implementados en esta distribución PWA.',
  '', 'Los resultados usan la aplicación compilada, service worker, IndexedDB y audio reales, con respuestas HTTP de proveedores controladas. La emulación de diseño no acredita el sistema operativo. Un caso agrupado fallido no acredita sus pasos posteriores.',
  '', '| Comprobación | ' + result.profiles.map(profile => profile.profile).join(' | ') + ' |',
  '| --- | ' + result.profiles.map(() => '---').join(' | ') + ' |',
  ...result.matrix.map(row => '| ' + escapeCell(row.name) + ' | ' + result.profiles.map(profile => row.profiles[profile.profile].status).join(' | ') + ' |'),
  '', '## Evidencia adicional',
  '', ...result.additionalEvidence.map(evidence => '- ' + evidence.kind + ': ' + evidence.checks.filter(check => check.status === 'pass').length + '/' + evidence.checks.length + ' pass. ' + evidence.source),
  '', '## Fuentes elegidas',
  '', ...result.sources.map(source => '- ' + source), '',
]
await writeFile(output.replace(/\.json$/, '') + '.md', lines.join('\n'))
console.log(JSON.stringify({ output, build: result.build, counts: result.counts, missingChecks: result.missingChecks.length,
  noBrowserFailuresOrBlocks: result.noBrowserFailuresOrBlocks, allRequestedPlatformsVerified: false }, null, 2))
if (!result.noBrowserFailuresOrBlocks || result.additionalEvidence.some(evidence => !evidence.passed)) process.exitCode = 1
