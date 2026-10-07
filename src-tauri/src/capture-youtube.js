// Site-specific observations, not a public YouTube contract. Missing signals fail closed.
(() => {
  const normalized = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
  function create({ document = globalThis.document, location = globalThis.location, target, skipDiagnostics = false }) {
    const player = () => document.querySelector('#movie_player')
    const visiblyRendered = (node) => {
      if (!node || node.hidden || !node.getClientRects?.().length) return false
      const style = document.defaultView?.getComputedStyle?.(node)
      return !style || (style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) && style.opacity !== '0')
    }
    const classify = (element) => {
      const p = player()
      const contains = !!p?.contains(element)
      const mediaSessionTitle = normalized(globalThis.navigator?.mediaSession?.metadata?.title)
      if (!p || !contains) return { state: 'unknown', sourceBound: false, signals: [], reason: JSON.stringify({ player: !!p, contains, position: element.currentTime, mediaSessionTitle }) }
      const elements = [...(p.querySelectorAll?.('audio,video') ?? [])]
      const mediaCount = elements.length
      const activeMediaCount = elements.filter((e) => !e.paused && !e.ended && e.readyState >= 2).length
      const anotherActive = elements.some((e) => e !== element && !e.paused && !e.ended && e.readyState >= 2)
      if (activeMediaCount > 1 || anotherActive) return { state: 'unknown', ambiguous: true, sourceBound: true, signals: [], reason: JSON.stringify({ player: true, contains, mediaCount, activeMediaCount, anotherActive, mediaSessionTitle, position: element.currentTime }) }
      let data
      try { data = typeof p.getVideoData === 'function' ? p.getVideoData() ?? {} : {} }
      catch { return { state: 'unknown', sourceBound: true, signals: [], reason: 'player identity unavailable' } }
      const adClassShowing = p.classList.contains('ad-showing'), adClassInterrupting = p.classList.contains('ad-interrupting')
      const adOverlay = p.querySelector('.ytp-ad-player-overlay'), adText = p.querySelector('.ytp-ad-text')
      // Keep classification unchanged until a real trial establishes whether hidden nodes
      // persist. Report presence and rendered visibility separately instead of guessing.
      const adMarker = adClassShowing || adClassInterrupting || !!p.querySelector('.ytp-ad-player-overlay, .ytp-ad-text')
      const adEvidence = { adClassShowing, adClassInterrupting, adOverlayPresent: !!adOverlay, adOverlayVisible: visiblyRendered(adOverlay), adTextPresent: !!adText, adTextVisible: visiblyRendered(adText) }
      if (adMarker || (data.video_id && data.video_id !== target)) {
        const evidence = { player: true, contains, mediaCount, activeMediaCount, adMarker, ...adEvidence, presentedId: data.video_id || null, requestedId: target, position: element.currentTime, mediaDuration: element.duration }
        return { state: 'ad', sourceBound: true, signals: [adMarker ? 'player-ad-marker' : 'different-presented-id'], evidence, reason: JSON.stringify(evidence) }
      }
      const barTitle = normalized(document.querySelector('ytmusic-player-bar .title')?.textContent)
      const playerTitle = normalized(data.title)
      const pageId = new URLSearchParams(location.search).get('v')
      const playerTitleLinks = [...(p.querySelectorAll?.('.ytp-title-link') ?? [])].map((e) => normalized(e.textContent))
      const selected = (mediaCount === 1 && elements[0] === element) || (activeMediaCount === 1 && !element.paused && !element.ended && element.readyState >= 2)
      const matchingBar = !!barTitle && barTitle === playerTitle
      // Observed signed-out layout has no player bar. Require BOTH additional exact signals;
      // a conflicting bar must never be bypassed. These remain provisional site observations.
      const matchingAlternate = !barTitle && playerTitleLinks.length === 1 && playerTitleLinks[0] === playerTitle && mediaSessionTitle === playerTitle
      const identified = selected && data.video_id === target && pageId === target && playerTitle && (matchingBar || matchingAlternate)
      const evidence = { player: true, contains, selected, mediaCount, activeMediaCount, mediaSessionTitle: mediaSessionTitle.slice(0, 120), playerTitleLinks: playerTitleLinks.slice(0, 3).map((title) => title.slice(0, 120)), presentedId: data.video_id || null, requestedId: target, pageId, playerTitle: playerTitle.slice(0, 80), barTitle: barTitle.slice(0, 80), adMarker, ...adEvidence, position: element.currentTime, mediaDuration: element.duration }
      return {
        state: identified ? 'content' : 'unknown', sourceBound: true,
        signals: identified ? ['presented-video-id', 'watch-location', ...(matchingBar ? ['player-bar-title'] : ['player-title-link', 'media-session-title'])] : [],
        title: playerTitle, author: normalized(data.author),
        evidence, reason: identified ? undefined : JSON.stringify(evidence),
      }
    }
    const interaction = () => {
      const text = normalized(document.querySelector('.ytp-error, yt-playability-error-supported-renderers, ytmusic-player .error')?.textContent)
      if (!text) return null
      const requiresUser = /sign in|log in|inici[ae] sesi[oó]n|iniciar sesi[oó]n|captcha|confirm|verif|comprueba|edad|age|bot/i.test(text)
      return { code: requiresUser ? 'CAPTURE_REQUIRES_INTERACTION' : 'CAPTURE_PLAYBACK_ERROR', reason: text.slice(0, 200) }
    }
    const rejectConsent = () => {
      if (location.hostname !== 'consent.youtube.com') return false
      const form = [...document.forms].find((f) => f.querySelector('input[name="set_eom"][value="true"]'))
      const button = form?.querySelector('button') || [...document.querySelectorAll('button')].find((b) => /rechazar|reject|ablehnen|refuser|rifiuta/i.test(b.textContent || ''))
      if (button) button.click()
      return !!button
    }
    const clickedAt = new WeakMap()
    const skipSelectors = ['.ytp-skip-ad-button', '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern']
    const skip = { calls: 0, tries: 0, returned: 0, threw: 0, clickEvents: 0, canceled: 0, result: null, matches: [0, 0, 0], outcomes: { notAd: 0, noMatch: 0, ineligible: 0, cooldown: 0 } }
    let sampledAt = -Infinity, observation = null
    const diagnosticNow = () => Math.round(globalThis.performance?.now?.() ?? 0)
    // Diagnostic reads/listeners must never determine which button is clicked or
    // turn a successful native click into an exception. No markup or URL attributes.
    const diagnose = work => { if (skipDiagnostics) { try { work() } catch { /* Optional observation only. */ } } }
    const publicText = (value, limit) => normalized(String(value ?? '').slice(0, 512)).replace(/\b(?:https?|blob|data):\S*/gi, '[url]').slice(0, limit)
    const sampleControls = (p, buttons, selected) => diagnose(() => {
      const now = diagnosticNow()
      if (now - sampledAt < 5000) return
      sampledAt = now; skip.sampleAt = now; skip.sampleSource = observation?.source ?? null
      skip.matches = skipSelectors.map(selector => buttons.filter(b => b.matches?.(selector)).length)
      // If the known controls are absent, inspect a bounded sample of public player
      // controls for a future diagnosis. These fallback controls are NEVER clicked.
      const otherControls = buttons.length ? [] : p?.querySelectorAll?.('button, [role="button"]') ?? []
      const candidates = buttons.length ? buttons.slice(0, 4) : Array.from({ length: Math.min(otherControls.length, 32) }, (_, i) => otherControls[i]).filter(visiblyRendered).slice(0, 4)
      skip.controls = candidates.map(b => {
        const style = document.defaultView?.getComputedStyle?.(b), blocked = []
        if (b.disabled) blocked.push('disabled')
        if (b.hidden) blocked.push('hidden')
        if (b.getAttribute?.('aria-disabled') === 'true') blocked.push('aria-disabled')
        if (!b.getClientRects?.().length) blocked.push('no-rect')
        if (style?.display === 'none') blocked.push('display')
        if (['hidden', 'collapse'].includes(style?.visibility)) blocked.push('visibility')
        if (style?.opacity === '0') blocked.push('opacity')
        return { selector: skipSelectors.findIndex(selector => b.matches?.(selector)), selected: b === selected, blocked,
          label: publicText(b.getAttribute?.('aria-label') || b.textContent, 32), role: publicText(b.getAttribute?.('role') || b.tagName, 12),
          classes: publicText(typeof b.className === 'string' ? b.className : '', 40) }
      })
    })
    const observeSkip = value => diagnose(() => {
      const next = { state: value.state, source: value.source ?? null, epoch: value.epoch ?? null, position: value.position, at: Math.round(value.now) }
      skip.observed = { ...next, paused: value.paused, seeking: value.seeking, readyState: value.readyState }
      if (skip.last && !skip.last.after && next.at >= skip.last.at) skip.last.after = { state: next.state, source: next.source, position: next.position, delayMs: next.at - skip.last.at }
      if (observation && (observation.state !== next.state || observation.source !== next.source || observation.epoch !== next.epoch)) skip.transition = { from: observation.state, fromSource: observation.source, to: next.state, source: next.source, at: next.at, sinceTryMs: skip.last ? next.at - skip.last.at : null }
      observation = next
    })
    const skipSummary = () => {
      if (!skipDiagnostics || (!skip.calls && !observation)) return null
      // Copy, don't expose the mutable diagnostic state. A fixed serialized budget
      // also bounds unusual public labels and very large counter/clock values.
      const summary = JSON.parse(JSON.stringify(skip))
      while (JSON.stringify(summary).length > 1000 && summary.controls?.length) { summary.controls.pop(); summary.controlsOmitted = true }
      if (JSON.stringify(summary).length > 1000) { delete summary.observed; summary.detailsOmitted = true }
      if (JSON.stringify(summary).length > 1000) { delete summary.transition; delete summary.last?.after }
      if (JSON.stringify(summary).length > 1000) return { calls: skip.calls, tries: skip.tries, returned: skip.returned, threw: skip.threw, result: skip.result, detailsOmitted: true }
      return summary
    }
    const skipAd = (element) => {
      diagnose(() => { skip.calls++ })
      if (classify(element).state !== 'ad') { diagnose(() => { skip.result = 'not-ad'; skip.outcomes.notAd++ }); return false }
      const p = player()
      const buttons = [...(p?.querySelectorAll?.(skipSelectors.join(', ')) ?? [])]
      const button = buttons.find((b) => {
        if (b.disabled || b.hidden || b.getAttribute?.('aria-disabled') === 'true' || !b.getClientRects?.().length) return false
        const style = document.defaultView?.getComputedStyle?.(b)
        return !style || (style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) && style.opacity !== '0')
      })
      sampleControls(p, buttons, button)
      if (!button) { diagnose(() => { skip.result = buttons.length ? 'ineligible' : 'no-match'; skip.outcomes[buttons.length ? 'ineligible' : 'noMatch']++ }); return false }
      if (Date.now() - (clickedAt.get(button) ?? -Infinity) < 1000) { diagnose(() => { skip.result = 'cooldown'; skip.outcomes.cooldown++ }); return false }
      clickedAt.set(button, Date.now())
      let seen = null, listening = false, attempt = null
      const onClick = event => { seen = event }
      diagnose(() => {
        skip.tries++; attempt = skip.last = { at: diagnosticNow(), source: observation?.source ?? null, epoch: observation?.epoch ?? null, position: element.currentTime, selector: skipSelectors.findIndex(selector => button.matches?.(selector)), eventSeen: false }
        if (button.addEventListener) { button.addEventListener('click', onClick, { capture: true, passive: true }); listening = true }
      })
      try {
        button.click()
        diagnose(() => { skip.returned++; skip.result = 'click-returned' })
        return true
      } catch (error) {
        diagnose(() => { skip.threw++; skip.result = 'click-threw'; if (attempt) attempt.errorName = publicText(error?.name, 32) })
        throw error
      } finally {
        diagnose(() => {
          if (listening) button.removeEventListener('click', onClick, true)
          if (attempt) { attempt.eventSeen = !!seen; attempt.isTrusted = seen ? seen.isTrusted === true : null; attempt.defaultPrevented = seen ? seen.defaultPrevented === true : null }
          if (seen) { skip.clickEvents++; if (seen.defaultPrevented) skip.canceled++ }
        })
      }
    }
    return { classify, interaction, rejectConsent, skipAd, observeSkip, skipSummary }
  }
  globalThis.__musifyCaptureYouTube = { create }
})()
