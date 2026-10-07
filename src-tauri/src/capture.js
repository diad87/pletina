// Capture API 4. Only remux samples covered by observed content intervals.
// Keep acquisition at 1x: page labels cannot safely predict the next advertisement.
(() => {
  const bridge = window.chrome?.webview
  if (!bridge || window.__musifyCapture || (window.top && window.top !== window)) return
  if (!['music.youtube.com', 'consent.youtube.com'].includes(location.hostname)) return
  window.__musifyCapture = true
  const target = window.__musifyTarget || new URLSearchParams(location.search).get('v'), generation = window.__musifyGeneration
  let epoch = window.__musifyEpoch, sequence = 0, queue = Promise.resolve(), tick = null
  let failed = false, started = false, lastBeat = 0, lastDiagnostic = 0, pendingSeek = null, interaction = '', finalizedEpoch = null, lastAuth = null
  const post = message => {
    sequence = Math.max(sequence + 1, Date.now() * 1000)
    bridge.postMessage('musify:' + JSON.stringify({ musify: 1, api: 4, v: target, generation, sequence, epoch, ...message }))
  }
  const enqueue = (message, prepare) => {
    const sentEpoch = message.epoch ?? epoch
    queue = queue.then(async () => {
      if (sentEpoch !== epoch) return
      const prepared = prepare ? await prepare() : message
      if (sentEpoch === epoch) post({ ...prepared, epoch: sentEpoch })
    }).catch(e => {
      if (sentEpoch !== epoch) return
      failed = true
      if (tick) clearInterval(tick)
      post({ kind: 'event', type: 'error', code: 'CAPTURE_BRIDGE_ERROR', reason: String(e), recoverable: true })
    })
    return queue
  }
  const event = (type, data = {}) => enqueue({ kind: 'event', type, ...data })
  const problem = (code, reason, recoverable = true) => {
    if (failed) return
    failed = true
    if (tick) clearInterval(tick)
    for (const media of document.querySelectorAll('audio,video')) { media.playbackRate = 1; media.pause() }
    event('error', { code, reason: String(reason).startsWith(`${code}:`) ? String(reason) : `${code}: ${reason}`, recoverable })
  }
  let capture
  const core = globalThis.__musifyCaptureCore, adapter = globalThis.__musifyCaptureYouTube?.create({ target, skipDiagnostics: true,
    requestSkip: request => event('skip-request', request),
    skipContext: media => !failed && finalizedEpoch !== epoch ? { generation, epoch, source: capture?.sourceOf(media)?.id } : null,
  })
  if (!core?.ProgressiveTracker || !adapter || !target || !Number.isSafeInteger(generation) || !Number.isSafeInteger(epoch) || epoch < 1) return problem('CAPTURE_PROTOCOL_MISMATCH', 'Capture API 4 requires target, generation and native epoch', false)
  window.__musifyValidateSkip = requestId => failed ? { valid: false, requestId, reason: 'capture-failed' } : adapter.validateSkip(requestId)
  window.__musifySkipResult = result => {
    if (!adapter.completeSkip(result)) return false
    event('diagnostic', { reason: diagnosticReason({ phase: 'native-skip-result', requestId: result.requestId, ok: result.ok === true }) })
    return true
  }
  const diagnosticReason = details => {
    const skip = adapter.skipSummary?.()
    if (!skip) return JSON.stringify(details)
    let result = JSON.stringify({ ...details, skip })
    // Preserve the existing phase/evidence and the skip counters after returning
    // to content. Drop optional control samples before Rust's2048-character limit.
    if (result.length > 2000) { delete skip.controls; skip.controlsOmitted = true; result = JSON.stringify({ ...details, skip }) }
    if (result.length > 2000) { delete skip.observed; delete skip.transition; delete skip.last?.after; result = JSON.stringify({ ...details, skip }) }
    if (result.length > 2000) result = JSON.stringify({ ...details, skip: { calls: skip.calls, tries: skip.tries, returned: skip.returned, threw: skip.threw, result: skip.result, detailsOmitted: true } })
    return result
  }
  const requireInteraction = reason => {
    if (interaction !== reason) event('interaction', { code: 'CAPTURE_REQUIRES_INTERACTION', reason: `CAPTURE_REQUIRES_INTERACTION: ${reason}` })
    interaction = reason
  }
  if (location.hostname === 'consent.youtube.com') {
    const reject = () => { if (!adapter.rejectConsent()) requireInteraction('Resuelve el consentimiento en la ventana de YouTube') }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reject, { once: true })
    else reject()
    return
  }
  const experimental = window.__musifyProgressiveExperiment === true
  const holdbackSeconds = experimental && Number.isFinite(window.__musifyHoldbackSeconds) ? window.__musifyHoldbackSeconds : 1.5
  const maxBytes = Number.isSafeInteger(window.__musifyMaxBytes) && window.__musifyMaxBytes > 0 ? window.__musifyMaxBytes : 96 * 1024 * 1024
  const tracker = new core.ProgressiveTracker({ epoch, experimental, holdbackSeconds, maxBytes, onDiagnostic: data => {
    if (failed) return
    if (data.source && tracker.sources.get(data.source)?.endedEpoch === epoch) return
    const now = performance.now()
    if (data.code || now - lastDiagnostic >= 1000) { lastDiagnostic = now; event('diagnostic', data) }
  } })
  try { capture = core.install({ tracker, forcePlaybackRateOne: true,
    onBeforeDetach: (media, snapshot) => beforeDetach(media, snapshot),
    onRateAttempt: (media, attempt) => {
      if (failed || finalizedEpoch === epoch) return
      const identity = adapter.classify(media)
      const { phase: operation, ...details } = attempt
      event('diagnostic', { state: identity.state, source: capture?.sourceOf(media)?.id ?? null, position: media.currentTime, duration: media.duration, playbackRate: media.playbackRate, browserNow: performance.now(), reason: diagnosticReason({ phase: 'rate-guard', operation, ...details }) })
    },
  }) }
  catch (e) { return problem(e.code || 'CAPTURE_UNSUPPORTED_PIPELINE', e.message, false) }
  const toBase64 = bytes => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error('Could not encode captured audio'))
    reader.readAsDataURL(new Blob([bytes]))
  })
  const attached = new WeakSet(), waiting = new WeakMap(), presented = new WeakMap(), lastIdentity = new WeakMap()
  let previousSources = new WeakMap()
  let unsupportedAt = null
  const publish = (source, snapshot) => {
    const units = tracker.pull(source, snapshot)
    for (const unit of units) {
      const { data, ...metadata } = unit
      metadata.initKey = `${generation}:${metadata.initKey}`
      event('diagnostic', { ...metadata, state: 'content', verified: true, bytesQuarantined: tracker.bytes })
      enqueue({ epoch: unit.epoch }, async () => ({ kind: 'seg', ...metadata, verified: true, classification: 'content', ad: false, data: await toBase64(data) }))
    }
    if (units.length) event('coverage', { ranges: tracker.coverage, eof: false, complete: false, bytesQuarantined: tracker.bytes })
  }
  const terminalIdentity = (media, source, snapshot, current) => {
    const prior = presented.get(source), now = performance.now()
    if (prior && prior.element === media && prior.epoch === epoch && !source.error && source.state === 'content' && source.seen.size === 1 && snapshot.ended === true && snapshot.paused === true && snapshot.sourceEnded === true && snapshot.seeking === false && snapshot.position === snapshot.duration && now >= prior.now && now - prior.now <= 500) {
      if (current.state !== 'content') event('diagnostic', { state: 'content', source: source.id, reason: diagnosticReason({ phase: 'terminal-identity', message: `Source confirmed before presentation ended; terminal identity=${current.state}` }) })
      return prior.identity
    }
    return current
  }
  const reportIdentity = (media, source, identity) => {
    const previous = lastIdentity.get(media)
    const current = { state: identity.state, source: source?.id ?? null, epoch, position: media.currentTime, browserNow: performance.now() }
    lastIdentity.set(media, current)
    adapter.observeSkip?.({ ...current, now: current.browserNow, paused: media.paused, seeking: media.seeking, readyState: media.readyState })
    if (!previous || previous.state !== current.state || previous.source !== current.source || previous.epoch !== epoch) {
      // Report observed boundaries without inventing the unobserved tail of an ad.
      event('diagnostic', { ...current, duration: media.duration, playbackRate: media.playbackRate, bytesQuarantined: tracker.bytes, reason: diagnosticReason({ phase: 'identity-transition', previous: previous ?? null, paused: media.paused, evidence: identity.evidence ?? identity.reason }) })
    }
  }
  const finish = (media, source, snapshot, identity) => {
    if (source.endedEpoch === epoch) return true
    const inventory = tracker.inventory(source, true), settings = source.buffers[0].timelineSettings
    const end = inventory.samples.reduce((end, s) => Math.max(end, tracker.sampleRange(s, settings).end), -Infinity)
    if (!Number.isFinite(end)) return false
    if (!core.timeAtOrAfter(snapshot.position, end) && !core.nativeFinalClockCandidate(snapshot, end)) {
      // Even sub-millisecond codec quantization is not proof of an unpresented tail.
      // A running source may reach it on the next observation. A native terminal
      // clock before it is explicit incompleteness. The sole exception is native
      // microsecond representation at a real terminal EOF; tracker.finish below
      // must certify it before pull may deliver that last sample.
      if (snapshot.ended) throw new core.CaptureError('CAPTURE_UNPRESENTED_BYTES', `Native ended before the final coded sample: clock=${snapshot.position}, end=${end}, duration=${snapshot.duration}, ended=${snapshot.ended}, paused=${snapshot.paused}, eof=${snapshot.sourceEnded}, successfulEndOfStream=${snapshot.successfulEndOfStream}, sourceReadyState=${snapshot.sourceReadyState}, native=${JSON.stringify(snapshot.audioRanges)}`)
      return false
    }
    // Normal mode verifies the complete clean history BEFORE putting any bytes in
    // the native ledger. A timed holdback cannot make delayed ad labels trustworthy.
    tracker.finish(source, snapshot)
    source.endedEpoch = epoch
    finalizedEpoch = epoch
    publish(source, snapshot)
    const proof = tracker.finish(source, snapshot)
    if (proof.certificate) proof.certificate.initKey = `${generation}:${proof.certificate.initKey}`
    media.pause()
    event('coverage', proof)
    event('ended', { ...proof, state: 'content', source: source.id, s: source.buffers[0].id, title: identity.title, author: identity.author, why: 'Official EOF and observed presentation ranges; completeness is the coverage union' })
    // Native ownership retires windows. Keep this source usable for a cache-miss seek.
    return true
  }
  const beforeDetach = (media, snapshot) => {
    const source = snapshot?.source
    if (failed || finalizedEpoch === epoch || pendingSeek || !source || source.endedEpoch === epoch) return
    if (source.state === 'ad' && source.seen.size === 1 && source.seen.has('ad')) {
      event('diagnostic', { state: 'ad', source: source.id, position: snapshot.position, duration: snapshot.duration, playbackRate: snapshot.playbackRate, browserNow: performance.now(), bytesQuarantined: tracker.bytes, reason: diagnosticReason({ phase: 'ad-before-detach', operation: snapshot.operation, nativeEnded: snapshot.ended, sourceEnded: snapshot.sourceEnded }) })
      return
    }
    if (!source.seen.has('content')) return
    const identity = terminalIdentity(media, source, snapshot, adapter.classify(media))
    event('diagnostic', { state: source.state, source: source.id, reason: diagnosticReason({ phase: 'before-detach', message: 'Before source detach', position: snapshot.position, duration: snapshot.duration, eof: snapshot.sourceEnded, nativeEnded: snapshot.ended, audioRanges: snapshot.audioRanges }) })
    try {
      tracker.observe(source, identity, { ...snapshot, now: performance.now(), element: media })
      if (source.error) throw source.error
      if ((snapshot.sourceEnded || snapshot.ended) && finish(media, source, snapshot, identity)) return
      problem('CAPTURE_PARTIAL_PRESENTATION', `Source detached before verified EOF; confirmed ranges remain partial: source=${source.id}, position=${snapshot.position}, duration=${snapshot.duration}`)
    } catch (e) { problem(e.code || 'CAPTURE_PARTIAL_PRESENTATION', `${e.message}; detach=${snapshot.operation}, position=${snapshot.position}, eof=${snapshot.sourceEnded}`) }
  }
  const maybeSeek = (media, source, identity) => {
    if (!pendingSeek || pendingSeek.assigned || identity.state !== 'content' || source.error || !Number.isFinite(media.duration) || media.duration <= 0) return false
    if (pendingSeek.at >= media.duration) { problem('CAPTURE_INVALID_SEEK', 'Requested seek is outside the official duration', false); return true }
    let preroll = 0.2
    try {
      const inventory = tracker.inventory(source)
      if (inventory.samples.length) {
        const maxPacket = inventory.samples.reduce((max, s) => Math.max(max, s.end - s.start), 0)
        preroll = source.buffers[0].webm ? Math.max(0.08, inventory.seekPreRoll ?? 0) + maxPacket : 2 * maxPacket
      }
    } catch { /* Warmup is observed afresh; it does not invent a sample inventory. */ }
    const start = Math.max(0, pendingSeek.at - preroll)
    tracker.seek.at = start
    // Bind the source before its standard setter, then discard the OLD clock anchor.
    tracker.observe(source, identity, { position: media.currentTime, duration: media.duration, now: performance.now(), element: media, playbackRate: 1 })
    source.observations = []; source.progress.ranges = []
    pendingSeek.assigned = true; pendingSeek.start = start
    media.playbackRate = 1
    try { media.currentTime = start } catch (e) { problem('CAPTURE_SEEK_FAILED', String(e)); return true }
    media.play().catch(() => requireInteraction('Pulsa reproducir en YouTube para continuar'))
    return true
  }
  const observe = (media, endedEvent = false) => {
    if (failed || finalizedEpoch === epoch || (endedEvent && media.ended !== true)) return
    const source = capture.sourceOf(media)
    if (source?.endedEpoch === epoch) return
    const previous = previousSources.get(media)
    if (previous?.endedEpoch === epoch) return
    if (previous && previous !== source && previous.seen.has('content') && previous.endedEpoch !== epoch) {
      const last = previous.observations.at(-1), detail = { source: previous.id, duration: last?.duration, lastPosition: last?.position }
      try { const parsed = tracker.inventory(previous); detail.rangeEnd = parsed.codedEnd ?? parsed.end } catch (e) { detail.parseError = e.message }
      return problem('CAPTURE_PARTIAL_PRESENTATION', `Source was replaced before verified EOF: ${JSON.stringify(detail)}`)
    }
    const current = adapter.classify(media)
    const snapshot = capture.snapshotOf(media), identity = source ? terminalIdentity(media, source, snapshot, current) : current
    reportIdentity(media, source, identity)
    if (current.ambiguous) return problem('CAPTURE_IDENTITY_UNCERTAIN', current.reason)
    if (!source) {
      if (!media.paused && media.readyState >= 2) {
        unsupportedAt ??= performance.now()
        if (performance.now() - unsupportedAt >= 3000) problem('CAPTURE_UNSUPPORTED_PIPELINE', 'Media is outside the observed main-thread MSE sources', false)
      }
      return
    }
    unsupportedAt = null
    if (maybeSeek(media, source, current)) return
    if (media.seeking || media.readyState < 1) return
    if (current.state === 'unknown' && media.currentTime === 0 && !source.observations.length && !source.error) {
      media.pause()
      const since = waiting.get(media) ?? performance.now(); waiting.set(media, since)
      if (performance.now() - since > 10000) problem('CAPTURE_IDENTITY_UNCERTAIN', `Initial identity did not become available: ${current.reason}`)
      return
    }
    if (waiting.has(media) && current.state !== 'unknown') { waiting.delete(media); media.play().catch(() => requireInteraction('Pulsa reproducir en YouTube para continuar')) }
    if (current.state === 'content' && source.seen.size === 0 && !source.observations.length && !pendingSeek && !source.error && media.currentTime > 0) {
      // Metadata/playing callbacks can first arrive a few milliseconds after sound.
      // Re-present the beginning while still quarantined instead of inventing coverage.
      media.pause(); tracker.restartBeginning(source)
      pendingSeek = { at: 0, start: 0, startup: true, assigned: true }
      source.state = 'content'; source.element = media
      try { media.currentTime = 0 } catch (e) { return problem('CAPTURE_SEEK_FAILED', String(e)) }
      return
    }
    if (pendingSeek?.startup && !media.seeking && media.currentTime !== 0) return problem('CAPTURE_UNOBSERVED_BEGINNING', 'The paused startup seek did not expose time zero; no missing sample is inferred')
    if (media.paused && !media.ended && media.currentTime !== 0 && !pendingSeek) return
    try {
      tracker.observe(source, identity, { ...snapshot, now: performance.now(), element: media })
      if (source.error && (identity.state !== 'ad' || source.seen.has('content'))) throw source.error
      previousSources.set(media, source)
      if (identity.state === 'ad') {
        if (snapshot.ended === true) event('diagnostic', { state: 'ad', source: source.id, position: snapshot.position, duration: snapshot.duration, playbackRate: snapshot.playbackRate, browserNow: performance.now(), bytesQuarantined: tracker.bytes, reason: diagnosticReason({ phase: 'ad-native-ended', sourceEnded: snapshot.sourceEnded }) })
        media.playbackRate = 1; adapter.skipAd(media); return
      }
      if (identity.state !== 'content') return
      if (!media.paused && !media.ended) presented.set(source, { identity, element: media, epoch, now: performance.now() })
      if (pendingSeek?.assigned) {
        event('seeked', { requestId: pendingSeek.requestId, requestedAt: pendingSeek.at, position: media.currentTime, warmupStart: pendingSeek.start })
        const startup = pendingSeek.startup
        pendingSeek = null
        if (startup) media.play().catch(() => requireInteraction('Pulsa reproducir en YouTube para continuar'))
      }
      if (!started) { started = true; event('playing', { title: identity.title, author: identity.author, duration: media.duration }); event('meta', { title: identity.title, author: identity.author, duration: media.duration }) }
      publish(source, snapshot)
      if (snapshot.sourceEnded || snapshot.ended) finish(media, source, snapshot, identity)
    } catch (e) {
      if (adapter.skipSummary?.()?.result === 'request-threw') event('diagnostic', { reason: diagnosticReason({ phase: 'skip-ad', outcome: 'exception' }) })
      problem(e.code || 'CAPTURE_PROGRESSIVE_ERROR', e.message)
    }
  }
  const attach = media => {
    if (attached.has(media)) return
    attached.add(media); media.muted = true; media.defaultPlaybackRate = 1; media.playbackRate = 1
    media.addEventListener('encrypted', () => problem('CAPTURE_ENCRYPTED_MEDIA', 'Encrypted media is not capturable clear audio', false))
    for (const name of ['loadstart', 'emptied', 'loadedmetadata', 'playing', 'timeupdate', 'durationchange', 'seeked']) media.addEventListener(name, () => observe(media))
    media.addEventListener('ended', () => observe(media, true))
    media.addEventListener('seeking', () => { if (!pendingSeek?.assigned && capture.sourceOf(media)?.state === 'content') problem('CAPTURE_PARTIAL_PRESENTATION', 'Unexpected seeking invalidates the current observation interval') })
  }
  const events = typeof window.addEventListener === 'function' ? window : document
  for (const name of ['ended', 'timeupdate', 'loadedmetadata', 'loadeddata', 'playing', 'seeked']) events.addEventListener?.(name, e => {
    if (['VIDEO', 'AUDIO'].includes(e.target?.tagName)) { attach(e.target); observe(e.target, name === 'ended') }
  }, true)
  window.__musifySeek = request => {
    if (failed) return
    try {
      tracker.beginEpoch(request?.epoch, request?.at)
      epoch = tracker.epoch
      // An old FileReader must not hold a new seek behind its cancelled queue. Its
      // continuation still checks the epoch and cannot publish into the new one.
      queue = Promise.resolve()
      previousSources = new WeakMap()
      pendingSeek = { at: request.at, requestId: request.requestId, assigned: false }
      for (const media of document.querySelectorAll('audio,video')) { media.playbackRate = 1; observe(media) }
      event('progress', { position: null, requestedAt: request.at, requestId: request.requestId, bytesQuarantined: tracker.bytes })
    } catch (e) { problem(e.code || 'CAPTURE_SEEK_FAILED', e.message) }
  }
  tick = setInterval(() => {
    if (failed || finalizedEpoch === epoch) return
    const now = performance.now(), issue = adapter.interaction()
    if (issue?.code === 'CAPTURE_REQUIRES_INTERACTION') requireInteraction(issue.reason)
    else {
      interaction = ''
      for (const media of document.querySelectorAll('audio,video')) {
        attach(media); media.muted = true
        if (media.playbackRate !== 1) media.playbackRate = 1
        observe(media)
        if (failed) return
        if (!waiting.has(media) && capture.sourceOf(media)?.endedEpoch !== epoch && media.paused && !media.ended) media.play().catch(() => {})
      }
    }
    if (now - lastBeat >= 1000) {
      lastBeat = now
      const auth = adapter.sessionState()
      event('auth', { ...auth, changed: auth.state !== lastAuth }); lastAuth = auth.state
      const states = [...document.querySelectorAll('audio,video')].map(media => ({ media, identity: adapter.classify(media) }))
      const current = states.find(s => s.identity.state === 'content') ?? states.find(s => s.identity.state === 'ad') ?? states[0]
      event('progress', { position: current?.identity.state === 'content' ? current.media.currentTime : null, bytesQuarantined: tracker.bytes, ranges: tracker.coverage })
      if (current && capture.sourceOf(current.media)?.endedEpoch !== epoch) event('diagnostic', { state: current.identity.state, source: capture.sourceOf(current.media)?.id ?? null, position: current.media.currentTime, duration: current.media.duration, playbackRate: current.media.playbackRate, browserNow: now, bytesQuarantined: tracker.bytes, reason: diagnosticReason({ phase: 'progressive', holdbackSeconds: experimental ? holdbackSeconds : null, paused: current.media.paused, rate: current.media.playbackRate, rateGuard: capture.rateStatistics, evidence: current.identity.evidence ?? current.identity.reason }) })
      if (issue && issue.code !== 'CAPTURE_REQUIRES_INTERACTION') problem(issue.code, issue.reason)
    }
  }, 100)
  const observer = new MutationObserver(() => { for (const media of document.querySelectorAll('audio,video')) attach(media) })
  observer.observe(document, { childList: true, subtree: true })
  for (const media of document.querySelectorAll('audio,video')) attach(media)
  const auth = adapter.sessionState(); event('auth', auth); lastAuth = auth.state
})()
