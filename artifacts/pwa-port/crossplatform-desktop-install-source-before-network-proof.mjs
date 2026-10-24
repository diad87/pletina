// Installs only in a new disposable Chrome/Edge profile, never the user's profile.
// CDP installation does not exercise the native confirmation dialog.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import crypto from 'node:crypto'
import puppeteer from 'puppeteer-core'

const args = process.argv.slice(2)
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const expectedBuild = option('--expected-build', '')
assert.match(expectedBuild, /^[a-f0-9]{16}$/)
const installURL = 'https://diad87.github.io/pletina/'
const executablePath = option('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe')
const output = resolve(option('--output', 'artifacts/pwa-port/crossplatform-desktop-install.json'))
const profile = await mkdtemp(join(option('--profile-root', tmpdir()), 'pletina-pwa-install-'))
const source = await readFile(new URL(import.meta.url))
const report = {
  testedAt: new Date().toISOString(), expectedBuild, host: { platform: process.platform, arch: process.arch },
  scope: 'Installed browser app lifecycle in a disposable desktop profile, controlled by CDP; not the native install dialog or a physical mobile device.',
  sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  profile, flags: ['--enable-unsafe-extension-debugging', '--remote-debugging-pipe'],
  nativeInstallDialogVerified: false, osLauncherShortcutVerified: false, checks: [], errors: [],
}
let browser, installed = false, manifestId
const launch = async () => {
  browser = await puppeteer.launch({ headless: true, executablePath, userDataDir: profile, pipe: true,
    args: ['--enable-unsafe-extension-debugging', ...(args.includes('--no-sandbox') ? ['--no-sandbox'] : [])], protocolTimeout: 30000 })
  report.browser = await browser.version()
  return browser.target().createCDPSession()
}
async function openInstalled(cdp) {
  const previous = new Set(browser.targets())
  const launched = await cdp.send('PWA.launch', { manifestId })
  // Chrome returns a tab target, whereas Puppeteer exposes its child page target.
  const target = await browser.waitForTarget(target => target.type() === 'page' && !previous.has(target), { timeout: 15000 })
  const page = await target.page()
  await page.waitForFunction(base => location.href.startsWith(base) && document.readyState === 'complete', {}, installURL)
  const state = await page.evaluate(() => ({ url: location.href, standalone: matchMedia('(display-mode: standalone)').matches }))
  assert.equal(state.standalone, true)
  report.launches ??= []
  report.launches.push({ targetId: launched.targetId, ...state })
  return page
}
try {
  let cdp = await launch()
  const page = await browser.newPage()
  await page.goto(installURL, { waitUntil: 'load', timeout: 30000 })
  await page.evaluate(() => navigator.serviceWorker.ready)
  const pageCdp = await page.createCDPSession()
  const manifest = await pageCdp.send('Page.getAppManifest')
  const installability = await pageCdp.send('Page.getInstallabilityErrors')
  assert.deepEqual(manifest.errors, [])
  assert.deepEqual(installability.installabilityErrors, [])
  manifestId = manifest.manifest.id
  report.manifest = { id: manifestId, startURL: manifest.manifest.startUrl, scope: manifest.manifest.scope }
  assert.equal(report.manifest.startURL, installURL)
  assert.equal(report.manifest.scope, installURL)
  assert.equal(await page.$eval('#version', element => element.textContent.trim()), expectedBuild)
  report.checks.push({ name: 'Public manifest and installability', pass: true })
  await cdp.send('PWA.install', { manifestId, installUrlOrBundleUrl: installURL })
  installed = true
  report.osAppState = await cdp.send('PWA.getOsAppState', { manifestId })
  report.checks.push({ name: 'App registered by browser', pass: true })
  await cdp.send('PWA.changeAppUserSettings', { manifestId, displayMode: 'standalone' })
  let app = await openInstalled(cdp)
  await app.waitForSelector('#open-player')
  await app.click('#open-player')
  await app.waitForSelector('.app')
  assert.equal(await app.evaluate(() => matchMedia('(display-mode: standalone)').matches), true)
  const navigation = await app.$$eval('.sidebar nav button, .sidebar .heading, .bottom-nav button', nodes => nodes.map(node => node.textContent.replace(/\s+/g, ' ').trim()))
  report.navigation = navigation
  for (const label of ['Inicio', 'Buscar', 'Podcasts', 'Tu biblioteca']) assert.ok(navigation.includes(label), label)
  report.checks.push({ name: 'Standalone window opens app with navigation and persistent desktop library', pass: true })
  const sentinel = crypto.randomUUID()
  await app.evaluate(value => localStorage.setItem('pletina:qa:desktop-install', value), sentinel)
  await browser.close()
  browser = null
  cdp = await launch()
  report.osAppStateAfterBrowserRestart = await cdp.send('PWA.getOsAppState', { manifestId })
  app = await openInstalled(cdp)
  await app.waitForSelector('.app')
  assert.equal(await app.evaluate(() => localStorage.getItem('pletina:qa:desktop-install')), sentinel)
  report.checks.push({ name: 'Browser restart preserves installation, app launch and origin storage', pass: true })
  await app.setOfflineMode(true)
  await app.reload({ waitUntil: 'load' })
  await app.waitForSelector('.app')
  assert.equal(await app.evaluate(() => navigator.onLine), false)
  assert.equal(await app.evaluate(() => matchMedia('(display-mode: standalone)').matches), true)
  assert.equal(await app.evaluate(() => localStorage.getItem('pletina:qa:desktop-install')), sentinel)
  report.checks.push({ name: 'Installed app reloads without network after browser restart', pass: true })
  await app.screenshot({ path: output.replace(/\.json$/, '.png') })
  await app.setOfflineMode(false)
  await cdp.send('PWA.uninstall', { manifestId })
  installed = false
  report.checks.push({ name: 'Only the disposable-profile installation is removed', pass: true })
} catch (error) {
  report.errors.push({ name: error.name, message: error.message })
} finally {
  if (installed && browser) {
    try { await (await browser.target().createCDPSession()).send('PWA.uninstall', { manifestId }); report.cleanupUninstalled = true }
    catch (error) { report.cleanupError = error.message }
  }
  await browser?.close()
  report.resourcesClosed = true
  report.passed = !report.errors.length && report.checks.length === 6
  await mkdir(resolve(output, '..'), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ output, browser: report.browser, host: report.host, checks: report.checks, errors: report.errors, passed: report.passed }))
if (!report.passed) process.exitCode = 1
