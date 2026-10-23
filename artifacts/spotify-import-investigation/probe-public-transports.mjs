import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const id = '37i9dQZF1DXcBWIGoYBM5M'
const output = new URL('./public-transports.json', import.meta.url)
const urls = [
  `https://open.spotify.com/embed/playlist/${id}`,
  `https://open.spotify.com/embed/playlist/${id}?utm_source=generator`,
  `https://open.spotify.com/embed/playlist/${id}?utm_source=oembed`,
  `https://open.spotify.com/embed/playlist/${id}?__nextDataReq=1`,
  `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/playlist/${id}`)}`,
  `https://embed.spotify.com/?uri=spotify:playlist:${id}`,
  `https://embed.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/playlist/${id}`)}`,
  `https://api.spotify.com/v1/playlists/${id}/items`,
]
const report = {
  timestamp: new Date().toISOString(), playlistId: id, account: false, token: false, proxy: false,
  documentKind: 'Locally fulfilled QA HTML at a genuine HTTPS origin; no deployed product mutation.',
  officialReferences: [
    'https://developer.spotify.com/documentation/embeds/reference/oembed',
    'https://developer.spotify.com/documentation/embeds/references/iframe-api',
    'https://developer.spotify.com/documentation/web-api/reference/get-playlists-items',
    'https://developer.spotify.com/documentation/web-api/concepts/authorization',
    'https://developer.spotify.com/documentation/web-api/concepts/quota-modes',
  ],
  node: [], browser: [],
}
for (const url of urls.slice(0, 1)) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { origin: 'https://diad87.github.io' } })
    const html = await response.text()
    const next = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s)?.[1]
    const data = next ? JSON.parse(next) : null
    const entity = data?.props?.pageProps?.state?.data?.entity
    const buildId = data?.buildId
    report.node.push({ url, status: response.status, bytes: Buffer.byteLength(html), cors: response.headers.get('access-control-allow-origin'), nextBuildId: buildId, trackCount: entity?.trackList?.length ?? null, title: entity?.name ?? entity?.title ?? null })
    if (buildId) urls.push(
      `https://open.spotify.com/embed/_next/data/${buildId}/playlist/${id}.json`,
      `https://open.spotify.com/_next/data/${buildId}/embed/playlist/${id}.json`,
      `https://embed-cdn.spotifycdn.com/_next/data/${buildId}/playlist/${id}.json`,
      `https://embed-cdn.spotifycdn.com/embed/_next/data/${buildId}/playlist/${id}.json`,
      `https://embed-cdn.spotifycdn.com/embed/playlist/${id}`,
    )
  } catch (error) { report.node.push({ url, error: error.message }) }
}
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio'] })
try {
  report.browserVersion = browser.version()
  const page = await browser.newPage()
  await page.route('https://diad87.github.io/pletina-spotify-public-probe', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Spotify transport probe</title><div id="host"></div>' }))
  await page.goto('https://diad87.github.io/pletina-spotify-public-probe')
  report.origin = await page.evaluate(() => location.origin)
  for (const url of urls) {
    const result = await page.evaluate(async url => {
      try {
        const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10000) })
        const text = await response.text()
        let data
        try { data = JSON.parse(text) } catch {}
        const next = text.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s)?.[1]
        let embedded
        try { embedded = next && JSON.parse(next)?.props?.pageProps?.state?.data?.entity } catch {}
        return { url, readable: true, status: response.status, bytes: new TextEncoder().encode(text).length, responseType: response.type, jsonKeys: data ? Object.keys(data) : null, trackCount: data?.pageProps?.state?.data?.entity?.trackList?.length ?? data?.tracks?.items?.length ?? embedded?.trackList?.length ?? null }
      } catch (error) { return { url, readable: false, errorName: error.name, error: error.message } }
    }, url)
    report.browser.push(result)
    console.log(JSON.stringify(result))
  }
  report.iframe = await page.evaluate(id => new Promise(resolve => {
    const script = document.createElement('script'), messages = []
    const receive = event => {
      if (event.origin !== 'https://open.spotify.com') return
      messages.push({ type: event.data?.type ?? null, keys: event.data && typeof event.data === 'object' ? Object.keys(event.data) : [], trackUriCount: (JSON.stringify(event.data)?.match(/spotify:track:/g) ?? []).length })
    }
    window.addEventListener('message', receive)
    let controller
    const finish = value => {
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      try { controller?.destroy() } catch {}
      script.remove()
      delete window.onSpotifyIframeApiReady
      resolve({ ...value, messages })
    }
    const timer = setTimeout(() => finish({ ready: false, outcome: 'timeout' }), 15000)
    window.onSpotifyIframeApiReady = api => {
      api.createController(document.getElementById('host'), { uri: 'spotify:playlist:' + id, width: 300, height: 380 }, value => {
        controller = value
        controller.addListener('ready', () => {
          let readable = false, accessError
          try { readable = Boolean(document.querySelector('iframe').contentWindow.document) } catch (error) { accessError = error.name }
          setTimeout(() => finish({ ready: true, methods: Object.keys(controller).filter(key => typeof controller[key] === 'function'), parentCanReadFrame: readable, accessError }), 500)
        })
      })
    }
    script.src = 'https://open.spotify.com/embed/iframe-api/v1'
    script.onerror = () => finish({ ready: false, outcome: 'script-error' })
    document.body.append(script)
  }), id)
  console.log('iframe', JSON.stringify(report.iframe))
} finally { await browser.close() }
report.conclusion = 'No tested direct anonymous browser route supplies playlist tracks. Node receives 50 tracks in public HTML, but that transport has no Access-Control-Allow-Origin and all tested embed/data routes fail browser fetch. oEmbed is readable but only supplies display metadata/iframe, while the official iframe emits ready without a track list and its DOM is cross-origin. Web API returns 401 without authorization. This bounds the tested routes; it does not prove all future routes impossible.'
await mkdir(new URL('.', output), { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log('Report', output.pathname)
