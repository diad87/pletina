import type { NavigationDriver, Route } from '../src/lib/nav.svelte'

type Snapshot = { stack: Route[]; index: number }
type Navigation = Snapshot & { restore(stack: Route[], index: number): void; installDriver(driver: NavigationDriver): void }
type Entry = { pletinaNavigation: 1; session: string; index: number; overlay: boolean; snapshot: Snapshot }

function route(value: unknown): value is Route {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (['home', 'liked', 'import-playlist', 'youtube-tracks', 'history', 'downloads', 'local', 'library'].includes(String(item.name))) return true
  if (item.name === 'search' || item.name === 'podcasts') return typeof item.query === 'string' && item.query.length <= 10000
  if (['artist', 'album', 'playlist', 'podcast'].includes(String(item.name))) {
    return Number.isSafeInteger(item.id) && Number(item.id) > 0 &&
      (item.feedUrl === undefined || typeof item.feedUrl === 'string' && item.feedUrl.length <= 10000)
  }
  return false
}

function snapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object') return false
  const item = value as Snapshot
  return Array.isArray(item.stack) && item.stack.length > 0 && item.stack.length <= 1000 && item.stack.every(route) &&
    Number.isInteger(item.index) && item.index >= 0 && item.index < item.stack.length
}

/** Mantiene la URL de instalación estable: las rutas de la app viven en history.state. */
export function initWebNavigation(nav: Navigation, browser: Window = window): () => void {
  const history = browser.history
  const storageKey = `pletina:web:navigation:${new URL('../', browser.location.href).pathname}`
  const previous = history.state as Partial<Entry> | null
  const session = previous?.pletinaNavigation === 1 && typeof previous.session === 'string'
    ? previous.session : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  let current: Snapshot = { stack: [{ name: 'home' }], index: 0 }
  let saved: { session?: string; snapshot?: Snapshot } | null = null
  try { saved = JSON.parse(browser.sessionStorage.getItem(storageKey) ?? 'null') } catch { /* Sesión privada o dato antiguo. */ }
  if (previous?.pletinaNavigation === 1 && snapshot(previous.snapshot)) {
    current = saved?.session === session && snapshot(saved.snapshot) && previous.index! < saved.snapshot.stack.length
      ? { stack: saved.snapshot.stack, index: previous.index! } : previous.snapshot
  }
  nav.restore(current.stack, current.index)
  let guarded = false
  let overlayWanted = false
  let closingGuard = previous?.pletinaNavigation === 1 && previous.session === session && previous.overlay === true
  let repairForward = closingGuard && current.index < current.stack.length - 1
  let closeOverlay: () => boolean = () => false
  let pending: (() => void)[] = []

  const persist = () => {
    try { browser.sessionStorage.setItem(storageKey, JSON.stringify({ session, snapshot: current })) } catch { /* Historial sigue operativo sin storage. */ }
  }
  const entry = (overlay = false, index = current.index): Entry => ({ pletinaNavigation: 1, session, index, overlay,
    snapshot: { stack: JSON.parse(JSON.stringify(current.stack)) as Route[], index } })
  const replace = () => { history.replaceState(entry(guarded), '', browser.location.href); persist() }
  // Un panel no se restaura tras recargar. Consumimos su entrada, en vez de dejar
  // dos rutas iguales que exigirían pulsar Atrás dos veces.
  if (!closingGuard) replace()

  const run = (action: () => void) => { if (closingGuard) pending.push(action); else action() }
  const onPop = (event: PopStateEvent) => {
    const value = event.state as Partial<Entry> | null
    const wasGuarded = guarded
    guarded = false
    if (wasGuarded) { overlayWanted = false; closeOverlay() }
    if (repairForward && (wasGuarded || closingGuard)) {
      // pushState del panel sustituye la rama Adelante. Al cerrarlo la reponemos
      // antes de aceptar otra navegación, sin cambiar la vista ni su índice.
      repairForward = false
      closingGuard = true
      const count = current.stack.length - current.index - 1
      for (let index = current.index + 1; index < current.stack.length; index++) {
        history.pushState(entry(false, index), '', browser.location.href)
      }
      history.go(-count)
      return
    }
    if (closingGuard) {
      closingGuard = false
      replace()
      const actions = pending
      pending = []
      for (const action of actions) action()
      return
    }
    if (value?.pletinaNavigation !== 1 || value.session !== session || !snapshot(value.snapshot)) return
    const index = value.index
    if (!Number.isInteger(index) || index! < 0) return
    const stack = index! < current.stack.length ? current.stack : value.snapshot.stack
    if (index! >= stack.length) return
    // Un overlay recorrido con Adelante no debe reaparecer sin su contenido.
    current = { stack, index: index! }
    nav.restore(stack, index!)
    if (value.overlay) replace()
    persist()
  }
  browser.addEventListener('popstate', onPop)
  nav.installDriver({
    push(stack, index) {
      const next = JSON.parse(JSON.stringify({ stack, index })) as Snapshot
      run(() => {
        current = next
        repairForward = false
        // Una navegación desde un menú ocupa su entrada temporal, sin duplicarla.
        if (guarded) { guarded = false; closeOverlay(); history.replaceState(entry(), '', browser.location.href) }
        else history.pushState(entry(), '', browser.location.href)
        persist()
      })
    },
    replace(stack, index) {
      const next = JSON.parse(JSON.stringify({ stack, index })) as Snapshot
      run(() => { current = next; replace() })
    },
    back() { run(() => history.back()) },
    forward() { run(() => history.forward()) },
    overlay(open, close) {
      closeOverlay = close
      overlayWanted = open
      if (open) run(() => {
        if (!overlayWanted || guarded) return
        guarded = true
        repairForward = current.index < current.stack.length - 1
        history.pushState(entry(true), '', browser.location.href)
      })
      else if (guarded) {
        guarded = false
        closingGuard = true
        history.back()
      }
    },
  })
  if (closingGuard) history.back()
  return () => browser.removeEventListener('popstate', onPop)
}
