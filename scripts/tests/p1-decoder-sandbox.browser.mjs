// QA only: establish whether a packaged P1 transform can run off the UI thread
// inside an opaque, network-denied frame. No provider code or audio is fetched.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import puppeteer from 'puppeteer-core'

const source = await readFile(new URL(import.meta.url)), sha = value => createHash('sha256').update(value).digest('hex')
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), scriptSha256: sha(source), checks: [], errors: [],
  scope: 'Synthetic transform isolation in a normal desktop browser, no provider decoding or playback proof.',
  productChanged: false, browserPolicyOverrides: false, providerCodeExecuted: false, providerAudioRequested: false }
let browser
try {
  browser = await puppeteer.launch({ headless: true,
    executablePath: 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe', args: [] })
  const page = await browser.newPage(); report.browser = await browser.version()
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(async () => {
    const run = (script, timeout = 1500) => new Promise(resolve => {
      const frame = document.createElement('iframe'), id = crypto.randomUUID(), started = performance.now()
      frame.hidden = true; frame.sandbox = 'allow-scripts'
      const finish = result => { clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); resolve({ ...result, elapsedMs: Math.round(performance.now() - started) }) }
      const receive = event => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.id === id) finish(event.data.result) }
      const timer = setTimeout(() => finish({ error: 'parent-deadline' }), timeout + 2000)
      window.addEventListener('message', receive)
      const bridge = ({ id, script, timeout }) => {
        const source = `const send=postMessage.bind(globalThis);onmessage=async()=>{try{const result=await Function(${JSON.stringify(script)})();send({result})}catch(error){send({error:error.name})}};`
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
        let worker
        const finish = result => { clearTimeout(timer); worker?.terminate(); URL.revokeObjectURL(url); parent.postMessage({ id, result }, '*') }
        const timer = setTimeout(() => finish({ error: 'worker-deadline' }), timeout)
        try {
          worker = new Worker(url); worker.onmessage = event => finish(event.data)
          worker.onerror = event => { event.preventDefault(); finish({ error: 'worker-error' }) }
          worker.postMessage(null)
        } catch (error) { finish({ error: error.name }) }
      }
      frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; worker-src blob:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'"><script>(' + bridge.toString() + ')(' + JSON.stringify({ id, script, timeout }).replaceAll('<', '\\u003c') + ')<' + '/script>'
      document.body.append(frame)
    })
    return {
      pure: await run('return {sig:"sample".split("").reverse().join(""),n:"value-transformed",dom:typeof document};'),
      network: await run('try { await fetch("https://www.youtube.com/"); return "network-allowed" } catch(error) { return "network-denied" }'.replace('try { await', 'return (async()=>{try { await') + '})()'),
      storage: await run('try { indexedDB.open("pletina-web-library"); return "storage-allowed" } catch(error) { return error.name }'),
      loop: await run('while(true){}', 300),
      afterLoop: await run('return "responsive"'),
      framesRemaining: document.querySelectorAll('iframe').length,
    }
  })
  report.results = result
  const check = (name, pass) => { report.checks.push({ name, pass }); assert.ok(pass, name) }
  check('packaged transform runs in a worker with no DOM', result.pure.result?.sig === 'elpmas' && result.pure.result?.dom === 'undefined')
  check('CSP blocks worker network', result.network.result === 'network-denied')
  check('opaque worker cannot open application storage', result.storage.result === 'SecurityError')
  check('busy worker is terminated at its deadline', result.loop.error === 'worker-deadline' && result.loop.elapsedMs < 1800)
  check('UI remains responsive after termination', result.afterLoop.result === 'responsive')
  check('all sandbox frames removed', result.framesRemaining === 0)
} catch (error) { report.errors.push(String(error.message).replace(/https?:\S+/g, '[URL]')) }
finally { await browser?.close(); report.browsersClosed = true }
const directory = new URL('../../artifacts/pwa-port/', import.meta.url)
await mkdir(directory, { recursive: true })
await writeFile(new URL('p1-decoder-sandbox-2026-10-23.json', directory), JSON.stringify(report, null, 2) + '\n')
await writeFile(new URL('p1-decoder-sandbox-source-' + report.scriptSha256.slice(0, 16) + '.mjs', directory), source)
console.log(JSON.stringify({ checks: report.checks, errors: report.errors }))
if (report.errors.length) process.exitCode = 1
