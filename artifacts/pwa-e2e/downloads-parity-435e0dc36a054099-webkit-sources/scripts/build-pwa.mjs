import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = fileURLToPath(new URL('../', import.meta.url))
export const sourceDirectory = join(workspace, 'pwa')
export const outputDirectory = join(workspace, 'dist-pwa')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const contains = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

async function readTree(directory, base = directory) {
  const files = new Map()
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) {
      for (const entry of await readTree(path, base)) files.set(...entry)
    } else if (item.isFile()) {
      files.set(relative(base, path).split(sep).join('/'), await readFile(path))
    }
  }
  return files
}

export async function buildPwa({ source = sourceDirectory, output = outputDirectory, application } = {}) {
  const files = await readTree(source)
  const worker = files.get('sw.js').toString()
  files.delete('sw.js')
  const optionalNames = new Set()
  let applicationPage
  if (application) {
    for (const name of [...files.keys()]) if (name.startsWith('player/')) files.delete(name)
    const bundled = await readTree(application)
    const html = bundled.get('index.html')
    if (!html) throw new Error('Falta la aplicación web compilada.')
    const htmlName = `index.${sha256(html).slice(0, 16)}.html`
    bundled.delete('index.html')
    bundled.set(htmlName, html)
    const paths = [...bundled.keys()].sort()
    // El primer acceso verifica y guarda el conjunto antes de entrar en la app.
    const launch = Buffer.from(`const files=${JSON.stringify(paths)};\nexport async function mountPlayer(){\nawait Promise.all(files.map(async path=>{const response=await fetch(new URL(path,import.meta.url));if(!response.ok)throw new Error('No se pudo descargar Pletina.');await response.arrayBuffer();}));\nlocation.replace(new URL(${JSON.stringify(htmlName)},import.meta.url).href);return {destroy(){}};\n}\n`)
    const launcher = `launcher.${sha256(launch).slice(0, 16)}.js`
    bundled.set(launcher, launch)
    for (const [name, bytes] of bundled) {
      files.set('application/' + name, bytes)
      optionalNames.add('application/' + name)
    }
    applicationPage = 'application/' + htmlName
    files.set('app.js', Buffer.from(files.get('app.js').toString()
      .replaceAll('./player/entry.mjs', './application/' + launcher)))
  }
  // Incluye el propio worker para que cualquier cambio de política tenga su caché.
  const fingerprint = createHash('sha256').update(worker)
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) fingerprint.update(name).update(bytes)
  const version = fingerprint.digest('hex').slice(0, 16)
  let app = files.get('app.js').toString()
  if (files.has('player/entry.mjs')) {
    // Dependencias primero: el hash de entry incluye el nombre del resolver.
    const resolver = files.get('player/resolver.mjs')
    if (!resolver) throw new Error('Falta el resolver del reproductor.')
    const resolverName = `player/resolver.${sha256(resolver).slice(0, 16)}.js`
    const entry = Buffer.from(files.get('player/entry.mjs').toString()
      .replaceAll('./resolver.mjs', './' + resolverName.slice('player/'.length)))
    const entryName = `player/entry.${sha256(entry).slice(0, 16)}.js`
    files.delete('player/resolver.mjs')
    files.delete('player/entry.mjs')
    files.set(resolverName, resolver)
    files.set(entryName, entry)
    optionalNames.add(resolverName)
    optionalNames.add(entryName)
    app = app.replaceAll('./player/entry.mjs', './' + entryName)
  }
  if ([...files.keys()].some((name) => name.startsWith('player/') && !optionalNames.has(name))) {
    throw new Error('Hay recursos del reproductor sin declarar en la carga bajo demanda.')
  }
  const appName = `app.${sha256(app).slice(0, 16)}.js`
  files.set(appName, Buffer.from(app))
  files.delete('app.js')
  files.set('index.html', Buffer.from(files.get('index.html').toString()
    .replace('src="./app.js"', `src="./${appName}"`).replace('__BUILD_VERSION__', version)))
  const integrity = [...files].sort(([a], [b]) => a.localeCompare(b))
    .map(([url, bytes]) => ({ url, sha256: sha256(bytes) }))
  const precache = integrity.filter((file) => !optionalNames.has(file.url))
  const optional = integrity.filter((file) => optionalNames.has(file.url))
  files.set('sw.js', Buffer.from(worker.replace('__BUILD_VERSION__', JSON.stringify(version))
    .replace('__PRECACHE_FILES__', JSON.stringify(precache))
    .replace('__OPTIONAL_FILES__', JSON.stringify(optional))))
  files.set('.nojekyll', Buffer.from(''))

  // Solo se limpia el directorio de salida concreto, nunca la raíz ni los fuentes.
  const target = resolve(output)
  const sourcePath = resolve(source)
  if (contains(target, resolve(workspace)) || contains(target, sourcePath) || contains(sourcePath, target)) {
    throw new Error('El directorio de salida no puede contener el proyecto o los fuentes.')
  }
  if (target !== resolve(outputDirectory)) {
    // Salidas alternativas (pruebas): deben ser carpetas nuevas, sin borrar nada previo.
    await mkdir(target, { recursive: false })
  } else {
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
  }
  for (const [name, bytes] of files) {
    const path = join(target, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }
  return { version, files: [...files.keys()], optionalFiles: [...optionalNames], applicationPage,
    bytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    initialBytes: [...files].filter(([name]) => !optionalNames.has(name)).reduce((sum, [, bytes]) => sum + bytes.length, 0) }
}

// Copia de un solo archivo para abrir con doble clic, sin servidor ni archivos vecinos.
// No se publica en Pages ni se precachea: la descarga inicial de la PWA sigue siendo mínima.
export async function buildPortablePwa({ directory = outputDirectory, output = join(workspace, 'dist-pwa-portable', 'Pletina.html') } = {}) {
  let html = await readFile(join(directory, 'index.html'), 'utf8')
  const script = html.match(/<script src="\.\/(app\.[a-f0-9]+\.js)" defer><\/script>/)
  if (!script) throw new Error('Falta el script compilado para crear la copia portable.')
  const javascript = (await readFile(join(directory, script[1]), 'utf8')).replace(/<\/script/gi, '<\\/script')
  const icon = (await readFile(join(directory, 'icons', 'icon-192.png'))).toString('base64')
  html = html.replace('<html lang="es">', '<html lang="es" data-portable>')
    .replace(/    <link rel="(?:manifest|icon|apple-touch-icon)"[^>]*>\r?\n/g, '')
    .replace(script[0], '')
    .replaceAll('src="./icons/icon-192.png"', `src="data:image/png;base64,${icon}"`)
    .replace('</body>', `  <script>${javascript}</script>\n  </body>`)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, html)
  return { output, bytes: Buffer.byteLength(html) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    throw new Error('Este generador interno no admite argumentos. Para el port completo usa npm run build:pwa.')
  }
  const result = await buildPwa()
  console.log(`PWA ${result.version}: ${result.initialBytes.toLocaleString('es-ES')} bytes iniciales; ${result.bytes.toLocaleString('es-ES')} bytes con reproductor en dist-pwa/`)
  const portable = await buildPortablePwa()
  console.log(`Copia sin servidor: dist-pwa-portable/Pletina.html (${portable.bytes.toLocaleString('es-ES')} bytes)`)
}
