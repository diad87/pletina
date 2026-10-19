// QA transport only. WebKit's media process can bypass Playwright routing on SW-controlled pages.
// This loopback TLS proxy feeds the SAME HTTP fixture handler without changing product URLs/SW.
import { createServer } from 'node:http'
import { createSecureContext, TLSSocket } from 'node:tls'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const hosts = new Set(['fixture.googlevideo.com', 'media.pletina.test', 'feeds.pletina.test', 'images.pletina.test', 'i.ytimg.com'])

export async function createWebKitNetworkTransport() {
  const directory = await mkdtemp(join(tmpdir(), 'pletina-wk-proxy-'))
  const sockets = new Set()
  let handler, closed = false
  const certificate = join(directory, 'qa-cert.pem'), key = join(directory, 'qa-key.pem')
  let server, parser
  try {
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=fixture.googlevideo.com', '-addext', 'subjectAltName=' + [...hosts].map(host => 'DNS:' + host).join(','),
      '-keyout', key, '-out', certificate], { timeout: 15000, maxBuffer: 100000 })
    const secureContext = createSecureContext({ cert: await readFile(certificate), key: await readFile(key) })
    function track(socket) {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
      socket.setTimeout(30000, () => socket.destroy())
    }
    parser = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'https://' + request.headers.host)
        if (!handler || !hosts.has(url.hostname) || url.protocol !== 'https:' || !['GET', 'HEAD'].includes(request.method)) {
          response.writeHead(502); response.end(); return
        }
        const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, String(value)]))
        const dest = headers['sec-fetch-dest']
        const resourceType = dest === 'audio' || dest === 'video' ? 'media' : 'fetch'
        const wrapped = { url: () => url.href, method: () => request.method, resourceType: () => resourceType,
          headers: () => headers, postDataJSON: () => ({}) }
        const abort = async () => { if (!response.writableEnded) { response.writeHead(502); response.end() } }
        await handler({ request: () => wrapped, abort, continue: abort,
          fulfill: async value => {
            if (response.writableEnded || response.destroyed) return
            const body = Buffer.isBuffer(value.body) ? value.body : Buffer.from(value.body ?? '')
            const out = { ...value.headers, ...(value.contentType ? { 'content-type': value.contentType } : {}), 'content-length': String(body.length) }
            response.writeHead(value.status ?? 200, out)
            response.end(request.method === 'HEAD' ? undefined : body)
          } })
      } catch { if (!response.writableEnded && !response.destroyed) { response.writeHead(502); response.end() } }
    })
    server = createServer((_request, response) => { response.writeHead(502); response.end() })
    server.on('connection', track)
    server.on('connect', (request, socket, head) => {
      let target
      try { target = new URL('https://' + request.url) } catch { socket.destroy(); return }
      if (!hosts.has(target.hostname) || target.port && target.port !== '443') { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) socket.unshift(head)
      const secure = new TLSSocket(socket, { isServer: true, secureContext })
      track(secure)
      parser.emit('connection', secure)
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    return {
      contextOptions: { proxy: { server: 'http://127.0.0.1:' + server.address().port, bypass: '127.0.0.1,localhost,[::1]' }, ignoreHTTPSErrors: true },
      connect: async ({ context, report }) => {
        report.networkTransport = 'Playwright HTTP interception plus loopback TLS proxy for five allowlisted fixture hosts (two media, one RSS feed and two image hosts); original URLs, response headers and production SW retained. No external upstream. Self-signed fixture certificate accepted only in this disposable QA context.'
        return {
          pages: () => context.pages(),
          route: async (pattern, action) => { handler = action; await context.route(pattern, action) },
        }
      },
      close: async () => {
        if (closed) return; closed = true
        for (const socket of sockets) socket.destroy()
        await new Promise(resolve => server.close(resolve)); parser.closeAllConnections()
        await rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    for (const socket of sockets) socket.destroy()
    server?.close(); parser?.closeAllConnections()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
