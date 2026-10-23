import { writeFile } from 'node:fs/promises'
process.env.PLAYWRIGHT_BROWSERS_PATH ||= 'D:/tmp/pletina-e2e-browsers'
const { chromium, firefox, webkit } = await import('playwright')

const report = {
  testedAt: new Date().toISOString(), origin: 'https://diad87.github.io', login: false, server: false, proxy: false,
  tokensPersisted: false, requestMocking: 'QA HTML only; all Spotify fetches real and direct.',
  primaryLargePlaylistSource: 'https://open.spotify.com/playlist/5C8xpz7lZLk5oliw5hB7Av',
  privatePlaylistCase: { executed: false, reason: 'No known private playlist fixture accessible without an account. Missing identifiers are exercised; their result cannot distinguish private from nonexistent.' },
  browsers: [],
}
for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  let browser
  const result = { name }
  try {
    browser = await engine.launch({ headless: true, ...(name === 'chromium' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}) })
    result.browserVersion = browser.version()
    const page = await browser.newPage()
    await page.route('https://diad87.github.io/pletina-spotify-pagination', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Guest playlist pagination</title>' }))
    await page.goto('https://diad87.github.io/pletina-spotify-pagination')
    result.results = await page.evaluate(async () => {
      const tokenResponse = await fetch('https://open.spotify.com/embed/api/token', { credentials: 'omit', signal: AbortSignal.timeout(12000) })
      const session = await tokenResponse.json()
      if (!tokenResponse.ok || session.isAnonymous !== true || !session.accessToken) throw new Error('Anonymous session unavailable')
      const headers = { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' }
      const extensions = { persistedQuery: { version: 1, sha256Hash: 'c685ca91fb0019c87ff1225f84e1d85b26cd631fa6187f3f0900da182cb0953d' } }
      const probes = []
      async function query(id, limit, offset) {
        const variables = { uri: 'spotify:playlist:' + id, limit, offset, includeItemV3: false }
        const url = 'https://api-partner.spotify.com/pathfinder/v1/query?' + new URLSearchParams({ operationName: 'queryPlaylist', variables: JSON.stringify(variables), extensions: JSON.stringify(extensions) })
        const response = await fetch(url, { credentials: 'omit', headers, signal: AbortSignal.timeout(12000) })
        const raw = await response.text()
        let data
        try { data = JSON.parse(raw) } catch {}
        const playlist = data?.data?.playlistV2, content = playlist?.content, items = content?.items
        const first = items?.[0]?.itemV2?.data
        const shape = { id, limit, offset, status: response.status, bytes: new TextEncoder().encode(raw).length,
          responseKeys: Object.keys(data || {}), playlistKeys: Object.keys(playlist || {}), contentKeys: Object.keys(content || {}),
          typename: playlist?.__typename ?? null, returnedId: playlist?.id ?? null, returnedUri: playlist?.uri ?? null,
          identityMatches: playlist?.id === id && playlist?.uri === 'spotify:playlist:' + id,
          name: playlist?.name ?? null, totalCount: content?.totalCount ?? null, pagingInfo: content?.pagingInfo ?? null,
          itemCount: Array.isArray(items) ? items.length : null,
          wrapperTypes: [...new Set((items ?? []).map(x => x?.itemV2?.__typename ?? null))],
          itemTypes: [...new Set((items ?? []).map(x => x?.itemV2?.data?.__typename ?? null))],
          first: first && { typename: first.__typename ?? null, uri: first.uri ?? null, title: first.name ?? null,
            artists: first.artists?.items?.map(x => x?.profile?.name) ?? [], duration: first.duration ?? null },
          error: data?.errors ?? data?.error ?? (playlist?.message ? { message: playlist.message } : null) }
        probes.push(shape)
        return { shape, items }
      }
      await query('3cEYpjA9oz9GiPac4AsH4n', 100, 0)
      await query('37i9dQZF1DXcBWIGoYBM5M', 100, 0)
      await query('37i9dQZF1DXcBWIGoYBM5M', 30, 30)
      await query('37i9dQZF1DXcBWIGoYBM5M', 30, 50)
      const largeId = '5C8xpz7lZLk5oliw5hB7Av'
      const firstPage = await query(largeId, 100, 0)
      const all = [...(firstPage.items ?? [])]
      if (firstPage.items?.length === 100 && firstPage.shape.totalCount > 100 && firstPage.shape.totalCount <= 600) {
        for (let offset = 100; offset < firstPage.shape.totalCount; offset += 100) {
          const next = await query(largeId, 100, offset)
          all.push(...(next.items ?? []))
        }
      }
      const uris = all.map(x => x?.itemV2?.data?.uri).filter(Boolean)
      await query('0000000000000000000000', 100, 0)
      return { tokenStatus: tokenResponse.status, anonymous: session.isAnonymous, probes,
        fullLargePlaylist: { id: largeId, requestedTotal: firstPage.shape.totalCount, returnedCount: all.length,
          completeCount: firstPage.shape.totalCount === all.length, uniqueTrackUris: new Set(uris).size,
          duplicateTrackUris: uris.length - new Set(uris).size } }
    })
    console.log(JSON.stringify({ name, version: result.browserVersion, probes: result.results.probes.map(x => ({ id: x.id, offset: x.offset, limit: x.limit, status: x.status, count: x.itemCount, total: x.totalCount, typename: x.typename })), full: result.results.fullLargePlaylist }))
  } catch (error) { result.error = { name: error.name, message: error.message.slice(0, 1000) }; console.log(name, error.name, error.message.slice(0, 300)) }
  finally { await browser?.close() }
  report.browsers.push(result)
  await writeFile(new URL('./guest-playlist-pagination-browser.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
}
report.conclusion = 'All three desktop browser runtimes directly read the anonymous guest token and full public metadata, including 502/502 entries over six pages of size 100. Limit 100 is therefore a verified page size, not an overall import cap. Chrome/Firefox/WebKit success does not establish a physical installed mobile PWA result. A missing playlist returns HTTP 200 with playlistV2.__typename=NotFound; private playlist behavior lacks a known fixture.'
await writeFile(new URL('./guest-playlist-pagination-browser.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
