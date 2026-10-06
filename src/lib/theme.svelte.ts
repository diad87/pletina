import { coverColor, FALLBACK_COLOR } from './color'

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true'
  } catch {
    return false
  }
}

/**
 * Aspecto de la página actual: color de fondo (sale de su carátula) y, para la barra superior
 * al hacer scroll, su título y un botón de reproducir.
 */
class Theme {
  color = $state(FALLBACK_COLOR)
  title = $state('')
  play = $state<{ playing: boolean; toggle: () => void } | null>(null)
  /** Pantalla completa de "Sonando ahora" abierta. */
  nowPlaying = $state(false)
  /** Panel lateral de la cola abierto. */
  #queueOpen = $state(readFlag('musify:queueOpen'))

  get queueOpen() {
    return this.#queueOpen
  }
  set queueOpen(open: boolean) {
    this.#queueOpen = open
    try {
      localStorage.setItem('musify:queueOpen', JSON.stringify(open))
    } catch {
      // Sin almacenamiento: vale para esta sesión.
    }
  }

  #token = 0

  /** Cada vista lo llama al cargar sus datos. */
  async set(image: string | null | undefined, title = '') {
    const token = ++this.#token
    this.title = title
    const color = await coverColor(image)
    if (token === this.#token) this.color = color
  }

  /** Color fijo (p. ej. "Canciones que te gustan"). */
  setColor(color: string, title = '') {
    this.#token++
    this.color = color
    this.title = title
  }

  /**
   * Al entrar en una pantalla: quita el título y el botón de la anterior. El color se queda
   * hasta que la nueva ponga el suyo, para que la transición sea suave.
   */
  clear() {
    this.#token++
    this.title = ''
    this.play = null
  }

  /** Pantallas sin carátula propia. */
  neutral() {
    this.setColor(FALLBACK_COLOR)
  }
}

export const theme = new Theme()
