// One isolated migration between real built distributions. Diagnostic evidence, not a QA PASS gate.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPwaServer } from '../preview-pwa.mjs'
import { buildPwa, sourceDirectory } from '../build-pwa.mjs'

const workspace = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
if (process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(process.env.PLAYWRIGHT_BROWSERS_PATH)
const { chromium } = await import('playwright')
const traceReceiver = args.includes('--trace-receiver')
const wrapSender = args.includes('--wrap-sender')
const qaTitle = args.includes('--qa-title')
const reportName = option('--report', 'activation-diagnostic.json')
assert.match(reportName, /^[a-z0-9-]+\.json$/i)
const output = join(workspace, 'artifacts/pwa-port')
const scrub = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').replace(/[A-Z]:[\\/][^\s\n"']+/gi, '[path]').slice(0, 1000)
const path = value => { try { return new URL(value).pathname } catch { return scrub(value) } }
const report = { startedAt: new Date().toISOString(), diagnosticOnly: true, qaPassClaimed: false,
  mode: traceReceiver ? 'receiver-observer-and-delegating-native-skipWaiting-wrapper' : 'passive-cdp-control',
  scope: 'One disposable desktop Chrome, cold old shell, real built baseline and canonical next distribution, one explicit old secondary update click. ' +
    (qaTitle ? 'The optional QA title/meta variant is rebuilt in temporary output after verifying an identical canonical roundtrip. ' : 'No A/B title variants. ') +
    'No seeded app data, music, physical device or publication.',
  receiverInstrumented: traceReceiver, pagePostMessageWrapped: wrapSender, qaTitleVariant: qaTitle, nativeSkipWaitingInvokedSeparately: false,
  host: { platform: process.platform, arch: process.arch, node: process.version },
  events: [], errors: [], requests: [], snapshots: [], receiverTrace: [], messages: [],
  messageScope: 'Passive control does not wrap page postMessage or fabricate a worker receiver. Receiver mode records incoming message events and delegates the existing native skipWaiting call unchanged.',
}
let browser, context, page, session, server, temporary, origin, phase = 'setup', live = 'baseline', waitingWorker
const servers = new Map()
async function snapshot(label) {
  const state = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    const worker = value => value ? { state: value.state, scriptPath: new URL(value.scriptURL).pathname } : null
    const cacheInfo = []
    for (const name of await caches.keys()) if (name.startsWith('pletina-pwa:')) cacheInfo.push({ version: name.split(':').at(-1),
      paths: (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname).sort() })
    return { path: location.pathname, search: location.search, title: document.title, status: document.querySelector('#status')?.textContent ?? null,
      displayedVersion: document.querySelector('#version')?.textContent ?? null, appVisible: Boolean(document.querySelector('.app')),
      button: { text: document.querySelector('#open-player')?.textContent ?? null, disabled: document.querySelector('#open-player')?.disabled ?? null },
      openedBefore: localStorage.getItem('pletina:web:opened'), online: navigator.onLine,
      scope: registration ? new URL(registration.scope).pathname : null,
      workers: { controller: worker(navigator.serviceWorker.controller), active: worker(registration?.active), waiting: worker(registration?.waiting), installing: worker(registration?.installing) }, cacheInfo }
  })
  const result = { label, at: new Date().toISOString(), ...state }
  report.snapshots.push(result)
  return result
}
async function poll(predicate, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { if (await predicate()) return true }
    catch (error) {
      if (!/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error
      report.events.push({ phase, at: new Date().toISOString(), type: 'navigation-context-transition', message: scrub(error.message) })
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}
async function collectTrace() {
  if (!traceReceiver || !waitingWorker) return
  try { report.receiverTrace = await waitingWorker.evaluate(() => globalThis.__qaActivationTrace ?? []) }
  catch (error) { report.receiverTraceUnavailable = scrub(error.message) }
}
try {
  await mkdir(output, { recursive: true })
  temporary = await mkdtemp(join(tmpdir(), 'pletina-activation-diagnostic-'))
  for (const [name, source] of [['baseline', option('--baseline', null)], ['next', option('--dist', 'dist-pwa')]]) {
    assert.ok(source, '--baseline must identify a built distribution')
    const directory = join(temporary, name)
    await cp(resolve(workspace, source), directory, { recursive: true })
    const version = (await readFile(join(directory, 'sw.js'), 'utf8')).match(/const VERSION = "([a-f0-9]{16})"/)?.[1]
    assert.ok(version, `${name} requires a real built worker`)
    report[name + 'Version'] = version
    servers.set(name, createPwaServer({ directory }))
  }
  if (qaTitle) {
    report.canonicalNextVersion = report.nextVersion
    const next = join(temporary, 'next'), application = join(temporary, 'qa-application')
    const worker = await readFile(join(next, 'sw.js'), 'utf8')
    const files = JSON.parse(worker.match(/const OPTIONAL = (\[[^\n]+\])/)[1])
    const htmlName = files.find(file => /^application\/index\.[a-f0-9]{16}\.html$/.test(file.url)).url
    const html = await readFile(join(next, htmlName), 'utf8')
    await mkdir(application); await cp(join(next, 'application/assets'), join(application, 'assets'), { recursive: true })
    await writeFile(join(application, 'index.html'), html)
    const roundtrip = await buildPwa({ source: sourceDirectory, application, output: join(temporary, 'roundtrip') })
    assert.equal(roundtrip.version, report.canonicalNextVersion, 'Variant must first reproduce the canonical distribution exactly')
    await writeFile(join(application, 'index.html'), html.replace(/<title>[^<]*<\/title>/, '<meta name="qa-release" content="A"><title>Pletina QA A</title>'))
    const directory = join(temporary, 'qa-title-site')
    const variant = await buildPwa({ source: sourceDirectory, application, output: directory })
    report.nextVersion = variant.version
    report.qaVariantChange = 'Only application index meta qa-release=A and title Pletina QA A; canonical roundtrip verified first.'
    servers.set('next', createPwaServer({ directory }))
  }
  assert.notEqual(report.baselineVersion, report.nextVersion)
  server = createServer((request, response) => {
    const row = { phase, distribution: live, path: new URL(request.url, 'http://localhost').pathname }
    report.requests.push(row); response.once('finish', () => { row.status = response.statusCode })
    servers.get(live).emit('request', request, response)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, executablePath: option('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe') })
  report.browser = browser.version()
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'allow' })
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'))
  if (wrapSender) {
    await context.exposeBinding('__qaUpdateLog', ({ frame }, value) => report.messages.push({ phase, path: path(frame.url()), ...value }))
    await context.addInitScript(() => {
      if (window.top !== window) return
      const postMessage = ServiceWorker.prototype.postMessage
      ServiceWorker.prototype.postMessage = function(...args) {
        if (['PREPARE_APPLICATION', 'ACTIVATE_UPDATE'].includes(args[0]?.type)) void window.__qaUpdateLog({ type: args[0].type, state: this.state }).catch(() => {})
        return Reflect.apply(postMessage, this, args)
      }
      navigator.serviceWorker.addEventListener('controllerchange', () => { void window.__qaUpdateLog({ type: 'controllerchange' }).catch(() => {}) })
    })
  }
  page = await context.newPage()
  page.on('pageerror', error => report.errors.push({ phase, kind: 'pageerror', message: scrub(error.message) }))
  session = await context.newCDPSession(page)
  session.on('ServiceWorker.workerVersionUpdated', event => report.events.push({ phase, at: new Date().toISOString(), type: 'versions',
    versions: event.versions.map(value => ({ versionId: value.versionId, registrationId: value.registrationId, targetId: value.targetId ?? null,
      scriptPath: path(value.scriptURL), status: value.status, runningStatus: value.runningStatus, controlledClients: value.controlledClients })) }))
  session.on('ServiceWorker.workerRegistrationUpdated', event => report.events.push({ phase, at: new Date().toISOString(), type: 'registrations',
    registrations: event.registrations.map(value => ({ registrationId: value.registrationId, scopePath: path(value.scopeURL), isDeleted: value.isDeleted })) }))
  session.on('ServiceWorker.workerErrorReported', event => report.errors.push({ phase, kind: 'workererror', ...event.errorMessage,
    errorMessage: scrub(event.errorMessage.errorMessage), sourceURL: path(event.errorMessage.sourceURL) }))
  await session.send('ServiceWorker.enable')
  phase = 'cold-baseline'
  await page.goto(origin + '/pletina/', { waitUntil: 'load' })
  assert.ok(await poll(() => page.evaluate(async () => Boolean(navigator.serviceWorker.controller && (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated'))), 'Baseline must control the page')
  const baseline = await snapshot('baseline-ready')
  assert.equal(baseline.displayedVersion, report.baselineVersion)
  assert.equal(baseline.openedBefore, null)
  assert.equal(baseline.cacheInfo.flatMap(cache => cache.paths).filter(value => value.includes('/application/')).length, 0)
  phase = 'next-waiting'; live = 'next'
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update() })
  assert.ok(await poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === 'installed')), 'Canonical next must wait')
  await snapshot('canonical-next-waiting')
  if (traceReceiver) {
    for (const worker of context.serviceWorkers()) {
      const version = await worker.evaluate(() => typeof VERSION === 'string' ? VERSION : null).catch(() => null)
      if (version === report.nextVersion) waitingWorker = worker
    }
    assert.ok(waitingWorker, 'Receiver instrumentation must identify the actual canonical waiting worker')
    await waitingWorker.evaluate(() => {
      globalThis.__qaActivationTrace = []
      const add = value => globalThis.__qaActivationTrace.push({ at: new Date().toISOString(), ...value })
      self.addEventListener('message', event => add({ event: 'message-received', type: event.data?.type ?? null }))
      const original = self.skipWaiting
      self.skipWaiting = function(...args) {
        add({ event: 'native-skipWaiting-called' })
        let result
        try { result = Reflect.apply(original, this, args) }
        catch (error) { add({ event: 'native-skipWaiting-threw', error: String(error) }); throw error }
        result.then(() => add({ event: 'native-skipWaiting-resolved' }), error => add({ event: 'native-skipWaiting-rejected', error: String(error) }))
        return result
      }
    })
  }
  phase = 'explicit-old-secondary-update'
  await page.locator('#apply-update').waitFor({ state: 'visible' })
  await page.locator('#apply-update').click()
  report.explicitOldSecondaryClick = true
  report.applicationEntered = await poll(async () => {
    const state = await snapshot('after-update-click')
    if (state.displayedVersion === report.nextVersion && !state.appVisible && !state.button.disabled) {
      await page.locator('#open-player').click(); report.newPrimaryClicked = true
    }
    return state.appVisible
  })
  await collectTrace()
  await snapshot('final-observed-state')
  const targets = await session.send('Target.getTargets')
  report.targets = targets.targetInfos.filter(value => value.type === 'service_worker' && value.url.startsWith(origin)).map(value => ({ targetId: value.targetId, scriptPath: path(value.url), attached: value.attached }))
  await page.screenshot({ path: join(output, reportName.replace(/\.json$/, '.png')), fullPage: true })
  report.observation = report.applicationEntered ? 'Application opened after the explicit old update gesture.' : 'Application did not open within the 30-second observation window.'
} catch (error) {
  report.fatal = scrub(error.message)
  if (page && !page.isClosed()) await snapshot('diagnostic-failure-state').catch(() => {})
  await collectTrace()
} finally {
  await session?.detach().catch(() => {})
  await context?.close().catch(() => {})
  report.contextClosed = !context || context.pages().length === 0
  await browser?.close().catch(() => {})
  report.browserClosed = !browser || !browser.isConnected()
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  report.serverClosed = !server || !server.listening
  if (temporary) {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir())); assert.match(basename(temporary), /^pletina-activation-diagnostic-/)
    await rm(temporary, { recursive: true, force: true }); report.temporarySiteRemoved = true
  }
  report.finishedAt = new Date().toISOString()
  await mkdir(output, { recursive: true }); await writeFile(join(output, reportName), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(`Diagnostic: artifacts/pwa-port/${reportName}; applicationEntered=${report.applicationEntered ?? false}; fatal=${report.fatal ?? 'none'}\n`)
  if (report.fatal || !report.applicationEntered) process.exitCode = 1
}
