// Isolated, real-network browser QA; never loads the application or resolves audio.
// node scripts/tests/web-youtube-podcasts.browser.mjs [--chrome executable] [--query text]
//   [--show-index 1 --require-continuation]
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const require = createRequire(import.meta.url)
const puppeteer = require(option('--puppeteer', 'puppeteer'))
const query = option('--query', 'nadie sabe nada')
const showIndex = Number(option('--show-index', '0'))
assert.ok(Number.isInteger(showIndex) && showIndex >= 0 && showIndex < 20)
let server, browser
try {
  server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [{ name: 'isolated-podcast-qa', configureServer(instance) {
      instance.middlewares.use((request, response, next) => {
        if (request.url !== '/__youtube_podcast_qa') return next()
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end('<!doctype html><html lang="es"><title>Isolated podcast QA</title><body>Podcast parser QA</body></html>')
      })
    } }],
  })
  await server.listen()
  const address = server.httpServer.address()
  const base = `http://127.0.0.1:${address.port}`
  browser = await puppeteer.launch({ headless: true, executablePath: option('--chrome', undefined) })
  const page = await browser.newPage()
  const transport = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.hostname !== 'music.youtube.com' || !url.pathname.startsWith('/youtubei/v1/')) return
    const headers = request.headers()
    const body = JSON.parse(request.postData() || '{}')
    transport.push({ endpoint: url.pathname.split('/').at(-1), method: request.method(),
      origin: headers.origin || null, cookiePresent: Boolean(headers.cookie),
      contentType: headers['content-type'] || null,
      client: body.context?.client?.clientName, version: body.context?.client?.clientVersion,
      continuation: Boolean(body.continuation) })
  })
  await page.goto(base + '/__youtube_podcast_qa')
  const report = await page.evaluate(async (query, showIndex) => {
    const podcasts = await import('/web-port/youtube-podcasts.ts')
    const shows = await podcasts.search(query)
    if (!shows.length) throw new Error('No public podcast shows found')
    if (!shows[showIndex]) throw new Error('Requested public show is not in search results')
    const page = await podcasts.detail('youtube:' + shows[showIndex].browseId)
    return {
      shows: shows.slice(0, 3).map(({ browseId, title, author }) => ({ browseId, title, author })),
      showCount: shows.length,
      detail: { browseId: page.show.browseId, title: page.show.title,
        episodeCount: page.episodes.length,
        episodes: page.episodes.slice(0, 3).map(({ guid, title, duration, publishedAt }) => ({ guid, title, duration, publishedAt })),
        allSourcesAreVideoIds: page.episodes.every((episode) => /^youtube:[A-Za-z0-9_-]{11}$/.test(episode.audioUrl)),
        uniqueEpisodes: new Set(page.episodes.map((episode) => episode.guid)).size === page.episodes.length },
      remainingFrames: document.querySelectorAll('iframe').length,
    }
  }, query, showIndex)
  assert.ok(report.showCount > 0 && report.showCount <= 20)
  assert.ok(report.detail.episodeCount > 0 && report.detail.episodeCount <= 300)
  assert.ok(report.detail.allSourcesAreVideoIds)
  assert.ok(report.detail.uniqueEpisodes)
  assert.equal(report.remainingFrames, 0)
  assert.ok(transport.some((request) => request.endpoint === 'search'))
  assert.ok(transport.some((request) => request.endpoint === 'browse'))
  if (args.includes('--require-continuation')) assert.ok(transport.some((request) => request.continuation), 'Expected at least one real continuation page')
  assert.ok(transport.every((request) => request.method === 'POST' && request.contentType === 'text/plain' && !request.cookiePresent
    && request.client === 'WEB_REMIX' && request.version === '1.20260901.01.00'))
  console.log(JSON.stringify({ browser: await browser.version(), query, ...report, transport }, null, 2))
} finally {
  await browser?.close()
  await server?.close()
}
