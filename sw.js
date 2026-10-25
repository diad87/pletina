/* Pletina: puente de las instalaciones anteriores. */
(() => {
  const gateway = new URL("https://pletina-app.netlify.app/")
  const installed = new URL(self.registration.scope)
  const nativeFetch = self.fetch.bind(self)
  const nativeImport = self.importScripts.bind(self)
  const destination = (value, release = false) => {
    const url = new URL(value, self.location.href)
    if (url.origin !== installed.origin || !url.pathname.startsWith(installed.pathname)) return null
    const path = url.pathname.slice(installed.pathname.length)
    // Never forward visitor parameters, credentials, headers or another origin.
    if (/%(?:2e|2f|5c)/i.test(path) || path.includes(String.fromCharCode(92)) || path.startsWith('/')) throw new TypeError('Ruta no válida.')
    // Keep A's optional assets available while the gateway already publishes B.
    // VERSION is the global lexical binding of the imported product worker.
    const version = release && typeof VERSION === 'string' && /^[a-f0-9]{16}$/.test(VERSION) ? VERSION : null
    // Binary aliases preserve exact HTML bytes even on hosts that inject markup.
    const result = new URL(version ? 'releases/' + version + '/' + path + '.bin' : path, gateway)
    if (result.origin !== gateway.origin || !result.pathname.startsWith(gateway.pathname)) throw new TypeError('Ruta fuera del destino.')
    return result.href
  }
  self.fetch = async (input, options) => {
    const request = new Request(input, options)
    const url = destination(request.url, true)
    if (!url || request.method !== 'GET') return nativeFetch(request)
    const response = await nativeFetch(new Request(url, {
      method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', cache: 'no-store', signal: request.signal,
    }))
    if (response.type === 'opaque' || response.redirected) throw new TypeError('Respuesta no verificable.')
    const headers = new Headers()
    for (const name of ['content-type', 'cache-control', 'x-content-type-options']) {
      if (response.headers.has(name)) headers.set(name, response.headers.get(name))
    }
    if (response.ok) {
      const extension = new URL(request.url).pathname.split('.').pop().toLowerCase()
      const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
        css: 'text/css; charset=utf-8', json: 'application/json', webmanifest: 'application/manifest+json',
        png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff',
        ttf: 'font/ttf', otf: 'font/otf', txt: 'text/plain; charset=utf-8' }
      headers.set('content-type', types[extension] || 'application/octet-stream')
      headers.set('x-content-type-options', 'nosniff')
    }
    // An empty response URL keeps HTML, modules and CSS on the installed origin.
    // The imported product SW still verifies each resource against its SHA-256.
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
  self.importScripts = (...urls) => nativeImport(...urls.map(url => destination(url) || url))
  self.importScripts(new URL('sw.js', gateway).href)
})()
