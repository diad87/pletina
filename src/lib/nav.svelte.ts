import { untrack } from 'svelte'

export type Route =
  | { name: 'home' }
  | { name: 'search'; query: string }
  | { name: 'podcasts'; query: string }
  | { name: 'podcast'; id: number; feedUrl?: string }
  | { name: 'artist'; id: number }
  | { name: 'album'; id: number }
  | { name: 'liked' }
  | { name: 'playlist'; id: number }
  | { name: 'import-playlist' }
  | { name: 'library-backup' }
  | { name: 'youtube-tracks' }
  | { name: 'history' }
  | { name: 'downloads' }
  | { name: 'local' }
  /** "Tu biblioteca" como página (en el móvil; en escritorio está en la barra lateral). */
  | { name: 'library' }

const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b)

export interface NavigationDriver {
  push(stack: Route[], index: number): void
  replace(stack: Route[], index: number): void
  back(): void
  forward(): void
  overlay(open: boolean, close: () => boolean, remaining?: () => boolean): void
}

/** Historial propio (atrás / adelante) sin router: una pila de rutas y un índice. */
class Nav {
  stack = $state<Route[]>([{ name: 'home' }])
  index = $state(0)
  #viewOffset = $state(0)

  /** Compactar el historial web no debe desmontar la pantalla que abrió un menú. */
  get viewKey() { return this.index + this.#viewOffset }

  /** Contenedor con scroll de la vista; lo registra App. */
  scroller: HTMLElement | null = null
  /** Enfoca el buscador; lo registra TopBar. */
  focusSearch: () => void = () => {}

  #scrollTops: number[] = []
  #driver: NavigationDriver | null = null

  /** Solo la entrada web instala un historial de navegador; Tauri conserva su pila. */
  installDriver(driver: NavigationDriver) { this.#driver = driver }

  restore(stack: Route[], index: number, preserveView = false) {
    this.#saveScroll()
    if (preserveView) this.#viewOffset += this.index - index
    this.stack = stack
    this.index = index
  }

  overlay(open: boolean, close: () => boolean, remaining?: () => boolean) { this.#driver?.overlay(open, close, remaining) }

  get route(): Route {
    return this.stack[this.index]
  }

  get canBack() {
    return this.index > 0
  }

  get canForward() {
    return this.index < this.stack.length - 1
  }

  go(route: Route) {
    if (sameRoute(route, this.route)) return
    this.#saveScroll()
    this.stack = [...this.stack.slice(0, this.index + 1), route]
    this.index = this.stack.length - 1
    this.#scrollTops[this.index] = 0
    this.scroller?.scrollTo(0, 0)
    this.#driver?.push(this.stack, this.index)
  }

  /** Cambia la ruta actual sin crear entrada en el historial (p. ej. al escribir en el buscador). */
  replace(route: Route) {
    this.stack[this.index] = route
    this.#driver?.replace(this.stack, this.index)
  }

  back() {
    if (!this.canBack) return
    if (this.#driver) { this.#driver.back(); return }
    this.#saveScroll()
    this.index--
  }

  forward() {
    if (!this.canForward) return
    if (this.#driver) { this.#driver.forward(); return }
    this.#saveScroll()
    this.index++
  }

  /** Las vistas lo llaman al tener sus datos: restaura el scroll que tenía esa página. */
  ready() {
    const top = untrack(() => this.#scrollTops[this.index] ?? 0)
    requestAnimationFrame(() => this.scroller?.scrollTo(0, top))
  }

  #saveScroll() {
    if (this.scroller) this.#scrollTops[this.index] = this.scroller.scrollTop
  }
}

export const nav = new Nav()
