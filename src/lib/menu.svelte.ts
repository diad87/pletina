import type { IconName } from '../components/Icon.svelte'

export interface MenuItem {
  label: string
  icon?: IconName
  action?: () => void
  /** Submenú (p. ej. la lista de playlists en "Añadir a playlist"). */
  children?: MenuItem[]
  danger?: boolean
  /** Línea separadora antes de este elemento. */
  separated?: boolean
}

/** Menú contextual único: clic derecho en una canción o botón "⋯". */
class Menu {
  open = $state<{ x: number; y: number; items: MenuItem[] } | null>(null)

  show(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault()
    e.stopPropagation()
    // Desde un botón, debajo del botón; con clic derecho, donde está el ratón.
    const target = e.currentTarget
    if (e.type === 'click' && target instanceof HTMLElement) {
      const r = target.getBoundingClientRect()
      this.open = { x: r.left, y: r.bottom + 4, items }
    } else {
      this.open = { x: e.clientX, y: e.clientY, items }
    }
  }

  close() {
    this.open = null
  }
}

export const menu = new Menu()
