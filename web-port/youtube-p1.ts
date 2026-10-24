/** Public, anonymous P1 recipe. This module does not obtain or persist recipes. */
export interface P1Recipe {
  context: Record<string, unknown>
  playbackContext: Record<string, unknown>
  signatureTimestamp: number
  script: string
  createdAt: string
  playerSHA: string
  expiresAt?: string
}

export class P1EngineError extends Error {
  constructor(message: string, readonly code: 'recipe' | 'response' | 'restricted' | 'format' | 'decoder' | 'timeout') {
    super(message)
    this.name = 'P1EngineError'
  }
}

export interface P1Cipher {
  url: string
  signature: string | null
  signatureParameter: 'sig' | 'signature' | 'lsig'
  n: string | null
}

export interface P1Decoded { sig?: string; n?: string }

const MAX_VALUE = 4096
const MAX_SCRIPT = 2 * 1024 * 1024
const MAX_RESPONSE = 4 * 1024 * 1024
const REQUEST_MS = 15000
const WORKER_MS = 1500
// P1 9892b9c4968e7b57a239f3b5bdcb45e74852c848,
// src-tauri/src/native_embedded.rs cipher()/apply_decoded(): encrypted inputs
// are opaque, bounded arguments; the output alphabet is checked only after
// transformation. This web boundary uses a smaller 4096-character budget and
// also rejects ASCII controls. It never interpolates inputs into source code.
const opaqueInput = (value: string) => value.length > 0 && value.length <= MAX_VALUE && !/[\u0000-\u001f\u007f]/.test(value)
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const fail = (code: P1EngineError['code'], message: string): never => { throw new P1EngineError(message, code) }
const aborted = () => new DOMException('P1 request cancelled', 'AbortError')
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw aborted() }

function jsonCopy(value: unknown, maximum: number, code: P1EngineError['code']): unknown {
  let json: string | undefined
  try { json = JSON.stringify(value) } catch { return fail(code, 'Invalid P1 JSON') }
  if (!json || json.length > maximum) return fail(code, 'P1 JSON exceeds its limit')
  // JSON received over the wire has no accessors, prototypes or executable values.
  // Clone the callback result as well, so only its JSON representation is used.
  return JSON.parse(json)
}

function validateRecipe(recipe: P1Recipe): { context: Record<string, unknown>; playbackContext: Record<string, unknown> } {
  if (!record(recipe) || typeof recipe.script !== 'string' || !recipe.script.length || recipe.script.length > MAX_SCRIPT ||
      !Number.isSafeInteger(recipe.signatureTimestamp) || recipe.signatureTimestamp <= 0 ||
      typeof recipe.playerSHA !== 'string' || !/^[a-f0-9]{64}$/.test(recipe.playerSHA) ||
      typeof recipe.createdAt !== 'string' || !Number.isFinite(Date.parse(recipe.createdAt))) return fail('recipe', 'Invalid P1 recipe')
  if (recipe.expiresAt !== undefined && (typeof recipe.expiresAt !== 'string' || !Number.isFinite(Date.parse(recipe.expiresAt)) || Date.parse(recipe.expiresAt) <= Date.now()))
    return fail('recipe', 'P1 recipe has expired')
  const context = jsonCopy(recipe.context, 256 * 1024, 'recipe')
  const playbackContext = jsonCopy(recipe.playbackContext, 256 * 1024, 'recipe')
  if (!record(context) || !record(context.client) || context.client.clientName !== 'WEB_EMBEDDED_PLAYER' ||
      typeof context.client.clientVersion !== 'string' || !/^[A-Za-z0-9._+-]{1,64}$/.test(context.client.clientVersion) ||
      !record(playbackContext) || !record(playbackContext.contentPlaybackContext)) return fail('recipe', 'Invalid anonymous P1 context')
  // The bootstrap is public and anonymous. Never accept account or HTTP credentials.
  const forbidden = /^(?:authorization|cookie|cookies|credentials|accessToken|access_token|idToken|id_token|oauth|password|accountId|onBehalfOfUser|sessionToken|user)$/i
  const inspect = (value: unknown, depth = 0): void => {
    if (depth > 16) return fail('recipe', 'P1 context is too deeply nested')
    if (Array.isArray(value)) { if (value.length > 128) return fail('recipe', 'P1 context array is too large'); value.forEach(item => inspect(item, depth + 1)); return }
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      let url: URL
      try { url = new URL(value) } catch { return fail('recipe', 'Invalid P1 context URL') }
      if (url.username || url.password) return fail('recipe', 'P1 context URL contains credentials')
    }
    if (!record(value)) return
    for (const [key, item] of Object.entries(value)) {
      if (forbidden.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') return fail('recipe', 'P1 context contains credentials')
      inspect(item, depth + 1)
    }
  }
  inspect(context); inspect(playbackContext)
  const timestamp = playbackContext.contentPlaybackContext.signatureTimestamp
  if (timestamp !== undefined && timestamp !== recipe.signatureTimestamp) return fail('recipe', 'P1 signature timestamp mismatch')
  return { context, playbackContext: { ...playbackContext, contentPlaybackContext: { ...playbackContext.contentPlaybackContext, signatureTimestamp: recipe.signatureTimestamp } } }
}

function mediaUrl(value: unknown): URL {
  if (typeof value !== 'string' || !value.length || value.length > MAX_VALUE || /[\u0000-\u0020\u007f]/.test(value) || /%(?![a-f0-9]{2})/i.test(value)) return fail('format', 'Invalid P1 audio URL')
  let url: URL
  try { url = new URL(value) } catch { return fail('format', 'Invalid P1 audio URL') }
  if (url.protocol !== 'https:' || !(url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com')) ||
      url.username || url.password || url.port || url.hash || url.pathname !== '/videoplayback') return fail('format', 'Untrusted P1 audio origin')
  const seen = new Set<string>()
  for (const key of url.searchParams.keys()) {
    if (seen.has(key)) return fail('format', 'Duplicate P1 audio parameter')
    seen.add(key)
  }
  return url
}

const hasDrm = (value: Record<string, unknown>) =>
  Object.hasOwn(value, 'licenseInfos') || Object.hasOwn(value, 'drmTrackType') || Object.hasOwn(value, 'keySystems') ||
  Object.hasOwn(value, 'drmFamilies') && (!Array.isArray(value.drmFamilies) || value.drmFamilies.length > 0)

const supportedAudio = (value: unknown, allowOpus: boolean): value is Record<string, unknown> =>
  record(value) && typeof value.mimeType === 'string' &&
  (/^audio\/mp4\s*;\s*codecs\s*=\s*"mp4a\.40\.(?:1|2|5|29)"\s*$/i.test(value.mimeType) ||
    allowOpus === true && /^audio\/webm\s*;\s*codecs\s*=\s*"opus"\s*$/i.test(value.mimeType)) && !hasDrm(value)

/** AAC remains the default; an explicitly supported browser may also try Opus/WebM. */
export function inspectP1Format(value: unknown, allowOpus = false): P1Cipher {
  if (!supportedAudio(value, allowOpus))
    return fail('format', 'P1 requires a supported unencrypted audio format')
  const hasSignatureCipher = Object.hasOwn(value, 'signatureCipher'), hasCipher = Object.hasOwn(value, 'cipher')
  const cipherValue = hasSignatureCipher ? value.signatureCipher : value.cipher
  if (hasSignatureCipher && hasCipher || Object.hasOwn(value, 'url') && (hasSignatureCipher || hasCipher))
    return fail('format', 'Ambiguous P1 audio locator')
  let signature: string | null = null, sp = 'signature', rawUrl: unknown = value.url
  if (hasSignatureCipher || hasCipher) {
    if (typeof cipherValue !== 'string' || !cipherValue.length || cipherValue.length > MAX_VALUE || /%(?![a-f0-9]{2})/i.test(cipherValue)) return fail('format', 'Invalid P1 signature cipher')
    const cipher = new URLSearchParams(cipherValue), seen = new Set<string>()
    for (const key of cipher.keys()) {
      if (!['url', 's', 'sp'].includes(key) || seen.has(key)) return fail('format', 'Invalid P1 cipher fields')
      seen.add(key)
    }
    rawUrl = cipher.get('url'); signature = cipher.get('s'); sp = cipher.get('sp') ?? 'signature'
    if (signature === null || !opaqueInput(signature)) return fail('format', 'Invalid P1 signature input')
  }
  if (!['sig', 'signature', 'lsig'].includes(sp)) return fail('format', 'Invalid P1 signature parameter')
  const url = mediaUrl(rawUrl), n = url.searchParams.get('n')
  if (n !== null && !opaqueInput(n)) return fail('format', 'Invalid P1 n input')
  if (signature !== null && url.searchParams.has(sp)) return fail('format', 'P1 signature is already present')
  return { url: url.href, signature, signatureParameter: sp as P1Cipher['signatureParameter'], n }
}

function publicAudioResponse(value: unknown, videoId: string) {
  if (!record(value) || !record(value.playabilityStatus) || !record(value.videoDetails) || value.videoDetails.videoId !== videoId)
    return fail('response', 'P1 response identity mismatch')
  if (value.playabilityStatus.status !== 'OK' || value.playabilityStatus.playableInEmbed === false || value.videoDetails.playableInEmbed === false || value.videoDetails.isPrivate === true)
    return fail('restricted', 'P1 audio is not publicly playable')
  if (!record(value.streamingData) || hasDrm(value.streamingData) || !Array.isArray(value.streamingData.adaptiveFormats) || value.streamingData.adaptiveFormats.length > 128)
    return fail('format', 'P1 response has no unencrypted audio')
  return { response: value, streaming: value.streamingData, available: value.streamingData.adaptiveFormats as unknown[] }
}

function sabrOnly(streaming: Record<string, unknown>, available: readonly unknown[], allowOpus: boolean,
  acceptFormat?: (format: Record<string, unknown>, allFormats: readonly unknown[]) => boolean): boolean {
  // A normal response may contain both SABR and usable ciphers. Only a trusted
  // SABR endpoint with entirely absent audio locators warrants another context;
  // malformed URLs/ciphers and failed decipher operations never do.
  try { mediaUrl(streaming.serverAbrStreamingUrl) } catch { return false }
  const audio = available.filter(value => supportedAudio(value, allowOpus))
  if (!audio.length || audio.some(format => ['url', 'signatureCipher', 'cipher'].some(key => format[key] !== undefined && format[key] !== null))) return false
  return audio.some(format => {
    try { return !acceptFormat || acceptFormat(format, available) === true } catch { return false }
  })
}

// Recipe timestamps, source hashes and key insertion order do not change the
// effective public POST. Match Native's semantic body comparison before retrying.
const comparableBody = (body: Record<string, unknown>) => JSON.stringify(body, (_key, value) =>
  record(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)

/** Validate untrusted decoder output before inserting it into a provider URL. */
export function applyP1Decoded(cipher: P1Cipher, decoded: unknown): string {
  const url = mediaUrl(cipher.url)
  if (!record(decoded) || Object.keys(decoded).some(key => key !== 'sig' && key !== 'n')) return fail('decoder', 'Invalid P1 decoder result')
  for (const [key, input] of [['sig', cipher.signature], ['n', cipher.n]] as const) {
    const output = decoded[key]
    if (input === null) { if (output !== undefined) return fail('decoder', 'Unexpected P1 decoder output'); continue }
    if (typeof output !== 'string' || !output.length || output.length > MAX_VALUE || output.includes('enhanced_except_') ||
        !(key === 'sig' ? /^[A-Za-z0-9_.-]+={0,2}$/ : /^[A-Za-z0-9_.-]+$/).test(output) || key === 'n' && output === input)
      return fail('decoder', 'P1 decoder rejected the input')
    if (key === 'sig') url.searchParams.set(cipher.signatureParameter, output)
    else url.searchParams.set('n', output)
  }
  if (url.href.length > MAX_VALUE) return fail('format', 'P1 audio URL exceeds its limit')
  return url.href
}

// This is P1's argument-only processor. The extracted fragment supplies its own
// URL-like implementation; neither a full player nor browser DOM is evaluated.
function processValues(exportedVars: { nsigFunction: (url: string, key: string, signature: string) => { get: (key: string) => unknown } }, sig: string | null, n: string | null): P1Decoded {
  const url = exportedVars.nsigFunction('https://ytjs.googlevideo.com/videoplayback?expire=1234567890&n=' + encodeURIComponent(n || ''), 'sig', sig || '')
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(url))) {
    const method = (url as unknown as Record<string, unknown>)[name]
    if (!['constructor', 'clone', 'set', 'get'].includes(name) && typeof method === 'function') method.call(url)
  }
  const result: P1Decoded = {}
  if (sig !== null) { const value = url.get('sig'); if (typeof value === 'string' && value) result.sig = decodeURIComponent(value) }
  if (n !== null) { const value = url.get('n'); if (typeof value === 'string' && value) result.n = decodeURIComponent(value) }
  return result
}

function decoderWorker() {
  const scope = globalThis as unknown as Record<string, unknown> & { postMessage: (value: unknown) => void; onmessage: ((event: MessageEvent) => void) | null }
  const send = scope.postMessage.bind(scope), compile = Function
  scope.onmessage = (event: MessageEvent) => {
    scope.onmessage = null
    try {
      const { source, values } = event.data
      if (!Array.isArray(values) || !values.length || values.length > 4) throw new Error('Invalid P1 decoder batch')
      const transform = compile('sig', 'n', source)
      for (const fn of [function () {}, async function () {}, function* () {}, async function* () {}])
        Object.defineProperty(Object.getPrototypeOf(fn), 'constructor', { value: undefined, writable: false, configurable: false })
      for (const name of ['eval', 'Function', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'importScripts', 'indexedDB', 'caches', 'navigator', 'BroadcastChannel', 'MessageChannel', 'postMessage', 'close', 'setTimeout', 'setInterval', 'queueMicrotask', 'SharedArrayBuffer', 'Atomics', 'WebAssembly'])
        Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false })
      // A provider transformation may reject one cipher while another encoding
      // of the same recording is valid. Never reflect its error text or inputs.
      const result = values.map((value: { signature: string | null; n: string | null }) => {
        try { return { ok: true, value: transform(value.signature, value.n) } }
        catch { return { ok: false } }
      })
      send({ result })
    } catch { send({ error: true }) }
  }
}

function decoderFrame(payload: { id: string; workerSource: string; source: string; values: P1Cipher[]; maximumMs: number }) {
  let worker: Worker | undefined, blob: string | undefined, settled = false
  const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', stop); worker?.terminate(); if (blob) URL.revokeObjectURL(blob) }
  const finish = (result: unknown) => { if (settled) return; settled = true; cleanup(); parent.postMessage({ id: payload.id, result }, '*') }
  const stop = (event: MessageEvent) => { if (event.source === parent && event.data?.id === payload.id && event.data.stop === true) finish({ stopped: true }) }
  const timer = setTimeout(() => finish({ timeout: true }), payload.maximumMs)
  window.addEventListener('message', stop)
  try {
    blob = URL.createObjectURL(new Blob([payload.workerSource], { type: 'text/javascript' }))
    worker = new Worker(blob)
    worker.onmessage = event => finish(event.data)
    worker.onerror = event => { event.preventDefault(); finish({ error: true }) }
    worker.postMessage({ source: payload.source, values: payload.values })
  } catch { finish({ error: true }) }
}

function decode(script: string, values: P1Cipher[], signal: AbortSignal): Promise<unknown[]> {
  checkAbort(signal)
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.body) return Promise.reject(new P1EngineError('P1 decoder requires a browser', 'decoder'))
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe'), id = crypto.randomUUID()
    frame.hidden = true; frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('aria-hidden', 'true')
    let settled = false
    const finish = (error: Error | null, result?: unknown[], stopWorker = false) => {
      if (settled) return; settled = true
      clearTimeout(timer); signal.removeEventListener('abort', cancel); window.removeEventListener('message', receive)
      const dispose = () => { frame.remove(); if (error) reject(error); else resolve(result!) }
      if (!stopWorker) { dispose(); return }
      // Give the isolated bridge a bounded chance to explicitly terminate and
      // revoke before discarding its document. A hung/missing bridge is removed
      // by the external deadline; it cannot hold the caller indefinitely.
      let cleaned = false
      const clean = () => { if (cleaned) return; cleaned = true; clearTimeout(grace); window.removeEventListener('message', acknowledged); dispose() }
      const acknowledged = (event: MessageEvent) => {
        if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.id === id) clean()
      }
      const grace = setTimeout(clean, 100)
      window.addEventListener('message', acknowledged)
      try { frame.contentWindow?.postMessage({ id, stop: true }, '*') } catch { clean() }
    }
    const cancel = () => finish(aborted(), undefined, true)
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== 'null' || !record(event.data) || event.data.id !== id) return
      const result = event.data.result
      if (!record(result) || !Array.isArray(result.result) || result.result.length !== values.length) {
        finish(new P1EngineError('P1 decoder failed', record(result) && result.timeout === true ? 'timeout' : 'decoder')); return
      }
      finish(null, result.result)
    }
    const timer = setTimeout(() => finish(new P1EngineError('P1 decoder timed out', 'timeout'), undefined, true), WORKER_MS + 1000)
    signal.addEventListener('abort', cancel, { once: true }); window.addEventListener('message', receive)
    const payload = { id, workerSource: '(' + decoderWorker.toString() + ')()', source: '"use strict";\n' + script + '\nreturn (' + processValues.toString() + ')(exportedVars,sig,n);', values, maximumMs: WORKER_MS }
    const csp = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'"
    try {
      frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + csp + '"><script>(' + decoderFrame.toString() + ')(' + JSON.stringify(payload).replaceAll('<', '\\u003c') + ')<' + '/script>'
      document.body.append(frame)
      if (signal.aborted) cancel()
    } catch { finish(new P1EngineError('P1 decoder setup failed', 'decoder')) }
  })
}

/** Resolve a public P1 response using a caller-supplied ordinary browser POST. */
export async function requestP1Player(videoId: string, request: (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>, recipe: P1Recipe, signal?: AbortSignal,
  acceptFormat?: (format: Record<string, unknown>, allFormats: readonly unknown[]) => boolean, allowOpus = false, renewedRecipe?: P1Recipe): Promise<unknown> {
  checkAbort(signal)
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return fail('response', 'Invalid P1 video ID')
  const { context, playbackContext } = validateRecipe(recipe)
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, REQUEST_MS)
  const awaitAbort = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const stop = () => reject(aborted())
    controller.signal.addEventListener('abort', stop, { once: true })
    promise.then(value => { controller.signal.removeEventListener('abort', stop); resolve(value) }, error => { controller.signal.removeEventListener('abort', stop); reject(error) })
    if (controller.signal.aborted) stop()
  })
  try {
    if (signal?.aborted) controller.abort()
    checkAbort(controller.signal)
    const body = { videoId, context, playbackContext, contentCheckOk: true, racyCheckOk: true }
    let activeRecipe = recipe
    let result = publicAudioResponse(jsonCopy(await awaitAbort(request(body, controller.signal)), MAX_RESPONSE, 'response'), videoId)
    checkAbort(controller.signal)
    if (renewedRecipe && sabrOnly(result.streaming, result.available, allowOpus, acceptFormat)) {
      const renewed = validateRecipe(renewedRecipe)
      const renewedBody = { videoId, ...renewed, contentCheckOk: true, racyCheckOk: true }
      if (comparableBody(body) !== comparableBody(renewedBody)) {
        checkAbort(controller.signal)
        activeRecipe = renewedRecipe
        // Both POSTs and the decoder share this original controller and 15s
        // deadline. A second SABR-only response cannot request a third context.
        result = publicAudioResponse(jsonCopy(await awaitAbort(request(renewedBody, controller.signal)), MAX_RESPONSE, 'response'), videoId)
      }
    }
    checkAbort(controller.signal)
    const { response, streaming, available } = result
    const candidates: { format: Record<string, unknown>; cipher: P1Cipher }[] = []
    // Global bounds stay strict, but one bad/dubbed/incompatible AAC must not
    // invalidate another encoding. The caller's originality policy sees every
    // format, including rejected and non-AAC language metadata.
    for (const format of available) {
      checkAbort(controller.signal)
      if (!record(format) || typeof format.mimeType !== 'string') continue
      try {
        const cipher = inspectP1Format(format, allowOpus)
        if (acceptFormat && acceptFormat(format, available) !== true) continue
        candidates.push({ format, cipher })
      } catch { checkAbort(controller.signal) }
    }
    const bitrate = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0
    const family = (format: Record<string, unknown>) => /^audio\/webm(?:\s*;|$)/i.test(String(format.mimeType)) === allowOpus ? 0 : 1
    const selected = candidates.sort((a, b) => family(a.format) - family(b.format) || bitrate(b.format.bitrate) - bitrate(a.format.bitrate)).slice(0, 4)
    if (!selected.length) return fail('format', 'P1 response has no compatible audio candidate')
    const needDecode = selected.filter(({ cipher }) => cipher.signature !== null || cipher.n !== null)
    const results = needDecode.length ? await decode(activeRecipe.script, needDecode.map(({ cipher }) => cipher), controller.signal) : []
    checkAbort(controller.signal)
    const approved = new Map<Record<string, unknown>, string>()
    let index = 0
    for (const { format, cipher } of selected) {
      if (cipher.signature === null && cipher.n === null) { approved.set(format, cipher.url); continue }
      const decoded = results[index++]
      // The worker's per-candidate envelope is not trusted. Invalid shapes and
      // outputs reject only that candidate; no raw failure details are exposed.
      if (!record(decoded) || decoded.ok !== true || !Object.hasOwn(decoded, 'value') ||
          Object.keys(decoded).some(key => key !== 'ok' && key !== 'value')) continue
      try { approved.set(format, applyP1Decoded(cipher, decoded.value)) }
      catch { checkAbort(controller.signal) }
    }
    if (!approved.size) return fail('decoder', 'P1 decoder rejected every audio candidate')
    streaming.adaptiveFormats = available.map(format => {
      if (!record(format)) return format
      const result: Record<string, unknown> = { ...format }
      delete result.url; delete result.signatureCipher; delete result.cipher
      const url = approved.get(format)
      if (url) result.url = url
      return result
    })
    // Do not allow an unprocessed muxed/cipher format to bypass this audio path.
    delete streaming.formats
    return response
  } catch (error) {
    if (timedOut) throw new P1EngineError('P1 request timed out', 'timeout')
    if (signal?.aborted || controller.signal.aborted) throw aborted()
    throw error
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel)
  }
}
