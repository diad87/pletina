// Site-specific observations, not a public YouTube contract. Missing signals fail closed.
(() => {
  const normalized = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
  function create({ document = globalThis.document, location = globalThis.location, target, skipDiagnostics = false, consentDiagnostics = false, requestSkip = null, skipContext = () => null }) {
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
    let consentAttempts = new WeakSet(), consentWasVisible = false, consentCycleAttempted = false
    const consentEvidence = { seenVisible: false, rejectDispatched: false, closedAfterAttempt: false }
    const consentSelector = 'button, [role="button"]'
    // The visible action remains exact. Accessibility labels can explain that
    // action in a sentence; require its first whole word to still mean reject.
    const rejectAriaPrefix = label => /^(?:rechazar|rechaza|reject)(?![\p{L}\p{N}_])/u.test(label)
    const consentControls = dialog => {
      const controls = [...(dialog.querySelectorAll?.(consentSelector) ?? [])], native = node => node.tagName === 'BUTTON'
      return controls.filter(control => {
        // A renderer and its actual button may both expose role=button. Prefer
        // the native button, then the deepest role control; separate buttons stay ambiguous.
        if (!native(control) && controls.some(other => other !== control && native(other) && (control.contains?.(other) || other.contains?.(control)))) return false
        return !controls.some(other => other !== control && control.contains?.(other) && (native(other) || !native(control)))
      })
    }
    const consentCounts = dialogs => {
      const counts = { dialogCount: Math.min(32, dialogs.length), buttonCount: 0, nativeButtons: 0, roleButtons: 0, renderedButtons: 0, enabledButtons: 0, rejectTextMatches: 0, rejectAriaMatches: 0, rejectAriaPrefixMatches: 0, ariaDifferent: 0, blockedButtons: 0, controlsTruncated: dialogs.length > 32 }
      const rejects = new Set(['rechazar todo', 'reject all'])
      for (const dialog of dialogs.slice(0, 32)) {
        const controls = dialog.querySelectorAll?.(consentSelector) ?? []
        const remaining = 32 - counts.buttonCount
        if (controls.length > remaining) counts.controlsTruncated = true
        for (let i = 0; i < Math.min(controls.length, remaining); i++) {
          const button = controls[i], text = normalized(button.textContent).toLowerCase(), aria = normalized(button.getAttribute?.('aria-label')).toLowerCase()
          counts.buttonCount++
          if (button.tagName === 'BUTTON') counts.nativeButtons++
          if (button.getAttribute?.('role') === 'button') counts.roleButtons++
          if (visiblyRendered(button)) counts.renderedButtons++
          if (!button.disabled && !button.hasAttribute?.('disabled') && normalized(button.getAttribute?.('aria-disabled')).toLowerCase() !== 'true') counts.enabledButtons++
          if (rejects.has(text)) counts.rejectTextMatches++
          if (rejects.has(aria)) counts.rejectAriaMatches++
          if (rejectAriaPrefix(aria)) counts.rejectAriaPrefixMatches++
          if (aria && aria !== text) counts.ariaDifferent++
          if (button.hidden || button.closest?.('[hidden], [inert], [aria-hidden="true"]')) counts.blockedButtons++
        }
      }
      return counts
    }
    const inlineConsent = () => {
      if (!['www.youtube.com', 'music.youtube.com'].includes(location.hostname)) return { present: false, visible: false, eligible: false, attempted: false }
      const roots = [...(document.querySelectorAll?.('ytd-consent-bump-v2-lightbox') ?? [])]
      const dialogs = []
      const visible = roots.flatMap(root => {
        const dialog = root.querySelector?.('tp-yt-paper-dialog#dialog')
        if (dialog) dialogs.push(dialog)
        if (root.hidden || root.isConnected === false || !dialog || !visiblyRendered(dialog) || dialog.closest?.('[hidden], [inert], [aria-hidden="true"]')) return []
        if (document.defaultView?.getComputedStyle?.(root)?.opacity === '0') return []
        return [dialog]
      })
      // A new visible cycle may reuse the same DOM button. Only an observed
      // closed dialog resets attempts; an ignored click while open never does.
      if (!visible.length && consentWasVisible) {
        if (consentDiagnostics && consentCycleAttempted) consentEvidence.closedAfterAttempt = true
        consentAttempts = new WeakSet(); consentCycleAttempted = false
      }
      consentWasVisible = visible.length > 0
      let counts
      if (consentDiagnostics) {
        try {
          counts = consentCounts(dialogs)
          if (visible.length) { consentEvidence.seenVisible = true; consentEvidence.lastVisible = { ...counts } }
        } catch { /* Optional numeric diagnostics do not select or block a control. */ }
      }
      const rejects = new Set(['rechazar todo', 'reject all'])
      const buttons = visible.length === 1 ? consentControls(visible[0]).filter(button => {
        const label = normalized(button.getAttribute?.('aria-label')).toLowerCase()
        return visiblyRendered(button) && button.isConnected !== false && !button.disabled && !button.hasAttribute?.('disabled') && normalized(button.getAttribute?.('aria-disabled')).toLowerCase() !== 'true'
          && !button.closest?.('[hidden], [inert], [aria-hidden="true"]') && rejects.has(normalized(button.textContent).toLowerCase()) && (!label || rejectAriaPrefix(label))
      }) : []
      const button = buttons.length === 1 ? buttons[0] : null
      return { present: roots.length > 0, visible: visible.length > 0, eligible: !!button, attempted: !!button && consentAttempts.has(button), button, counts }
    }
    const consentState = () => {
      const { present, visible, eligible, attempted, counts } = inlineConsent()
      return { present, visible, eligible, attempted, ...counts }
    }
    const consentSummary = () => consentDiagnostics && consentEvidence.seenVisible ? { ...consentEvidence, ...(consentEvidence.lastVisible ? { lastVisible: { ...consentEvidence.lastVisible } } : {}) } : null
    const rejectConsent = () => {
      if (location.hostname !== 'consent.youtube.com') {
        const { button, attempted } = inlineConsent()
        if (!button || attempted) return false
        consentAttempts.add(button); consentCycleAttempted = true
        try { button.click(); if (consentDiagnostics) consentEvidence.rejectDispatched = true; return true } catch { return false }
      }
      const form = [...document.forms].find((f) => f.querySelector('input[name="set_eom"][value="true"]'))
      const button = form?.querySelector('button') || [...document.querySelectorAll('button')].find((b) => /rechazar|reject|ablehnen|refuser|rifiuta/i.test(b.textContent || ''))
      if (button) button.click()
      return !!button
    }
    const sessionState = () => {
      let loggedIn
      try { loggedIn = globalThis.ytcfg?.get?.('LOGGED_IN') } catch { /* A missing site hint is unknown, not signed out. */ }
      return { state: loggedIn === true ? 'signed-in' : loggedIn === false ? 'signed-out' : 'unknown', browserNow: Math.round(globalThis.performance?.now?.() ?? 0), evidenceVersion: 1 }
    }
    const clickedAt = new WeakMap(), buttonTokens = new WeakMap()
    let nextRequest = 0, nextButton = 0, pendingSkip = null, completedSkip = null
    // Invalidated proposals cannot be used for input, but their native callback
    // can arrive after the next ad has created another proposal.
    const retiredSkips = new Map()
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
    const skipSummary = requestId => {
      if (!skipDiagnostics || (!skip.calls && !observation)) return null
      // Copy, don't expose the mutable diagnostic state. A fixed serialized budget
      // also bounds unusual public labels and very large counter/clock values.
      const summary = JSON.parse(JSON.stringify(skip))
      const completed = completedSkip?.requestId === requestId ? completedSkip : null
      if (completed) { summary.last = { ...completed.attempt }; summary.result = completed.result }
      while (JSON.stringify(summary).length > 1000 && summary.controls?.length) { summary.controls.pop(); summary.controlsOmitted = true }
      if (JSON.stringify(summary).length > 1000) { delete summary.observed; summary.detailsOmitted = true }
      if (JSON.stringify(summary).length > 1000) { delete summary.transition; delete summary.last?.after }
      if (JSON.stringify(summary).length > 1000) return { calls: skip.calls, tries: skip.tries, returned: skip.returned, threw: skip.threw, result: completed?.result ?? skip.result,
        ...(completed ? { last: { requestId, source: completed.attempt.source, epoch: completed.attempt.epoch, eventSeen: completed.attempt.eventSeen, isTrusted: completed.attempt.isTrusted, defaultPrevented: completed.attempt.defaultPrevented, nativeOk: completed.attempt.nativeOk } } : {}), detailsOmitted: true }
      return summary
    }
    const eligibleButton = button => !!button && button.isConnected === true && !button.disabled && button.getAttribute?.('aria-disabled') !== 'true' && visiblyRendered(button)
    const pointOf = button => {
      const rect = button.getBoundingClientRect?.(), view = document.defaultView
      const viewportWidth = view?.innerWidth, viewportHeight = view?.innerHeight
      if (!rect || ![rect.left, rect.top, rect.width, rect.height, viewportWidth, viewportHeight].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
      if (x < 0 || y < 0 || x >= viewportWidth || y >= viewportHeight) return null
      const hit = document.elementFromPoint?.(x, y)
      return hit && (hit === button || button.contains?.(hit)) ? { x, y, viewportWidth, viewportHeight } : null
    }
    const completeSkip = ({ requestId, epoch, source, ok = false, reason = 'native-result-missing' } = {}) => {
      const pending = pendingSkip?.requestId === requestId ? pendingSkip : retiredSkips.get(requestId)
      if (!pending) return false
      if ((epoch !== undefined && epoch !== pending.binding.epoch) || (source !== undefined && source !== pending.binding.source)) return false
      if (pending === pendingSkip) pendingSkip = null
      retiredSkips.delete(requestId)
      if (!pending.detached) pending.button.removeEventListener?.('click', pending.onClick, true)
      diagnose(() => {
        const seen = pending.seen, attempt = pending.attempt
        const result = ok ? 'native-returned' : 'native-rejected'
        if (skip.last === attempt) skip.result = result
        if (ok) skip.returned++
        if (attempt) { attempt.eventSeen = !!seen; attempt.isTrusted = seen ? seen.isTrusted === true : null; attempt.defaultPrevented = seen ? seen.defaultPrevented === true : null; attempt.nativeOk = ok === true; attempt.reason = publicText(reason, 64) }
        if (seen) { skip.clickEvents++; if (seen.defaultPrevented) skip.canceled++ }
        completedSkip = { requestId, result, attempt: { ...attempt } }
      })
      return true
    }
    const validateSkip = requestId => {
      const pending = pendingSkip, invalid = reason => ({ valid: false, requestId, reason })
      if (!pending || pending.requestId !== requestId) return invalid('stale-request')
      if (diagnosticNow() - pending.at > 2000) return invalid('request-expired')
      const current = skipContext(pending.element)
      if (!current || ['generation', 'epoch', 'source'].some(key => current[key] !== pending.binding[key])) return invalid('source-changed')
      if (classify(pending.element).state !== 'ad') return invalid('not-ad')
      if (!player()?.contains(pending.button) || !eligibleButton(pending.button) || !skipSelectors.some(selector => pending.button.matches?.(selector))) return invalid('button-ineligible')
      const point = pointOf(pending.button)
      if (!point || Object.keys(point).some(key => point[key] !== pending.point[key])) return invalid('button-moved-or-covered')
      return { valid: true, requestId, ...pending.binding, buttonToken: pending.buttonToken, ...point }
    }
    const skipAd = (element) => {
      diagnose(() => { skip.calls++ })
      if (pendingSkip) {
        if (!validateSkip(pendingSkip.requestId).valid) {
          const retired = pendingSkip; pendingSkip = null
          retired.button.removeEventListener?.('click', retired.onClick, true); retired.detached = true
          retiredSkips.set(retired.requestId, retired)
          if (retiredSkips.size > 4) { retiredSkips.delete(retiredSkips.keys().next().value); diagnose(() => { skip.lateResultsDropped = (skip.lateResultsDropped ?? 0) + 1 }) }
        }
        else { diagnose(() => { skip.result = 'native-pending' }); return false }
      }
      if (classify(element).state !== 'ad') { diagnose(() => { skip.result = 'not-ad'; skip.outcomes.notAd++ }); return false }
      const p = player()
      const buttons = [...(p?.querySelectorAll?.(skipSelectors.join(', ')) ?? [])]
      const button = buttons.find(eligibleButton)
      sampleControls(p, buttons, button)
      if (!button) { diagnose(() => { skip.result = buttons.length ? 'ineligible' : 'no-match'; skip.outcomes[buttons.length ? 'ineligible' : 'noMatch']++ }); return false }
      const binding = skipContext(element), point = pointOf(button)
      if (typeof requestSkip !== 'function' || !binding || !['generation', 'epoch', 'source'].every(key => Number.isSafeInteger(binding[key]) && binding[key] > 0) || !point || !p.contains(button)) { diagnose(() => { skip.result = 'native-unavailable-or-covered' }); return false }
      if (Date.now() - (clickedAt.get(button) ?? -Infinity) < 1000) { diagnose(() => { skip.result = 'cooldown'; skip.outcomes.cooldown++ }); return false }
      clickedAt.set(button, Date.now())
      let attempt = null
      diagnose(() => {
        skip.tries++; attempt = skip.last = { at: diagnosticNow(), source: observation?.source ?? null, epoch: observation?.epoch ?? null, position: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : null, adMarker: classify(element).evidence?.adMarker === true, selector: skipSelectors.findIndex(selector => button.matches?.(selector)), eventSeen: false }
      })
      if (!buttonTokens.has(button)) buttonTokens.set(button, ++nextButton)
      // The native window can navigate without changing generation. Do not recycle
      // request1 in its replacement document while an old COM callback is pending.
      nextRequest = Math.max(nextRequest + 1, Date.now() * 1000)
      if (attempt) Object.assign(attempt, { requestId: nextRequest, generation: binding.generation, epoch: binding.epoch, source: binding.source })
      const pending = { requestId: nextRequest, buttonToken: buttonTokens.get(button), button, element, binding: { generation: binding.generation, epoch: binding.epoch, source: binding.source }, point, at: diagnosticNow(), attempt, seen: null }
      pending.onClick = event => { pending.seen = event }
      button.addEventListener?.('click', pending.onClick, { capture: true, passive: true })
      pendingSkip = pending
      try {
        requestSkip({ requestId: pending.requestId, buttonToken: pending.buttonToken, ...pending.binding, ...point })
        diagnose(() => { skip.result = 'native-requested' })
        return true
      } catch (error) {
        completeSkip({ requestId: pending.requestId, reason: 'request-threw' })
        diagnose(() => { skip.threw++; skip.result = 'request-threw'; if (attempt) attempt.errorName = publicText(error?.name, 32) })
        throw error
      }
    }
    return { classify, interaction, rejectConsent, consentState, consentSummary, sessionState, skipAd, observeSkip, skipSummary, validateSkip, completeSkip }
  }
  globalThis.__musifyCaptureYouTube = { create }
})()
