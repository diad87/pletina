import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Run only after the final browser repetitions and public HTTP verification.
// Failed observer revisions remain bound evidence, never relabelled successes.
const root = resolve(process.argv[2] ?? process.cwd())
const build = 'b698958a8a49ec05'
const sourceCommit = 'f3e890ce8a7b99ce3803d14c9df5be168431e63c'
const baselineBuild = '6bdc970908569e3c'
const baseline = resolve(process.argv[4] ?? 'D:/tmp/pletina-pwa-baseline-6bdc970908569e3c/dist-pwa')
const dryRunPath = process.argv[3] ?? `artifacts/pwa-port/podcast-p1-publish-dry-run-${build}.json`
const target = 'media.youtube-p1-podcast-download-button-serial-rollback-and-offline-progress-resume'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'))
const bind = async path => { const bytes = await readFile(join(root, path)); return { path, bytes: bytes.length, sha256: digest(bytes) } }
async function files(path) {
  const rows = []
  for (const item of await readdir(join(root, path), { withFileTypes: true })) {
    const child = path + '/' + item.name
    rows.push(...(item.isDirectory() ? await files(child) : [child]))
  }
  return rows.sort()
}
async function verifyBinding(binding, path = binding.path) {
  const actual = await bind(path)
  assert.equal(actual.sha256, binding.sha256, `Evidence bytes changed: ${path}`)
  if (binding.bytes !== undefined) assert.equal(actual.bytes, binding.bytes, `Evidence size changed: ${path}`)
  return actual
}
async function testLog(path, count) {
  const text = await readFile(join(root, path), 'utf8')
  for (const [key, expected] of Object.entries({ tests: count, pass: count, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
    assert.match(text, new RegExp(`(?:^|\\n)[^\\n]*?\\b${key}\\s+${expected}(?:\\r?\\n|$)`), `${path}: ${key}`)
  }
  return { passed: count, failed: 0, skipped: 0, report: await bind(path) }
}

const logic = await testLog('artifacts/pwa-port/podcast-p1-logic-final-2026-10-23.log', 856)
const pwaSubset = await testLog('artifacts/pwa-port/podcast-p1-web-logic-2026-10-23.log', 681)
const directedSubset = await testLog('artifacts/pwa-port/podcast-p1-directed-2026-10-23.log', 165)
const typePath = 'artifacts/pwa-port/podcast-p1-types-2026-10-23.log'
assert.match(await readFile(join(root, typePath), 'utf8'), /0 errors and 0 warnings/)
const updatePath = `artifacts/pwa-port/update-e2e-${build}.json`, update = await json(updatePath)
assert.equal(update.passed, true); assert.equal(update.baseDistributionVersion, build)
assert.equal(update.prototypeVersion, baselineBuild); assert.equal(update.checks.length, 11)
assert.ok(update.checks.every(check => check.pass === true)); assert.deepEqual(update.errors, [])
assert.equal(update.browserClosed, true); assert.equal(update.localServerClosed, true)
const setupPath = `artifacts/pwa-port/update-e2e-${build}-setup-failure.json`, setup = await json(setupPath)
assert.equal(setup.passed, false); assert.equal(setup.browser, null); assert.equal(setup.checks.length, 0)
assert.match(setup.fatal, /Executable doesn't exist/)

const negativePath = 'artifacts/pwa-port/podcast-p1-capability-negative-manifest.json', negative = await json(negativePath)
assert.deepEqual(negative.result, { tests: 9, passed: 3, failed: 6, expectedNegative: true })
for (const binding of [...negative.files, negative.report, negative.originalBeforeReport, negative.after.report, negative.directed.report, negative.types.report]) await verifyBinding(binding)
assert.equal(negative.after.result.passed, 9); assert.equal(negative.after.result.failed, 0)

const reportPaths = {
  windowsV1: `artifacts/pwa-e2e/podcast-p1-${build}-win/summary.json`,
  windowsV2: `artifacts/pwa-e2e/podcast-p1-${build}-win-session-final/summary.json`,
  windowsFinal: `artifacts/pwa-e2e/podcast-p1-${build}-win-offline-final/summary.json`,
  webkitV1: `artifacts/pwa-e2e/podcast-p1-${build}-webkit/summary.json`,
  webkitV2: `artifacts/pwa-e2e/podcast-p1-${build}-webkit-session-final/summary.json`,
  webkitFinal: `artifacts/pwa-e2e/podcast-p1-${build}-webkit-offline-final/summary.json`,
}
const reports = Object.fromEntries(await Promise.all(Object.entries(reportPaths).map(async ([key, path]) => [key, await json(path)])))
for (const [key, report] of Object.entries(reports)) {
  assert.equal(report.build, build); assert.deepEqual(report.errors, [], key); assert.deepEqual(report.unexpectedErrors, [], key)
  assert.equal(report.serverClosed, true, key)
  for (const profile of report.profiles) {
    assert.equal(profile.build, build); assert.deepEqual(profile.errors, [], key + '/' + profile.engine)
    assert.equal(profile.contextClosed, true); assert.equal(profile.browserClosed, true)
  }
}
const consolidated = []
for (const engine of ['chromium', 'firefox', 'webkit']) {
  const prefix = engine === 'webkit' ? 'webkit' : 'windows'
  const v1 = reports[prefix + 'V1'].profiles.find(profile => profile.engine === engine)
  const v2 = reports[prefix + 'V2'].profiles.find(profile => profile.engine === engine)
  const final = reports[prefix + 'Final'].profiles.find(profile => profile.engine === engine)
  assert.ok(v1 && v2 && final, `Missing ${engine} source report`)
  assert.deepEqual(v1.counts, { pass: 8, fail: 1, blocked: 0, unsupported: 0 })
  assert.deepEqual(v2.counts, { pass: 3, fail: 1, blocked: 0, unsupported: 0 })
  assert.deepEqual(final.counts, { pass: 4, fail: 0, blocked: 0, unsupported: 0 })
  assert.equal(v1.checks.length, 9); assert.equal(v2.checks.length, 4); assert.equal(final.checks.length, 4)
  assert.equal(v1.checks.find(check => check.name === target)?.status, 'fail')
  assert.equal(v2.checks.find(check => check.name === target)?.status, 'fail')
  const corrected = final.checks.find(check => check.name === target)
  assert.equal(corrected?.status, 'pass')
  const checks = v1.checks.filter(check => check.status === 'pass').map(check => ({ name: check.name, status: 'pass', sourceReport: reportPaths[prefix + 'V1'] }))
  const names = new Set(checks.map(check => check.name))
  assert.equal(names.size, 8)
  for (const check of final.checks.filter(check => check.name !== target)) assert.ok(names.has(check.name), 'Repeated setup/selection cannot add coverage')
  assert.ok(!names.has(target)); checks.push({ name: target, status: 'pass', sourceReport: reportPaths[prefix + 'Final'] })
  consolidated.push({ engine, profile: final.profile, browserVersion: final.browserVersion, passed: checks.length, failed: 0, checks,
    finalEpisodeScenario: corrected, scope: 'Desktop browser with mobile layout, not a physical phone.' })
}
assert.equal(consolidated.reduce((sum, engine) => sum + engine.passed, 0), 27)

const inventory = []
for (const path of await files('dist-pwa')) inventory.push({ ...await bind(path), path: path.slice('dist-pwa/'.length) })
assert.equal(inventory.length, 33); assert.equal(inventory.reduce((sum, file) => sum + file.bytes, 0), 883757)
const inventoryByPath = new Map(inventory.map(file => [file.path, file]))
const unchanged = []
for (const file of inventory.filter(file => /\.(?:woff2|css)$/.test(file.path) || file.path.includes('p1-recipe.generated-'))) {
  assert.equal(digest(await readFile(join(baseline, file.path))), file.sha256, 'CSS/fonts/recipe changed: ' + file.path)
  unchanged.push(file.path)
}
const buildLogPath = 'artifacts/pwa-port/podcast-p1-build-2026-10-23.log'
assert.match(await readFile(join(root, buildLogPath), 'utf8'), /b698958a8a49ec05: 51243 bytes iniciales; 786941 bajo demanda/)

const frozenPaths = [
  `artifacts/pwa-e2e/podcast-p1-${build}-webkit-frozen-copy.json`,
  `artifacts/pwa-e2e/podcast-p1-${build}-webkit-session-final-frozen-copy.json`,
  `artifacts/pwa-e2e/podcast-p1-${build}-webkit-offline-final-frozen-copy.json`,
]
for (const path of frozenPaths) {
  const frozen = await json(path)
  assert.equal(frozen.build, build); assert.equal(frozen.sourceCommit, sourceCommit)
  assert.equal(frozen.originalAndCopyUnchangedBeforeAfter, true)
  assert.equal(frozen.qaSourceAndSnapshotUnchangedBeforeAfter, true); assert.equal(frozen.productSourcesUnchangedBeforeAfter, true)
  assert.deepEqual(frozen.distribution.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), inventory.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })))
  for (const binding of frozen.bindings) await verifyBinding(binding)
  for (const binding of [...frozen.distribution.qaSources, ...frozen.distribution.productSources]) await verifyBinding(binding, binding.snapshotPath)
}
const sourceFiles = ['web-port/audio.ts', 'web-port/podcast-audio.ts', 'web-port/youtube-playable.ts', 'web-port/youtube.ts',
  'web-port/downloads.ts', 'web-port/download-store.ts', 'pwa/sw.js', 'src/lib/player.svelte.ts', 'src/lib/downloads.svelte.ts',
  'src/components/DownloadButton.svelte', 'src/views/PodcastView.svelte']
const productSources = []
for (const path of sourceFiles) {
  const binding = await bind(path), committed = execFileSync('git', ['show', sourceCommit + ':' + path], { cwd: root })
  assert.equal(binding.sha256, digest(committed), 'Product source changed after the frozen build: ' + path)
  productSources.push(binding)
}

// This gate is intentionally last. Until these exact files are public and the
// corresponding Pages workflow succeeds, this generator cannot claim release.
const statePath = 'artifacts/pwa-deploy/state.json', state = await json(statePath)
const publicPath = `artifacts/pwa-deploy/public-files-${build}.json`, publicReport = await json(publicPath)
const pendingPublicPath = `artifacts/pwa-deploy/public-files-${build}-pending.json`, pendingPublic = await json(pendingPublicPath)
const workflowPath = `artifacts/pwa-deploy/workflow-${build}.json`, workflow = await json(workflowPath)
const dryRun = await json(dryRunPath)
assert.equal(state.pwa_build, build); assert.equal(publicReport.build, build); assert.equal(publicReport.passed, true)
assert.equal(publicReport.files.length, 33); assert.equal(workflow.conclusion, 'success'); assert.equal(workflow.headSha, state.commit)
assert.equal(dryRun.sourceHash, state.source_hash)
for (const file of publicReport.files) {
  assert.equal(file.pass, true); assert.equal(file.status, 200)
  assert.equal(file.expected, inventoryByPath.get(file.path)?.sha256); assert.equal(file.actual, file.expected)
}
assert.equal(new Set(publicReport.files.map(file => file.path)).size, 33)
assert.equal(pendingPublic.build, build); assert.equal(pendingPublic.passed, false)
assert.equal(pendingPublic.files.length, 33); assert.equal(pendingPublic.files.filter(file => file.pass).length, 27)

const evidencePaths = new Set([statePath, publicPath, pendingPublicPath, workflowPath, dryRunPath])
for (const path of await files('artifacts/pwa-port')) {
  if (/^artifacts\/pwa-port\/(?:podcast-p1-|update-e2e-b698958a8a49ec05)/.test(path)) evidencePaths.add(path)
}
for (const item of await readdir(join(root, 'artifacts/pwa-e2e'), { withFileTypes: true })) {
  if (!item.name.startsWith('podcast-p1-' + build)) continue
  const path = 'artifacts/pwa-e2e/' + item.name
  for (const child of item.isDirectory() ? await files(path) : [path]) evidencePaths.add(child)
}
const evidence = await Promise.all([...evidencePaths].sort().map(bind))
const sourceVersions = evidence.filter(binding => /(?:^|\/)(?:provider-fixtures|media-scenarios)\.mjs$/.test(binding.path))
const manifest = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), build, sourceCommit, baselineBuild,
  runtime: { purePwa: true, addedBackend: false, proxyAtRuntime: false, userAccountsRequired: false, subscriptionRequired: false },
  changes: { youtubeP1PodcastDownloadsEnabled: true, musicAndPodcastShareP1CapabilityContract: true,
    podcastPlaybackPrimaryCdnRepairEnabled: true, downloadRenewalEarlyPrimaryRepairEnabled: false,
    storedExactEpisodeVideoIdRetained: true, rssPlaybackPolicyChanged: false, rssDownloadsEnabled: false,
    musicSourceAssociationCreatedForEpisode: false, signedLocatorsPersisted: false,
    downloadGate: 'Positive declared size <=256 MiB and duration <=24 h; complete Cache.put followed by cache-only decoder duration and decodable-tail validation.',
    opaqueSizeIsDeclared: true, opaqueBodySHA256Verified: false, schemaOrWorkerMigration: false,
    downloadJobBudget: 'P1 max(90 s, min(10 min, duration +30 s)) from job start, including renewal; explicit timeout wins.' },
  logic: { ...logic, subsets: { pwa: pwaSubset, directed: directedSubset }, countsAreNotAdded: true },
  typecheck: { errors: 0, warnings: 0, report: await bind(typePath) },
  controlledBrowsers: { passed: 27, failed: 0, engines: consolidated, reports: await Promise.all(Object.values(reportPaths).map(bind)),
    consolidation: 'For each engine take the eight passing v1 check names plus only the corrected episode scenario from v3. Repeated setup and selection checks in v2/v3 are not added.',
    countScope: 'Nine unique checks per engine, including two setup checks and seven media scenarios; not 27 distinct product features.',
    observerHistory: [
      { revision: 'v1', passed: 24, failed: 3, reason: 'A visitor session bootstrap search with the exact stored video ID was incorrectly labelled musical matching. Raw failures remain unchanged.' },
      { revision: 'v2', passed: 9, failed: 3, reason: 'An offline restored PodcastView attempted its known metadata browse. The broad no-nonmedia assertion rejected this aborted metadata request after successful local playback/seek/checkpoint operations. Raw failures remain unchanged.' },
      { revision: 'v3', passed: 12, failed: 0, reason: 'Only the exact known no-params WEB visitor bootstrap and known failed offline metadata browse are distinguished. Player/source/musical searches remain forbidden offline; external provider deliveries remain zero.' },
    ],
    scope: 'Compiled Svelte UI, genuine ninety-second silent AAC fixture, native decoder, IDB, CacheStorage and production service worker. Desktop layouts; no real musical recording, physical mobile, background transfer or long-episode claim.',
    outageScope: 'Each final episode scenario records its actual outage mode and navigator.onLine expectation. WebKit HTTP origin/provider outage is not presented as physical airplane mode.',
    frozenCopies: await Promise.all(frozenPaths.map(bind)) },
  negativeControl: { result: negative.result, sourceCommit: negative.sourceCommit, manifest: await bind(negativePath),
    meaning: 'Six expected capability/repair failures on frozen pre-feature product modules; three unchanged-policy controls pass. Not failures of the released product.' },
  update: { fromBuild: baselineBuild, passed: 11, failed: 0, report: await bind(updatePath),
    initialSetupFailure: { completedChecks: 0, reason: 'Configured Chrome executable absent before launch.', report: await bind(setupPath) },
    scope: 'Compiled final graph with real worker, IDB/cache fixtures and duplicate playlists; no physical icon/APK-data migration or live extraction claim.' },
  distribution: { files: 33, bytes: 883757, initialBytes: 51243, onDemandBytes: 786941,
    sourceHash: dryRun.sourceHash, cssFontsAndRecipeUnchangedFrom: baselineBuild, unchangedFiles: unchanged, inventory, buildLog: await bind(buildLogPath) },
  publication: { verified: true, ...state, workflow: workflow.url, workflowConclusion: workflow.conclusion,
    publicFilesPassed: 33, report: await bind(publicPath), workflowReport: await bind(workflowPath), dryRun: await bind(dryRunPath),
    priorPendingVerification: { passed: 27, failed: 6, report: await bind(pendingPublicPath),
      reason: 'HTTP verification was attempted before the deployment workflow finished. Its mixed-version/absent-file result remains a historical failure, superseded by the final exact-build33/33 check.' } },
  realProvider: { newLiveProviderCanaryExecuted: false, priorBuildEvidenceReassigned: false },
  limits: { universalAvailabilityClaimed: false, niNiNiPersistent403Resolved: false, newPhysicalAndroidTest: false,
    newPhysicalIOSTest: false, screenOffVerifiedForThisBuild: false, backgroundDownloadsGuaranteed: false,
    longPodcastDownloadProven: false, APKMigration: false, androidAuto: false, carPlay: false },
  productSources, qaSourceVersions: sourceVersions,
  sourceBindingPolicy: 'Historical mutable source paths describe execution-time bytes. Each immutable QA snapshot is bound separately; the final observer does not rewrite earlier reports or results.',
  evidence,
}
const output = `artifacts/pwa-e2e/validation-${build}.json`
await writeFile(join(root, output), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ output, build, logic: 856, controlledBrowsers: 27, update: 11, publicFiles: 33, distributionBytes: 883757, evidence: evidence.length }))
