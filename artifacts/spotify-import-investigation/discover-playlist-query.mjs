import { writeFile } from 'node:fs/promises'
const urls = [
  'https://embed-cdn.spotifycdn.com/_next/static/chunks/7995-854bb504ac405c84.js',
  'https://embed-cdn.spotifycdn.com/_next/static/chunks/pages/playlist/%5Bid%5D-a1a2d48d360eca87.js',
  'https://embed-cdn.spotifycdn.com/_next/static/chunks/pages/_app-3b6e117a14a04830.js',
  'https://open.spotifycdn.com/cdn/build/mobile-web-player/mobile-web-player.cac367b7.js',
]
const results = []
for (const url of urls) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) }), body = await r.text(), hits = []
  for (const term of ['fetchPlaylist', 'queryPlaylist', 'getPlaylist', 'playlistV2', 'query Playlist', 'Playlist(', 'playlistV3', 'playlist/v2', 'queryEmbedPlaylist', 'fetchPlaylistContents']) {
    let from = 0, at
    while ((at = body.indexOf(term, from)) !== -1 && hits.filter(x => x.term === term).length < 20) {
      hits.push({ term, at, context: body.slice(Math.max(0, at - 350), at + term.length + 550) }); from = at + term.length
    }
  }
  results.push({ url, status: r.status, hits })
  console.log(url, JSON.stringify(hits))
}
await writeFile(new URL('./official-playlist-query.json', import.meta.url), JSON.stringify(results, null, 2) + '\n')
