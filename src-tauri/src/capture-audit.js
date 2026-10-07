// Private benchmark recorder. This channel never supplies audio to the player or
// assigns semantic ad labels. All successful audio appends are retained equally.
(() => {
  const recorders = new Set()
  function create({ scope = globalThis, epoch = () => scope.__musifyEpoch } = {}) {
    if (scope.__musifyBenchmarkAudit !== true && scope.window?.__musifyBenchmarkAudit !== true) return null
    const host = scope.window ?? scope, bridge = host.chrome?.webview
    if (!bridge) return null
    const target = host.__musifyTarget, generation = host.__musifyGeneration
    if (typeof target !== 'string' || !Number.isSafeInteger(generation)) return null
    const documentId = scope.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const MAX_BYTES = 1024 * 1024 * 1024, PART_BYTES = 128 * 1024
    const statistics = { appends: 0, parts: 0, bytes: 0, clocks: 0, dropped: 0, errors: 0 }
    let sequence = 0, nextAppend = 0, capture = null, interval = null, frozen = false
    const listeners = []
    const now = () => scope.performance?.now?.() ?? 0
    const emit = message => {
      try { bridge.postMessage('musify-audit:' + JSON.stringify({ audit: 1, v: target, generation, epoch: epoch(), documentId, sequence: ++sequence, browserNow: now(), ...message })); return true }
      catch { statistics.dropped++; statistics.errors++; return false }
    }
    // This diagnostic observes calls, never awaits/replaces a play promise or
    // changes native receivers, arguments, exceptions, rates or pause policy.
    const playbackCounts = { pause: 0, play: 0, rateWrites: 0, rateRedundant: 0, mutedWrites: 0, mutedRedundant: 0, captureCalls: 0, externalCalls: 0, throws: 0 }
    const sampleBudgets = { pause: 8, play: 8, rate: 2, muted: 2 }
    let playbackSamples = 0, playbackDirty = false, playbackLast = 0, controlReason = null, lastPlaybackMedia = null
    const playbackSnapshot = media => {
      try {
        const state = {}, visibility = scope.document?.visibilityState
        if (Number.isFinite(media.currentTime)) state.position = media.currentTime
        if (Number.isFinite(media.playbackRate)) state.rate = media.playbackRate
        if (typeof media.paused === 'boolean') state.paused = media.paused
        if (typeof media.muted === 'boolean') state.muted = media.muted
        if (visibility === 'visible' || visibility === 'hidden') state.visibility = visibility
        if (typeof scope.document?.hasFocus === 'function') state.focused = scope.document.hasFocus() === true
        return state
      } catch { return null }
    }
    const safeStack = () => {
      const names = []
      try {
        // V8 normally captures ten frames, including these wrappers. Raise that
        // local diagnostic capture limit briefly, then restore the exact property.
        const ErrorType = Error, limit = Object.getOwnPropertyDescriptor(ErrorType, 'stackTraceLimit')
        let raw, raised = false
        try {
          if (limit && 'value' in limit && typeof limit.value === 'number' && limit.value < 20 && limit.writable) {
            Object.defineProperty(ErrorType, 'stackTraceLimit', { ...limit, value: 20 }); raised = true
          }
          raw = String(new ErrorType().stack ?? '').slice(0, 8192)
        } finally { if (raised) Object.defineProperty(ErrorType, 'stackTraceLimit', limit) }
        // Read only bounded function names. Never retain frame locations, URLs,
        // query strings, exception messages, source text or account information.
        for (const line of raw.split('\n').slice(1, 25)) {
          const name = /^\s*at ([A-Za-z_$][A-Za-z0-9_$.]{0,63})\s*\(/.exec(line)?.[1]
          if (name && !['safeStack', 'auditedPlayback', 'control', 'controlled'].includes(name.split('.').at(-1))) names.push(name)
          if (names.length === 12) break
        }
      } catch { /* Optional caller evidence never changes the native call. */ }
      return names
    }
    const playbackMessage = (phase, control) => {
      let source = null
      try { source = lastPlaybackMedia && capture?.sourceOf(lastPlaybackMedia) } catch {}
      return { kind: 'diagnostic', reason: 'audit-playback-control', source: source?.id ?? null, s: source?.buffers?.[0]?.id ?? null,
        playback: { version: 1, phase, ...(control ? { control } : {}), counts: { ...playbackCounts }, samples: playbackSamples, maxSamples: 20 } }
    }
    const playbackSummary = force => {
      if (!playbackDirty || (!force && now() - playbackLast < 1000)) return
      playbackLast = now(); playbackDirty = false
      emit(playbackMessage('summary'))
    }
    const recordPlayback = (media, method, requested, previousValue, before, origin, reason, threw, stack) => {
      if (frozen) return
      lastPlaybackMedia = media; playbackDirty = true
      playbackCounts[origin === 'capture' ? 'captureCalls' : 'externalCalls']++
      if (threw) playbackCounts.throws++
      if (method === 'pause' || method === 'play') playbackCounts[method]++
      else if (method === 'muted') {
        playbackCounts.mutedWrites++
        if (typeof requested === 'boolean' && requested === previousValue) playbackCounts.mutedRedundant++
      } else {
        playbackCounts.rateWrites++
        if (typeof requested === 'number' && requested === previousValue) playbackCounts.rateRedundant++
      }
      if (!stack) return
      playbackSamples++
      const control = { method, origin, ...(reason ? { reason } : {}), before, after: playbackSnapshot(media), threw, stack }
      if (typeof requested === 'boolean' || (typeof requested === 'number' && Number.isFinite(requested))) control.requested = requested
      emit(playbackMessage('sample', control))
    }
    const installPlayback = () => {
      const prototype = scope.HTMLMediaElement?.prototype
      if (!prototype) return
      const wrap = (method, original, getter) => function auditedPlayback(...args) {
        if (frozen) return original.apply(this, args)
        let before = null, stack = null, previousValue, origin = controlReason ? 'capture' : 'external', reason = controlReason, threw = false
        try {
          before = playbackSnapshot(this)
          if (getter) previousValue = getter.call(this)
          const budget = ['play', 'pause', 'muted'].includes(method) ? method : 'rate'
          if (sampleBudgets[budget] > 0) { sampleBudgets[budget]--; stack = safeStack() }
        } catch { /* Optional instrumentation must not swallow a native call. */ }
        try { return original.apply(this, args) }
        catch (error) { threw = true; throw error }
        finally {
          try { recordPlayback(this, method, args[0], previousValue, before, origin, reason, threw, stack) } catch { statistics.errors++ }
        }
      }
      for (const method of ['pause', 'play']) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method)
        if (typeof descriptor?.value === 'function' && descriptor.configurable)
          Object.defineProperty(prototype, method, { ...descriptor, value: wrap(method, descriptor.value) })
      }
      for (const property of ['playbackRate', 'defaultPlaybackRate', 'muted']) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, property)
        if (descriptor?.set && descriptor.configurable)
          Object.defineProperty(prototype, property, { ...descriptor, set: wrap(property, descriptor.set, descriptor.get) })
      }
    }
    const control = (reason, operation) => {
      const previous = controlReason
      controlReason = typeof reason === 'string' && /^[a-z-]{1,48}$/.test(reason) ? reason : 'capture-control'
      try { return operation() } finally { controlReason = previous }
    }
    const tuple = settings => ({ timestampOffset: settings.timestampOffset ?? 0, appendWindowStart: settings.appendWindowStart ?? 0, appendWindowEnd: Number.isFinite(settings.appendWindowEnd) ? settings.appendWindowEnd : null, mode: settings.mode ?? 'segments' })
    const base64 = bytes => {
      let binary = ''
      for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192))
      return scope.btoa(binary)
    }
    const append = (buffer, input, settings) => {
      if (frozen) return
      try {
        // Copy independently: the gate can immediately discard these same bytes.
        const bytes = input instanceof ArrayBuffer ? new Uint8Array(input).slice() : new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice()
        const appendId = ++nextAppend, parts = Math.ceil(bytes.length / PART_BYTES)
        if (!bytes.length || statistics.bytes + bytes.length > MAX_BYTES) { statistics.dropped++; emit({ kind: 'diagnostic', reason: 'audit-byte-budget-or-empty-append', statistics }); return }
        statistics.appends++; statistics.bytes += bytes.length
        for (let part = 0; part < parts; part++) {
          if (emit({ kind: 'append', source: buffer.source.id, s: buffer.id, mime: buffer.mime, timelineSettings: tuple(settings), appendId, part, parts, totalBytes: bytes.length, data: base64(bytes.subarray(part * PART_BYTES, (part + 1) * PART_BYTES)) })) statistics.parts++
        }
      } catch { statistics.dropped++; statistics.errors++; emit({ kind: 'diagnostic', reason: 'audit-copy-failed', statistics }) }
    }
    const mutation = (buffer, operation, detail = {}) => {
      if (frozen || !buffer) return
      // The caller supplies only operation names and numeric bounds, never URLs.
      emit({ kind: 'mutation', source: buffer.source.id, s: buffer.id, operation, start: detail.start, end: detail.end, error: detail.error === true })
    }
    let classifier = null
    try { classifier = scope.__musifyCaptureYouTube?.create({ target }) } catch { /* Unknown site observation is recorded explicitly. */ }
    const clock = (media, phase = 'tick') => {
      if (frozen || !capture) return
      try {
        const snapshot = capture.snapshotOf(media)
        let observation
        try { observation = classifier?.classify(media) } catch { /* Still record the native clock. */ }
        const message = {
          kind: 'clock', source: snapshot?.source?.id ?? null, s: snapshot?.source?.buffers?.[0]?.id ?? null, phase,
          position: media.currentTime, duration: media.duration, paused: media.paused, ended: media.ended, seeking: media.seeking,
          playbackRate: media.playbackRate, readyState: media.readyState, sourceEnded: snapshot?.sourceEnded ?? false,
          audioRanges: snapshot?.audioRanges ?? [], siteState: ['content', 'ad', 'unknown'].includes(observation?.state) ? observation.state : 'unknown',
          adMarker: observation?.evidence?.adMarker ?? null,
        }
        if (emit(message)) statistics.clocks++
      } catch { statistics.errors++; statistics.dropped++; emit({ kind: 'diagnostic', reason: 'audit-clock-failed', statistics }) }
    }
    const finalize = (reason, requestId) => {
      if (frozen) return false
      // Take the last clock while this document still exists, then stop every
      // producer before the final counters. No unload/pagehide is required.
      for (const media of scope.document?.querySelectorAll('audio,video') ?? []) clock(media, 'finalize')
      playbackSummary(true)
      frozen = true
      if (interval !== null) scope.clearInterval(interval)
      for (const [type, listener] of listeners) scope.removeEventListener?.(type, listener, true)
      return emit({ kind: 'diagnostic', reason, ...(requestId ? { requestId } : {}), statistics: { ...statistics } })
    }
    const attach = value => {
      if (frozen || capture) return
      capture = value
      installPlayback()
      for (const type of ['timeupdate', 'playing', 'ended', 'seeking', 'seeked', 'pause', 'loadedmetadata']) {
        const listener = event => { if (event.target instanceof scope.HTMLMediaElement) clock(event.target, type) }
        listeners.push([type, listener]); scope.addEventListener?.(type, listener, true)
      }
      interval = scope.setInterval(() => {
        if (frozen) return
        for (const media of scope.document?.querySelectorAll('audio,video') ?? []) clock(media)
        playbackSummary(false)
        emit({ kind: 'diagnostic', reason: 'audit-heartbeat', statistics })
      }, 100)
      const pagehide = () => finalize('audit-pagehide')
      listeners.push(['pagehide', pagehide]); scope.addEventListener?.('pagehide', pagehide, true)
      emit({ kind: 'diagnostic', reason: 'audit-started', statistics })
    }
    recorders.add({ generation, finalize })
    return { append, mutation, clock, attach, statistics, control }
  }
  globalThis.__musifyCaptureAudit = { create, finalize({ generation, requestId } = {}) {
    if (!Number.isSafeInteger(generation) || typeof requestId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(requestId)) return false
    let sent = false
    for (const recorder of recorders) if (recorder.generation === generation)
      sent = recorder.finalize('audit-finalized', requestId) || sent
    return sent
  } }
})()
