// Site-specific observations, not a public YouTube contract. Missing signals fail closed.
(() => {
  const normalized = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
  function create({ document = globalThis.document, location = globalThis.location, target }) {
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
    const skipAd = (element) => {
      if (classify(element).state !== 'ad') return false
      const p = player()
      const buttons = [...(p?.querySelectorAll?.('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern') ?? [])]
      const button = buttons.find((b) => {
        if (b.disabled || b.hidden || b.getAttribute?.('aria-disabled') === 'true' || !b.getClientRects?.().length) return false
        const style = document.defaultView?.getComputedStyle?.(b)
        return !style || (style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) && style.opacity !== '0')
      })
      if (!button || Date.now() - (clickedAt.get(button) ?? -Infinity) < 1000) return false
      clickedAt.set(button, Date.now())
      button.click()
      return true
    }
    return { classify, interaction, rejectConsent, skipAd }
  }
  globalThis.__musifyCaptureYouTube = { create }
})()
