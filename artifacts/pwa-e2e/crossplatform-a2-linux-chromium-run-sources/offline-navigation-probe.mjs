// Isolate browser offline-navigation behavior from provider routing. Production shell,
// production SW and native CacheStorage; no replacement application code or SW.
// Follow-up: --engines firefox,webkit --modes global-unroute-offline,stopped-origin
// stopped-origin closes the actual HTTP listener. It does not change navigator.onLine
// or claim that the browser/device has entered airplane mode.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createPwaServer } from '../../preview-pwa.mjs'

process.env.PLAYWRIGHT_BROWSERS_PATH ??= 'D:/tmp/pletina-e2e-browsers'
const { chromium, firefox, webkit } = await import('playwright')
const args = process.argv.slice(2)
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const output = resolve(option('--output', 'artifacts/pwa-e2e/offline-navigation-probe'))
const engines = { chromium, firefox, webkit }
const selected = option('--engines', 'chromium,firefox,webkit').split(',')
const modes = option('--modes', 'no-routing,global-routing,external-pattern-routing').split(',')
const report = { testedAt: new Date().toISOString(), scope: 'Desktop browser offline navigation controls; no physical phone/Safari claim.', cases: [] }
const safe = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 1500)
const server = createPwaServer()
const traffic = []
server.on('request', request => traffic.push({ method: request.method, path: new URL(request.url, 'http://localhost').pathname }))
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const baseURL = `http://127.0.0.1:${server.address().port}/pletina/`
await mkdir(output, { recursive: true })

async function browserState(page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    const index = new URL('index.html', location.href).href
    const entries = []
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      const response = await cache.match(index)
      if (!response) continue
      const clone = response.clone()
      entries.push({ cache: name.replace(/https?%3A[^:]+/g, '[scope]'), status: response.status,
        bytes: (await clone.arrayBuffer()).byteLength, keys: (await cache.keys()).map(request => new URL(request.url).pathname) })
    }
    return { online: navigator.onLine, controller: Boolean(navigator.serviceWorker.controller), active: registration?.active?.state ?? null,
      installing: registration?.installing?.state ?? null, cacheEntries: entries, title: document.title, installPresent: Boolean(document.querySelector('#install')) }
  })
}

try {
  for (const engine of selected) {
    if (!engines[engine]) throw new Error('Unknown engine')
    let browser
    try {
      browser = await engines[engine].launch({ headless: true,
        ...(engine === 'chromium' ? { executablePath: option('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe') } : {}) })
      for (const mode of modes) {
        const entry = { engine, browserVersion: browser.version(), mode,
          condition: mode === 'stopped-origin' ? 'origin-server-stopped; navigator remains online' : 'browser-context-offline',
          requestFailures: [], before: null, offline: null, reload: null }
        report.cases.push(entry)
        let context, page, caseServer
        try {
          let caseURL = baseURL
          if (mode === 'stopped-origin') {
            caseServer = createPwaServer()
            caseServer.on('request', request => traffic.push({ method: request.method, path: new URL(request.url, 'http://localhost').pathname }))
            await new Promise(resolve => caseServer.listen(0, '127.0.0.1', resolve))
            caseURL = `http://127.0.0.1:${caseServer.address().port}/pletina/`
          }
          context = await browser.newContext({ serviceWorkers: 'allow' })
          if (mode === 'global-routing' || mode === 'global-unroute-offline') await context.route('**/*', route => route.continue())
          if (mode === 'external-pattern-routing') await context.route('https://api.deezer.com/**', route => route.abort('blockedbyclient'))
          page = await context.newPage()
          page.on('requestfailed', request => entry.requestFailures.push({ path: new URL(request.url()).pathname,
            type: request.resourceType(), error: safe(request.failure()?.errorText) }))
          await page.goto(caseURL, { waitUntil: 'load', timeout: 15000 })
          await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), undefined, { timeout: 15000 })
          entry.before = await browserState(page)
          const from = traffic.length
          if (mode === 'stopped-origin') {
            await new Promise(resolve => { caseServer.close(resolve); caseServer.closeAllConnections() })
            entry.originServerStopped = !caseServer.listening
          } else await context.setOffline(true)
          if (mode === 'global-unroute-offline') { await context.unrouteAll(); entry.routingRemovedWhileOffline = true }
          entry.offline = await browserState(page)
          try {
            const response = await page.reload({ waitUntil: 'load', timeout: 5000 })
            entry.reload = { succeeded: true, status: response?.status() ?? null, state: await browserState(page) }
          } catch (error) { entry.reload = { succeeded: false, error: safe(error.message) } }
          entry.serverRequestsDuringOffline = traffic.slice(from)
        } catch (error) { entry.setupError = safe(error.message) }
        finally {
          await context?.setOffline(false).catch(() => {})
          await context?.close().catch(() => {})
          if (caseServer?.listening) await new Promise(resolve => { caseServer.close(resolve); caseServer.closeAllConnections() })
          entry.contextClosed = true
          await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
          console.log(JSON.stringify({ engine, mode, cachedIndex: entry.before?.cacheEntries?.map(value => ({ status: value.status, bytes: value.bytes })),
            navigatorOnline: entry.offline?.online, reload: entry.reload?.succeeded, error: entry.reload?.error ?? entry.setupError ?? null,
            serverHitsDuringOffline: entry.serverRequestsDuringOffline?.length }))
        }
      }
    } catch (error) { report.cases.push({ engine, launchError: safe(error.message) }) }
    finally { await browser?.close(); report[engine + 'Closed'] = !browser?.isConnected() }
  }
} finally {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  report.serverClosed = !server.listening
  report.finishedAt = new Date().toISOString()
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}
