// Prepara una versión para publicar en diad87/musify-releases a partir de los artefactos de GitHub Actions:
// copia los instaladores con su nombre final y genera latest.json, el índice que consulta el actualizador.
//
//   node scripts/release.mjs <carpeta-de-artefactos> <etiqueta> [notas.md]
//
// Deja todo en <carpeta-de-artefactos>/_release, listo para `gh release create`.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const [dir, tag, notesFile] = process.argv.slice(2)
if (!dir || !tag) {
  console.error('Uso: node scripts/release.mjs <carpeta-de-artefactos> <etiqueta> [notas.md]')
  process.exit(1)
}

const REPO = 'diad87/musify-releases'
const version = tag.replace(/^v/, '')
const out = join(dir, '_release')
mkdirSync(out, { recursive: true })

const files = []
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const path = join(d, name)
    if (path === out) continue
    if (statSync(path).isDirectory()) walk(path)
    else files.push(path)
  }
}
walk(dir)

const find = (re) => files.find((f) => re.test(basename(f)))
const url = (name) => `https://github.com/${REPO}/releases/download/${tag}/${name}`

/** Copia un archivo con su nombre final y devuelve ese nombre. */
function publish(path, name = basename(path)) {
  copyFileSync(path, join(out, name))
  return name
}

/** Instalador firmado para el actualizador: { signature, url }. */
function signed(path, name) {
  const sig = `${path}.sig`
  if (!existsSync(sig)) throw new Error(`Falta la firma de ${basename(path)} (¿se compiló con la clave?)`)
  const final = publish(path, name)
  publish(sig, `${final}.sig`)
  return { signature: readFileSync(sig, 'utf8').trim(), url: url(final) }
}

const platforms = {}

const exe = find(/_x64-setup\.exe$/)
if (exe) platforms['windows-x86_64'] = signed(exe)

// Mac universal: el mismo paquete sirve para chip de Apple e Intel.
const app = find(/\.app\.tar\.gz$/)
if (app) {
  const entry = signed(app, `Musify_${version}_universal.app.tar.gz`)
  platforms['darwin-aarch64'] = entry
  platforms['darwin-x86_64'] = entry
}

const appImage = find(/\.AppImage$/)
if (appImage) platforms['linux-x86_64'] = signed(appImage)

// Instaladores que no usa el actualizador, pero sí la gente para la primera instalación.
for (const re of [/\.dmg$/, /\.deb$/]) {
  const f = find(re)
  if (f) publish(f)
}

if (!Object.keys(platforms).length) {
  console.error('No se ha encontrado ningún instalador en', dir)
  process.exit(1)
}

const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8').trim() : ''
writeFileSync(
  join(out, 'latest.json'),
  JSON.stringify({ version, notes: notes || `Musify ${version}`, pub_date: new Date().toISOString(), platforms }, null, 2),
)

console.log(`Versión ${version} preparada en ${out}:`)
for (const name of readdirSync(out)) console.log('  ' + name)
