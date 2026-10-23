// Bounded discovery of Badok's public search/player, no song IDs or MP3 URLs prefixed.
// Node only drives a clean browser. Cross-origin PWA evidence and same-origin
// provider UI controls are reported separately; the latter is not a PWA solution.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import puppeteer from 'puppeteer-core'

const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const title = option('--title', 'Olentzero'), artist = option('--artist', 'Izaro')
const reportName = option('--report', 'badok-public-discovery-2026-10-23.json')
if (!/^[a-z0-9.-]+\.json$/i.test(reportName)) throw new Error('Unsafe report name')
const report = { testedAt: new Date().toISOString(), input: { title, artist }, scope: 'Generic title/artist search with normal Pages/opaque CORS, plus a separate public-provider UI control. No curated song ID/audio URL.',
  policy: { productChanged: false, published: false, proxyUsed: false, credentialsUsed: false, signedUrlsPersisted: false, mediaPersisted: false, browserSecurityOverrides: false, observerUserGesture: false,
    phoneBackgroundClaimed: false, sameOriginProviderControlNotPresentedAsPwa: true }, pwaTransport: [], providerSearch: [], providerUi: null, network: [], errors: [] }
const scrub = value => String(value?.message ?? value).replace(/(?:https?|blob):[^\s"'<>]+/g, '[URL]').slice(0, 350)
let browser, pwa, provider
try {
  browser = await puppeteer.launch({ executablePath: 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe', headless: true,
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [] })
  const call = async (page, fn, value = null) => {
    const context = page.mainFrame().mainRealm().context
    const result = await page.mainFrame().client.send('Runtime.callFunctionOn', { executionContextId: context.id, functionDeclaration: fn.toString(), arguments: [{ value }], returnByValue: true, awaitPromise: true, userGesture: false })
    if (result.exceptionDetails) throw new Error(scrub(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
    return result.result.value
  }
  pwa = await browser.newPage()
  const client = pwa.mainFrame().client, requests = new Map()
  await client.send('Network.enable')
  client.on('Network.requestWillBeSent', event => { const url = new URL(event.request.url); if (url.hostname.endsWith('badok.eus')) requests.set(event.requestId, { host: url.hostname, path: url.pathname }) })
  client.on('Network.loadingFailed', event => { const request = requests.get(event.requestId); if (request) report.network.push({ scope: 'pwa', ...request, errorText: event.errorText, corsErrorStatus: event.corsErrorStatus ?? null }) })
  await pwa.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 45000 })
  report.pwaTransport = await call(pwa, async title => {
    const urls = [
      { kind: 'public-search-json', url: 'https://www.badok.eus/wp-content/plugins/badok/server_processing.php?menu=' + encodeURIComponent(title) },
      { kind: 'public-search-html', url: 'https://www.badok.eus/bilatzaile?search=' + encodeURIComponent(title) },
      { kind: 'standard-wp-rest-index', url: 'https://www.badok.eus/wp-json/' },
    ]
    const probe = async url => {
      try {
        const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10000) })
        if (!response.ok) { await response.body?.cancel(); return { readable: true, status: response.status, ok: false } }
        const text = await response.text()
        let value; try { value = JSON.parse(text) } catch {}
        return { readable: true, status: response.status, contentType: response.headers.get('content-type'), bytes: text.length, jsonKeys: value && typeof value === 'object' ? Object.keys(value).slice(0, 15) : null }
      } catch (error) { return { readable: false, error: error.name, message: error.message } }
    }
    const results = []
    for (const item of urls) results.push({ kind: item.kind, origin: location.origin, ...await probe(item.url) })
    const opaque = await new Promise(resolve => {
      const frame = document.createElement('iframe'), id = crypto.randomUUID()
      frame.sandbox = 'allow-scripts'; frame.hidden = true
      const finish = result => { clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); resolve(result) }
      const receive = event => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.id === id) finish(event.data.result) }
      const timer = setTimeout(() => finish({ readable: false, error: 'timeout' }), 13000)
      window.addEventListener('message', receive)
      frame.srcdoc = '<script>(' + (async config => { const probe = Function('return (' + config.probe + ')')(); parent.postMessage({ id: config.id, result: await probe(config.url) }, '*') }).toString() + ')(' + JSON.stringify({ url: urls[0].url, id, probe: probe.toString() }).replaceAll('<', '\\u003c') + ')<' + '/script>'
      document.body.append(frame)
    })
    results.push({ kind: 'public-search-json', origin: 'opaque-null', ...opaque })
    // Conventional callback support is checked as a public JSONP transport;
    // raw JSON or an uncalled callback is not treated as usable JSONP.
    const jsonp = await new Promise(resolve => {
      const callback = 'badokProbe_' + crypto.randomUUID().replaceAll('-', ''), script = document.createElement('script')
      const finish = result => { clearTimeout(timer); delete window[callback]; script.remove(); resolve(result) }
      window[callback] = value => finish({ callbackCalled: true, hasSongs: Array.isArray(value?.abestiak) })
      const timer = setTimeout(() => finish({ callbackCalled: false, reason: 'timeout-without-callback' }), 5000)
      script.onerror = () => finish({ callbackCalled: false, reason: 'script-error' })
      script.src = urls[0].url + '&callback=' + callback; document.head.append(script)
    })
    results.push({ kind: 'public-search-jsonp', origin: location.origin, ...jsonp })
    return results
  }, title)
  provider = await browser.newPage()
  const mediaAddresses = [] // RAM only. Never emit request URLs, nonces or tokens.
  provider.on('response', response => {
    const url = new URL(response.url()), kind = response.request().resourceType(), mime = response.headers()['content-type'] ?? ''
    if ((kind === 'xhr' || kind === 'fetch' || kind === 'media') && url.hostname.endsWith('badok.eus')) report.network.push({ scope: 'provider-control', host: url.hostname, path: url.pathname, parameterNames: [...url.searchParams.keys()], status: response.status(), kind, mime })
    if (kind === 'media' || /^audio\//.test(mime)) mediaAddresses.push(response.url())
  })
  await provider.goto('https://www.badok.eus/', { waitUntil: 'domcontentloaded', timeout: 45000 })
  for (const query of [title, 'Epoitaitaye']) {
    const result = await call(provider, async query => {
      const response = await fetch('/wp-content/plugins/badok/server_processing.php?menu=' + encodeURIComponent(query), { credentials: 'omit', signal: AbortSignal.timeout(10000) })
      const value = await response.json()
      return { query, origin: location.origin, httpStatus: response.status, songs: value.abestiak ?? [], songCount: value.abestiak_count, albums: value.diskoak ?? [] }
    }, query)
    report.providerSearch.push(result)
  }
  const selected = report.providerSearch[0]?.songs.find(song => song.izena.toLowerCase() === `${title} (${artist})`.toLowerCase())
  if (!selected) throw new Error('No exact title/artist provider result found in the bounded public search')
  report.selected = selected
  await provider.goto(selected.url, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await new Promise(resolve => setTimeout(resolve, 1500))
  const before = await call(provider, ({ title, artist }) => {
    const link = [...document.querySelectorAll('a.atwill[data-mp3="mp3"]')].find(link => link.dataset.izena.toLowerCase() === title.toLowerCase() && link.dataset.artist.toLowerCase() === artist.toLowerCase())
    if (!link) return { matchingMp3Control: false }
    link.scrollIntoView({ block: 'center', behavior: 'instant' })
    const rect = link.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2, hit = document.elementFromPoint(x, y)
    return { matchingMp3Control: true, discoveredTrackId: link.dataset.tid, title: link.dataset.izena, artist: link.dataset.artist,
      playerObjectPresent: typeof window.bplayer !== 'undefined' && window.bplayer !== null, jQueryPresent: typeof window.jQuery === 'function',
      mediaElements: document.querySelectorAll('audio,video').length, point: { x, y, unobstructed: hit === link || link.contains(hit) } }
  }, { title, artist })
  report.providerUi = { before, trustedSongClicks: 0 }
  if (before.point?.unobstructed) {
    await provider.mouse.click(before.point.x, before.point.y); report.providerUi.trustedSongClicks++
    await new Promise(resolve => setTimeout(resolve, 5500))
    report.providerUi.after = await call(provider, () => ({
      hash: location.hash, playerObjectPresent: typeof window.bplayer !== 'undefined' && window.bplayer !== null,
      media: [...document.querySelectorAll('audio,video')].map(audio => ({ tag: audio.tagName, srcPresent: !!audio.currentSrc, time: audio.currentTime, paused: audio.paused, error: audio.error?.code ?? null })),
    }))
  }
  report.providerUi.mediaAddressesObserved = mediaAddresses.length
  report.providerUi.audioIdentityOrBackgroundClaimed = false
  if (mediaAddresses.length) report.followup = 'A provider-control media address exists only in RAM. No PWA automatic discovery, catalog identity comparison or hidden/background claim is made by this transport probe.'
} catch (error) { report.errors.push(scrub(error)) }
finally { await browser?.close() }
report.scriptSha256 = createHash('sha256').update(await readFile(new URL('badok-public-discovery.browser.mjs', import.meta.url))).digest('hex')
report.conclusion = { pwaSearchReadable: report.pwaTransport.some(result => result.kind === 'public-search-json' && result.readable && result.status === 200), jsonpCallbackWorked: report.pwaTransport.some(result => result.callbackCalled),
  publicProviderSongSelectionAvailable: !!report.providerUi?.before?.matchingMp3Control, providerMediaObserved: (report.providerUi?.mediaAddressesObserved ?? 0) > 0,
  genericPwaFullAudioVerified: false }
const directory = new URL('../../artifacts/pwa-port/', import.meta.url)
await mkdir(directory, { recursive: true })
await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (report.errors.length) process.exitCode = 1
