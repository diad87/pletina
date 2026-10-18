// Real media transition QA. Desktop background evidence never proves phone lock-screen behavior.
// node scripts/tests/web-port-transition.browser.mjs --expected-build HASH
//   [--url https://diad87.github.io/pletina/] [--report transition-public.json]
//   [--puppeteer PACKAGE] [--chrome EXECUTABLE]
//   [--second-title 'Million Dollar Question']
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { createPwaServer } from '../preview-pwa.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const reportName = option('--report', 'transition-local.json')
const secondTitle = option('--second-title', 'Million Dollar Question')
assert.match(reportName, /^[a-z0-9-]+\.json$/i)
const require = createRequire(import.meta.url)
const puppeteer = require(option('--puppeteer', 'puppeteer'))
const directory = new URL('../../artifacts/pwa-port/', import.meta.url)
await mkdir(directory, { recursive: true })
const scrub = (value) => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 450)
const report = { testedAt: new Date().toISOString(), build: null, checks: [], errors: [], network: [],
  scope: 'Real Chrome desktop audio with a hidden tab; ending accelerated by seek. Physical lock screen and iOS remain unverified.',
  physicalScreenOffVerified: false, iOSPlaybackVerified: false, mediaMuted: false,
  outputSilencedByChromeLaunchArgument: true, seekToEndSeconds: 1.5,
}
let browser, page, background, server

// Instrument instance methods and the application's ended listener. The wrapper
// encloses exactly the synchronous listener call; async continuations have depth 0.
// Media URLs and request/response bodies are never copied into logs.
function instrumentTransition() {
  const instances = [], events = [], preparedIds = new Set()
  let sequence = 0, endedSequence = 0, endedDepth = 0, endedId = null, qaReading = false
  const title = () => navigator.mediaSession?.metadata?.title ?? null
  const log = (type, details = {}) => {
    const event = { seq: ++sequence, at: Date.now(), performanceMs: Number(performance.now().toFixed(3)),
      type, title: title(), hidden: document.hidden, endedDepth, endedId, ...details }
    events.push(event)
    return event
  }
  const state = (audio, index) => ({ index, srcPresent: Boolean(audio.src || audio.currentSrc),
    currentTime: Number.isFinite(audio.currentTime) ? Number(audio.currentTime.toFixed(3)) : null,
    duration: Number.isFinite(audio.duration) ? Number(audio.duration.toFixed(3)) : null,
    paused: audio.paused, ended: audio.ended, muted: audio.muted, volume: audio.volume,
    readyState: audio.readyState, errorCode: audio.error?.code ?? null })
  const NativeAudio = window.Audio
  const source = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')
  let WrappedAudio
  WrappedAudio = new Proxy(NativeAudio, {
    construct(target, args, newTarget) {
      const audio = Reflect.construct(target, args, newTarget === WrappedAudio ? target : newTarget)
      const index = instances.push(audio) - 1
      const add = audio.addEventListener.bind(audio), remove = audio.removeEventListener.bind(audio)
      const endedListeners = new WeakMap()
      for (const type of ['loadstart', 'loadedmetadata', 'playing', 'pause', 'ended', 'error']) {
        add(type, () => log(`event:${type}`, state(audio, index)))
      }
      audio.addEventListener = (type, handler, options) => {
        if (type !== 'ended' || !handler) return add(type, handler, options)
        const wrapped = function(event) {
          const previous = endedId
          endedId = ++endedSequence; endedDepth++
          log('ended-handler-enter', { index })
          try { return typeof handler === 'function' ? handler.call(this, event) : handler.handleEvent(event) }
          finally { log('ended-handler-exit', { index }); endedDepth--; endedId = previous }
        }
        endedListeners.set(handler, wrapped)
        return add(type, wrapped, options)
      }
      audio.removeEventListener = (type, handler, options) => remove(type,
        type === 'ended' && handler ? endedListeners.get(handler) ?? handler : handler, options)
      for (const method of ['play', 'pause', 'load']) {
        const original = audio[method].bind(audio)
        audio[method] = (...args) => { log(`call:${method}`, state(audio, index)); return original(...args) }
      }
      const removeAttribute = audio.removeAttribute.bind(audio)
      audio.removeAttribute = (name) => {
        if (name.toLowerCase() === 'src') log('call:remove-src', state(audio, index))
        return removeAttribute(name)
      }
      Object.defineProperty(audio, 'src', { configurable: true, enumerable: source.enumerable,
        get: () => source.get.call(audio),
        set: (value) => {
          log('source-set', { index, nonempty: Boolean(value) })
          source.set.call(audio, value)
        },
      })
      return audio
    },
  })
  window.Audio = WrappedAudio
  for (const method of ['get', 'getAll', 'put', 'add', 'delete']) {
    const original = IDBObjectStore.prototype[method]
    IDBObjectStore.prototype[method] = function(...args) {
      const value = args[0]
      const trackId = typeof value === 'number' ? value : value && typeof value.trackId === 'number' ? value.trackId : null
      if (!qaReading) log(`idb:${method}`, { store: this.name, trackId })
      const request = original.apply(this, args)
      if (this.name === 'sources' && method === 'put' && trackId) {
        request.addEventListener('success', () => { preparedIds.add(trackId); log('source-choice-stored', { trackId }) })
      }
      return request
    }
  }
  const create = Document.prototype.createElement
  Document.prototype.createElement = function(name, ...args) {
    if (String(name).toLowerCase() === 'iframe') log('create:iframe')
    return create.call(this, name, ...args)
  }
  window.__transition = {
    instances, events, preparedIds,
    snapshot: () => ({ origin: location.origin, path: location.pathname,
      title: title(), artist: navigator.mediaSession?.metadata?.artist ?? null,
      mediaSessionState: navigator.mediaSession?.playbackState ?? null,
      instances: instances.map(state), events: events.slice(-350), hidden: document.hidden,
      online: navigator.onLine, sourceChoiceIds: [...preparedIds],
      headings: [...document.querySelectorAll('.view h1,.view h2')].map((element) => element.textContent.trim()).slice(0, 8) }),
    readIdentities: () => new Promise((resolve, reject) => {
      qaReading = true
      const request = indexedDB.open('pletina-web-library')
      request.onerror = () => { qaReading = false; reject(new Error('Cannot read test identities')) }
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['tracks', 'sources'])
        const tracks = tx.objectStore('tracks').getAll(), sources = tx.objectStore('sources').getAll()
        tx.oncomplete = () => {
          qaReading = false; db.close()
          resolve({ tracks: tracks.result.map((row) => ({ id: row.id, title: row.title, artist: row.artistName })),
            sources: sources.result.map((row) => ({ trackId: row.trackId, videoId: row.choice.videoId,
              title: row.choice.title, channel: row.choice.channel })) })
        }
        tx.onerror = () => { qaReading = false; db.close(); reject(new Error('Cannot read test identities')) }
      }
    }),
  }
}

async function check(name, action) {
  process.stdout.write(`${name} ... `)
  try { const result = await action(); report.checks.push({ name, pass: true, ...result }); process.stdout.write('passed\n'); return true }
  catch (error) { report.checks.push({ name, pass: false, error: scrub(error.message) }); process.stdout.write('FAILED\n'); return false }
}
async function wait(predicate, timeout = 60000, ...args) {
  await page.waitForFunction(predicate, { polling: 200, timeout }, ...args)
}
async function clickText(selector, text) {
  const handle = await page.evaluateHandle((selector, text) => [...document.querySelectorAll(selector)].find((item) => item.textContent.includes(text)), selector, text)
  assert.ok(handle.asElement(), `Action ${text}`)
  await handle.asElement().click(); await handle.dispose()
}

try {
  let url = option('--url', null)
  if (!url) {
    server = createPwaServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${server.address().port}/pletina/`
  } else assert.equal(new URL(url).protocol, 'https:', 'Public transition QA must use HTTPS')
  report.target = { origin: new URL(url).origin, basePath: new URL(url).pathname }
  browser = await puppeteer.launch({ headless: true, args: ['--mute-audio'],
    ...(option('--chrome', null) ? { executablePath: option('--chrome') } : {}) })
  report.browser = await browser.version()
  page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  await page.evaluateOnNewDocument(instrumentTransition)
  page.on('pageerror', (error) => report.errors.push({ name: error.name, message: scrub(error.message) }))
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.hostname.endsWith('.youtube.com') && /\/youtubei\/v1\/(search|player)$/.test(url.pathname)) {
      let publicVideoId = null
      try { const id = JSON.parse(request.postData() || '{}').videoId; if (/^[A-Za-z0-9_-]{11}$/.test(id)) publicVideoId = id } catch {}
      report.network.push({ type: 'request', at: Date.now(), host: url.hostname,
        endpoint: url.pathname.endsWith('/player') ? 'player' : 'search', videoId: publicVideoId })
    }
  })
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.hostname.endsWith('.youtube.com') && /\/youtubei\/v1\/(search|player)$/.test(url.pathname)) {
      report.network.push({ type: 'json-response', at: Date.now(), host: url.hostname,
        endpoint: url.pathname.endsWith('/player') ? 'player' : 'search', status: response.status() })
    }
    if (url.hostname.endsWith('.googlevideo.com')) report.network.push({ type: 'media-response', at: Date.now(),
      host: url.hostname, status: response.status(), contentType: response.headers()['content-type'] ?? null })
  })
  page.on('requestfailed', (request) => {
    const host = new URL(request.url()).hostname
    if (host.endsWith('.googlevideo.com') || host.endsWith('.youtube.com')) report.network.push({ type: 'failed', at: Date.now(), host, failure: scrub(request.failure()?.errorText) })
  })

  const started = await check('two catalog songs are selected through the UI; first song plays and second prepares', async () => {
    await page.goto(url, { waitUntil: 'load' })
    await wait(() => Boolean(navigator.serviceWorker.controller), 30000)
    report.build = await page.$eval('#version', (element) => element.textContent.trim())
    if (option('--expected-build', null)) assert.equal(report.build, option('--expected-build'))
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 45000 }), page.click('#open-player')])
    await page.waitForSelector('.sidebar', { timeout: 20000 })
    await page.type('input[aria-label="Buscar música"]', 'Radiohead Creep')
    await page.waitForSelector('.tracks li[data-reorder-index="2"] .name', { timeout: 45000 })
    report.searchSelections = await page.$$eval('.tracks li[data-reorder-index]', (elements, requested) => elements.map((item) => ({
      index: item.getAttribute('data-reorder-index'), title: item.querySelector('.name').textContent.trim(),
    })).filter((item) => item.title === 'Creep' || item.title === requested), secondTitle)
    const firstSelection = report.searchSelections.find((item) => item.title === 'Creep')
    const secondSelection = report.searchSelections.find((item) => item.title === secondTitle)
    assert.ok(firstSelection && secondSelection, 'Both expected catalog songs are present')
    report.expectedTitles = ['Creep', secondTitle]
    // Likes are newest first: save the second selection before studio Creep.
    await page.click(`.tracks li[data-reorder-index="${secondSelection.index}"] button.heart`)
    await page.waitForSelector(`.tracks li[data-reorder-index="${secondSelection.index}"] button.heart.on`)
    await page.click('.tracks li[data-reorder-index="0"] button.heart')
    await page.waitForSelector('.tracks li[data-reorder-index="0"] button.heart.on')
    await clickText('.sidebar .item', 'Canciones que te gustan')
    await page.waitForSelector('.tracks li[data-reorder-index="1"] .name')
    const actual = await page.$$eval('.tracks li[data-reorder-index] .name', (elements) => elements.map((item) => item.textContent.trim()))
    assert.deepEqual(actual, report.expectedTitles, 'Exactly two songs; no third-song fallback can satisfy the test')
    report.identitiesBeforePlay = await page.evaluate(() => window.__transition.readIdentities())
    assert.equal(report.identitiesBeforePlay.tracks.length, 2)
    // The row center may be an artist/album link in this grid. Its number is
    // the explicit play target and does not trigger nested navigation.
    await page.click('.tracks li[data-reorder-index="0"] .row[role="button"] .num')
    await wait(() => window.__transition.instances.some((audio) => !audio.paused && audio.currentTime > 2), 90000)
    let state = await page.evaluate(() => window.__transition.snapshot())
    assert.equal(state.title, report.expectedTitles[0], 'Selected studio Creep must play')
    assert.equal(state.instances.length, 1)
    assert.equal(state.instances[0].muted, false)
    process.stdout.write('\nFirst song confirmed; waiting for second source preparation ... ')
    // Waiting for the provider/IDB to finish in foreground is part of this prepared-source test.
    const second = report.identitiesBeforePlay.tracks.find((track) => track.title === report.expectedTitles[1])
    assert.ok(second)
    report.secondCatalogId = second.id
    await wait((id) => window.__transition.preparedIds.has(id), 60000, second.id)
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 15000 })
    report.beforeTransition = await page.evaluate(() => window.__transition.snapshot())
    report.identitiesPrepared = await page.evaluate(() => window.__transition.readIdentities())
    return { titles: actual, identities: report.identitiesPrepared }
  })
  assert.ok(started, 'First song and prepared second are required')

  await check('real ended hands source 2 to the same Audio synchronously while hidden', async () => {
    // Seek in foreground, then hide before the real media element reaches ended.
    await page.evaluate(() => { const audio = window.__transition.instances[0]; audio.currentTime = audio.duration - 1.5 })
    background = await browser.newPage()
    await background.goto('about:blank'); await background.bringToFront()
    await wait(() => document.hidden, 5000)
    await wait((expected) => window.__transition.snapshot().title === expected &&
      window.__transition.instances.some((audio) => !audio.paused && audio.currentTime > 2 && audio.currentTime < 20), 90000, report.expectedTitles[1])
    const after = await page.evaluate(() => window.__transition.snapshot())
    report.afterTransition = after
    assert.equal(after.title, report.expectedTitles[1], 'Second track itself plays')
    assert.equal(after.instances.length, 1, 'One Audio across both songs')
    assert.equal(after.instances[0].muted, false)
    assert.equal(after.instances[0].errorCode, null)
    const entered = after.events.find((event) => event.type === 'ended-handler-enter' && event.hidden)
    assert.ok(entered, 'Application ended handler ran while hidden')
    const exited = after.events.find((event) => event.type === 'ended-handler-exit' && event.endedId === entered.endedId)
    const synchronous = after.events.filter((event) => event.seq > entered.seq && event.seq < exited.seq)
    const play = synchronous.find((event) => event.type === 'call:play' && event.title === report.expectedTitles[1])
    assert.ok(play && play.endedDepth > 0, 'Second play() must execute synchronously inside the original ended listener')
    const forbidden = synchronous.filter((event) => event.type === 'call:pause' || event.type === 'call:remove-src' ||
      event.type === 'call:load' && !event.srcPresent || event.type.startsWith('idb:') || event.type === 'create:iframe')
    assert.deepEqual(forbidden, [], 'No pause, empty unload, IDB or resolver frame before the synchronous handoff')
    const endedToSecondPlaying = after.events.filter((event) => event.seq > entered.seq)
    assert.ok(endedToSecondPlaying.some((event) => event.type === 'event:playing' && event.title === report.expectedTitles[1] && event.hidden))
    const newProviderRequests = report.network.filter((event) => event.type === 'request' && event.at >= entered.at)
    assert.deepEqual(newProviderRequests, [], 'Prepared second track starts without resolving YouTube again')
    return { endedHandlerId: entered.endedId, synchronousCalls: synchronous, providerRequestsAfterEnded: newProviderRequests }
  })
} catch (error) { report.fatal = scrub(error.message) }
finally {
  if (page && !page.isClosed()) {
    report.finalState = await page.evaluate(() => window.__transition.snapshot()).catch(() => null)
    await page.evaluate(() => window.__transition.instances.forEach((audio) => audio.pause())).catch(() => {})
  }
  report.finishedAt = new Date().toISOString()
  report.passed = !report.fatal && report.checks.every((check) => check.pass) && report.errors.length === 0
  try { await writeFile(new URL(reportName, directory), `${JSON.stringify(report, null, 2)}\n`) }
  finally {
    await Promise.allSettled([browser?.close(), server ? new Promise((resolve) => server.close(resolve)) : undefined])
  }
  process.stdout.write(`Report artifacts/pwa-port/${reportName}: ${report.passed ? 'PASS' : 'FAIL'}\n`)
  if (!report.passed) process.exitCode = 1
}
