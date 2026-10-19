// Public Spotify transport probes only. No login, user token, proxy, playback or publication.
// node scripts/tests/web-imports.browser.mjs --playwright packageOrPath --chrome executable
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { build } from 'vite'

const workspace = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const { chromium } = createRequire(import.meta.url)(option('--playwright', 'playwright'))
const playlistId = '37i9dQZF1DXcBWIGoYBM5M'
const report = {
  testedAt: new Date().toISOString(), browser: null, playlistId,
  origin: 'https://diad87.github.io', documentKind: 'QA HTML supplied by a local browser route at the HTTPS origin; no deployed files changed.',
  userLogin: false, userToken: false, proxy: false, spotifyPlaybackRequested: false, probes: [],
  officialReferences: [
    'https://developer.spotify.com/documentation/embeds/reference/oembed',
    'https://developer.spotify.com/documentation/embeds/references/iframe-api',
    'https://developer.spotify.com/documentation/web-api/reference/get-playlists-items',
  ],
}
let temporary, browser
try {
  temporary = await mkdtemp(join(tmpdir(), 'pletina-import-browser-'))
  await build({ configFile: false, root: workspace, logLevel: 'silent', build: {
    outDir: join(temporary, 'bundle'), emptyOutDir: true, minify: false,
    lib: { entry: join(workspace, 'web-port', 'imports.ts'), formats: ['iife'], name: 'PletinaImportQA', fileName: () => 'imports.js' },
  } })
  browser = await chromium.launch({ headless: true, args: ['--mute-audio'],
    ...(option('--chrome', null) ? { executablePath: option('--chrome') } : {}) })
  report.browser = browser.version()
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.route('https://diad87.github.io/pletina-import-qa', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><html><head><title>Spotify public import QA</title></head><body><div id="spotify-host"></div></body></html>' }))
  await page.goto('https://diad87.github.io/pletina-import-qa')
  await page.addScriptTag({ content: await readFile(join(temporary, 'bundle', 'imports.js'), 'utf8') })
  process.stdout.write('Actual import adapter from HTTPS origin ... ')
  report.probes.push(await page.evaluate(async (playlistId) => {
    try {
      const source = await PletinaImportQA.readSpotifyPlaylist('spotify:playlist:' + playlistId)
      return { name: 'product-adapter', readable: true, trackCount: source.tracks.length, warningCount: source.warnings.length }
    } catch (error) { return { name: 'product-adapter', readable: false, errorName: error.name, message: error.message } }
  }, playlistId))
  process.stdout.write('recorded\n')
  for (const [name, url] of [
    ['public-embed-fetch', `https://open.spotify.com/embed/playlist/${playlistId}`],
    ['oembed-iframe-url-fetch', `https://open.spotify.com/embed/playlist/${playlistId}?utm_source=oembed`],
    ['oembed-fetch', `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/playlist/${playlistId}`)}`],
    ['public-api-without-token', `https://api.spotify.com/v1/playlists/${playlistId}/items`],
  ]) {
    process.stdout.write(`${name} ... `)
    report.probes.push(await page.evaluate(async ({ name, url }) => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000)
      try {
        const response = await fetch(url, { credentials: 'omit', signal: controller.signal })
        const text = await response.text()
        let data
        try { data = JSON.parse(text) } catch { /* HTML is not a JSON metadata API. */ }
        return { name, readable: true, status: response.status, responseType: response.type,
          contentType: response.headers.get('content-type'), bytes: new TextEncoder().encode(text).length,
          jsonKeys: data && typeof data === 'object' ? Object.keys(data) : [],
          hasTrackList: Boolean(data?.trackList || data?.tracks?.items || data?.items),
          htmlHasNextData: text.includes('__NEXT_DATA__') }
      } catch (error) { return { name, readable: false, errorName: error.name } }
      finally { clearTimeout(timer) }
    }, { name, url }))
    process.stdout.write('recorded\n')
  }
  process.stdout.write('oEmbed JSONP callback ... ')
  report.probes.push(await page.evaluate((playlistId) => new Promise(resolve => {
    const script = document.createElement('script')
    const onError = event => { event.preventDefault() }
    window.addEventListener('error', onError)
    const finish = value => {
      clearTimeout(timer); script.remove(); delete window.qaSpotifyOembed
      window.removeEventListener('error', onError); resolve({ name: 'oembed-jsonp', ...value })
    }
    const timer = setTimeout(() => finish({ callbackCalled: false, outcome: 'timeout' }), 10000)
    window.qaSpotifyOembed = data => finish({ callbackCalled: true, jsonKeys: Object.keys(data), hasTrackList: Boolean(data?.trackList || data?.tracks?.items || data?.items) })
    script.onload = () => finish({ callbackCalled: false, outcome: 'script-loaded-without-callback' })
    script.onerror = () => finish({ callbackCalled: false, outcome: 'script-error' })
    script.src = 'https://open.spotify.com/oembed?url=' + encodeURIComponent('https://open.spotify.com/playlist/' + playlistId) + '&callback=qaSpotifyOembed'
    document.body.append(script)
  }), playlistId))
  process.stdout.write('recorded\n')
  process.stdout.write('Official iframe API without playback ... ')
  report.probes.push(await page.evaluate((playlistId) => new Promise(resolve => {
    const script = document.createElement('script'), messages = []
    const receive = event => {
      if (event.origin !== 'https://open.spotify.com' || !event.data || typeof event.data !== 'object') return
      messages.push({ keys: Object.keys(event.data), type: typeof event.data.type === 'string' ? event.data.type.slice(0, 100) : null })
    }
    window.addEventListener('message', receive)
    const finish = value => {
      clearTimeout(timer); window.removeEventListener('message', receive); script.remove()
      delete window.onSpotifyIframeApiReady; resolve({ name: 'official-iframe-api', ...value, publicMessageShapes: messages.slice(0, 20) })
    }
    const timer = setTimeout(() => finish({ ready: false, outcome: 'timeout' }), 15000)
    window.onSpotifyIframeApiReady = api => {
      try {
        api.createController(document.getElementById('spotify-host'), { uri: 'spotify:playlist:' + playlistId, width: 300, height: 380 }, controller => {
          controller.addListener('ready', () => {
            const methods = Object.keys(controller).filter(key => typeof controller[key] === 'function')
            let parentCanReadFrame = false, accessError = null
            try { parentCanReadFrame = Boolean(document.querySelector('iframe')?.contentWindow.document) }
            catch (error) { accessError = error.name }
            controller.destroy()
            finish({ ready: true, methods, parentCanReadFrame, accessError,
              documentedPlaylistExportMethod: false, note: 'Official documented controls/events do not expose a playlist track list.' })
          })
        })
      } catch (error) { finish({ ready: false, outcome: error.name }) }
    }
    script.onerror = () => finish({ ready: false, outcome: 'script-error' })
    script.src = 'https://open.spotify.com/embed/iframe-api/v1'
    document.body.append(script)
  }), playlistId))
  process.stdout.write('recorded\n')
  report.csvSmoke = await page.evaluate(() => {
    const source = PletinaImportQA.readPlaylistCsv('Title,Artist\nOne,Band\nOne,Band', 'Importada.csv')
    return { count: source.tracks.length, name: source.name, duplicatesPreserved: source.tracks[0].title === source.tracks[1].title }
  })
  report.actualPublicPlaylistImported = report.probes[0].readable === true && report.probes[0].trackCount > 0
  report.conclusion = report.actualPublicPlaylistImported
    ? 'The actual direct public playlist adapter read tracks in this browser run.'
    : 'No tested direct browser path supplied an importable playlist track list. CSV works; URL import is not feature-equivalent to the APK in this run.'
} catch (error) { report.fatal = error.message.replace(/https?:\/\/[^\s"']+/g, '[URL]').slice(0, 600) }
finally {
  await browser?.close().catch(() => {})
  if (temporary) {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
    assert.match(basename(temporary), /^pletina-import-browser-/)
    await rm(temporary, { recursive: true, force: true }); report.temporaryBundleRemoved = true
  }
  report.finishedAt = new Date().toISOString()
  await mkdir(join(workspace, 'artifacts', 'pwa-port'), { recursive: true })
  await writeFile(join(workspace, 'artifacts', 'pwa-port', 'imports-browser.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('Report: artifacts/pwa-port/imports-browser.json')
  if (report.fatal) process.exitCode = 1
}
