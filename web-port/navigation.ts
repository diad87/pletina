import type { NavigationDriver, Route } from '../src/lib/nav.svelte'

type Snapshot = { stack: Route[]; index: number }
type Navigation = Snapshot & { restore(stack: Route[], index: number, preserveView?: boolean): void; installDriver(driver: NavigationDriver): void }
type Entry = { pletinaNavigation: 1; session: string; index: number; overlay: boolean; snapshot: Snapshot;
  protectedRoot?: true; rootBoundary?: true; rootDistance?: number; rootId?: string; preparedOverlay?: true }
type Options = { onExitArmed?: () => void }
export const ROOT_EXIT_WINDOW_MS = 800
const markerId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

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

function navigationEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false
  const item = value as Entry
  return item.pletinaNavigation === 1 && typeof item.session === 'string' && typeof item.overlay === 'boolean' &&
    snapshot(item.snapshot) && Number.isInteger(item.index) && item.index >= 0 &&
    item.index === item.snapshot.index && item.index < item.snapshot.stack.length &&
    (item.protectedRoot === undefined || item.protectedRoot === true && Number.isInteger(item.rootDistance) && item.rootDistance! >= 0) &&
    (item.rootId === undefined || item.protectedRoot === true && typeof item.rootId === 'string' && /^[a-z0-9-]{8,100}$/.test(item.rootId)) &&
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
  let protectedRoot = standalone && previous?.protectedRoot === true && previous.rootId !== undefined
  let rootId = protectedRoot ? previous!.rootId! : markerId()
  let rootDistance = protectedRoot ? previous!.rootDistance! : 0
  let rootTravel = false
  let exitHeld: { rootId: string } | null = null
  let exitTimer: number | undefined
  let leaving = false
  let exitSteps = 0
  const stopExitHold = () => {
    browser.clearTimeout(exitTimer)
    exitTimer = undefined
    exitHeld = null
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
    ...(protectedRoot ? { protectedRoot: true as const, rootDistance, rootId } : {}),
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
    // Una sesión antigua no tiene entrada debajo de Inicio. Reconstruimos solo
    // su historial interno; nunca cambiamos de documento ni tocamos el audio.
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
    if (leaving) {
      // Una acción nueva reclama el historial sin seguir recorriendo una salida pendiente.
      leaving = false
      pending.push(action)
      protect(true)
      drain()
    } else if (exitHeld) {
      pending.push(action)
      stopExitHold()
      rootTravel = true
      history.forward()
    } else if (closingGuard || rootTravel || openingGuard) pending.push(action)
    else action()
  }
  const onPop = (event: PopStateEvent) => {
    const value = navigationEntry(event.state) ? event.state : null
    if (leaving) {
      // Las compactaciones dejan límites antiguos. Solo se recorren nuestros marcadores
      // validados; cada back reduce el historial, sin pushState ni volver hacia delante.
      if (value?.session === session && exitSteps-- > 0) history.back()
      return
    }
    if (exitHeld) {
      const held = exitHeld.rootId
      stopExitHold()
      if (value?.session === session && value.rootId === held && value.index === 0 && !value.overlay && !value.rootBoundary) {
        // Adelante durante la ventana cancela la salida y conserva su sentido de navegación.
        if (current.stack.length > 1) { history.forward(); return }
      } else {
        // El segundo Atrás ya ha atravesado el límite de forma nativa. Si aún queda
        // historial interno de esta sesión, se consume hasta entregar el control al navegador.
        leaving = true
        exitSteps = Math.max(1, history.length)
        if (value?.session === session) history.back()
        return
      }
    }
    if (standalone && protectedRoot && value?.session === session && value.rootId !== rootId) {
      // Un salto iniciado fuera de Inicio puede alcanzar una raíz compactada anterior.
      // Se vuelve hacia nuestra raíz vigente sin tratarlo como el segundo toque de salida.
      rootTravel = true
      history.forward()
      return
    }
    if (value?.session === session && value.protectedRoot) rootDistance = value.rootDistance!
    if (value?.pletinaNavigation === 1 && value.session === session && value.rootBoundary === true) {
      // En modo instalado, Atrás en la raíz conserva el documento y la rama
      // Adelante. En una pestaña normal se permite abandonar la página.
      if (standalone) {
        const canExit = current.index === 0 && current.stack[0].name === 'home' && !guarded &&
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
        if (canExit) {
          // El primer Atrás se queda en el límite: un segundo gesto nativo puede salir
          // incluso cuando no existe documento anterior para history.back(). No se cierra
          // la ventana por JavaScript; el navegador/SO decide el destino de ese gesto.
          exitHeld = { rootId }
          exitTimer = browser.setTimeout(() => {
            if (!exitHeld) return
            stopExitHold()
            rootTravel = true
            history.forward()
          }, ROOT_EXIT_WINDOW_MS)
          try { options.onExitArmed?.() } catch { /* El aviso no controla la navegación. */ }
        } else {
          rootTravel = true
          history.forward()
        }
      }
      else history.back()
      return
    }
    if (rootTravel) {
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
  browser.addEventListener('popstate', onPop)
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
  if (closingGuard) history.back()
  else if (previous?.rootBoundary) {
    if (standalone) { rootTravel = true; history.forward() }
    else history.back()
  }
  else protect()
  return () => { stopExitHold(); browser.removeEventListener('popstate', onPop) }
}
