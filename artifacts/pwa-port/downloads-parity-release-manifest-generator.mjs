import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Generate only after browser resources close and the public build is verified.
const root = resolve(process.argv[2] ?? process.cwd())
const build = '435e0dc36a054099', sourceCommit = 'cd5e6d1d10a2732181b6c6b9d2b2204e7432ed44'
const baselineBuild = 'b698958a8a49ec05', baselineCommit = 'f8c714698566d26aa56adbcabbe3b40b73c6d04b'
const dryRunPath = process.argv[3] ?? `artifacts/pwa-port/downloads-parity-publish-dry-run-${build}.json`
const baseline = resolve(process.argv[4] ?? 'D:/tmp/pletina-pwa-baseline-b698958a8a49ec05/dist-pwa')
const winPath = process.argv[5] ?? `artifacts/pwa-e2e/downloads-parity-${build}-win-expanded-final/summary.json`
const wkFrozenPath = process.argv[6] ?? `artifacts/pwa-e2e/downloads-parity-${build}-webkit-expanded-final-frozen-copy.json`
const winV1Path = `artifacts/pwa-e2e/downloads-parity-${build}-win/summary.json`
const wkV1Path = `artifacts/pwa-e2e/downloads-parity-${build}-webkit/summary.json`
const targetCases = ['media.downloaded-library-native-order-and-offline-collection-playback',
  'media.download-list-reconciles-evicted-copy-and-allows-redownload-without-reload']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'))
const bind = async path => { const bytes = await readFile(join(root, path)); return { path, bytes: bytes.length, sha256: sha(bytes) } }
async function files(path) {
  const entries = []
  for (const item of await readdir(join(root, path), { withFileTypes: true })) {
    const child = path + '/' + item.name
    entries.push(...(item.isDirectory() ? await files(child) : [child]))
  }
  return entries.sort()
}
async function verify(binding, path = binding.path) {
  const actual = await bind(path)
  assert.equal(actual.sha256, binding.sha256, 'Changed evidence: ' + path)
  if (binding.bytes !== undefined) assert.equal(actual.bytes, binding.bytes, 'Changed evidence size: ' + path)
  return actual
}
async function testLog(path, tests, passed, failed = 0) {
  const text = await readFile(join(root, path), 'utf8')
  for (const [key, expected] of Object.entries({ tests, pass: passed, fail: failed, cancelled: 0, skipped: 0 })) {
    assert.match(text, new RegExp(`(?:^|\\n)[^\\n]*?\\b${key}\\s+${expected}(?:\\r?\\n|$)`), path + ': ' + key)
  }
  return { tests, passed, failed, report: await bind(path) }
}

const logic = await testLog('artifacts/pwa-port/downloads-parity-logic-final-2026-10-24.log', 878, 878)
const storeSubset = await testLog('artifacts/pwa-port/download-stale-pointer-after-2026-10-24.log', 16, 16)
const orderSubset = await testLog('artifacts/pwa-port/download-order-after-2026-10-24.log', 10, 10)
const typePath = 'artifacts/pwa-port/downloads-parity-types-final-2026-10-24.log'
assert.match(await readFile(join(root, typePath), 'utf8'), /0 errors and 0 warnings/)
const nativeBuildPath = 'artifacts/pwa-port/downloads-parity-native-frontend-build-2026-10-24.log'
const nativeBuildLog = await readFile(join(root, nativeBuildPath), 'utf8')
assert.match(nativeBuildLog, /built in /); assert.match(nativeBuildLog, /Some chunks are larger than 500 kB/)
const negativeOrder = await testLog('artifacts/pwa-port/download-order-negative-frozen-2026-10-24.log', 10, 6, 4)
const negativeStage = await testLog('artifacts/pwa-port/download-stale-pointer-negative-frozen-2026-10-24.log', 16, 12, 4)
for (const path of ['artifacts/pwa-port/download-order-negative-sources/manifest.json', 'artifacts/pwa-port/download-stale-pointer-negative-sources/manifest.json']) {
  const manifest = await json(path)
  for (const file of manifest.files) await verify(file)
}
const badgePath = 'artifacts/pwa-port/downloads-stale-badges-manifest.json', badges = await json(badgePath)
assert.deepEqual(badges.final.directedNew.tests, 12); assert.equal(badges.final.directedNew.passed, 12); assert.equal(badges.final.directedNew.failed, 0)
assert.equal(badges.final.fullFrontend.tests, 47); assert.equal(badges.final.fullFrontend.passed, 47); assert.equal(badges.final.fullFrontend.failed, 0)
const badgeBaseline = badges.negatives.find(value => value.variant === 'baseline')
const badgeSubscription = badges.negatives.find(value => value.variant === 'subscription')
assert.deepEqual([badgeBaseline.tests, badgeBaseline.passed, badgeBaseline.failed], [12, 8, 4])
assert.deepEqual([badgeSubscription.tests, badgeSubscription.passed, badgeSubscription.failed], [1, 0, 1])
for (const value of Object.values(badges.final)) await verify(value.report)
for (const negative of badges.negatives) { await verify(negative.report); for (const file of negative.files) await verify(file) }
for (const initial of badges.initialObservations) await verify(initial.report)
for (const file of [...badges.production, badges.test, badges.dependencies.lock]) await verify(file)

const wkFrozen = await json(wkFrozenPath)
const wkPath = wkFrozen.bindings.find(binding => binding.path.endsWith('/summary.json'))?.path
assert.ok(wkPath, 'The final WebKit frozen-copy manifest must bind its exact summary')
const win = await json(winPath), wk = await json(wkPath)
const winV1 = await json(winV1Path), wkV1 = await json(wkV1Path)
assert.deepEqual(win.counts, { pass: 10, fail: 0, blocked: 0, unsupported: 0 })
assert.deepEqual(wk.counts, { pass: 5, fail: 0, blocked: 0, unsupported: 0 })
assert.deepEqual(winV1.counts, { pass: 18, fail: 4, blocked: 0, unsupported: 0 })
assert.deepEqual(wkV1.counts, { pass: 9, fail: 2, blocked: 0, unsupported: 0 })
const engines = []
for (const report of [winV1, wkV1, win, wk]) {
  assert.equal(report.build, build); assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedErrors, [])
  assert.equal(report.serverClosed, true)
  for (const profile of report.profiles) {
    assert.equal(profile.build, build); assert.equal(profile.contextClosed, true); assert.equal(profile.browserClosed, true)
    assert.deepEqual(profile.errors, [])
  }
}
for (const report of [win, wk]) {
  assert.equal(report.browserFeatureChecksPassed, true)
  for (const profile of report.profiles) {
    assert.deepEqual(profile.counts, { pass: 5, fail: 0, blocked: 0, unsupported: 0 })
    assert.equal(profile.checks.length, 5); assert.ok(profile.checks.every(check => check.status === 'pass'))
    const previousReport = report === win ? winV1 : wkV1
    const previous = previousReport.profiles.find(old => old.engine === profile.engine)
    assert.ok(previous); assert.equal(previous.checks.length, 11)
    assert.deepEqual(previous.counts, { pass: 9, fail: 2, blocked: 0, unsupported: 0 })
    assert.deepEqual(previous.checks.filter(check => check.status === 'fail').map(check => check.name).sort(), [...targetCases].sort())
    const oldPath = report === win ? winV1Path : wkV1Path, finalPath = report === win ? winPath : wkPath
    const merged = previous.checks.filter(check => check.status === 'pass').map(check => ({ ...check, sourceReport: oldPath }))
    const repeatedNames = new Set(merged.map(check => check.name))
    for (const check of profile.checks) {
      if (targetCases.includes(check.name)) merged.push({ ...check, sourceReport: finalPath })
      else assert.ok(repeatedNames.has(check.name), 'Repeated setup/selection must not add coverage')
    }
    assert.equal(merged.length, 11); assert.equal(new Set(merged.map(check => check.name)).size, 11)
    engines.push({ engine: profile.engine, profile: profile.profile, browserVersion: profile.browserVersion,
      passed: 11, failed: 0, initialReport: await bind(oldPath), correctedNewCasesReport: await bind(finalPath),
      checks: merged.map(({ name, status, sourceReport, networkMode, navigatorOfflineExpected }) => ({ name, status, sourceReport,
        ...(networkMode !== undefined ? { networkMode } : {}), ...(navigatorOfflineExpected !== undefined ? { navigatorOfflineExpected } : {}) })) })
  }
}
assert.deepEqual(engines.map(engine => engine.engine).sort(), ['chromium', 'firefox', 'webkit'])
assert.deepEqual(engines[0].checks.map(check => check.name).sort(), engines[1].checks.map(check => check.name).sort())
assert.deepEqual(engines[0].checks.map(check => check.name).sort(), engines[2].checks.map(check => check.name).sort())

const inventory = []
for (const path of await files('dist-pwa')) inventory.push({ ...await bind(path), path: path.slice('dist-pwa/'.length) })
assert.equal(inventory.length, 33); assert.equal(inventory.reduce((sum, file) => sum + file.bytes, 0), 885074)
const byPath = new Map(inventory.map(file => [file.path, file]))
const unchangedAssets = []
for (const file of inventory.filter(file => /\.(?:css|woff2)$/.test(file.path) || file.path.includes('p1-recipe.generated-'))) {
  assert.equal(sha(await readFile(join(baseline, file.path))), file.sha256, 'Changed CSS/fonts/P1 recipe: ' + file.path)
  unchangedAssets.push(file.path)
}
assert.equal(wkFrozen.build, build); assert.equal(wkFrozen.sourceCommit, sourceCommit)
assert.equal(wkFrozen.originalAndCopyUnchangedBeforeAfter, true); assert.equal(wkFrozen.qaSourceAndSnapshotUnchangedBeforeAfter, true)
assert.equal(wkFrozen.productSourcesUnchangedBeforeAfter, true)
assert.deepEqual(wkFrozen.distribution.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), inventory.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })))
for (const binding of wkFrozen.bindings) await verify(binding)
for (const file of [...wkFrozen.distribution.qaSources, ...wkFrozen.distribution.productSources]) await verify(file, file.snapshotPath)
const buildLogPath = 'artifacts/pwa-port/downloads-parity-build-2026-10-24.log'
assert.match(await readFile(join(root, buildLogPath), 'utf8'), /435e0dc36a054099: 51243 bytes iniciales; 788258 bajo demanda/)
const productFiles = ['web-port/download-store.ts', 'src/lib/downloads.svelte.ts', 'src/views/DownloadsView.svelte']
const unchangedProductFiles = ['web-port/storage.ts', 'web-port/downloads.ts', 'web-port/audio.ts', 'web-port/podcast-audio.ts',
  'web-port/youtube-playable.ts', 'web-port/youtube.ts', 'pwa/sw.js']
const productSources = []
for (const path of [...productFiles, ...unchangedProductFiles]) {
  const binding = await bind(path), committed = execFileSync('git', ['show', sourceCommit + ':' + path], { cwd: root })
  assert.equal(binding.sha256, sha(committed), 'Product changed after frozen build: ' + path)
  if (unchangedProductFiles.includes(path)) assert.equal(binding.sha256, sha(execFileSync('git', ['show', baselineCommit + ':' + path], { cwd: root })), 'Unexpected provider/storage/worker change: ' + path)
  productSources.push(binding)
}

const updatePath = `artifacts/pwa-port/update-e2e-${build}.json`, update = await json(updatePath)
assert.equal(update.passed, true); assert.equal(update.baseDistributionVersion, build); assert.equal(update.prototypeVersion, baselineBuild)
assert.equal(update.checks.length, 11); assert.ok(update.checks.every(check => check.pass)); assert.deepEqual(update.errors, [])
assert.equal(update.browserClosed, true); assert.equal(update.localServerClosed, true)

// Never infer publication from a local build or an upload request alone.
const statePath = 'artifacts/pwa-deploy/state.json', state = await json(statePath)
const publicPath = `artifacts/pwa-deploy/public-files-${build}.json`, publicReport = await json(publicPath)
const workflowPath = `artifacts/pwa-deploy/workflow-${build}.json`, workflow = await json(workflowPath)
const dryRun = await json(dryRunPath)
assert.equal(state.pwa_build, build); assert.equal(publicReport.build, build); assert.equal(publicReport.passed, true)
assert.equal(publicReport.files.length, 33); assert.equal(workflow.conclusion, 'success'); assert.equal(workflow.headSha, state.commit)
assert.equal(dryRun.sourceHash, state.source_hash)
for (const file of publicReport.files) { assert.equal(file.pass, true); assert.equal(file.status, 200); assert.equal(file.expected, byPath.get(file.path)?.sha256); assert.equal(file.actual, file.expected) }
assert.equal(new Set(publicReport.files.map(file => file.path)).size, 33)

const evidencePaths = new Set([statePath, publicPath, workflowPath, dryRunPath])
for (const path of await files('artifacts/pwa-port')) if (/^artifacts\/pwa-port\/(?:download-order-|download-stale-pointer-|downloads-stale-badges-|downloads-parity-|update-e2e-435e0dc36a054099)/.test(path)) evidencePaths.add(path)
const historicalBrowserAttempts = []
for (const item of await readdir(join(root, 'artifacts/pwa-e2e'), { withFileTypes: true })) {
  if (!item.name.startsWith('downloads-parity-' + build)) continue
  const path = 'artifacts/pwa-e2e/' + item.name
  for (const child of item.isDirectory() ? await files(path) : [path]) {
    evidencePaths.add(child)
    if (child.endsWith('/summary.json') && ![winPath, wkPath, winV1Path, wkV1Path].includes(child)) {
      const report = await json(child)
      historicalBrowserAttempts.push({ report: await bind(child), counts: report.counts, finishedAt: report.finishedAt ?? null,
        selectedAsFinalEvidence: false, scope: 'Retained raw attempt; its results are not relabelled or added to the final browser count.' })
    }
  }
}
const evidence = await Promise.all([...evidencePaths].sort().map(bind))
const manifest = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), build, sourceCommit, baselineBuild, baselineCommit,
  runtime: { purePwa: true, architectureUnchanged: true, addedBackend: false, proxyAtRuntime: false, userAccountsRequired: false, subscriptionRequired: false },
  changes: { visibleDownloadOrder: 'Artist ASCII NOCASE, album ASCII NOCASE, download date ascending, using current canonical metadata before sorting.',
    collation: 'ASCII A-Z folding only and UTF-8 byte order; no locale/accent normalization.',
    exactNativeSqlTieOrderClaimed: false, deterministicTieBreak: 'Track ID ascending. APK SQL leaves complete ties unspecified.', rawStoreListOrderingChanged: false,
    atomicMissingPointerRetirement: 'One files readwrite transaction rereads the row and deletes only if its cacheKey equals the stage actually observed missing.',
    replacementCacheProbes: 1, reconciliationDeletesAudioBodies: false,
    visibleDownloadBadges: 'Authoritative local listing reconciles completed IDs while protecting current jobs, removals, overlapping reads and player-side corrections.',
    viewReadsReactiveDoneSnapshotUntracked: true, nativeFrontendListingBehaviorChanged: false,
    providersChanged: false, audioResolutionPolicyChanged: false, schemaChanged: false, workerChanged: false, signedLocatorsPersisted: false },
  logic: { ...logic, countsAreNotAdded: true, subsets: { downloadStore: storeSubset, intermediateOrder: orderSubset,
    newFrontend: badges.final.directedNew, completeFrontend: badges.final.fullFrontend } },
  typecheck: { errors: 0, warnings: 0, report: await bind(typePath) },
  nativeFrontendCompilation: { passed: true, chunkSizeWarningPresent: true, report: await bind(nativeBuildPath),
    scope: 'Vite compilation of the native frontend only; no APK build, native service execution or physical-device claim.' },
  controlledBrowsers: { passed: 33, failed: 0, engines, reports: await Promise.all([winV1Path, wkV1Path, winPath, wkPath].map(bind)),
    consolidation: 'For each engine select nine passing v1 checks and the two corrected new cases from v2. The three repeated setup/selection checks per engine in v2 are not added.',
    observerHistory: { v1: { passed: 27, failed: 6, reason: 'Both new cases assumed twelve search rows before clicking the real Ver más control. They failed in preparation before downloading; the existing nine checks per engine passed. Raw results remain unchanged.' },
      v2: { passed: 15, failed: 0, reason: 'Only the UI preparation expands the twelve search results before its unchanged twelve-row assertion. Product, download, ordering, decoder, storage and outage assertions remain unchanged.' } },
    countScope: 'Eleven checks per engine: two setup checks, selection baseline and eight selected media scenarios. Not 33 distinct product features.',
    scope: 'Compiled PWA, HTTP provider fixtures and genuine silent AAC, native HTMLAudio, IDB, CacheStorage and production service worker. Desktop browsers with mobile layouts.',
    outageScope: 'The scenario report records the actual offline or origin/provider outage mode. A WebKit HTTP gate is not physical airplane mode.',
    syntheticCacheEviction: 'Only the missing-cache scenario removes a previously product-downloaded cache body as a fault. No QA download-row insertion, replacement player, live-provider or physical-device claim.',
    frozenCopy: await bind(wkFrozenPath), historicalBrowserAttempts },
  negativeControls: { ordering: { ...negativeOrder, expectedNegative: true, snapshot: await bind('artifacts/pwa-port/download-order-negative-sources/manifest.json') },
    stalePointer: { ...negativeStage, expectedNegative: true, snapshotIncludesOrderingFix: true, snapshot: await bind('artifacts/pwa-port/download-stale-pointer-negative-sources/manifest.json') },
    frontend: { tests: badgeBaseline.tests, passed: badgeBaseline.passed, failed: badgeBaseline.failed, expectedNegative: true, report: badgeBaseline.report },
    reactiveSubscription: { tests: badgeSubscription.tests, passed: badgeSubscription.passed, failed: badgeSubscription.failed, expectedNegative: true, report: badgeSubscription.report },
    frontendManifest: await bind(badgePath), intermediateObserverHistory: badges.initialObservations,
    observerPolicy: 'The initial plain Map/Set server-reactivity observation is preserved but excluded from final proof. The final twelve cases use real Svelte browser reactive collections and the shared client runtime.' },
  update: { fromBuild: baselineBuild, passed: 11, failed: 0, report: await bind(updatePath),
    scope: 'Final compiled graph, actual worker and IDB/cache fixtures, duplicate playlist persistence and offline entry. No APK database or physical icon migration.' },
  distribution: { files: inventory.length, bytes: inventory.reduce((sum, file) => sum + file.bytes, 0), initialBytes: 51243, onDemandBytes: 788258,
    cssFontsAndP1RecipeUnchangedFrom: baselineBuild, unchangedAssets, sourceHash: dryRun.sourceHash, inventory, buildLog: await bind(buildLogPath) },
  publication: { verified: true, ...state, workflow: workflow.url, workflowConclusion: workflow.conclusion, publicFilesPassed: 33,
    report: await bind(publicPath), workflowReport: await bind(workflowPath), dryRun: await bind(dryRunPath) },
  realProvider: { newLiveProviderCanaryExecuted: false, priorEvidenceReassigned: false },
  limits: { universalAvailabilityClaimed: false, niNiNiPersistent403Resolved: false, newPhysicalAndroidTest: false, newPhysicalIOSTest: false,
    screenOffVerifiedForThisBuild: false, backgroundDownloadsGuaranteed: false, APKMigration: false, androidAuto: false, carPlay: false },
  productSources, sourceBindingPolicy: 'Snapshots and raw reports retain the exact bytes and scope of each negative or intermediate observer. Only final successful build-specific reports supply final counts.', evidence,
}
const output = `artifacts/pwa-e2e/validation-${build}.json`
await writeFile(join(root, output), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ output, build, logic: 878, controlledBrowsers: 33, update: 11, publicFiles: 33, distributionBytes: 885074, evidence: evidence.length }))
