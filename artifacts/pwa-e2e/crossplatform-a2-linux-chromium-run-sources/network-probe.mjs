// Diagnostic: concurrent opaque JSONP frames must all receive controlled responses.
import { createProviderFixtures } from './provider-fixtures.mjs'
process.env.PLAYWRIGHT_BROWSERS_PATH = 'D:/tmp/pletina-e2e-browsers'
const { chromium, webkit, firefox } = await import(process.argv[2] || 'playwright')
for (const [name, engine] of Object.entries({ chromium, webkit, firefox })) {
  let browser
  try {
    browser = await engine.launch({ headless: true, ...(name === 'chromium' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}) })
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const fixture = await createProviderFixtures(context, { baseURL: 'https://example.test/' })
    const seen = []
    context.on('request', request => { if (request.url().includes('deezer')) seen.push(new URL(request.url()).pathname) })
    const page = await context.newPage()
    await page.route('https://example.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body>Network diagnostic</body>' }))
    await page.goto('https://example.test/')
    const result = await page.evaluate(async () => {
      const rows = []
      return await Promise.race([
        new Promise(resolve => {
          window.addEventListener('message', event => {
            if (!event.data?.kind) return
            rows.push(event.data)
            if (rows.length === 3) resolve(rows)
          })
          for (const kind of ['artist', 'album', 'track']) {
            const frame = document.createElement('iframe')
            frame.sandbox = 'allow-scripts'
            frame.srcdoc = '<script>function callback(value){ parent.postMessage({kind:' + JSON.stringify(kind) +
              ',count:value.data?.length,first:value.data?.[0]?.title||value.data?.[0]?.name},"*")};<' + '/script><script src="https://api.deezer.com/search/' +
              kind + '?q=QA%20Media&amp;output=jsonp&amp;callback=callback"><' + '/script>'
            document.body.append(frame)
          }
        }),
        new Promise(resolve => setTimeout(() => resolve({ timeout: true, rows }), 12000)),
      ])
    })
    console.log(JSON.stringify({ name, result, seen, counts: fixture.counts }))
  } catch (error) { console.log(JSON.stringify({ name, error: error.message })) }
  finally { await browser?.close() }
}
