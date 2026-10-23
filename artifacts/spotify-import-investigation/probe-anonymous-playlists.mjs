import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const report = { testedAt: new Date().toISOString(), browserVersion: browser.version(), origin: 'https://diad87.github.io', server: false, login: false, tokensPersisted: false, probes: [] }
try {
  const page = await browser.newPage()
  await page.route('https://diad87.github.io/pletina-spotify-anonymous-playlists', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Anonymous playlist transport</title>' }))
  await page.goto('https://diad87.github.io/pletina-spotify-anonymous-playlists')
  report.probes = await page.evaluate(async () => {
    const tokenResponse = await fetch('https://open.spotify.com/embed/api/token', { credentials: 'omit', signal: AbortSignal.timeout(12000) })
    const session = await tokenResponse.json()
    if (!tokenResponse.ok || session.isAnonymous !== true || !session.accessToken) throw new Error('No anonymous token')
    const probes = []
    for (const id of ['3cEYpjA9oz9GiPac4AsH4n', '37i9dQZF1DXcBWIGoYBM5M']) {
      const variables = { uri: `spotify:playlist:${id}`, limit: 30, offset: 0, includeItemV3: false }
      const extensions = { persistedQuery: { version: 1, sha256Hash: 'c685ca91fb0019c87ff1225f84e1d85b26cd631fa6187f3f0900da182cb0953d' } }
      const paths = [
        `https://spclient.wg.spotify.com/playlist/v2/playlist/${id}?decorate=revision,attributes,length,contents`,
        `https://api-partner.spotify.com/pathfinder/v1/query?${new URLSearchParams({ operationName: 'queryPlaylist', variables: JSON.stringify(variables), extensions: JSON.stringify(extensions) })}`,
        `https://api.spotify.com/v1/playlists/${id}/tracks?limit=10`,
      ]
      for (const url of paths) {
        try {
          const response = await fetch(url, { credentials: 'omit', headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) })
          const text = await response.text()
          let data; try { data = JSON.parse(text) } catch {}
          const playlist = data?.data?.playlistV2
          probes.push({ id, endpoint: new URL(url).origin + new URL(url).pathname, status: response.status, type: response.headers.get('content-type'), bytes: text.length, keys: Object.keys(data || {}), playlistKeys: Object.keys(playlist || {}), contentsKeys: Object.keys(data?.contents || {}), itemCount: playlist?.content?.items?.length ?? data?.contents?.items?.length ?? data?.items?.length ?? null, total: playlist?.content?.totalCount ?? data?.length ?? data?.total ?? null, name: playlist?.name ?? data?.attributes?.name ?? null, firstItem: playlist?.content?.items?.[0] ?? data?.contents?.items?.[0] ?? data?.items?.[0] ?? null, error: data?.errors ?? data?.error ?? null })
        } catch (error) { probes.push({ id, endpoint: new URL(url).origin + new URL(url).pathname, error: error.name, message: error.message }) }
      }
    }
    return probes
  })
} finally { await browser.close() }
await writeFile(new URL('./anonymous-playlists-browser.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
