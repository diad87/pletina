import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createPwaServer } from '../../preview-pwa.mjs'
import { createHarness } from './harness.mjs'
import { createWebKitNetworkTransport } from './webkit-network-transport.mjs'
const { webkit } = await import('playwright')
const directory = fileURLToPath(new URL('../../../artifacts/pwa-e2e/webkit-tls-proxy-proof/', import.meta.url))
const server = createPwaServer({ directory: fileURLToPath(new URL('../../../dist-pwa/', import.meta.url)) })
let browser, transport, ctx
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  transport = await createWebKitNetworkTransport()
  browser = await webkit.launch({ headless: true })
  ctx = await createHarness({ browser, baseURL: `http://127.0.0.1:${server.address().port}/pletina/`,
    profile: { id: 'webkit-iphone-layout', context: transport.contextOptions }, directory,
    networkTransport: transport.connect, report: { host: { platform: process.platform, arch: process.arch }, checks: [], errors: [] } })
  await ctx.check('proxy.open: compiled PWA stays controlled by production SW', async () => {
    const result = await ctx.open(); assert.equal(await ctx.page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true)
    return result
  })
  await ctx.check('proxy.fixture: catalog remains strictly synthetic', async () => {
    await ctx.fillSearch('Buscar', ctx.fixture.media.query)
    const row = ctx.page.locator('.tracks li[data-reorder-index="0"] .name')
    await row.waitFor(); assert.equal((await row.textContent()).trim(), ctx.fixture.tracks[0].title)
    return { fixtureFirstTitle: ctx.fixture.tracks[0].title }
  })
  await ctx.check('proxy.audio: native HTTPS AAC through TLS fixture with unchanged URL and SW', async () => {
    await ctx.tap('.tracks li[data-reorder-index="0"] .name')
    await ctx.page.waitForFunction(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > 0.2 && audio.duration === 12 && !audio.error), null, { timeout: 15000 })
    assert.ok(ctx.fixture.requests.some(request => request.host === 'fixture.googlevideo.com'))
    assert.equal(await ctx.page.evaluate(() => new URL(window.__qaAudio.instances.find(audio => !audio.paused).src).hostname), 'fixture.googlevideo.com')
    return { snapshot: await ctx.snapshot(), controlledAACRequests: ctx.fixture.requests.filter(request => request.host === 'fixture.googlevideo.com'), productionWorkerPreserved: true }
  })
  if (ctx.report.checks.some(check => check.status === 'fail')) process.exitCode = 1
} finally {
  await ctx?.close(); await browser?.close(); await transport?.close()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
