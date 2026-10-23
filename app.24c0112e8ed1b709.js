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
const playerURL = new URL('./application/launcher.e458fcb919a7856d.js', location.href)
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

// Iconos locales: formas constantes, sin imágenes ni código de terceros.
const guideIcons = {
  share: 'M12 15V3m0 0L7 8m5-5 5 5M7 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2',
  add: 'M8 12h8m-4-4v8M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z',
  check: 'm7 12 3 3 7-7M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  menu: 'M12 5h.01M12 12h.01M12 19h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  safari: 'm15 9-2 4-4 2 2-4 4-2ZM21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8M8 17h5',
  install: 'M12 3v12m-4-4 4 4 4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M6 10h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Zm6 4v3',
}
function guideNode(tag, className, text) {
  const node = document.createElement(tag)
  node.className = className
  if (text) node.textContent = text
  return node
}
function guideIcon(name, small = false) {
  const icon = guideNode('span', small ? 'guide-help-icon' : 'guide-icon')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': ['menu', 'more'].includes(name) ? '3.5' : '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(key, value)
  svg.setAttribute('aria-hidden', 'true')
  path.setAttribute('d', guideIcons[name])
  svg.append(path)
  icon.append(svg)
  return icon
}
function guideStep(step, index) {
  const item = document.createElement('li')
  const number = guideNode('span', 'guide-number', String(index + 1))
  number.setAttribute('aria-hidden', 'true')
  const body = guideNode('div', 'guide-copy')
  body.append(guideNode('strong', 'guide-label', step.label))
  if (step.setting) {
    const setting = guideNode('div', 'guide-setting')
    const toggle = guideNode('span', 'guide-switch')
    toggle.setAttribute('aria-hidden', 'true')
    setting.append(toggle, guideNode('span', '', step.setting))
    body.append(setting)
  }
  if (step.help) {
    const help = guideNode('p', 'guide-help')
    if (step.helpIcon) help.append(guideIcon(step.helpIcon, true))
    help.append(guideNode('span', '', step.help))
    body.append(help)
  }
  item.append(number, guideIcon(step.icon), body)
  return item
}
function showInstallGuide() {
  let title = 'Instalar Pletina'
  let lead = ''
  let steps
  if (!window.isSecureContext) {
    steps = [
      { icon: 'lock', label: 'Abre Pletina con HTTPS', help: 'Desde su dirección segura.' },
      { icon: 'install', label: 'Pulsa Instalar' },
      { icon: 'check', label: 'Confirma la instalación' },
    ]
  } else if (iOS) {
    title = `Instalar en ${iPad ? 'iPad' : 'iPhone'}`
    if (!safari) lead = 'Primero, abre esta página en Safari.'
    steps = [
      { icon: 'share', label: 'Compartir', helpIcon: 'more', help: 'Si no lo ves: Menú de página / Más → Compartir.' },
      { icon: 'add', label: 'Añadir a pantalla de inicio', help: 'Si no aparece: Editar acciones.' },
      { icon: 'check', label: 'Añadir', setting: 'Abrir como app web', help: 'Déjalo activado si aparece.' },
    ]
  } else if (/Android/i.test(ua)) {
    title = 'Instalar en Android'
    steps = [
      { icon: 'menu', label: 'Más', help: 'El menú del navegador.' },
      { icon: 'add', label: 'Instalar y crear acceso directo', help: 'También: Añadir a pantalla de inicio o Instalar aplicación.' },
      { icon: 'check', label: 'Instalar', help: 'Si no aparece la opción, abre esta página en Chrome.' },
    ]
  } else if (safari && /Mac/i.test(navigator.platform)) {
    title = 'Instalar en Mac'
    steps = [
      { icon: 'file', label: 'Archivo', help: 'En el menú de Safari.' },
      { icon: 'add', label: 'Añadir al Dock' },
      { icon: 'check', label: 'Añadir' },
    ]
  } else {
    steps = [
      { icon: 'menu', label: 'Menú del navegador' },
      { icon: 'install', label: 'Instalar Pletina', help: 'O Instalar aplicación. También puede estar en la barra de direcciones.' },
      { icon: 'check', label: 'Instalar', help: 'Si no aparece, usa Chrome o Edge.' },
    ]
  }
  guideTitle.textContent = title
  document.querySelector('#guide-context').textContent = window.isSecureContext && (iOS || safari && /Mac/i.test(navigator.platform))
    ? 'En Safari, toca estos botones.' : 'En tu navegador, toca estos botones.'
  const guideLead = document.querySelector('#guide-lead')
  guideLead.hidden = !lead
  guideLead.replaceChildren(...(lead ? [guideIcon('safari', true), document.createTextNode(lead)] : []))
  guideSteps.replaceChildren(...steps.map(guideStep))
  installGuide.scrollTop = 0
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
