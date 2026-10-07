// Extractores que se actualizan solos, sin sacar otra versión de la app (ver src-tauri/src/extractors.rs).
//
//   node scripts/extractors.mjs                  publica en GitHub los que hayan cambiado
//   node scripts/extractors.mjs --dry-run        solo dice qué publicaría
//   node scripts/extractors.mjs --to <carpeta>   los deja en una carpeta (para probar la app con
//                                                MUSIFY_EXTRACTORS_URL=<carpeta>)
//   node scripts/extractors.mjs upgrade-youtubei si hay youtubei.js nuevo y funciona, lo pone y
//                                                sube la versión del extractor (lo usa la revisión diaria)
//   node scripts/extractors.mjs smoke <módulo>   prueba un youtubei.js empaquetado con vídeos de verdad
//
// Se publican en la versión "extractores" de diad87/pletina-releases: cada extractor como
// <nombre>-api<api>-v<versión>.<ext>, firmado con la clave de las actualizaciones de la app, y el
// índice extractores.json. Para firmar hacen falta TAURI_SIGNING_PRIVATE_KEY (o _PATH) y
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD; si no están, se usan ~/.musify/updater.key y updater.password.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'diad87/pletina-releases'
const TAG = 'extractores'
const MANIFEST = 'extractores.json'
const MANIFEST_URL = `https://github.com/${REPO}/releases/download/${TAG}/${MANIFEST}`
const META = 'src-tauri/extractors.json'
const OUT = 'dist-extractors/out'
const MODULE = 'dist-extractors/build/youtubei.js'
const SOURCES = { recipe: 'src-tauri/recipe/youtube.json', capture: 'src-tauri/src/capture.js', youtubei: MODULE }
const EXT = { recipe: 'json', capture: 'js', youtubei: 'js' }
/** Vídeos para probar youtubei.js (Radiohead - Airbag, Estopa - Sucede). */
const SMOKE_VIDEOS = ['jNY_wLukVW0', 'nV-F1WSpJIA']

const args = process.argv.slice(2)
// En Windows, npm y npx son .cmd y necesitan la consola (se les pasa la orden entera: sus
// argumentos aquí nunca llevan espacios). gh y git son programas normales.
const viaShell = (cmd) => process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx')
const exec = (cmd, a, opts = {}) =>
  viaShell(cmd) ? execFileSync([cmd, ...a].join(' '), { shell: true, ...opts }) : execFileSync(cmd, a, opts)
const run = (cmd, a, opts = {}) => exec(cmd, a, { stdio: 'inherit', ...opts })
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

if (args[0] === 'smoke') {
  const ok = await smoke(args[1])
  process.exit(ok === SMOKE_VIDEOS.length ? 0 : 1)
} else if (args[0] === 'upgrade-youtubei') {
  await upgradeYoutubei()
} else {
  await publish({ dryRun: args.includes('--dry-run'), to: args.includes('--to') ? args[args.indexOf('--to') + 1] : null })
}

function buildModule() {
  run('npx', ['vite', 'build', '--config', 'vite.extractors.config.ts', '--logLevel', 'warn'])
}

async function publish({ dryRun, to }) {
  const meta = readJson(META)
  buildModule()
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const local = Object.entries(SOURCES).map(([name, path]) => {
    const { api, version } = meta[name]
    const file = `${name}-api${api}-v${version}.${EXT[name]}`
    copyFileSync(path, join(OUT, file))
    return { name, api, version, file, sha256: sha256(readFileSync(path)) }
  })

  // Lo publicado ahora.
  let published = { components: [] }
  if (to) {
    if (existsSync(join(to, MANIFEST))) published = readJson(join(to, MANIFEST))
  } else {
    const res = await fetch(MANIFEST_URL)
    if (res.ok) published = await res.json()
    else if (res.status !== 404) throw new Error(`No se pudo leer ${MANIFEST_URL}: ${res.status}`)
  }

  const changes = []
  const errors = []
  for (const c of local) {
    const prev = published.components.find((p) => p.name === c.name && p.api === c.api)
    if (prev?.sha256 === c.sha256) {
      console.log(`${c.name}: sin cambios (v${prev.version})`)
    } else if (prev && c.version <= prev.version) {
      errors.push(
        `${c.name} ha cambiado, pero su versión (${c.version}) no es mayor que la publicada (${prev.version}): súbela en ${META}.`,
      )
    } else {
      console.log(`${c.name}: v${c.version} nueva (api ${c.api})${prev ? `, antes v${prev.version}` : ''}`)
      changes.push(c)
    }
  }
  if (errors.length) {
    for (const e of errors) console.error(e)
    process.exit(1)
  }
  if (!changes.length) return console.log('Nada que publicar.')
  if (dryRun) return console.log('(--dry-run: no se publica nada)')

  for (const c of changes) {
    sign(join(OUT, c.file))
    c.signature = readFileSync(join(OUT, `${c.file}.sig`), 'utf8').trim()
  }

  // El índice: lo que había más lo nuevo. Se guardan los de otras api, para las apps más viejas.
  const fresh = changes.map(({ name, api, version, file, sha256, signature }) => ({ name, api, version, file, sha256, signature }))
  const components = published.components
    .filter((p) => !changes.some((c) => c.name === p.name && c.api === p.api))
    .concat(fresh)
    .sort((a, b) => a.name.localeCompare(b.name) || a.api - b.api)
  writeFileSync(join(OUT, MANIFEST), JSON.stringify({ updated: new Date().toISOString(), components }, null, 2) + '\n')

  const files = changes.map((c) => join(OUT, c.file))
  if (to) {
    mkdirSync(to, { recursive: true })
    for (const f of [...files, join(OUT, MANIFEST)]) copyFileSync(f, join(to, f.split(/[\\/]/).pop()))
    return console.log(`Listo en ${resolve(to)}`)
  }
  try {
    exec('gh', ['release', 'view', TAG, '-R', REPO], { stdio: 'ignore' })
  } catch {
    run('gh', ['release', 'create', TAG, '-R', REPO, '--prerelease', '--latest=false', '--title', 'Extractores', '--notes',
      'Extractores de audio que Pletina baja y cambia solo, sin reinstalar. No hace falta descargar nada de aquí.'])
  }
  // Primero los extractores y después el índice, para que nunca apunte a algo que aún no está.
  run('gh', ['release', 'upload', TAG, ...files, '--clobber', '-R', REPO])
  run('gh', ['release', 'upload', TAG, join(OUT, MANIFEST), '--clobber', '-R', REPO])
  console.log(`Publicado: ${changes.map((c) => `${c.name} v${c.version}`).join(', ')}`)
}

/** Firma un archivo con la clave de las actualizaciones (deja <archivo>.sig al lado). */
function sign(file) {
  const env = { ...process.env }
  if (!env.TAURI_SIGNING_PRIVATE_KEY && !env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    const dir = join(homedir(), '.musify')
    env.TAURI_SIGNING_PRIVATE_KEY_PATH = join(dir, 'updater.key')
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= readFileSync(join(dir, 'updater.password'), 'utf8').trim()
  }
  exec('npx', ['tauri', 'signer', 'sign', file], { env, stdio: 'ignore' })
}

/** Prueba un youtubei.js empaquetado como lo usa la app. Devuelve cuántos vídeos dieron audio. */
async function smoke(path) {
  const m = await import(pathToFileURL(resolve(path)).href + `?t=${Date.now()}`)
  if (m.api !== readJson(META).youtubei.api) throw new Error(`El módulo dice api ${m.api}`)
  m.setup({ fetch: (input, init) => fetch(input, init), evaluate: async (code) => new Function(code)() })
  let ok = 0
  for (const id of SMOKE_VIDEOS) {
    try {
      const s = await m.stream(id)
      const res = await fetch(s.url, { headers: { Range: 'bytes=0-1023' } })
      if (res.status !== 206 && res.status !== 200) throw new Error(`el audio responde ${res.status}`)
      console.log(`  ${id}: bien (${s.client}, ${s.mime.split(';')[0]})`)
      ok++
    } catch (e) {
      console.log(`  ${id}: falla (${String(e).slice(0, 160)})`)
    }
  }
  return ok
}

/**
 * Revisión diaria: si hay youtubei.js nuevo en npm, lo prueba y, si va al menos tan bien como el
 * actual, lo deja puesto y sube la versión del extractor (después hay que publicar y subir el cambio).
 * Escribe en GITHUB_OUTPUT `changed=true|false`.
 */
async function upgradeYoutubei() {
  const output = (changed) => process.env.GITHUB_OUTPUT && writeFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`, { flag: 'a' })
  const current = readJson('node_modules/youtubei.js/package.json').version
  const latest = exec('npm', ['view', 'youtubei.js', 'version'], { encoding: 'utf8' }).trim()
  if (latest === current) {
    console.log(`youtubei.js ${current} es la última.`)
    return output(false)
  }
  console.log(`youtubei.js: ${current} → ${latest}`)
  buildModule()
  copyFileSync(MODULE, 'dist-extractors/youtubei-actual.js')
  const before = await smoke('dist-extractors/youtubei-actual.js')

  run('npm', ['install', `youtubei.js@${latest}`, '--save', '--no-audit', '--no-fund'])
  // Que siga encajando con la app (tipos) y que se empaquete.
  run('npm', ['run', 'check'])
  buildModule()
  const after = await smoke(MODULE)
  // Desde los servidores de GitHub YouTube a veces no deja: entonces basta con no ir a peor.
  if (after < before || (after === 0 && before === 0 && process.env.CI !== 'true')) {
    console.error(`youtubei.js ${latest} no funciona tan bien como ${current} (${after} frente a ${before}): no se cambia.`)
    run('git', ['checkout', '--', 'package.json', 'package-lock.json'])
    run('npm', ['ci', '--no-audit', '--no-fund'])
    process.exit(1)
  }
  const meta = readJson(META)
  meta.youtubei.version++
  writeFileSync(META, JSON.stringify(meta, null, 2) + '\n')
  console.log(`youtubei.js ${latest} puesto; extractor youtubei v${meta.youtubei.version}.`)
  output(true)
}
