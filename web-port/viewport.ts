/** Chrome puede conservar una altura antigua al volver desde el teclado o desde Android. */
export function initWebViewport(onKeyboardChange: (visible: boolean) => void = () => {}): () => void {
  let frame = 0
  let settling: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let keyboard = false
  const setKeyboard = (visible: boolean) => {
    if (keyboard === visible) return
    keyboard = visible
    onKeyboardChange(visible)
  }
  const apply = () => {
    if (disposed) return
    frame = 0
    const heights = [window.innerHeight, window.visualViewport?.height]
      .filter((height): height is number => typeof height === 'number' && Number.isFinite(height) && height > 0)
    if (heights.length) document.documentElement.style.setProperty('--pletina-viewport-height', `${Math.floor(Math.min(...heights))}px`)
    const viewport = window.visualViewport
    const entry = document.activeElement as HTMLElement | null
    const input = entry as HTMLInputElement | null
    const editable = Boolean(entry && (entry.isContentEditable ||
      entry.tagName === 'TEXTAREA' && !input?.readOnly && !input?.disabled ||
      entry.tagName === 'INPUT' && /^(?:text|search|email|url|tel|password|number)$/.test(input?.type ?? '') && !input?.readOnly && !input?.disabled))
      && input?.inputMode !== 'none'
    // El foco solo no demuestra un teclado: también puede haber uno físico.
    // Chrome/Safari reducen el viewport visual. Excluir pinch zoom y diferencias
    // pequeñas evita esconder la navegación por zoom o las barras del navegador.
    const occluded = viewport && Number.isFinite(viewport.height) && viewport.height > 0
      && Number.isFinite(viewport.scale) && Math.abs(viewport.scale - 1) < 0.02
      && window.innerHeight - viewport.height > Math.max(120, window.innerHeight * 0.2)
    setKeyboard(Boolean(editable && occluded))
  }
  const update = () => {
    if (!frame) frame = requestAnimationFrame(apply)
    clearTimeout(settling)
    // Las métricas de la ventana y del teclado no siempre cambian en el mismo fotograma.
    settling = setTimeout(apply, 150)
  }
  const onVisible = () => { if (!document.hidden) update() }
  for (const event of ['resize', 'pageshow', 'focus']) window.addEventListener(event, update)
  for (const event of ['resize', 'scroll']) window.visualViewport?.addEventListener(event, update)
  document.addEventListener('visibilitychange', onVisible)
  document.addEventListener('focusin', update)
  document.addEventListener('focusout', update)
  apply()
  return () => {
    disposed = true
    cancelAnimationFrame(frame)
    clearTimeout(settling)
    for (const event of ['resize', 'pageshow', 'focus']) window.removeEventListener(event, update)
    for (const event of ['resize', 'scroll']) window.visualViewport?.removeEventListener(event, update)
    document.removeEventListener('visibilitychange', onVisible)
    document.removeEventListener('focusin', update)
    document.removeEventListener('focusout', update)
    setKeyboard(false)
    document.documentElement.style.removeProperty('--pletina-viewport-height')
  }
}
