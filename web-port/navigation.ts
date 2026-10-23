import type { NavigationDriver, Route } from '../src/lib/nav.svelte'

type Snapshot = { stack: Route[]; index: number }
type Navigation = Snapshot & { restore(stack: Route[], index: number, preserveView?: boolean): void; installDriver(driver: NavigationDriver): void }
type Entry = { pletinaNavigation: 1; session: string; index: number; overlay: boolean; snapshot: Snapshot;
  protectedRoot?: true; rootBoundary?: true; rootDistance?: number; rootId?: string; rootGuardDepth?: 2; preparedOverlay?: true }
type Options = { onRootBack?: () => void }
const ROOT_GUARD_DEPTH = 2
const markerId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

function route(value: unknown): value is Route {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (['home', 'liked', 'import-playlist', 'library-backup', 'youtube-tracks', 'history', 'downloads', 'local', 'library'].includes(String(item.name))) return true
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

function navigationEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false
  const item = value as Entry
  return item.pletinaNavigation === 1 && typeof item.session === 'string' && typeof item.overlay === 'boolean' &&
    snapshot(item.snapshot) && Number.isInteger(item.index) && item.index >= 0 &&
    item.index === item.snapshot.index && item.index < item.snapshot.stack.length &&
    (item.protectedRoot === undefined || item.protectedRoot === true && Number.isInteger(item.rootDistance) && item.rootDistance! >= 0) &&
    (item.rootId === undefined || item.protectedRoot === true && typeof item.rootId === 'string' && /^[a-z0-9-]{8,100}$/.test(item.rootId)) &&
    (item.rootGuardDepth === undefined || item.protectedRoot === true && item.rootGuardDepth === ROOT_GUARD_DEPTH) &&
    (item.preparedOverlay === undefined || item.preparedOverlay === true && item.overlay) &&
    (item.rootBoundary === undefined || item.rootBoundary === true && item.protectedRoot === true && !item.overlay && item.index === 0)
}

/** Mantiene la URL de instalación estable: las rutas de la app viven en history.state. */
export function initWebNavigation(nav: Navigation, browser: Window = window, options: Options = {}): () => void {
  const history = browser.history
  const storageKey = `pletina:web:navigation:${new URL('../', browser.location.href).pathname}`
  const state: unknown = history.state
  const previous = navigationEntry(state) ? state : null
  const standalone = browser.matchMedia?.('(display-mode: standalone)').matches === true ||
    (browser.navigator as Navigator & { standalone?: boolean } | undefined)?.standalone === true
  const session = previous?.pletinaNavigation === 1 && typeof previous.session === 'string'
    ? previous.session : markerId()
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
  let repairForward = closingGuard && !previous?.preparedOverlay && current.index < current.stack.length - 1
  let openingGuard = false
  let closeOverlay: () => boolean = () => false
  let overlaysRemain: () => boolean = () => false
  let reclaimOverlay = false
  let pending: (() => void)[] = []
  let protectedRoot = standalone && previous?.protectedRoot === true && previous.rootId !== undefined && previous.rootGuardDepth === ROOT_GUARD_DEPTH
  let rootId = protectedRoot ? previous!.rootId! : markerId()
  let rootDistance = protectedRoot ? previous!.rootDistance! : 0
  let rootTravel = false
  let rootRepairTimer: number | undefined
  let returnedBoundary: { rootId: string; distance: number } | null = null
  const stopRootRepair = () => {
    browser.clearTimeout(rootRepairTimer)
    rootRepairTimer = undefined
  }
  const repairRoot = () => {
    stopRootRepair()
    // Los dos Atrás pueden invalidar una travesía pedida desde el primer pop.
    // Se agrupan los eventos antes de leer el estado real, y se vuelve al ancla
    // exacta: pedir varios Adelante podría acabar en la rama de búsqueda.
    rootRepairTimer = browser.setTimeout(() => {
      rootRepairTimer = undefined
      const value = history.state
      if (!navigationEntry(value) || value.session !== session) return
      if (value.rootId !== rootId) history.forward()
      else if (value.rootBoundary && value.rootDistance! < ROOT_GUARD_DEPTH) {
        history.go(ROOT_GUARD_DEPTH - value.rootDistance!)
      }
    }, 0)
  }
  if (standalone && !protectedRoot) {
    // La migración sustituye también cualquier overlay antiguo en una sola
    // reconstrucción acotada; no se repara antes otra vez la misma rama.
    closingGuard = false
    repairForward = false
  }

  const persist = () => {
    try { browser.sessionStorage.setItem(storageKey, JSON.stringify({ session, snapshot: current })) } catch { /* Historial sigue operativo sin storage. */ }
  }
  const entry = (overlay = false, index = current.index): Entry => ({ pletinaNavigation: 1, session, index, overlay,
    ...(protectedRoot ? { protectedRoot: true as const, rootDistance, rootId, rootGuardDepth: ROOT_GUARD_DEPTH } : {}),
    ...(overlay && standalone ? { preparedOverlay: true as const } : {}),
    snapshot: { stack: JSON.parse(JSON.stringify(current.stack)) as Route[], index } })
  const replace = () => { history.replaceState(entry(guarded), '', browser.location.href); persist() }
  const push = (overlay = false, index = current.index) => {
    rootDistance++
    history.pushState(entry(overlay, index), '', browser.location.href)
  }
  const drain = () => {
    while (pending.length && !closingGuard && !rootTravel && !openingGuard) pending.shift()!()
  }
  const protect = (rebuild = false) => {
    if (!standalone || protectedRoot && !rebuild) return
    // Adaptar las sesiones antiguas a los dos límites solo reconstruye
    // su historial interno; nunca cambia de documento ni toca el audio.
    // Acotamos esta migración para no superar el límite de llamadas de Safari.
    if (current.stack.length > 32) {
      const start = Math.max(1, current.index - 15)
      const end = Math.min(current.stack.length, current.index + (current.index ? 16 : 32))
      current = { stack: [current.stack[0], ...current.stack.slice(start, end)],
        index: current.index ? current.index - start + 1 : 0 }
      nav.restore(current.stack, current.index, true)
    }
    protectedRoot = true
    rootId = markerId()
    rootDistance = 0
    history.replaceState({ ...entry(false, 0), rootBoundary: true }, '', browser.location.href)
    // Dos gestos pueden llegar antes del primer popstate. Ambos deben seguir
    // dentro del documento para conservar el HTMLAudio del reproductor.
    rootDistance++
    history.pushState({ ...entry(false, 0), rootBoundary: true }, '', browser.location.href)
    for (let index = 0; index < current.stack.length; index++) {
      push(false, index)
    }
    persist()
    const delta = current.index - current.stack.length + 1
    if (delta) { rootTravel = true; history.go(delta) }
  }
  // Un panel no se restaura tras recargar. Consumimos su entrada, en vez de dejar
  // dos rutas iguales que exigirían pulsar Atrás dos veces.
  if (!closingGuard && !previous?.rootBoundary) replace()

  const run = (action: () => void) => {
    if (closingGuard || rootTravel || openingGuard) pending.push(action)
    else action()
  }
  const onPop = (event: PopStateEvent) => {
    const value = navigationEntry(event.state) ? event.state : null
    if (returnedBoundary !== null) {
      const restored = value?.session === session && value.rootBoundary && value.rootId === returnedBoundary.rootId &&
        value.rootDistance === returnedBoundary.distance
      returnedBoundary = null
      // pageshow ya ha pedido Adelante. Algunos motores notifican además el pop
      // del límite restaurado; no debe solicitar un segundo salto.
      if (restored) return
    }
    if (standalone && protectedRoot && value?.session === session && value.rootId !== rootId) {
      // Un salto iniciado fuera de Inicio puede alcanzar una raíz compactada anterior.
      // Se vuelve hacia nuestra raíz vigente sin abandonar el documento.
      rootTravel = true
      repairRoot()
      return
    }
    if (value?.session === session && value.protectedRoot) rootDistance = value.rootDistance!
    if (value?.pletinaNavigation === 1 && value.session === session && value.rootBoundary === true) {
      // En modo instalado, Atrás en la raíz conserva el documento y la rama
      // Adelante. En una pestaña normal se permite abandonar la página.
      if (standalone) {
        const notifyRootBack = current.index === 0 && current.stack[0].name === 'home' && !guarded &&
          !closingGuard && !openingGuard && !rootTravel && !overlayWanted && !overlaysRemain() && pending.length === 0
        const repair = repairForward
        const close = guarded
        guarded = false
        overlayWanted = false
        closingGuard = false
        openingGuard = false
        repairForward = false
        reclaimOverlay = false
        if (close) {
          closeOverlay()
          for (let layer = 0; layer < 8 && overlaysRemain(); layer++) closeOverlay()
        }
        if (repair) {
          // Una travesía puede saltar el panel y varias pantallas juntas. Quitar
          // su entrada temporal desde el límite evita un panel huérfano y un
          // segundo Inicio fantasma, manteniendo la rama Adelante de la app.
          current = { stack: current.stack, index: 0 }
          if (pending.length === 0) nav.restore(current.stack, current.index)
          protect(true)
          drain()
          return
        }
        rootTravel = true
        repairRoot()
        if (notifyRootBack) {
          try { options.onRootBack?.() } catch { /* El aviso no controla la navegación. */ }
        }
      }
      else history.back()
      return
    }
    if (rootTravel) {
      stopRootRepair()
      rootTravel = false
      if (value?.pletinaNavigation === 1 && value.session === session && snapshot(value.snapshot) &&
        Number.isInteger(value.index) && value.index! >= 0 && value.index! < current.stack.length) {
        const changed = current.index !== value.index
        current = { stack: current.stack, index: value.index! }
        if (changed && pending.length === 0) nav.restore(current.stack, current.index)
        persist()
      }
      drain()
      return
    }
    if (openingGuard) {
      openingGuard = false
      if (value?.session === session && value.preparedOverlay && value.index === current.index) {
        drain()
        return
      }
    }
    const wasGuarded = guarded
    guarded = false
    if (wasGuarded) {
      overlayWanted = false
      closeOverlay()
      reclaimOverlay = standalone && value?.index === current.index && !value?.overlay && overlaysRemain()
    }
    if (value?.session === session && value.preparedOverlay) {
      // El marcador de un panel cerrado no es una pantalla. Se recorre sin
      // crear entradas: pushState desde popstate haría que Chrome saltase todo
      // el historial de la PWA al usar su botón Atrás.
      if (value.index < current.index || value.index >= current.stack.length - 1) history.back()
      else history.forward()
      return
    }
    if (repairForward && (wasGuarded || closingGuard)) {
      // pushState del panel sustituye la rama Adelante. Al cerrarlo la reponemos
      // antes de aceptar otra navegación, sin cambiar la vista ni su índice.
      repairForward = false
      closingGuard = true
      const count = current.stack.length - current.index - 1
      for (let index = current.index + 1; index < current.stack.length; index++) {
        push(false, index)
      }
      history.go(-count)
      return
    }
    if (closingGuard) {
      closingGuard = false
      replace()
      protect()
      drain()
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
    drain()
  }
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return
    // Restaurar desde cualquiera de los dos límites debe recuperar Inicio.
    // Algunos motores omiten el popstate del límite restaurado.
    const value = navigationEntry(history.state) ? history.state : null
    if (standalone && value?.session === session && (value.rootBoundary || value.rootId !== rootId)) {
      rootTravel = true
      if (value.rootId === rootId) rootDistance = value.rootDistance!
      returnedBoundary = value.rootBoundary && value.rootId ? { rootId: value.rootId, distance: value.rootDistance! } : null
      repairRoot()
    }
  }
  browser.addEventListener('popstate', onPop)
  browser.addEventListener('pageshow', onPageShow)
  nav.installDriver({
    push(stack, index) {
      const next = JSON.parse(JSON.stringify({ stack, index })) as Snapshot
      run(() => {
        current = next
        repairForward = false
        reclaimOverlay = false
        // Chrome conserva unas pocas decenas de entradas. Renovar el límite
        // con una navegación del usuario evita que descarte nuestra raíz.
        if (standalone && rootDistance >= 36) {
          if (guarded) { guarded = false; closeOverlay() }
          protect(true)
          return
        }
        // Una navegación desde un menú ocupa su entrada temporal, sin duplicarla.
        if (guarded) {
          guarded = false
          closeOverlay()
          if (standalone) push()
          else history.replaceState(entry(), '', browser.location.href)
        }
        else push()
        persist()
      })
    },
    replace(stack, index) {
      const next = JSON.parse(JSON.stringify({ stack, index })) as Snapshot
      run(() => { current = next; replace() })
    },
    back() { run(() => history.back()) },
    forward() { run(() => history.forward()) },
    overlay(open, close, remaining) {
      closeOverlay = close
      overlaysRemain = remaining ?? (() => false)
      overlayWanted = open
      if (!open) reclaimOverlay = false
      if (open && reclaimOverlay) {
        reclaimOverlay = false
        // Al cerrar Cola puede seguir abierto Sonando ahora. Reutilizar el
        // mismo marcador mantiene ese segundo Atrás sin pushState desde pop.
        run(() => {
          if (!overlayWanted || guarded) return
          guarded = true
          openingGuard = true
          history.forward()
        })
        return
      }
      const openPanel = () => {
        if (!overlayWanted || guarded) return
        if (standalone && rootDistance + current.stack.length - current.index >= 36) {
          protect(true)
          run(openPanel)
          return
        }
        guarded = true
        repairForward = !standalone && current.index < current.stack.length - 1
        push(true)
        if (standalone) {
          // Preparar Adelante con el gesto que abre el panel evita reconstruir
          // entradas al cerrarlo mediante el botón del sistema.
          const count = current.stack.length - current.index - 1
          for (let index = current.index + 1; index < current.stack.length; index++) {
            push(false, index)
          }
          if (count) { openingGuard = true; history.go(-count) }
        }
      }
      if (open) run(openPanel)
      else if (guarded) {
        run(() => {
          if (!guarded) return
          guarded = false
          closingGuard = true
          history.back()
        })
      }
    },
  })
  if (standalone && !protectedRoot) protect()
  else if (closingGuard) history.back()
  else if (previous?.rootBoundary) {
    if (standalone) { rootTravel = true; repairRoot() }
    else history.back()
  }
  else protect()
  return () => {
    stopRootRepair()
    browser.removeEventListener('popstate', onPop)
    browser.removeEventListener('pageshow', onPageShow)
  }
}
