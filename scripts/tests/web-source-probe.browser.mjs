// Direct browser capability probe. Does not publish or change the user's browser/profile.
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import ts from 'typescript'
const require = createRequire(import.meta.url)
const puppeteer = require('C:/Users/iunan/node_modules/puppeteer')
const source = ts.transpileModule(await readFile(new URL('../../web-port/youtube.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText
const browser = await puppeteer.launch({ headless: true, args: ['--mute-audio'], executablePath: 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe' })
const report = { testedAt: new Date().toISOString(), scope: 'Desktop Chrome HTTPS, opaque frame fetch; no mobile guarantee', checks: [] }
try {
  const page = await browser.newPage()
  await page.goto('https://example.org/', { waitUntil: 'load' })
  report.checks = await page.evaluate(async (moduleCode) => {
    const results = []
    const youtube = await import(URL.createObjectURL(new Blob([moduleCode], { type: 'text/javascript' })))
    async function probe(url, kind) {
      return new Promise((resolve) => {
        const frame = document.createElement('iframe'); frame.hidden = true; frame.sandbox = 'allow-scripts'
        const id = crypto.randomUUID()
        const timer = setTimeout(() => finish({ error: 'timeout' }), 25000)
        const receive = (event) => { if (event.source === frame.contentWindow && event.data?.id === id) finish(event.data.result) }
        const finish = (result) => { clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); resolve(result) }
        window.addEventListener('message', receive)
        const code = async ({ url, kind, id }) => {
          try {
            const response = await fetch(url, { credentials: 'omit', headers: kind === 'audio' ? { Range: 'bytes=0-65535' } : {} })
            let result = { status: response.status, type: response.type, contentType: response.headers.get('content-type') }
            if (kind === 'audio') result.bytes = (await response.arrayBuffer()).byteLength
            else {
              const html = await response.text()
              const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
              const entity = match ? JSON.parse(match[1])?.props?.pageProps?.state?.data?.entity : null
              result = { ...result, bytes: html.length, entityType: entity?.type ?? null, tracks: entity?.trackList?.length ?? null }
            }
            parent.postMessage({ id, result }, '*')
          } catch (error) { parent.postMessage({ id, result: { error: error.name } }, '*') }
        }
        frame.srcdoc = '<script>(' + code.toString() + ')(' + JSON.stringify({ url, kind, id }).replaceAll('<', '\\u003c') + ')<' + '/script>'
        document.body.append(frame)
      })
    }
    try { const stream = await youtube.stream('9RfVp-GhKfs'); results.push({ name: 'audio bytes in opaque frame', ...await probe(stream.url, 'audio') }) }
    catch (error) { results.push({ name: 'audio bytes in opaque frame', error: error.name }) }
    results.push({ name: 'Spotify public embed in opaque frame', ...await probe('https://open.spotify.com/embed/playlist/37i9dQZEVXbNFJfN1Vw8d9', 'html') })
    return results
  }, source)
} finally { await browser.close() }
const directory = new URL('../../artifacts/pwa-parity/', import.meta.url)
await mkdir(directory, { recursive: true })
await writeFile(new URL('direct-source-probe.json', directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
