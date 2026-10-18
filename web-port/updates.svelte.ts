const root = new URL('../', location.href)
let registration: ServiceWorkerRegistration | undefined
let controlled = Boolean(navigator.serviceWorker?.controller)
let redirecting = false
export const webUpdate = $state({ ready: false, busy: false, error: '' })

export async function initWebUpdates() {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (controlled && !redirecting) {
      redirecting = true
      location.replace(new URL('?open=app', root).href)
    }
    controlled = true
  })
  try {
    registration = await navigator.serviceWorker.register(new URL('sw.js', root), { scope: root.href, updateViaCache: 'none' })
    const inspect = () => { webUpdate.ready = Boolean(registration?.waiting) }
    registration.addEventListener('updatefound', () => {
      registration?.installing?.addEventListener('statechange', inspect)
    })
    inspect()
    await registration.update()
  } catch { /* La versión guardada sigue disponible sin red. */ }
  window.addEventListener('online', () => { void registration?.update().catch(() => {}) })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void registration?.update().catch(() => {})
  })
}

export async function applyWebUpdate() {
  const worker = registration?.waiting
  if (!worker || webUpdate.busy) return
  webUpdate.busy = true
  webUpdate.error = ''
  try {
    // Solo al actualizar la app completa se preparan también sus módulos nuevos.
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => { channel.port1.close(); reject(new Error('La descarga tardó demasiado.')) }, 120000)
      channel.port1.onmessage = (event) => {
        clearTimeout(timer)
        channel.port1.close()
        event.data?.ok ? resolve() : reject(new Error('No se pudo completar la descarga.'))
      }
      worker.postMessage({ type: 'PREPARE_APPLICATION' }, [channel.port2])
    })
    worker.postMessage({ type: 'ACTIVATE_UPDATE' })
  } catch {
    webUpdate.error = 'No se pudo completar la actualización. Reintenta con conexión.'
    webUpdate.busy = false
  }
}
