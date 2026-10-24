import assert from 'node:assert/strict'

// Provider failures are real HTTP responses. No podcast module or saved data is replaced.
export async function runPodcastRecoveryScenario(ctx) {
  const { page, fixture, check } = ctx
  await check('library.podcast-recovery: failed RSS shows an error, retry recovers feeds and a genuine empty search stays empty', async () => {
    const { query, showTitle, episodes } = fixture.media.rss
    const feeds = () => fixture.requests.filter(row => row.host === 'feeds.pletina.test')
    await fixture.reset()
    await ctx.fillSearch('Podcasts', query)
    await page.getByRole('combobox', { name: 'Idioma de los pódcasts' }).selectOption('es')
    await page.locator('[aria-label="Resultados de pódcasts"] .hit').first().waitFor()
    // Reload removes the successful in-memory RSS cache before injecting failure.
    await fixture.set({ failPodcastFeeds: true, emptyYoutubePodcasts: true })
    const mark = feeds().length
    try {
      await page.reload({ waitUntil: 'load' })
      const retry = page.locator('.status').getByRole('button', { name: 'Reintentar', exact: true })
      await retry.waitFor()
      assert.match(await page.locator('.status').textContent(), /no se pudo leer ningún|no se pudieron leer/i)
      assert.equal(await page.locator('.empty-state').count(), 0, 'A failed read is not a valid no-results response')
      const failed = feeds().slice(mark)
      assert.ok(failed.length >= 2 && failed.every(row => row.injectedFailure === 'rss-http-503'))
      await fixture.set({ failPodcastFeeds: false })
      await retry.click()
      const result = page.locator('[aria-label="Resultados de pódcasts"]').getByRole('button', { name: showTitle, exact: true })
      await result.waitFor()
      assert.equal(await page.locator('.status button, .empty-state').count(), 0)
      assert.equal(await page.locator('[aria-label="Pódcasts de YouTube"] .hit').count(), 0, 'RSS must recover without a YouTube substitute')
      const recovered = feeds().slice(mark + failed.length)
      assert.ok(recovered.length >= 2 && recovered.every(row => !row.injectedFailure))
      await result.click()
      await page.locator('.episodes .episode').first().waitFor()
      assert.deepEqual(await page.locator('.episodes .episode h3').allTextContents(), episodes.map(item => item.title))
      await fixture.set({ emptyPodcastDirectory: true })
      await ctx.fillSearch('Podcasts', 'QA Búsqueda Sin Podcasts 2026')
      await page.locator('.empty-state strong').waitFor()
      assert.match(await page.locator('.empty-state strong').textContent(), /No hay resultados/)
      assert.equal(await page.locator('.status button').count(), 0)
      assert.equal(await page.locator('.partial').count(), 0)
      return { injectedHttpStatus: 503, failedFeedRequests: failed.length, retryFeedRequests: recovered.length,
        recoveredRssEpisodes: episodes.length, youtubeFallbackUsed: false, genuineEmptyIsNotAnError: true,
        realReloadClearedMemoryCache: true }
    } finally { await fixture.reset() }
  })
}
