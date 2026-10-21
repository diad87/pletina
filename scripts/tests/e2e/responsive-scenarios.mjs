import assert from 'node:assert/strict'

export const responsiveScenarioInventory = [
  { id: 'responsive.resize', actions: ['portrait to desktop layout', 'short landscape viewport', 'restore portrait', 'query and navigation survive', 'no horizontal overflow'] },
  { id: 'responsive.resume', actions: ['resize and page visibility lifecycle', 'reload on search', 'four navigation destinations remain accessible'] },
  { id: 'responsive.keyboard-navigation', actions: ['named navigation landmark', 'Tab and Enter activate music/podcast search', 'search focus', 'Escape clears search', 'one current destination'] },
  { id: 'responsive.source-dialog-accessibility', actions: ['named source input', 'Enter submits invalid link', 'associated live error', 'editing clears invalid state', 'Escape closes native dialog'] },
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
    await check('responsive.keyboard-navigation: Tab and Enter reach named searches with a current destination', async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      await ctx.tab('Inicio')
      const navigation = page.getByRole('navigation', { name: 'Navegación principal', exact: true })
      const home = navigation.getByRole('button', { name: 'Inicio', exact: true })
      assert.equal(await home.getAttribute('aria-current'), 'page')
      // Establish the start of this keyboard traversal; subsequent actions use real key events.
      await home.focus()
      await page.keyboard.press('Tab')
      assert.equal(await navigation.getByRole('button', { name: 'Buscar', exact: true }).evaluate(node => node === document.activeElement), true)
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Buscar música')
      await page.keyboard.type(query)
      await page.locator('ol.tracks > li[data-reorder-index]').first().waitFor()
      await page.keyboard.press('Escape')
      assert.equal(await page.getByRole('textbox', { name: 'Buscar música', exact: true }).inputValue(), '')
      assert.equal(await navigation.getByRole('button', { name: 'Buscar', exact: true }).getAttribute('aria-current'), 'page')
      assert.equal(await navigation.locator('[aria-current="page"]').count(), 1)
      await home.focus()
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter')
      assert.equal(await navigation.getByRole('button', { name: 'Podcasts', exact: true }).getAttribute('aria-current'), 'page')
      await page.getByRole('textbox', { name: 'Buscar podcasts', exact: true }).waitFor()
      return { keyboardActions: ['Tab', 'Enter', 'typing', 'Escape'], currentDestination: 'Podcasts', screenReaderDeviceClaimed: false }
    })
    await check('responsive.source-dialog-accessibility: keyboard validation exposes and clears its associated error', async () => {
      await ctx.fillSearch('Buscar', query)
      await page.locator('ol.tracks > li[data-reorder-index="0"]').waitFor()
      await ctx.tap('ol.tracks > li[data-reorder-index="0"] button.more')
      await ctx.clickText('[role="menuitem"]', '¿No es esta canción?')
      const dialog = page.getByRole('dialog', { name: 'Elegir otro vídeo', exact: true })
      const input = dialog.getByRole('textbox', { name: 'Enlace o ID del vídeo de YouTube', exact: true })
      await dialog.locator('button.alt').first().waitFor()
      await input.fill('enlace no válido'); await input.press('Enter')
      const error = dialog.getByRole('alert')
      await error.waitFor()
      assert.equal(await input.getAttribute('aria-invalid'), 'true')
      assert.equal(await input.getAttribute('aria-describedby'), await error.getAttribute('id'))
      assert.match(await error.textContent(), /no parece/)
      await input.press('Control+a'); await input.press('Backspace')
      assert.equal(await input.getAttribute('aria-invalid'), 'false')
      assert.equal(await input.getAttribute('aria-describedby'), null)
      await error.waitFor({ state: 'detached' })
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      return { nativeDialogClosedByEscape: true, labelledInputAndError: true, screenReaderDeviceClaimed: false }
    })
  } finally {
    await page.setViewportSize(original)
    await ctx.settle()
  }
}
