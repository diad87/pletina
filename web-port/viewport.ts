/** Chrome puede conservar una altura antigua al volver desde el teclado o desde Android. */
export function initWebViewport(): () => void {
  let frame = 0
  let settling: ReturnType<typeof setTimeout> | undefined
  const apply = () => {
    frame = 0
    const heights = [window.innerHeight, window.visualViewport?.height]
      .filter((height): height is number => typeof height === 'number' && Number.isFinite(height) && height > 0)
    if (heights.length) document.documentElement.style.setProperty('--pletina-viewport-height', `${Math.floor(Math.min(...heights))}px`)
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
  document.addEventListener('focusout', update)
  apply()
  return () => {
    cancelAnimationFrame(frame)
    clearTimeout(settling)
    for (const event of ['resize', 'pageshow', 'focus']) window.removeEventListener(event, update)
    for (const event of ['resize', 'scroll']) window.visualViewport?.removeEventListener(event, update)
    document.removeEventListener('visibilitychange', onVisible)
    document.removeEventListener('focusout', update)
    document.documentElement.style.removeProperty('--pletina-viewport-height')
  }
}
