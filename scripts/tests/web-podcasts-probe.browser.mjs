// Bounded provider feasibility probe in a normal HTTPS browser context.
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
const require = createRequire(import.meta.url)
const puppeteer = require(process.argv[2] || 'puppeteer')
const folder = new URL('../../artifacts/pwa-podcasts/', import.meta.url)
await mkdir(folder, { recursive: true })
const report = { testedAt: new Date().toISOString(), scope: 'Chrome desktop HTTPS and opaque-origin iframe; no proxy or disabled browser security', cases: [] }
let browser
try {
  browser = await puppeteer.launch({ headless: true, args: ['--mute-audio'], ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) })
  const page = await browser.newPage()
  await page.goto('https://example.org', { waitUntil: 'load' })
  report.parentOrigin = await page.evaluate(() => location.origin)
  await page.evaluate(() => {
    let sequence = 0
    window.probeJSONP = (url) => new Promise((resolve) => {
      const id = ++sequence, frame = document.createElement('iframe')
      frame.sandbox = 'allow-scripts'; frame.hidden = true
      const timer = setTimeout(() => done({ error: 'timeout' }), 15000)
      const done = (result) => { clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); resolve(result) }
      const receive = (event) => {
        if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.id === id) done(event.data)
      }
      window.addEventListener('message', receive)
      const target = new URL(url); target.searchParams.set('callback', '__podcastProbe')
      frame.srcdoc = '<script>window.__podcastProbe=(value)=>parent.postMessage({id:' + id + ',value},"*");const s=document.createElement("script");s.src=' + JSON.stringify(target.href).replaceAll('<','\\u003c') + ';s.onerror=()=>parent.postMessage({id:' + id + ',error:"script"},"*");document.head.append(s)<' + '/script>'
      document.body.append(frame)
    })
    window.probeFeed = async (url, opaque) => {
      const run = async (url) => {
        try {
          const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(12000) })
          const body = await response.text()
          return { status: response.status, type: response.type, readableLength: body.length, body, finalURL: response.url }
        } catch (error) { return { error: error.name } }
      }
      if (!opaque) return run(url)
      return new Promise((resolve) => {
        const id = ++sequence, frame = document.createElement('iframe')
        frame.sandbox = 'allow-scripts'; frame.hidden = true
        const timer = setTimeout(() => done({ error: 'timeout' }), 15000)
        const done = (result) => { clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); resolve(result) }
        const receive = (event) => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.id === id) done(event.data.value) }
        window.addEventListener('message', receive)
        frame.srcdoc = '<script>(' + run.toString() + ')(' + JSON.stringify(url).replaceAll('<','\\u003c') + ').then(value=>parent.postMessage({id:' + id + ',value},"*"))<' + '/script>'
        document.body.append(frame)
      })
    }
  })
  for (const query of ['Nadie sabe nada', 'The Daily', 'Radio Ambulante']) {
    process.stdout.write(`Apple ${query} ... `)
    const directory = await page.evaluate((query) => window.probeJSONP('https://itunes.apple.com/search?' + new URLSearchParams({ term: query, media:'podcast', entity:'podcast', country:'ES', limit:'5' })), query)
    const rows = directory.value?.results || []
    const first = rows.find((row) => row.feedUrl)
    const result = { query, directoryError: directory.error ?? null, count: rows.length,
      shows: rows.slice(0,3).map((row) => ({ id:row.collectionId, title:row.collectionName, author:row.artistName, feedUrl:row.feedUrl })) }
    if (first) {
      const lookup = await page.evaluate((id) => window.probeJSONP('https://itunes.apple.com/lookup?' + new URLSearchParams({ id:String(id), entity:'podcastEpisode', country:'ES', limit:'5' })), first.collectionId)
      result.lookupError = lookup.error ?? null
      result.lookup = (lookup.value?.results || []).map((row) => ({ kind:row.kind, wrapperType:row.wrapperType,
        id:row.trackId, title:row.trackName, releaseDate:row.releaseDate, durationMs:row.trackTimeMillis,
        hasDescription:Boolean(row.description || row.shortDescription), language:row.language ?? null,
        feedUrl:row.feedUrl, audioHost:row.episodeUrl ? new URL(row.episodeUrl).hostname : null,
        publicKeys:Object.keys(row).sort() }))
      for (const opaque of [false,true]) {
        const feed = await page.evaluate(({url,opaque}) => window.probeFeed(url,opaque), {url:first.feedUrl,opaque})
        const metadata = await page.evaluate((xml) => {
          if (!xml) return null
          const doc = new DOMParser().parseFromString(xml,'application/xml')
          const channel = doc.querySelector('channel')
          return { root:doc.documentElement.localName, title:channel?.querySelector('title')?.textContent,
            language:channel?.querySelector('language')?.textContent, items:doc.querySelectorAll('item').length,
            audioEnclosures:[...doc.querySelectorAll('enclosure')].filter(node=>(node.getAttribute('type')||'').startsWith('audio/')).length }
        }, feed.body)
        result[opaque?'opaqueRSS':'directRSS'] = {error:feed.error??null,status:feed.status,type:feed.type,
          readableLength:feed.readableLength, finalHost:feed.finalURL ? new URL(feed.finalURL).hostname:null, metadata}
      }
    }
    report.cases.push(result)
    process.stdout.write('done\n')
  }
} catch (error) { report.fatal = String(error.message).replace(/https?:\/\/[^\s]+/g,'[URL]') }
finally {
  await writeFile(new URL('provider-probe.json',folder),JSON.stringify(report,null,2)+'\n')
  await browser?.close()
}
