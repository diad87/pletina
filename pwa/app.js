// Instalación mínima. El reproductor se importa solo cuando se solicita.
const status = document.querySelector('#status')
const installButton = document.querySelector('#install')
const checkButton = document.querySelector('#check-update')
const applyButton = document.querySelector('#apply-update')
const headline = document.querySelector('#headline')
const intro = document.querySelector('#intro')
const installGuide = document.querySelector('#install-guide')
const guideTitle = document.querySelector('#guide-title')
const guideSteps = document.querySelector('#guide-steps')
const playerButton = document.querySelector('#open-player')
const homeScreen = document.querySelector('#home-screen')
const playerScreen = document.querySelector('#player-screen')
const playerURL = new URL('./player/entry.mjs', location.href)
const portable = location.protocol === 'file:' || document.documentElement.hasAttribute('data-portable')
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
const say = (message) => { status.textContent = message }
const ua = navigator.userAgent
const iPad = /iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const iOS = iPad || /iPhone|iPod/i.test(ua)
const safari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|OPiOS|Android/i.test(ua)
let installed = standalone()
let installPrompt
let registration
let checking = false
let reloading = false
let controlled = !portable && Boolean(navigator.serviceWorker?.controller)
let player
let playerLoadFailed = false
let opening = false
let applying = false

if (portable) {
  playerButton.hidden = true
  document.querySelector('link[rel="manifest"]')?.remove()
  document.querySelector('#updates').hidden = true
  const version = document.querySelector('#version')
  if (version.textContent.includes('__BUILD_VERSION__')) version.textContent = 'local'
}

async function openPletina(updateOnly = false, allowUpdate = true) {
  if (opening || applying) return
  opening = true
  playerButton.disabled = applyButton.disabled = true
  try {
    if (!player || updateOnly) {
      say('Preparando Pletina…')
      await waitForController()
      registration ||= await navigator.serviceWorker.getRegistration()
      if (allowUpdate) {
        await waitForInstalling()
        // Una entrada mínima antigua puede no tener su launcher guardado. Si ya
        // hay una actualización, preparamos esa versión antes de retirar la actual.
        if (await applyAndOpen()) return
      }
      if (updateOnly) { showState(); return }
      if (playerLoadFailed) { location.reload(); return }
      const { mountPlayer } = await import(playerURL.href)
      player = await mountPlayer(document.querySelector('#player-host'))
    }
    homeScreen.hidden = true
    playerScreen.hidden = false
    playerButton.textContent = 'Abrir Pletina'
    document.querySelector('#back-home').focus()
  } catch {
    playerLoadFailed = true
    // La actualización puede haber terminado mientras fallaba el recurso antiguo.
    // El siguiente clic debe ofrecer B, en lugar de recargar A indefinidamente.
    try { await checkForUpdate(); await waitForInstalling() } catch { /* Conserva la versión activa. */ }
    showState()
    say(registration?.waiting
      ? 'No se pudo abrir la versión anterior. Pulsa «Actualizar y abrir».'
      : 'No se pudo abrir Pletina. Comprueba la conexión y recarga para reintentar.')
  } finally {
    opening = false
    playerButton.disabled = applyButton.disabled = applying
  }
}
playerButton.addEventListener('click', () => openPletina())

async function waitForInstalling() {
  const worker = registration?.installing
  if (!worker) return
  await new Promise((resolve, reject) => {
    let timer
    const cleanup = () => { clearTimeout(timer); worker.removeEventListener('statechange', inspect) }
    const inspect = () => {
      if (['installed', 'activated', 'redundant'].includes(worker.state)) { cleanup(); resolve() }
    }
    worker.addEventListener('statechange', inspect)
    timer = setTimeout(() => { cleanup(); reject(new Error('No se pudo preparar la actualización.')) }, 30000)
    inspect()
  })
  registration = await navigator.serviceWorker.getRegistration() || registration
}

async function applyAndOpen() {
  const worker = registration?.waiting
  if (!worker) return false
  applying = true
  say('Preparando la nueva versión…')
  try {
    await new Promise((resolve, reject) => {
      const channel = new MessageChannel()
      const finish = (error) => { clearTimeout(timer); channel.port1.close(); error ? reject(error) : resolve() }
      const timer = setTimeout(() => finish(new Error('La descarga tardó demasiado.')), 120000)
      channel.port1.onmessage = (event) => finish(event.data?.ok ? null : new Error('No se pudo completar la descarga.'))
      try { worker.postMessage({ type: 'PREPARE_APPLICATION' }, [channel.port2]) }
      catch (error) { channel.port2.close(); finish(error) }
    })
    // No activar otro worker que haya sustituido al que acabamos de verificar.
    if (registration.waiting !== worker || worker.state !== 'installed') throw new Error('La actualización ha cambiado.')
    const destination = new URL(location.href)
    destination.searchParams.set('open', 'app')
    history.replaceState(history.state, '', destination.href)
    say('Abriendo la nueva versión…')
    worker.postMessage({ type: 'ACTIVATE_UPDATE' })
  } catch {
    applying = false
    say('No se pudo completar la actualización. Conservas tu versión. Reintenta con conexión.')
  }
  return true
}

function waitForController() {
  if (navigator.serviceWorker?.controller) return Promise.resolve()
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return Promise.reject(new Error('Navegador sin acceso seguro.'))
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', check) }
    const check = () => { if (navigator.serviceWorker.controller) { cleanup(); resolve() } }
    const timer = setTimeout(() => { cleanup(); reject(new Error('No se pudo preparar la aplicación.')) }, 30000)
    navigator.serviceWorker.addEventListener('controllerchange', check)
    check()
  })
}
document.querySelector('#back-home').addEventListener('click', () => {
  playerScreen.hidden = true
  homeScreen.hidden = false
  playerButton.focus()
  showState()
})

function showInstallState() {
  installed ||= standalone()
  installButton.hidden = installed || portable
  headline.textContent = installed || portable ? headline.dataset.installedTitle : 'Instalar Pletina'
  intro.textContent = portable ? 'Copia local, sin servidor.' : installed ? 'Todo empieza por algo pequeño.' : 'Llévala a tu pantalla de inicio.'
}
showInstallState()
matchMedia('(display-mode: standalone)').addEventListener('change', showInstallState)

function showInstallGuide() {
  let title = 'Instalar Pletina'
  let steps
  if (!window.isSecureContext) {
    steps = ['Abre la dirección HTTPS de Pletina en tu navegador.', 'Pulsa Instalar de nuevo desde esa dirección.']
  } else if (iOS) {
    title = `Instalar en ${iPad ? 'iPad' : 'iPhone'}`
    steps = [
      ...(!safari ? ['Abre esta misma dirección en Safari.'] : []),
      'Abre Compartir en Safari: el cuadrado con una flecha hacia arriba. Puede estar dentro de Más (···).',
      'Pulsa Añadir a pantalla de inicio. Si no aparece, busca la opción en Editar acciones.',
      'Deja activado Abrir como app web si aparece y pulsa Añadir.',
    ]
  } else if (/Android/i.test(ua)) {
    title = 'Instalar en Android'
    steps = [
      'Abre el menú del navegador (⋮ o ☰).',
      'Elige Instalar aplicación o Añadir a pantalla de inicio.',
      'Confirma Instalar. Si no aparece la opción, abre esta dirección en Chrome.',
    ]
  } else if (safari && /Mac/i.test(navigator.platform)) {
    title = 'Instalar en Mac'
    steps = ['En Safari, abre el menú Archivo.', 'Elige Añadir al Dock y confirma Añadir.']
  } else {
    steps = ['Abre el menú del navegador y busca Instalar Pletina o Instalar aplicación.', 'También puede aparecer un icono de instalación en la barra de direcciones. Si no aparece, abre esta dirección en Chrome o Edge.']
  }
  guideTitle.textContent = title
  guideSteps.replaceChildren(...steps.map((text) => {
    const item = document.createElement('li')
    item.textContent = text
    return item
  }))
  if (!installGuide.open) installGuide.showModal()
}
document.querySelector('#close-guide').addEventListener('click', () => installGuide.close())
installGuide.addEventListener('click', (event) => { if (event.target === installGuide) installGuide.close() })

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault()
  installPrompt = event
  showInstallState()
})
installButton.addEventListener('click', async () => {
  if (!installPrompt) { showInstallGuide(); return }
  const prompt = installPrompt
  installPrompt = undefined
  installButton.disabled = true
  try {
    // Debe ejecutarse dentro de este clic para conservar el gesto del usuario.
    await prompt.prompt()
    await prompt.userChoice
  } catch {
    showInstallGuide()
  } finally {
    installButton.disabled = false
    showInstallState()
  }
})
window.addEventListener('appinstalled', () => {
  installed = true
  installPrompt = undefined
  installGuide.close()
  showInstallState()
})

function showState() {
  if (applying) return
  applyButton.hidden = !registration?.waiting
  if (!player) playerButton.textContent = registration?.waiting ? 'Actualizar y abrir'
    : playerLoadFailed ? 'Recargar para reintentar' : 'Abrir Pletina'
  if (registration?.waiting) {
    say('Hay una nueva versión lista.')
  } else if (registration?.installing) {
    say(controlled ? 'Descargando la nueva versión…' : 'Preparando el acceso sin conexión…')
  } else if (navigator.serviceWorker?.controller) {
    say(navigator.onLine ? 'Lista para abrir sin conexión.' : 'Sin conexión. Puedes seguir usando esta versión.')
  }
}

function watch(worker) {
  if (!worker) return
  let installed = ['installed', 'activating', 'activated'].includes(worker.state)
  worker.addEventListener('statechange', () => {
    installed ||= ['installed', 'activating', 'activated'].includes(worker.state)
    if (worker.state === 'redundant' && !installed) {
      say(controlled ? 'No se pudo completar la actualización. Conservas tu versión.' : 'No se pudo guardar la app. Reintenta con conexión.')
    } else {
      showState()
    }
  })
  showState()
}

async function checkForUpdate(manual = false) {
  if (!registration || checking) return
  if (!navigator.onLine) { showState(); return }
  checking = true
  checkButton.disabled = true
  if (manual) say('Buscando actualizaciones…')
  try {
    await registration.update()
    if (manual && !registration.installing && !registration.waiting) say('Ya tienes la última versión. Lista sin conexión.')
    else showState()
  } catch {
    say(controlled ? 'No se pudo comprobar la actualización. Conservas tu versión.' : 'No se pudo preparar la app. Reintenta con conexión.')
  } finally {
    checking = false
    checkButton.disabled = false
  }
}
checkButton.addEventListener('click', () => checkForUpdate(true))
applyButton.addEventListener('click', () => openPletina(true))

if (!portable && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // La primera instalación solo habilita offline; las actualizaciones recargan una vez.
    if (controlled && !reloading) { reloading = true; location.reload(); return }
    controlled = true
    showState()
  })
  const base = new URL('./', location.href)
  navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.href, updateViaCache: 'none' })
    .then((result) => {
      registration = result
      checkButton.hidden = false
      registration.addEventListener('updatefound', () => watch(registration.installing))
      watch(registration.installing)
      showState()
      return checkForUpdate()
    })
    .catch(() => say('No se pudo preparar el acceso sin conexión. Reintenta con conexión.'))
  window.addEventListener('online', () => { showState(); checkForUpdate() })
  window.addEventListener('offline', showState)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate()
  })
} else {
  say(portable
    ? 'Archivo local. Listo para usar sin servidor. Esta copia se actualiza sustituyendo el archivo.'
    : 'Para instalar y guardar esta app, ábrela en un navegador compatible desde su dirección HTTPS.')
}

if (!portable) {
  let reopen = new URL(location.href).searchParams.get('open') === 'app'
  try { reopen ||= standalone() && localStorage.getItem('pletina:web:opened') === '1' } catch { /* Sin persistencia. */ }
  // Reabrir la app guardada no equivale a consentir una actualización pendiente.
  if (reopen) void openPletina(false, false)
}
