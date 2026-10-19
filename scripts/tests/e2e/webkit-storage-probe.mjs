// Checks quota-failure test injection against a StorageManager captured before the patch.
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
const { webkit } = await import('playwright')
const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Storage API probe</title>') })
const report = { host: { platform: process.platform, arch: process.arch }, at: new Date().toISOString(), scope: 'Isolated test-host injection probe; no product code changed', cases: [] }
let browser
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await webkit.launch({ headless: true }); report.browser = browser.version()
  for (const [mobile, mode] of [[false, 'late-instance-assignment'], [false, 'prototype-definition'], [true, 'late-instance-assignment'], [true, 'prototype-definition']]) {
    const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } : {})
    try {
      const page = await context.newPage()
      await page.goto(`http://127.0.0.1:${server.address().port}/`)
      const result = await page.evaluate(async mode => {
        const captured = navigator.storage
        const capabilities = { secureContext: isSecureContext, storageExposed: 'storage' in navigator,
          storageType: typeof captured, storageManagerType: typeof window.StorageManager }
        if (!captured?.estimate) return { mode, ...capabilities, status: 'unsupported', reason: 'navigator.storage.estimate is not exposed by this runtime' }
        const proto = Object.getPrototypeOf(captured)
        const sameObject = captured === navigator.storage
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'estimate')
        const before = await captured.estimate()
        const stub = async () => ({ usage: 1024, quota: 1024 })
        try {
          if (mode === 'late-instance-assignment') navigator.storage.estimate = stub
          else Object.defineProperty(proto, 'estimate', { ...descriptor, value: stub })
          return { mode, ...capabilities, sameObject, configurable: descriptor?.configurable, writable: descriptor?.writable,
            before, capturedEstimateIsStub: captured.estimate === stub, currentEstimateIsStub: navigator.storage.estimate === stub,
            captured: await captured.estimate(), current: await navigator.storage.estimate() }
        } finally {
          if (mode === 'prototype-definition') Object.defineProperty(proto, 'estimate', descriptor)
          else delete navigator.storage.estimate
        }
      }, mode)
      report.cases.push({ mobile, ...result })
    } finally { await context.close() }
  }
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  const directory = new URL('../../../artifacts/pwa-e2e/', import.meta.url); await mkdir(directory, { recursive: true })
  await writeFile(new URL('webkit-storage-probe-' + process.platform + '.json', directory), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
