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
      frozen = true
      if (interval !== null) scope.clearInterval(interval)
      for (const [type, listener] of listeners) scope.removeEventListener?.(type, listener, true)
      return emit({ kind: 'diagnostic', reason, ...(requestId ? { requestId } : {}), statistics: { ...statistics } })
    }
    const attach = value => {
      if (frozen || capture) return
      capture = value
      for (const type of ['timeupdate', 'playing', 'ended', 'seeking', 'seeked', 'pause', 'loadedmetadata']) {
        const listener = event => { if (event.target instanceof scope.HTMLMediaElement) clock(event.target, type) }
        listeners.push([type, listener]); scope.addEventListener?.(type, listener, true)
      }
      interval = scope.setInterval(() => {
        if (frozen) return
        for (const media of scope.document?.querySelectorAll('audio,video') ?? []) clock(media)
        emit({ kind: 'diagnostic', reason: 'audit-heartbeat', statistics })
      }, 100)
      const pagehide = () => finalize('audit-pagehide')
      listeners.push(['pagehide', pagehide]); scope.addEventListener?.('pagehide', pagehide, true)
      emit({ kind: 'diagnostic', reason: 'audit-started', statistics })
    }
    recorders.add({ generation, finalize })
    return { append, mutation, clock, attach, statistics }
  }
  globalThis.__musifyCaptureAudit = { create, finalize({ generation, requestId } = {}) {
    if (!Number.isSafeInteger(generation) || typeof requestId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(requestId)) return false
    let sent = false
    for (const recorder of recorders) if (recorder.generation === generation)
      sent = recorder.finalize('audit-finalized', requestId) || sent
    return sent
  } }
})()
