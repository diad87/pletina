import assert from 'node:assert/strict'

export const installationScenarioInventory = [
  { id: 'install.minimal', actions: ['initial installer', 'no application assets before opening'] },
  { id: 'install.manifest', actions: ['stable id and scope', 'standalone display', 'Android and Apple icons'] },
  { id: 'install.guide', actions: ['platform instructions', 'close instructions'] },
  { id: 'install.offline', actions: ['service worker activation', 'cached installer reload offline'] },
  { id: 'install.native-prompt', actions: ['real OS installation confirmation requires an installed physical browser'] },
]
export async function runInstallationScenarios(ctx) {
  const { page, check, baseURL } = ctx
  await page.addInitScript(() => {
    if (window !== top) return
    window.__qaNativeInstallPromptCalls = 0
    addEventListener('beforeinstallprompt', event => {
      const original = event.prompt.bind(event)
      event.prompt = (...args) => {
        window.__qaNativeInstallPromptCalls++
        return original(...args)
      }
    })
  })
  const applicationRequests = []
  const track = request => { if (request.url().includes('/application/')) applicationRequests.push(request.url()) }
  page.on('request', track)
  await check('install.minimal: initial entry avoids all application assets', async () => {
    await page.goto(baseURL, { waitUntil: 'load' })
    await page.locator('#install').waitFor()
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller))
    assert.match(await page.locator('#headline').textContent(), /Instalar Pletina/)
    assert.equal(applicationRequests.length, 0)
    const cachedApplicationFiles = await page.evaluate(async () => {
      const found = []
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) {
          if (new URL(request.url).pathname.includes('/application/')) found.push(new URL(request.url).pathname)
        }
      }
      return found
    })
    assert.deepEqual(cachedApplicationFiles, [], 'The initial service worker must not pre-cache the optional application')
    return { applicationRequests: 0, cachedApplicationFiles, realServiceWorkerController: true }
  })
  await check('install.manifest: stable scope, standalone identity and icon resources', async () => {
    const result = await page.evaluate(async () => {
      const reference = document.querySelector('link[rel="manifest"]').href
      const response = await fetch(reference)
      const manifest = await response.json()
      const icons = await Promise.all(manifest.icons.map(async icon => ({ size: icon.sizes, status: (await fetch(new URL(icon.src, reference))).status })))
      const appleIcon = document.querySelector('link[rel="apple-touch-icon"]')
      return { manifest, icons, reference, appleStatus: (await fetch(appleIcon.href)).status }
    })
    assert.equal(result.manifest.display, 'standalone')
    for (const name of ['id', 'scope', 'start_url']) assert.equal(new URL(result.manifest[name], result.reference).href, baseURL)
    assert.ok(result.icons.some(icon => icon.size === '192x192'))
    assert.ok(result.icons.some(icon => icon.size === '512x512'))
    assert.ok(result.icons.every(icon => icon.status === 200))
    assert.equal(result.appleStatus, 200)
    return { stableIdentity: true, iconSizes: result.icons.map(icon => icon.size) }
  })
  await check('install.guide: platform instructions open and close', async () => {
    await ctx.tap('#install')
    try { await page.locator('#install-guide[open]').waitFor({ timeout: 2000 }) }
    catch (error) {
      const nativePromptCalls = await page.evaluate(() => window.__qaNativeInstallPromptCalls || 0)
      if (!nativePromptCalls) throw error
      await page.reload({ waitUntil: 'load' })
      return { status: 'unsupported', reason: 'The browser invoked its native install prompt, which headless mode cannot confirm.', nativePromptCalls }
    }
    const guide = await page.locator('#install-guide').textContent()
    const ua = await page.evaluate(() => navigator.userAgent)
    if (/iPhone|iPad/.test(ua)) {
      assert.match(guide, /Compartir/)
      assert.match(guide, /Safari/)
      assert.match(guide, /Añadir a pantalla de inicio/)
    } else if (/Android/.test(ua)) assert.match(guide, /Android|Instalar aplicación/)
    else assert.match(guide, /Instalar Pletina|Instalar aplicación|Añadir al Dock/)
    await ctx.tap('#close-guide')
    assert.equal(await page.locator('#install-guide[open]').count(), 0)
    return { guideVerifiedForUserAgent: true, OSConfirmationClaimed: false }
  })
  await check('install.offline: cached entry reloads with the network disconnected', async () => {
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller))
    const disconnection = await ctx.goOffline(true)
    try {
      await page.reload({ waitUntil: 'load' })
      await page.locator('#install').waitFor()
      assert.equal(await page.evaluate(() => navigator.onLine), !disconnection.navigatorOfflineExpected)
      assert.equal(applicationRequests.length, 0)
    } finally { await ctx.goOffline(false) }
    return { cachedInstaller: true, applicationNotDownloaded: true, disconnectionMode: disconnection.mode,
      navigatorOfflineExpected: disconnection.navigatorOfflineExpected, physicalAirplaneModeClaimed: false }
  })
  await check('install.native-prompt: actual phone installation', async () => ({
    status: 'unsupported',
    reason: 'A desktop browser context cannot confirm Add to Home Screen, installed standalone state or an OS native installation prompt on Android/iPhone.',
  }))
  page.off('request', track)
}
