// Isolated DOMParser/IndexedDB integration. Every provider request uses a local fixture.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const report = { testedAt: new Date().toISOString(), scope: 'Isolated Chrome: transcript RSS namespaces, historical GUID refresh, IndexedDB and real browser CORS' }
const artifacts = new URL('../../artifacts/pwa-e2e/', import.meta.url)
let server, browser, feedRequests = 0, textRequests = 0, feedStatus = 200, textStatus = 200, allowCors = true
const item = index => `<item><title>Episode ${index}</title><guid>episode-${index}</guid><enclosure url="https://audio.example/${index}.mp3" type="audio/mpeg"/>${index === 335 ? '<p:transcript url="text.vtt" type="text/vtt" language="es"/><alias:transcript url="text.json" type="application/json"/><fake:transcript url="fake.vtt" type="text/vtt"/>' : ''}</item>`
const rss = items => `<rss xmlns:p="https://podcastindex.org/namespace/1.0" xmlns:alias="https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md" xmlns:fake="urn:fake"><channel><title>Programme</title><language>es</language>${items}</channel></rss>`
let feedXML = rss(Array.from({ length: 350 }, (_, index) => item(index)).join(''))
const caption = 'WEBVTT\n\n00:01.250 --> 00:03.000\n<v Ana>Texto publicado &amp; seguro.'
try {
  server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'transcript-fixture', configureServer(instance) {
      instance.middlewares.use((request, response, next) => {
        if (request.url !== '/__transcript_qa') return next()
        response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Transcript parser QA</title><body>Fixture</body>')
      })
    } }] })
  await server.listen()
  browser = await puppeteer.launch({ headless: true, executablePath: process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' })
  const page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.hostname !== 'feed.example') return void request.continue()
    const isFeed = url.pathname === '/rss.xml'
    if (isFeed) feedRequests++; else textRequests++
    void request.respond({ status: isFeed ? feedStatus : textStatus,
      headers: { 'content-type': isFeed ? 'application/rss+xml' : 'text/vtt', ...(isFeed || allowCors ? { 'access-control-allow-origin': '*' } : {}) },
      body: isFeed ? feedXML : caption })
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__transcript_qa`)
  const initial = await page.evaluate(async xml => {
    const api = await import('/web-port/podcasts.ts'), storage = await import('/web-port/storage.ts')
    const first300 = api.parseRSS(xml, 'https://feed.example/rss.xml')
    const targeted = api.parseRSS(xml, 'https://feed.example/rss.xml', 'https://feed.example/rss.xml', 'episode-335')
    const references = targeted.episodes[0].transcripts
    delete targeted.episodes[0].transcripts; delete targeted.episodes[0].transcriptsChecked
    const old = await storage.savePodcastDetail(targeted), id = old.episodes[0].id
    await storage.savePodcastDetail(first300)
    const document = await api.transcript(id), stored = await storage.readPodcastTranscripts(id)
    const visible = await storage.readPodcastDetail('https://feed.example/rss.xml')
    return { id, catalogCount: first300.episodes.length, targetedCount: targeted.episodes.length,
      officialAndAlias: references.length === 2 && references[0].url === 'https://feed.example/text.vtt' && references[1].url === 'https://feed.example/text.json',
      loaded: document.text === 'Ana: Texto publicado & seguro.' && document.cues[0].start === 1.25,
      saved: stored.checked && stored.references.length === 2, stable: visible.episodes.length === 300 && !visible.episodes.some(value => value.id === id) }
  }, feedXML)
  assert.equal(initial.catalogCount, 300); assert.equal(initial.targetedCount, 1)
  assert.ok(initial.officialAndAlias && initial.loaded && initial.saved && initial.stable)
  assert.equal(feedRequests, 1); assert.equal(textRequests, 1)
  await page.reload()
  const restart = await page.evaluate(async id => {
    const api = await import('/web-port/podcasts.ts'), storage = await import('/web-port/storage.ts')
    return { loaded: (await api.transcript(id)).cues[0].start === 1.25, saved: (await storage.readPodcastTranscripts(id)).checked }
  }, initial.id)
  assert.ok(restart.loaded && restart.saved); assert.equal(feedRequests, 1); assert.equal(textRequests, 2)
  const refreshed = await page.evaluate(async id => {
    const api = await import('/web-port/podcasts.ts'), storage = await import('/web-port/storage.ts')
    await storage.savePodcastTranscripts(id, [], Date.now() - 600_001)
    const found = await api.transcript(id)
    return found?.cues[0].start === 1.25 && (await storage.readPodcastTranscripts(id)).references.length === 2
  }, initial.id)
  assert.ok(refreshed); assert.equal(feedRequests, 2)
  // A historical item disappearing from a trimmed RSS cannot revoke its known links.
  feedXML = rss(item(1))
  const archived = await page.evaluate(async id => {
    const api = await import('/web-port/podcasts.ts'), storage = await import('/web-port/storage.ts')
    const before = await storage.readPodcastTranscripts(id)
    await storage.savePodcastTranscripts(id, before.references, Date.now() - 600_001)
    const found = await api.transcript(id), after = await storage.readPodcastTranscripts(id)
    return !!found && after.references.length === 2
  }, initial.id)
  assert.ok(archived); assert.equal(feedRequests, 3)
  // Conversely, a matching item with the transcript tag removed confirms absence.
  feedXML = rss(item(335).replace(/<(?:p|alias):transcript[^>]*\/>/g, ''))
  const withdrawn = await page.evaluate(async id => {
    const api = await import('/web-port/podcasts.ts'), storage = await import('/web-port/storage.ts')
    return await api.transcript(id) === null && (await storage.readPodcastTranscripts(id)).references.length === 0
  }, initial.id)
  assert.ok(withdrawn)
  // Real CORS rejection must be an error with a working retry, never cached absence.
  allowCors = false
  const cors = await page.evaluate(async () => {
    const api = await import('/web-port/podcast-transcripts.ts')
    try { await api.fetchTranscript({ url: 'https://feed.example/cors.vtt', mimeType: 'text/vtt', language: 'es' }); return false }
    catch (error) { return error.message.includes('CORS') && error.message.includes('Vuelve a intentarlo') }
  })
  assert.ok(cors)
  allowCors = true
  const retry = await page.evaluate(async () => {
    const api = await import('/web-port/podcast-transcripts.ts')
    return (await api.fetchTranscript({ url: 'https://feed.example/cors.vtt', mimeType: 'text/vtt', language: 'es' })).cues[0].start === 1.25
  })
  assert.ok(retry)
  report.passed = true
  report.checks = { catalogLimit: true, guidBeyond300: true, officialNamespaceAndAlias: true, restart: true,
    staleAbsenceDiscoversText: true, trimmedFeedPreservesReferences: true, removedTagConfirmsAbsence: true, corsErrorAndRetry: true }
  report.browser = await browser.version()
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1 }
finally {
  await mkdir(artifacts, { recursive: true }); await writeFile(new URL('transcripts-browser.json', artifacts), JSON.stringify(report, null, 2) + '\n')
  await browser?.close(); await server?.close()
}
console.log(JSON.stringify(report))
