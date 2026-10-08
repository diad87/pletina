// Reordenar una lista con el dedo (o el ratón), arrastrando el asa de cada fila. Lo usan la cola y
// las playlists en el móvil, donde el arrastrar del navegador (HTML5) no funciona.
//
// En la lista: `use:reorder={{ onMove }}`. Cada fila lleva `data-reorder-index={i}` y dentro un
// elemento con `data-reorder-handle` (el asa). Al soltar se llama a `onMove(desde, hasta)`, con
// `hasta` = la posición final de la fila.

interface Options {
  onMove: (from: number, to: number) => void
  enabled?: boolean
}

/** Cerca del borde de la zona con scroll, se desplaza sola (px desde el borde y px por fotograma). */
const EDGE = 64
const SPEED = 12

function scrollParent(node: HTMLElement): HTMLElement {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) return el
  }
  return document.scrollingElement as HTMLElement
}

export function reorder(node: HTMLElement, options: Options) {
  let opts = options
  let drag: {
    row: HTMLElement
    rows: HTMLElement[]
    mids: number[]
    from: number
    to: number
    height: number
    startY: number
    lastY: number
    scroller: HTMLElement
    startScroll: number
    frame: number
  } | null = null

  function onDown(e: PointerEvent) {
    if (opts.enabled === false || e.button !== 0) return
    const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-reorder-handle]')
    const row = handle?.closest<HTMLElement>('[data-reorder-index]')
    if (!handle || !row || !node.contains(row)) return
    e.preventDefault()
    const rows = [...node.querySelectorAll<HTMLElement>('[data-reorder-index]')]
    const scroller = scrollParent(node)
    const from = Number(row.dataset.reorderIndex)
    drag = {
      row,
      rows,
      mids: rows.map((r) => {
        const rect = r.getBoundingClientRect()
        return rect.top + rect.height / 2
      }),
      from,
      to: from,
      height: row.getBoundingClientRect().height,
      startY: e.clientY,
      lastY: e.clientY,
      scroller,
      startScroll: scroller.scrollTop,
      frame: requestAnimationFrame(autoScroll),
    }
    row.classList.add('reordering')
    for (const r of rows) if (r !== row) r.style.transition = 'transform 0.18s ease'
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      // Sin captura (p. ej. eventos simulados): sigue funcionando mientras el dedo esté encima.
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  /** Coloca la fila arrastrada bajo el dedo y aparta las demás. */
  function layout() {
    if (!drag) return
    const scrolled = drag.scroller.scrollTop - drag.startScroll
    const dy = drag.lastY - drag.startY + scrolled
    drag.row.style.transform = `translateY(${dy}px)`
    const center = drag.mids[drag.from] + dy
    let to = drag.from
    for (let i = 0; i < drag.mids.length; i++) {
      if (i < drag.from && center < drag.mids[i]) {
        to = i
        break
      }
      if (i > drag.from && center > drag.mids[i]) to = i
    }
    drag.to = to
    drag.rows.forEach((r, i) => {
      if (r === drag!.row) return
      const shift =
        drag!.from < to && i > drag!.from && i <= to ? -drag!.height : to < drag!.from && i >= to && i < drag!.from ? drag!.height : 0
      r.style.transform = shift ? `translateY(${shift}px)` : ''
    })
  }

  function onMove(e: PointerEvent) {
    if (!drag) return
    drag.lastY = e.clientY
    layout()
  }

  function autoScroll() {
    if (!drag) return
    const rect = drag.scroller === document.scrollingElement ? new DOMRect(0, 0, innerWidth, innerHeight) : drag.scroller.getBoundingClientRect()
    let step = 0
    if (drag.lastY < rect.top + EDGE) step = -SPEED * (1 - (drag.lastY - rect.top) / EDGE)
    else if (drag.lastY > rect.bottom - EDGE) step = SPEED * (1 - (rect.bottom - drag.lastY) / EDGE)
    if (step) {
      drag.scroller.scrollTop += step
      layout()
    }
    drag.frame = requestAnimationFrame(autoScroll)
  }

  function onUp(e: PointerEvent) {
    if (!drag) return
    const { row, rows, from, to, frame } = drag
    drag = null
    cancelAnimationFrame(frame)
    const handle = e.currentTarget as HTMLElement
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
    row.classList.remove('reordering')
    for (const r of rows) {
      r.style.transition = ''
      r.style.transform = ''
    }
    if (to !== from && e.type === 'pointerup') opts.onMove(from, to)
  }

  node.addEventListener('pointerdown', onDown)
  return {
    update(next: Options) {
      opts = next
    },
    destroy() {
      node.removeEventListener('pointerdown', onDown)
    },
  }
}
