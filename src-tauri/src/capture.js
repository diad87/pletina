// Capture API 2 orchestrator; bundled after capture-core.js and capture-youtube.js.
// Diagnostic prototype: 1x, entire-source quarantine, no low-latency guarantee.
(() => {
  const bridge = window.chrome?.webview
  if (!bridge || window.__musifyCapture) return
  if (window.top && window.top !== window) return
  if (!['music.youtube.com', 'consent.youtube.com'].includes(location.hostname)) return
  window.__musifyCapture = true
  const target = window.__musifyTarget || new URLSearchParams(location.search).get('v')
  const generation = window.__musifyGeneration
  let sequence = 0
  let queue = Promise.resolve()
  // Navigation creates a new JS realm but retains the Rust generation. Use epoch microticks
  // and allow gaps so consent -> music cannot reset the per-generation ordering.
  const post = (message) => {
    sequence = Math.max(sequence + 1, Date.now() * 1000)
    bridge.postMessage('musify:' + JSON.stringify({ musify: 1, v: target, generation, sequence, ...message }))
  }
  const event = (type, data = {}) => { queue = queue.then(() => post({ kind: 'event', type, ...data })); return queue }
  const adapter = globalThis.__musifyCaptureYouTube?.create({ target })
  if (location.hostname === 'consent.youtube.com') {
    const reject = () => {
      if (!adapter?.rejectConsent()) event('interaction', { code: 'CAPTURE_REQUIRES_INTERACTION', reason: 'CAPTURE_REQUIRES_INTERACTION: Resuelve el consentimiento en la ventana de YouTube' })
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reject, { once: true })
    else reject()
    return
  }
  if (!target) return
  let tick = null
  let finished = false
  let started = false
  let waitingInteraction = ''
  const requestInteraction = (reason) => {
    if (waitingInteraction !== reason) event('interaction', { code: 'CAPTURE_REQUIRES_INTERACTION', reason: `CAPTURE_REQUIRES_INTERACTION: ${reason}` })
    waitingInteraction = reason
  }
  const error = (code, reason) => {
    if (finished) return
    finished = true
    if (tick) clearInterval(tick)
    for (const media of document.querySelectorAll('audio,video')) media.pause()
    event('error', { code, reason: String(reason).startsWith(`${code}:`) ? String(reason) : `${code}: ${reason}` })
    queue.then(() => location.replace('about:blank'))
  }
  const core = globalThis.__musifyCaptureCore
  if (!core || !adapter || !Number.isSafeInteger(generation)) return error('CAPTURE_PROTOCOL_MISMATCH', 'Capture API 2 bundle or generation is missing')
  if (Number(/musify-t=([\d.]+)/.exec(location.hash)?.[1] ?? 0) > 0) return error('CAPTURE_PARTIAL_PRESENTATION', 'The diagnostic gate must observe the song from the beginning')
  let lastDiagnostic = 0
  const tracker = new core.SessionTracker({
    onDiagnostic: (data) => {
      if (finished) return
      const now = performance.now()
      if (data.code || now - lastDiagnostic >= 1000) { lastDiagnostic = now; event('diagnostic', data) }
    },
  })
  let capture
  try { capture = core.install({ tracker, onBeforeDetach: (media, snapshot) => beforeDetach(media, snapshot) }) } catch (e) { return error(e.code || 'CAPTURE_UNSUPPORTED_PIPELINE', e.message) }
  const toBase64 = (bytes) => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error('Could not encode captured audio'))
    reader.readAsDataURL(new Blob([bytes]))
  })
  const mediaSeen = new WeakSet()
  const pendingStarts = new WeakMap()
  const previousSources = new WeakMap()
  const presentedIdentities = new WeakMap()
  const startedAt = performance.now()
  let unsupportedAt = null
  let lastBeat = 0
  const waitAtStart = (media) => {
    const source = capture.sourceOf(media)
    let pending = pendingStarts.get(media)
    if (pending && pending.source !== source) { pendingStarts.delete(media); pending = null }
    const identity = adapter.classify(media)
    if (identity.ambiguous) { error('CAPTURE_IDENTITY_UNCERTAIN', `Multiple media elements cannot share global identity: ${identity.reason || ''}`); return true }
    if (!pending && source && !source.error && source.state === 'unknown' && source.observations.length === 0 && media.currentTime === 0 && identity.state === 'unknown') {
      media.pause()
      pending = { source, since: performance.now(), reported: -Infinity }
      pendingStarts.set(media, pending)
    }
    if (!pending) return false
    if (media.currentTime !== 0) { error('CAPTURE_IDENTITY_UNCERTAIN', 'Media advanced while waiting for initial identity'); return true }
    if (identity.state !== 'unknown') {
      pendingStarts.delete(media)
      media.play().catch(() => requestInteraction('Pulsa reproducir en YouTube para continuar'))
      return false
    }
    media.pause()
    const now = performance.now()
    if (now - pending.reported >= 1000) {
      pending.reported = now
      event('diagnostic', { state: 'unknown', source: source.id, position: 0, duration: media.duration, bytesQuarantined: tracker.bytes, reason: `Waiting at time zero for identity: ${identity.reason || ''}` })
    }
    if (now - pending.since > 10000) error('CAPTURE_IDENTITY_UNCERTAIN', `Initial identity did not become available at time zero: ${identity.reason || ''}`)
    return true
  }
  const release = (media, identity, confirmed, duration, why) => {
    finished = true
    clearInterval(tick)
    media.pause()
    event('diagnostic', { state: 'content', source: confirmed.source, s: confirmed.session, bytesQuarantined: tracker.bytes, frames: confirmed.timeline.frames.length, rangeStart: confirmed.timeline.start, rangeEnd: confirmed.timeline.end, timelineSettings: confirmed.timelineSettings, verified: true })
    // Drain all initialized media before sending ended, so Rust cannot close the window early.
    for (const bytes of confirmed.chunks) {
      for (let at = 0; at < bytes.length; at += 1024 * 1024) {
        const part = bytes.subarray(at, at + 1024 * 1024)
        queue = queue.then(async () => post({ kind: 'seg', s: confirmed.session, source: confirmed.source, mime: confirmed.mime, classification: 'content', ad: false, data: await toBase64(part) }))
      }
    }
    event('ended', { source: confirmed.source, s: confirmed.session, title: identity.title, author: identity.author, duration, why })
    queue.then(() => location.replace('about:blank')).catch((e) => post({ kind: 'event', type: 'error', code: 'CAPTURE_BRIDGE_ERROR', reason: String(e) }))
  }
  const completedPresentationIdentity = (media, source, snapshot, currentIdentity) => {
    const previous = presentedIdentities.get(source), now = performance.now()
    // Once native playback has ended, page labels may already describe a postroll. They
    // are no longer evidence about presentation of the immutable source that just ended.
    // This never repairs a source observed as unknown/ad while it was actually playing.
    if (!previous || previous.element !== media || source.element !== media || source.error || source.state !== 'content' || source.seen.size !== 1 || !source.seen.has('content') || !snapshot?.ended || !snapshot.paused || !snapshot.sourceEnded || snapshot.seeking !== false || snapshot.position !== snapshot.duration || now < previous.now || now - previous.now > 500) return null
    event('diagnostic', { state: 'content', source: source.id, bytesQuarantined: tracker.bytes, reason: `Source confirmed before presentation ended; terminal labels are not a new presentation: ${JSON.stringify({ position: snapshot.position, duration: snapshot.duration, previousPosition: previous.position, ageMs: now - previous.now, terminalIdentity: currentIdentity.state, terminalEvidence: currentIdentity.evidence ?? currentIdentity.reason })}` })
    return previous.identity
  }
  const beforeDetach = (media, snapshot) => {
    if (finished) return
    const { source, ...timing } = snapshot
    const currentIdentity = adapter.classify(media)
    const completedIdentity = completedPresentationIdentity(media, source, snapshot, currentIdentity)
    const identity = completedIdentity ?? currentIdentity
    const detail = { source: source.id, ...timing, identity: currentIdentity.state, confirmedBeforeEnded: !!completedIdentity }
    try {
      const timeline = tracker.inspect(source)
      Object.assign(detail, { frames: timeline.frames.length, rangeStart: timeline.start, rangeEnd: timeline.end, quantum: timeline.quantum, containerAudibleRange: timeline.containerAudibleRange, lastBlock: timeline.lastBlock })
    } catch (e) { detail.parseError = String(e.message) }
    event('diagnostic', { state: source.state, source: source.id, bytesQuarantined: tracker.bytes, reason: `Before source detach: ${JSON.stringify(detail)}` })
    // Read the old source synchronously, while currentTime and SourceBuffer.buffered still
    // refer to it. A src assignment is not an ended event: its clock must cover EVERY frame.
    tracker.observe(source, identity, { position: snapshot.position, duration: snapshot.duration, now: performance.now(), element: media })
    let confirmed
    try { confirmed = tracker.seal(source, snapshot) } catch (e) { return error(e.code || 'CAPTURE_PARTIAL_PRESENTATION', `${e.message}; beforeDetach=${JSON.stringify(detail)}`) }
    release(media, identity, confirmed, snapshot.duration, completedIdentity ? 'source confirmed before presentation ended; complete immutable source verified before detach' : 'complete audio presentation verified before source detach')
  }
  const observe = (media, ended = false) => {
    if (finished) return
    // A page can dispatch a synthetic event; only the native media state is completion.
    if (ended && media.ended !== true) return
    const source = capture.sourceOf(media)
    const previous = previousSources.get(media)
    if (previous && previous.source !== source && previous.source.seen.has('content') && !previous.source.sealed) {
      const replacement = { source: previous.source.id, nextSource: source?.id ?? null, lastPosition: previous.position, duration: previous.duration }
      try {
        const timeline = tracker.inspect(previous.source)
        Object.assign(replacement, { frames: timeline.frames.length, rangeStart: timeline.start, rangeEnd: timeline.end, quantum: timeline.quantum })
      } catch (e) { replacement.parseError = String(e.message) }
      event('diagnostic', { state: 'content', bytesQuarantined: tracker.bytes, reason: `Source replacement before ended: ${JSON.stringify(replacement)}` })
      return error('CAPTURE_PARTIAL_PRESENTATION', `Source changed without an observed ended event: ${JSON.stringify(replacement)}`)
    }
    if (!ended && waitAtStart(media)) return
    if ((media.paused && !ended) || media.readyState < 2) return
    const problem = adapter.interaction()
    if (problem?.code === 'CAPTURE_REQUIRES_INTERACTION') { requestInteraction(problem.reason); return }
    waitingInteraction = ''
    const currentIdentity = adapter.classify(media)
    if (!source) {
      unsupportedAt ??= performance.now()
      if (performance.now() - unsupportedAt > 3000) error('CAPTURE_UNSUPPORTED_PIPELINE', 'Media is outside the observed main-thread MSE sources (worker, native HLS or another path)')
      return
    }
    unsupportedAt = null
    const finalSnapshot = ended ? capture.snapshotOf(media, 'ended') : null
    const completedIdentity = finalSnapshot && completedPresentationIdentity(media, source, finalSnapshot, currentIdentity)
    const identity = completedIdentity ?? currentIdentity
    const previousObservation = source.observations.at(-1)
    const cachedTimeline = source.projectedTimeline?.value ?? source.parsedTimeline
    tracker.observe(source, identity, { position: media.currentTime, duration: media.duration, now: performance.now(), ended, element: media })
    // Uncapturable advertisements can run in the official player; their bytes are discarded.
    if (source.error && (identity.state !== 'ad' || source.seen.has('content'))) {
      const { source: _, ...snapshot } = capture.snapshotOf(media, 'observation-error')
      const detail = { source: source.id, ...snapshot, previousObservation, ...(cachedTimeline ? { rangeStart: cachedTimeline.start, rangeEnd: cachedTimeline.end, frames: cachedTimeline.frames.length, quantum: cachedTimeline.quantum, containerAudibleRange: cachedTimeline.containerAudibleRange, lastBlock: cachedTimeline.lastBlock } : {}) }
      return error(source.error.code, `${source.error.message}; presentation=${JSON.stringify(detail)}`)
    }
    if (identity.state === 'ad' && !ended) adapter.skipAd(media)
    if (identity.state === 'content' && !media.paused && !media.ended && !ended && !source.error) presentedIdentities.set(source, { identity, element: media, position: media.currentTime, now: performance.now() })
    previousSources.set(media, { source, position: media.currentTime, duration: media.duration })
    if (identity.state === 'content' && !started) {
      started = true
      event('playing', { title: identity.title, author: identity.author, duration: media.duration })
      event('meta', { title: identity.title, author: identity.author, duration: media.duration })
    }
    if (identity.state !== 'content') return
    const terminal = finalSnapshot ?? capture.snapshotOf(media, 'audio-eof')
    if (!ended) {
      if (!terminal?.sourceEnded) return
      let timeline
      try { timeline = tracker.inspect(source, terminal.audioRanges) } catch (e) { return error(e.code || 'CAPTURE_IDENTITY_UNCERTAIN', e.message) }
      if (terminal.position + timeline.quantum + 0.000001 < timeline.end) return
    }
    let confirmed
    try { confirmed = tracker.seal(source, terminal) } catch (e) { return error(e.code || 'CAPTURE_IDENTITY_UNCERTAIN', e.message) }
    release(media, identity, confirmed, media.duration, completedIdentity ? 'source confirmed before presentation ended; complete immutable source passed the diagnostic gate' : ended ? 'complete source passed the diagnostic gate' : 'official EOF and complete audio presentation passed the diagnostic gate')
  }
  // Non-bubbling media events still traverse Window -> Document -> target in capture.
  // Register at Window during initialization, before page listeners on any of those nodes.
  const captureEvents = typeof window.addEventListener === 'function' ? window : document
  captureEvents.addEventListener?.('ended', (e) => {
    if (e.target?.tagName === 'VIDEO' || e.target?.tagName === 'AUDIO') observe(e.target, true)
  }, true)
  captureEvents.addEventListener?.('timeupdate', (e) => {
    if (e.target?.tagName === 'VIDEO' || e.target?.tagName === 'AUDIO') { attach(e.target); observe(e.target) }
  }, true)
  const attach = (media) => {
    if (mediaSeen.has(media)) return
    mediaSeen.add(media)
    media.muted = true
    media.playbackRate = 1
    media.addEventListener('encrypted', () => error('CAPTURE_ENCRYPTED_MEDIA', 'Encrypted playback is not a capturable clear-audio source'))
    for (const name of ['loadstart', 'emptied', 'loadedmetadata', 'playing', 'timeupdate', 'durationchange']) media.addEventListener(name, () => observe(media))
    media.addEventListener('ended', () => observe(media, true))
    media.addEventListener('seeking', () => {
      const source = capture.sourceOf(media)
      if (source?.state === 'content') error('CAPTURE_PARTIAL_PRESENTATION', 'Seeking invalidates the complete-presentation diagnostic gate')
    })
  }
  window.__musifySeek = () => error('CAPTURE_PARTIAL_PRESENTATION', 'Seeking is not supported by the complete-source diagnostic gate')
  tick = setInterval(() => {
    if (finished) return
    const now = performance.now()
    const problem = adapter.interaction()
    if (problem?.code === 'CAPTURE_REQUIRES_INTERACTION') {
      requestInteraction(problem.reason)
      if (now - lastBeat >= 1000) { lastBeat = now; event('progress', { position: null, bytesQuarantined: tracker.bytes }) }
      return
    }
    waitingInteraction = ''
    for (const media of document.querySelectorAll('audio,video')) {
      attach(media)
      media.muted = true
      if (media.playbackRate !== 1) media.playbackRate = 1
      observe(media)
      if (finished) return
      if (pendingStarts.has(media)) continue
      if (media.paused && !media.ended) media.play().catch(() => {})
    }
    if (now - lastBeat >= 1000) {
      lastBeat = now
      const states = [...document.querySelectorAll('audio,video')].map(media => ({ media, identity: adapter.classify(media) }))
      const playingContent = states.find(s => s.identity.state === 'content')
      event('progress', { position: playingContent?.media.currentTime ?? null, bytesQuarantined: tracker.bytes })
      if (!playingContent) {
        const current = states.find(s => s.identity.state === 'ad') ?? states[0]
        const media = current?.media, identity = current?.identity
        event('diagnostic', { state: identity?.state ?? 'unknown', source: media ? capture.sourceOf(media)?.id ?? null : null, position: Number.isFinite(media?.currentTime) ? media.currentTime : null, duration: Number.isFinite(media?.duration) ? media.duration : null, bytesQuarantined: tracker.bytes, reason: JSON.stringify({ phase: 'waiting-for-content', mediaCount: states.length, paused: media?.paused, ended: media?.ended, readyState: media?.readyState, signals: identity?.signals, evidence: identity?.evidence ?? identity?.reason }) })
      }
    }
    if (now - startedAt > 3000) {
      if (problem) error(problem.code, problem.reason)
    }
  }, 100)
  const observer = new MutationObserver(() => { for (const media of document.querySelectorAll('audio,video')) attach(media) })
  observer.observe(document, { childList: true, subtree: true })
  for (const media of document.querySelectorAll('audio,video')) attach(media)
})()
