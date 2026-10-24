// Exercise the real QA TLS proxy after removing Playwright interception.
// A socket abort must reject no-cors fetch; HTTP502 must remain opaque/fulfilled.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createWebKitNetworkTransport } from './webkit-network-transport.mjs'
const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
if (option('--browsers', null)) process.env.PLAYWRIGHT_BROWSERS_PATH = option('--browsers')
const { webkit } = await import('playwright')
const output = resolve(option('--output', 'artifacts/pwa-e2e/webkit-transport-abort-control.json'))
const source = await readFile(new URL('./webkit-network-transport.mjs', import.meta.url))
const report = { startedAt: new Date().toISOString(), scope: 'Desktop WebKit QA TLS-proxy transport control, not product playback or physical-mobile evidence.',
  transportSha256: createHash('sha256').update(source).digest('hex'), cases: [], errors: [] }
let browser, context, transport
try {
  transport = await createWebKitNetworkTransport()
  browser = await webkit.launch({ headless: true }); context = await browser.newContext(transport.contextOptions)
  const provider = await transport.connect({ context, report })
  await provider.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/abort') return route.abort('internetdisconnected')
    return route.fulfill({ status: url.pathname === '/http502' ? 502 : 200, headers: { 'content-type': 'text/plain' }, body: 'Controlled transport bytes' })
  })
  // Keep only the proxy's handler. Every target request must appear in its
  // snapshot, so direct Playwright route.abort cannot satisfy this control.
  await context.unroute('**/*')
  const page = await context.newPage(); await page.goto('data:text/html,<title>QA transport abort control</title>')
  page.on('pageerror', error => report.errors.push({ name: error.name, message: String(error.message).replace(/https?:\/\/[^\s]+/g, '[URL]') }))
  for (const path of ['/good', '/http502', '/abort']) {
    const result = await page.evaluate(async path => {
      try { const response = await fetch('https://media.pletina.test' + path, { mode: 'no-cors', credentials: 'omit', cache: 'no-store' }); return { fulfilled: true, type: response.type, status: response.status } }
      catch (error) { return { fulfilled: false, name: error.name } }
    }, path)
    report.cases.push({ path, ...result })
  }
  assert.deepEqual(report.cases.map(row => row.fulfilled), [true, true, false])
  assert.equal(report.cases[0].type, 'opaque'); assert.equal(report.cases[1].type, 'opaque'); assert.equal(report.cases[2].name, 'TypeError')
  report.transport = transport.snapshot()
  for (const path of ['/good', '/http502', '/abort']) assert.ok(report.transport.requests.some(row => row.path === path))
  assert.equal(report.transport.externalUpstreamConnections, 0)
  report.socketAbortRejectsNoCors = true; report.http502IsOpaqueFulfilled = true; report.browserVersion = browser.version()
} finally {
  await context?.close(); report.contextClosed = true; await browser?.close(); report.browserClosed = true
  await transport?.close(); report.transportClosed = true; report.completedAt = new Date().toISOString()
  await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ output, socketAbortRejectsNoCors: report.socketAbortRejectsNoCors, http502IsOpaqueFulfilled: report.http502IsOpaqueFulfilled, cases: report.cases }))
