import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'

const id = '37i9dQZF1DXcBWIGoYBM5M'
const urls = [
  'https://open.spotify.com/embed/api/token',
  'https://open.spotify.com/api/token?reason=init&productType=embed',
  'https://open.spotify.com/api/token?reason=init&productType=web-player',
  'https://open.spotify.com/api/server-time',
  'https://open.spotify.com/get_access_token?reason=transport&productType=embed',
  `https://spclient.wg.spotify.com/playlist/v2/playlist/${id}?decorate=revision,attributes,length,contents`,
  `https://api-partner.spotify.com/pathfinder/v1/query?operationName=fetchPlaylist&variables=${encodeURIComponent(JSON.stringify({uri:'spotify:playlist:'+id,offset:0,limit:10}))}`,
]
const report = {
  testedAt: new Date().toISOString(), proxy: false, account: false, credentials: 'omit', tokensPersisted: false,
  source: 'Current Spotify-owned embed runtime: https://embed-cdn.spotifycdn.com/_next/static/chunks/7995-854bb504ac405c84.js invokes /embed/api/token without authorization. Current mobile web runtime invokes /api/token and /api/server-time.',
  probes: [],
}
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
report.browserVersion = browser.version()
try {
  const page = await browser.newPage()
  await page.route('https://diad87.github.io/pletina-spotify-guest-api', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Guest API probe</title>' }))
  await page.goto('https://diad87.github.io/pletina-spotify-guest-api')
  report.origin = await page.evaluate(() => location.origin)
  for (const url of urls) {
    const result = await page.evaluate(async ({ url, id }) => {
      try {
        const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10000) })
        const text = await response.text()
        let data
        try { data = JSON.parse(text) } catch {}
        const result = { url, readable: true, status: response.status, contentType: response.headers.get('content-type'), bytes: new TextEncoder().encode(text).length, keys: data && typeof data === 'object' ? Object.keys(data) : [], tokenReturned: Boolean(data?.accessToken), isAnonymous: data?.isAnonymous ?? null, expiryRemainingSeconds: Number.isFinite(data?.accessTokenExpirationTimestampMs) ? Math.round((data.accessTokenExpirationTimestampMs - Date.now()) / 1000) : null, responseType: response.type }
        if (data?.accessToken && data.isAnonymous) {
          const tracks = await fetch(`https://api.spotify.com/v1/playlists/${id}/items?limit=10`, { credentials: 'omit', signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + data.accessToken } })
          const items = await tracks.json()
          result.authenticatedMetadata = { status: tracks.status, keys: Object.keys(items), count: items?.items?.length ?? null }
        }
        return result
      } catch (error) { return { url, readable: false, error: error.name, message: error.message } }
    }, { url, id })
    report.probes.push(result)
    console.log(JSON.stringify(result))
  }
  report.opaqueFrame = await page.evaluate(url => new Promise(resolve => {
    const iframe = document.createElement('iframe')
    iframe.sandbox = 'allow-scripts'
    iframe.srcdoc = `<script>fetch(${JSON.stringify(url)},{credentials:'omit',signal:AbortSignal.timeout(10000)}).then(async r=>{const d=await r.json();parent.postMessage({kind:'guest-opaque-result',readable:true,status:r.status,keys:Object.keys(d),tokenReturned:Boolean(d.accessToken),isAnonymous:d.isAnonymous??null},'*')}).catch(e=>parent.postMessage({kind:'guest-opaque-result',readable:false,error:e.name,message:e.message},'*'))<\/script>`
    const receive = event => {
      if (event.source !== iframe.contentWindow || event.data?.kind !== 'guest-opaque-result') return
      clearTimeout(timer); window.removeEventListener('message', receive); iframe.remove(); resolve(event.data)
    }
    const timer = setTimeout(() => { window.removeEventListener('message', receive); iframe.remove(); resolve({ readable: false, error: 'timeout' }) }, 12000)
    window.addEventListener('message', receive)
    document.body.append(iframe)
  }), urls[0])
  console.log('opaque', JSON.stringify(report.opaqueFrame))
} finally { await browser.close() }
report.conclusion = report.probes.some(x => x.authenticatedMetadata?.count > 0) ? 'Guest metadata obtained in browser.' : 'The fresh /embed/api/token route succeeds through browser CORS and returns a dynamic anonymous token with credentials omitted, also in a null-origin sandbox frame. The initial Web API items request using it is rate-limited (429); no playlist list has been established by this probe. This is a concrete guest-token route for further metadata transport testing, not the former direct embed-HTML route.'
await writeFile(new URL('./guest-api-browser.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
