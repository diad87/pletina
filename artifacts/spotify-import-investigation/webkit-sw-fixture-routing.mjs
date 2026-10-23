// Test-only route-bypass control. Preserve both before/after observations; never
// store an actual Spotify token or forward it to another endpoint.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { PROFILES } from '../../scripts/tests/e2e/harness.mjs'
import { createProviderFixtures } from '../../scripts/tests/e2e/provider-fixtures.mjs'
import { createWebKitNetworkTransport } from '../../scripts/tests/e2e/webkit-network-transport.mjs'
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('D:/tmp/pletina-e2e-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = 'D:/tmp/pletina-e2e-browsers'
const { webkit } = await import('playwright')
const server = createServer((request, response) => {
  if (request.url === '/sw.js') return response.writeHead(200, { 'content-type': 'application/javascript' }).end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('fetch',event=>event.respondWith(fetch(event.request)));")
  response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>SW fixture routing</title><button id="play">Play exact fixture AAC</button>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
const evidence = { startedAt: new Date().toISOString(), host: { platform: process.platform, node: process.version },
  scope: 'Isolated native SW fetch and HTMLAudio in desktop WebKit, unchanged shared provider fixtures, no product modules. Actual token values omitted.', cases: [] }
let browser, transport
try {
  browser = await webkit.launch({ headless: true })
  evidence.browserVersion = browser.version()
  for (const proxyEnabled of [false, true]) {
    transport = proxyEnabled ? await createWebKitNetworkTransport() : null
    const context = await browser.newContext({ ...PROFILES['webkit-iphone-layout'].context, ...transport?.contextOptions })
    const report = {}
    const providerContext = transport ? await transport.connect({ context, report }) : context
    const fixture = await createProviderFixtures(providerContext, { baseURL: origin })
    const page = await context.newPage(), browserRequests = [], browserResponses = [], pageErrors = []
    page.on('request', request => { const url = new URL(request.url()); browserRequests.push({ host: url.hostname, path: url.pathname, method: request.method(), resourceType: request.resourceType() }) })
    page.on('response', response => { const url = new URL(response.url()); browserResponses.push({ host: url.hostname, path: url.pathname, status: response.status() }) })
    page.on('pageerror', error => pageErrors.push({ name: error.name, message: error.message }))
    await page.goto(origin, { waitUntil: 'load' })
    await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready })
    await page.reload({ waitUntil: 'load' })
    await page.waitForFunction(() => !!navigator.serviceWorker.controller)
    const token = await page.evaluate(async () => {
      try {
        const response = await fetch('https://open.spotify.com/embed/api/token', { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000) })
        const body = await response.json()
        return { status: response.status, hasAccessToken: typeof body.accessToken === 'string', fixtureToken: body.accessToken === 'fixture-anonymous-token',
          isAnonymous: body.isAnonymous, expiresInFuture: body.accessTokenExpirationTimestampMs > Date.now() }
      } catch (error) { return { error: { name: error.name, message: error.message } } }
    })
    let metadata = null
    // Never send a real token found by the negative control anywhere else.
    if (token.fixtureToken) metadata = await page.evaluate(async uri => {
      try {
        const url = new URL('https://api-partner.spotify.com/pathfinder/v1/query')
        url.searchParams.set('operationName', 'queryPlaylist')
        url.searchParams.set('variables', JSON.stringify({ uri, offset: 0, limit: 100 }))
        url.searchParams.set('extensions', JSON.stringify({ persistedQuery: { version: 1, sha256Hash: 'a'.repeat(64) } }))
        const response = await fetch(url, { headers: { Authorization: 'Bearer fixture-anonymous-token' }, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000) })
        const body = await response.json(), playlist = body.data?.playlistV2
        return { status: response.status, name: playlist?.name, itemCount: playlist?.content?.items?.length, nextOffset: playlist?.content?.pagingInfo?.nextOffset }
      } catch (error) { return { error: { name: error.name, message: error.message } } }
    }, fixture.spotify.uri)
    await page.evaluate(() => {
      const audio = new Audio(); window.probe = { audio, playError: null }
      document.querySelector('#play').onclick = () => { audio.src = 'https://fixture.googlevideo.com/audio/qaAudio001a'; audio.play().catch(error => { window.probe.playError = { name: error.name, message: error.message } }) }
    })
    await page.locator('#play').click()
    await page.waitForFunction(() => window.probe.audio.currentTime > 0.25 || window.probe.audio.error || window.probe.playError, null, { timeout: 5000 }).catch(() => {})
    const media = await page.evaluate(() => ({ currentTime: window.probe.audio.currentTime, errorCode: window.probe.audio.error?.code ?? null, playError: window.probe.playError }))
    let unknownHostBlocked = null
    if (proxyEnabled) unknownHostBlocked = await page.evaluate(async () => { try { await fetch('https://not-allowlisted.pletina.test/no-upstream', { signal: AbortSignal.timeout(5000) }); return false } catch { return true } })
    const item = { proxyEnabled, serviceWorkerControlled: true, token, metadata, media, unknownHostBlocked,
      fixtureRequests: fixture.requests, browserRequests, browserResponses, pageErrors, proxy: transport?.snapshot() ?? null }
    evidence.cases.push(item)
    await context.close()
    if (transport) { await transport.close(); transport = null; item.proxyClosed = true }
  }
  const before = evidence.cases[0], after = evidence.cases[1]
  evidence.assertions = { beforeTokenBypassedFixture: !before.token.fixtureToken && !before.fixtureRequests.some(row => row.spotifyStage === 'token'),
    afterExactFixtureToken: after.token.fixtureToken && after.token.isAnonymous === true && after.token.expiresInFuture,
    afterExactMetadata: after.metadata?.name === 'Spotify QA Orden y Duplicados' && after.metadata.itemCount === 2 && after.metadata.nextOffset === 2,
    afterSyntheticAuthorization: after.fixtureRequests.some(row => row.spotifyAuthorizationValid === true),
    unknownHostBlocked: after.unknownHostBlocked === true,
    noExternalUpstream: after.proxy.externalUpstreamConnections === 0,
    unknownConnectDenied: after.proxy.rejected.some(row => row.host === 'not-allowlisted.pletina.test' && row.method === 'CONNECT') }
  evidence.mediaObservation = { afterMediaAdvanced: after.media.currentTime > 0.25,
    afterMediaRequestReachedProxy: after.proxy.requests.some(row => row.host === 'fixture.googlevideo.com'),
    interpretation: 'The independent Windows native media path still fails and bypasses both interception and this context proxy. The successful local exact-AAC probe rules out a general missing decoder. This observation remains a failure, separate from the corrected Spotify fetch transport.' }
  assert.ok(Object.values(evidence.assertions).every(Boolean), 'The isolated before/after fixture-routing controls must all pass.')
} catch (error) { evidence.probeError = { name: error.name, message: error.message }; process.exitCode = 1 }
finally {
  await transport?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await new Promise(resolve => server.close(resolve))
  evidence.finishedAt = new Date().toISOString()
  await writeFile(new URL('./webkit-sw-fixture-routing.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
}
console.log(JSON.stringify({ assertions: evidence.assertions, probeError: evidence.probeError, cases: evidence.cases.map(({ proxyEnabled, token, metadata, media, fixtureRequests, proxy }) => ({ proxyEnabled, token, metadata, media, fixtureRequests, proxy })) }, null, 2))
