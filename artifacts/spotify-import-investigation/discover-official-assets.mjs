import { writeFile } from 'node:fs/promises'
const pages = [
  'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M',
  'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
]
const result = { testedAt: new Date().toISOString(), pages: [], assets: [] }
for (const url of pages) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) })
  const html = await r.text()
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)/g)].map(x => new URL(x[1], url).href)
  result.pages.push({ url, status: r.status, scripts })
  for (const source of scripts) {
    if (!/^https:\/\/(?:embed-cdn\.spotifycdn\.com|open\.scdn\.co|open\.spotifycdn\.com)\//.test(source)) continue
    if (result.assets.some(x => x.url === source)) continue
    const asset = await fetch(source, { signal: AbortSignal.timeout(10000) })
    const body = await asset.text()
    const terms = ['get_access_token', 'api/token', 'clienttoken', 'client_token', 'pathfinder', 'playlist/v2', 'playlist/v3', 'playlist/v4', 'api-partner', 'api-embed', 'server-time']
    const hits = []
    for (const term of terms) {
      let from = 0, at
      while ((at = body.indexOf(term, from)) !== -1 && hits.filter(x => x.term === term).length < 12) {
        hits.push({ term, context: body.slice(Math.max(0, at - 160), at + term.length + 160) })
        from = at + term.length
      }
    }
    if (hits.length) { result.assets.push({ url: source, status: asset.status, bytes: Buffer.byteLength(body), hits }); console.log(source, JSON.stringify(hits)) }
  }
}
await writeFile(new URL('./official-assets.json', import.meta.url), JSON.stringify(result, null, 2) + '\n')
