import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compileModule } from 'svelte/compiler'
import * as svelte from 'svelte/internal/client'
import ts from 'typescript'
import { toQuery } from '../../src/lib/queue.ts'

// Compile the real Svelte module; IPC and UI dependencies do not take part in
// metadata conversion. This exercises the same adapters used by library views.
const javascript = ts.transpileModule(await readFile(new URL('../../src/lib/library.svelte.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText
const code = ts.transpileModule(compileModule(javascript, { filename: 'library.svelte.js' }).js.code, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const library = {}, modules = {
  'svelte/internal/client': svelte,
  'svelte/reactivity': { SvelteSet: Set },
  './api': {}, './toast.svelte': { toast: {} }, './pins.svelte': { pins: {} },
}
new Function('exports', 'require', code)(library, name => {
  assert.ok(name in modules, `Unexpected dependency: ${name}`)
  return modules[name]
})

test('guardar una canción y recuperarla de biblioteca conserva la identidad enviada al resolvedor', () => {
  const original = { track: { id: 3250715431, title: 'Iritsi da Eguna', titleVersion: 'Original', duration: 169,
    trackPosition: 3, diskNumber: 1, explicitLyrics: false, isrc: 'QM6N21424821', artist: { id: 42, name: 'Pirritx eta Porrotx' } },
    albumId: 43, albumTitle: 'Eskerrik Asko!', artistId: 42, cover: null }
  const saved = library.toLib(original)
  const restored = library.fromLib(JSON.parse(JSON.stringify(saved)))
  assert.deepEqual(toQuery(restored), toQuery(original))
  assert.equal(saved.isrc, 'QM6N21424821')
  assert.equal(saved.titleVersion, 'Original')
})

test('una ficha nativa antigua o con identidad nula conserva la compatibilidad al volver a la cola', () => {
  const old = { id: 42, title: 'Tema', duration: 180, explicit: false, artistId: 1, artistName: 'Artista',
    albumId: 2, albumTitle: 'Álbum', albumArtistId: 1, cover: null }
  for (const metadata of [{}, { isrc: null, titleVersion: null }]) {
    const query = toQuery(library.fromLib({ ...old, ...metadata }))
    assert.equal(query.isrc, null)
    assert.equal(query.titleVersion, null)
    assert.equal(query.artist, 'Artista')
    assert.equal(query.album, 'Álbum')
  }
})
