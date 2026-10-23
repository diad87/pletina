import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildPwa, outputDirectory } from './build-pwa.mjs'

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.png': 'image/png' }

export function createPwaServer({ directory = outputDirectory, base = '/pletina/' } = {}) {
  const root = resolve(directory)
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost')
      if (url.pathname === base.slice(0, -1)) { response.writeHead(301, { Location: base }); response.end(); return }
      if (!['GET', 'HEAD'].includes(request.method) || !url.pathname.startsWith(base)) {
        response.writeHead(404); response.end('Not found'); return
      }
      const path = resolve(root, decodeURIComponent(url.pathname.slice(base.length)) || 'index.html')
      if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) {
        response.writeHead(404); response.end('Not found'); return
      }
      const bytes = await readFile(path)
      response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' })
      response.end(request.method === 'HEAD' ? undefined : bytes)
    } catch {
      response.writeHead(404); response.end('Not found')
    }
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { buildWebPwa } = await import('./build-web-pwa.mjs')
  await buildWebPwa()
  const index = process.argv.indexOf('--port')
  const port = index === -1 ? 4174 : Number(process.argv[index + 1])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Puerto no válido')
  const server = createPwaServer()
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
  server.listen(port, '127.0.0.1', () => console.log(`Pletina PWA: http://localhost:${port}/pletina/`))
}
