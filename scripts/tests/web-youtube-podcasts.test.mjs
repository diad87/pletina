import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const asModule = (source) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText).toString('base64')
const youtube = asModule(await readFile(new URL('../../web-port/youtube.ts', import.meta.url), 'utf8'))
const source = (await readFile(new URL('../../web-port/youtube-podcasts.ts', import.meta.url), 'utf8')).replace("from './youtube'", `from '${youtube}'`)
const { validBrowseId, parseSearch, parseDetail, parsePodcastDuration, parsePodcastDate, search, detail } = await import(asModule(source))

const runs = (...labels) => ({ runs: labels.map((text) => ({ text })) })
const show = (browseId, title, author) => ({ musicResponsiveListItemRenderer: {
  navigationEndpoint: { browseEndpoint: { browseId } },
  flexColumns: [title, author].map((label) => ({ musicResponsiveListItemFlexColumnRenderer: { text: runs(label) } })),
  thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/cover.jpg' }] } } },
} })
const episode = (videoId, title) => ({ musicMultiRowListItemRenderer: {
  onTap: { watchEndpoint: { videoId } }, title: runs(title), description: runs('Descripción.'),
  subtitle: runs('214 K visualizaciones', ' • ', '27 ago 2018'),
  playbackProgress: { musicPlaybackProgressRenderer: { durationText: runs(' • ', '51 min') } },
} })

test('search returns only valid shows in source order, deduplicated and bounded', () => {
  const results = parseSearch({ items: [show('MPSPfirst', 'Primero', 'Podcast • Autor'), show('MPSPfirst', 'Duplicado', 'x'),
    show('UCchannel', 'Canal', 'x'), show('MPSP<script>', 'Inválido', 'x'),
    ...Array.from({ length: 25 }, (_, i) => show(`MPSPshow${i}`, `Temporada ${i}`, 'Autor'))] })
  assert.equal(results.length, 20)
  assert.equal(results[0].browseId, 'MPSPfirst')
  assert.equal(results[0].author, 'Autor')
  assert.equal(results[1].title, 'Temporada 0')
  assert.equal(validBrowseId('MPSP' + 'a'.repeat(95)), true)
  assert.equal(validBrowseId('MPSP' + 'a'.repeat(96)), false)
})

test('detail preserves episode order, stable video GUIDs and safe thumbnails', () => {
  const response = { header: { musicResponsiveHeaderRenderer: { title: runs('Temporada 5'), straplineTextOne: runs('Autora'),
    description: { musicDescriptionShelfRenderer: { description: runs('La quinta temporada.') } },
    thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'javascript:alert(1)' }] } } } } },
  contents: [episode('aV8l7X7B3tU', 'Primero'), episode('aV8l7X7B3tU', 'Duplicado'), episode('dQw4w9WgXcQ', 'Segundo'), episode('bad', 'Inválido')] }
  const page = parseDetail('MPSPshow', response, new Date('2026-10-08T00:00:00Z'))
  assert.equal(page.show.title, 'Temporada 5')
  assert.equal(page.show.image, null)
  assert.equal(page.description, 'La quinta temporada.')
  assert.equal(page.episodes.length, 2)
  assert.equal(page.episodes[0].guid, 'aV8l7X7B3tU')
  assert.equal(page.episodes[1].title, 'Segundo')
  assert.equal(page.episodes[0].audioUrl, 'youtube:aV8l7X7B3tU')
  assert.equal(page.episodes[0].duration, 3060)
  assert.equal(page.episodes[0].publishedAt, '2018-08-27T12:00:00Z')
  assert.equal(page.episodes[0].explicit, false)
  assert.throws(() => parseDetail('MPSPshow', {}), /no ha devuelto/)
})

test('Spanish dates and durations match native podcast metadata semantics', () => {
  const now = new Date('2026-10-08T08:00:00Z')
  for (const [input, expected] of [['27 ago 2018', '2018-08-27'], ['26 sept', '2026-09-26'], ['20 dic', '2025-12-20'],
    ['hace 4 d', '2026-10-04'], ['hace 2 semanas', '2026-09-24'], ['hace 3 h', '2026-10-08'], ['hace 1 año', '2025-10-08']]) {
    assert.equal(parsePodcastDate(input, now), expected + 'T12:00:00Z')
  }
  assert.equal(parsePodcastDate('214 K visualizaciones', now), null)
  for (const [input, seconds] of [['51 min', 3060], ['1 h 5 min', 3900], ['1:02:03', 3723], ['45 s', 45], ['Reproducido', 0], ['999999999999 h', 0]]) {
    assert.equal(parsePodcastDuration(input), seconds)
  }
})

test('detail stops at the native limit of 300 unique episodes', () => {
  const response = { header: { musicResponsiveHeaderRenderer: { title: runs('Archivo') } },
    contents: Array.from({ length: 320 }, (_, index) => episode(String(index).padStart(11, '0'), `Episodio ${index}`)) }
  const page = parseDetail('MPSParchive', response)
  assert.equal(page.episodes.length, 300)
  assert.equal(page.episodes.at(-1).title, 'Episodio 299')
})

test('invalid identifiers, long search and aborted operations perform no DOM work', async () => {
  await assert.rejects(detail('https://example.test/rss'), /no es válido/)
  await assert.rejects(search('a'.repeat(251)), /demasiado larga/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(search('podcast', controller.signal), { name: 'AbortError' })
})
