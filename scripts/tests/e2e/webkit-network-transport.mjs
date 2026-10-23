// QA transport only. WebKit's media process can bypass Playwright routing on SW-controlled pages.
// This loopback TLS proxy feeds the SAME HTTP fixture handler without changing product URLs/SW.
import { createServer } from 'node:http'
import { createSecureContext, TLSSocket } from 'node:tls'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'

const exec = promisify(execFile)
const hosts = new Set(['fixture.googlevideo.com', 'media.pletina.test', 'feeds.pletina.test', 'images.pletina.test', 'i.ytimg.com', 'api.audius.co',
  'open.spotify.com', 'api-partner.spotify.com'])

export async function createWebKitNetworkTransport() {
  const directory = await mkdtemp(join(tmpdir(), 'pletina-wk-proxy-'))
  const sockets = new Set()
  const requests = [], rejected = []
  let handler, closed = false
  const certificate = join(directory, 'qa-cert.pem'), key = join(directory, 'qa-key.pem')
  let server, parser
  try {
    const certificateArgs = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=fixture.googlevideo.com', '-addext', 'subjectAltName=' + [...hosts].map(host => 'DNS:' + host).join(','),
      '-keyout', key, '-out', certificate]
    const certificateOptions = { timeout: 15000, maxBuffer: 100000 }
    try { await exec('openssl', certificateArgs, certificateOptions) }
    catch (error) {
      const windowsOpenSSL = 'C:/Program Files/Git/usr/bin/openssl.exe'
      if (error.code !== 'ENOENT' || process.platform !== 'win32' || !existsSync(windowsOpenSSL)) throw error
      await exec(windowsOpenSSL, certificateArgs, certificateOptions)
    }
    const secureContext = createSecureContext({ cert: await readFile(certificate), key: await readFile(key) })
    function track(socket) {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
      socket.setTimeout(30000, () => socket.destroy())
    }
    parser = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'https://' + request.headers.host)
        if (!handler || !hosts.has(url.hostname) || url.protocol !== 'https:' || !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
          rejected.push({ host: url.hostname, path: url.pathname, method: request.method, reason: 'host/protocol/method not allowlisted' })
          response.writeHead(502); response.end(); return
        }
        requests.push({ host: url.hostname, path: url.pathname, method: request.method })
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
      if (!hosts.has(target.hostname) || target.port && target.port !== '443') {
        rejected.push({ host: target.hostname, method: 'CONNECT', reason: 'target not allowlisted' })
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) socket.unshift(head)
      const secure = new TLSSocket(socket, { isServer: true, secureContext })
      track(secure)
      parser.emit('connection', secure)
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    return {
      contextOptions: { proxy: { server: 'http://127.0.0.1:' + server.address().port, bypass: '127.0.0.1,localhost,[::1]' }, ignoreHTTPSErrors: true },
      snapshot: () => ({ allowlistedHosts: [...hosts], requests: requests.map(row => ({ ...row })),
        rejected: rejected.map(row => ({ ...row })), externalUpstreamConnections: 0 }),
      connect: async ({ context, report }) => {
        report.networkTransport = 'Playwright HTTP interception plus loopback TLS proxy for eight allowlisted fixture hosts (media, RSS, images, Audius and Spotify); original URLs, response headers and production SW retained. No external upstream. Self-signed fixture certificate accepted only in this disposable QA context.'
        report.networkTransportHosts = [...hosts]
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
