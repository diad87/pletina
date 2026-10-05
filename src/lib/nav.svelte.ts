import { untrack } from 'svelte'

export type Route =
  | { name: 'home' }
  | { name: 'search'; query: string }
  | { name: 'artist'; id: number }
  | { name: 'album'; id: number }
  | { name: 'liked' }
  | { name: 'playlist'; id: number }
  | { name: 'history' }
  | { name: 'downloads' }

const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b)

/** Historial propio (atrás / adelante) sin router: una pila de rutas y un índice. */
class Nav {
  stack = $state<Route[]>([{ name: 'home' }])
  index = $state(0)

  /** Contenedor con scroll de la vista; lo registra App. */
  scroller: HTMLElement | null = null
  /** Enfoca el buscador; lo registra TopBar. */
  focusSearch: () => void = () => {}

  #scrollTops: number[] = []

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
  }

  /** Cambia la ruta actual sin crear entrada en el historial (p. ej. al escribir en el buscador). */
  replace(route: Route) {
    this.stack[this.index] = route
  }

  back() {
    if (!this.canBack) return
    this.#saveScroll()
    this.index--
  }

  forward() {
    if (!this.canForward) return
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
