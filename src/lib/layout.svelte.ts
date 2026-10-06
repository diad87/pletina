// ¿Pantalla de móvil? Entonces la app cambia de estructura: barra de abajo (Inicio, Buscar,
// Biblioteca), minirreproductor y menús que salen desde abajo. El escritorio no cambia.

const query = typeof matchMedia === 'function' ? matchMedia('(max-width: 720px)') : null

class Layout {
  mobile = $state(query?.matches ?? false)
  /** Descargas para escuchar sin conexión: en el móvil todavía no (usan yt-dlp). */
  get canDownload() {
    return !this.mobile
  }

  constructor() {
    query?.addEventListener('change', (e) => (this.mobile = e.matches))
  }
}

export const layout = new Layout()

// En Android el WebView no da las zonas seguras con env(); las da la actividad (MainActivity.kt).
const native = (window as unknown as { MusifyInsets?: { get(): string } }).MusifyInsets
if (native) {
  const apply = () => {
    const [top, bottom] = native.get().split(',').map(Number)
    document.documentElement.style.setProperty('--safe-top', `${top || 0}px`)
    document.documentElement.style.setProperty('--safe-bottom', `${bottom || 0}px`)
  }
  apply()
  window.addEventListener('musify-insets', apply)
}
