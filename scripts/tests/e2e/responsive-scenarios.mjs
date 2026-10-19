import assert from 'node:assert/strict'

export const responsiveScenarioInventory = [
  { id: 'responsive.resize', actions: ['portrait to desktop layout', 'short landscape viewport', 'restore portrait', 'query and navigation survive', 'no horizontal overflow'] },
  { id: 'responsive.resume', actions: ['resize and page visibility lifecycle', 'reload on search', 'four navigation destinations remain accessible'] },
]

export async function runResponsiveScenarios(ctx) {
  const { page, check } = ctx
  const original = page.viewportSize()
  const query = ctx.fixture.media.query
  const measure = () => page.evaluate(() => {
    const dock = document.querySelector('.bottom-nav')
    const bounds = dock?.getBoundingClientRect()
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      tabs: [...document.querySelectorAll('.bottom-nav button')].map(node => node.textContent.trim()),
      dock: bounds && { top: bounds.top, bottom: bounds.bottom, height: bounds.height },
      sidebar: Boolean(document.querySelector('.sidebar')), query: document.querySelector('input[aria-label="Buscar música"]')?.value }
  })
  try {
    await check('responsive.resize: query and dock survive portrait, desktop and short landscape', async () => {
      await ctx.fillSearch('Buscar', query)
      await page.locator('ol.tracks > li[data-reorder-index]').first().waitFor()
      const results = []
      for (const size of [{ width: 390, height: 844 }, { width: 1100, height: 650 }, { width: 700, height: 390 }, { width: 390, height: 650 }]) {
        await page.setViewportSize(size)
        await ctx.settle()
        if (size.width < 800) await page.locator('.bottom-nav').waitFor()
        else await page.locator('.sidebar').waitFor()
        // The product deliberately settles visualViewport metrics again at 150 ms.
        // Wait for that bounded layout state instead of asserting an intermediate frame.
        await page.waitForFunction(size => {
          if (innerWidth !== size.width || innerHeight !== size.height) return false
          const expectedHeight = Math.floor(Math.min(innerHeight, visualViewport?.height ?? innerHeight))
          const applied = Number.parseFloat(document.documentElement.style.getPropertyValue('--pletina-viewport-height'))
          const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect()
          return applied === expectedHeight && (!nav || nav.top >= 0 && nav.bottom <= innerHeight + 1)
        }, size, { timeout: 3000 })
        const state = await measure()
        assert.ok(state.documentWidth <= state.width + 1, 'No horizontal document overflow at ' + size.width + 'x' + size.height)
        assert.equal(state.query, query)
        if (size.width < 800) {
          assert.deepEqual(state.tabs, ['Inicio', 'Buscar', 'Podcasts', 'Tu biblioteca'])
          assert.ok(state.dock.top >= 0 && state.dock.bottom <= state.height + 1, 'Bottom navigation stays within viewport')
        } else assert.equal(state.sidebar, true)
        results.push(state)
      }
      return { viewports: results, physicalRotationClaimed: false }
    })
    await check('responsive.resume: navigation survives lifecycle signals and reload after resizing', async () => {
      await page.setViewportSize({ width: 390, height: 650 })
      // Dispatch actual DOM lifecycle listeners without claiming an OS process suspension.
      await page.evaluate(() => {
        window.dispatchEvent(new Event('pageshow'))
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('resize'))
      })
      await ctx.settle()
      await page.reload({ waitUntil: 'load' })
      await page.locator('input[aria-label="Buscar música"]').waitFor()
      assert.equal(await page.locator('input[aria-label="Buscar música"]').inputValue(), query)
      for (const name of ['Inicio', 'Podcasts', 'Tu biblioteca', 'Buscar']) {
        await ctx.tab(name)
        const state = await measure()
        assert.deepEqual(state.tabs, ['Inicio', 'Buscar', 'Podcasts', 'Tu biblioteca'])
        assert.ok(state.dock.bottom <= state.height + 1)
      }
      return { syntheticLifecycleSignals: true, realReload: true, physicalProcessRestoreClaimed: false }
    })
  } finally {
    await page.setViewportSize(original)
    await ctx.settle()
  }
}
